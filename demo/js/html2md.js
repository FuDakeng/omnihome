/* ============================================================
   OmniHome · 剪贴板 HTML → Markdown
   ------------------------------------------------------------
   从浏览器、文档软件复制的带样式内容，粘贴进编辑器时转成
   Markdown（标题、加粗、列表、链接、表格等）。
   Ctrl/⌘+Shift+V 只使用 text/plain，不走这层转换。
   ============================================================ */

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'TITLE', 'HEAD',
  'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'BUTTON', 'SELECT', 'TEXTAREA',
  'FORM', 'COLGROUP', 'COL',
]);
const LINE_TAGS = new Set([
  'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'NAV',
  'ASIDE', 'FIGURE', 'FIGCAPTION', 'ADDRESS', 'DD', 'DT', 'CENTER',
]);
const BLOCK_CHILD = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'CENTER', 'DIV', 'DL',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HR', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'UL',
]);
const INLINE_TAGS = new Set([
  'A', 'ABBR', 'B', 'BR', 'CITE', 'CODE', 'DEL', 'EM', 'FONT', 'I', 'IMG', 'INPUT',
  'KBD', 'LABEL', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRIKE', 'STRONG',
  'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR',
]);
const NONE = { b: false, i: false, s: false };

function isInlineEl(el){
  return !!(el && INLINE_TAGS.has(el.tagName));
}

function extractFragment(html){
  let s = String(html || '');
  const m = s.match(/<!--\s*StartFragment\s*-->([\s\S]*?)<!--\s*EndFragment\s*-->/i);
  if (m) s = m[1];
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<!\[if[\s\S]*?<!\[endif\]>/gi, '');
  return s;
}

function styleMap(el){
  const style = (el.getAttribute && el.getAttribute('style')) || '';
  const weight = /font-weight\s*:\s*([^;]+)/i.exec(style);
  const italic = /font-style\s*:\s*([^;]+)/i.exec(style);
  const deco = /text-decoration(?:-line)?\s*:\s*([^;]+)/i.exec(style);
  return {
    weight: weight ? weight[1].trim().toLowerCase() : '',
    italic: italic ? italic[1].trim().toLowerCase() : '',
    deco: deco ? deco[1].trim().toLowerCase() : '',
  };
}

function weightIsBold(w){
  if (!w) return false;
  if (w === 'bold' || w === 'bolder') return true;
  const n = parseInt(w, 10);
  return !isNaN(n) && n >= 600;
}

function marksOf(el, parent){
  const m = { b: parent.b, i: parent.i, s: parent.s };
  const st = styleMap(el);
  const tag = el.tagName;
  if (st.weight) m.b = weightIsBold(st.weight);
  else if (tag === 'B' || tag === 'STRONG') m.b = true;
  if (st.italic) m.i = (st.italic === 'italic' || st.italic === 'oblique');
  else if (tag === 'I' || tag === 'EM') m.i = true;
  if (st.deco) m.s = st.deco.includes('line-through');
  else if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') m.s = true;
  return m;
}

function isPreWs(el){
  const st = ((el.getAttribute && el.getAttribute('style')) || '').toLowerCase();
  return /white-space\s*:\s*(pre|pre-wrap|break-spaces)\b/.test(st);
}

function hasBlockChild(el){
  for (const c of el.children) if (BLOCK_CHILD.has(c.tagName)) return true;
  return false;
}

function isBlankLine(el){
  const nodes = Array.from(el.childNodes);
  if (!nodes.length) return false;
  return nodes.every(n => {
    if (n.nodeType === 3) return !String(n.nodeValue || '').trim();
    return n.nodeType === 1 && n.tagName === 'BR';
  });
}

function cleanHref(href){
  return String(href || '').trim().replace(/\s/g, '%20').replace(/\)/g, '%29');
}

function makeLink(inner, href){
  const url = String(href || '').trim();
  if (!url || /^(javascript|data):/i.test(url)) return inner;
  const text = String(inner || '').trim();
  if (!text) return url;
  if (text === url) return url;
  return '[' + text + '](' + cleanHref(url) + ')';
}

function renderImg(el){
  let src = (el.getAttribute('src') || '').trim();
  if (!src || /^data:/i.test(src) || /^blob:/i.test(src)) return '';
  const alt = (el.getAttribute('alt') || '').replace(/[\[\]]/g, '');
  return '![' + alt + '](' + cleanHref(src) + ')';
}

function inlineCode(text){
  const t = String(text || '').replace(/\u00a0/g, ' ').replace(/\u200b/g, '').replace(/\n+/g, ' ');
  if (!t) return '';
  if (!t.includes('`')) return '`' + t + '`';
  let n = 1;
  const runs = t.match(/`+/g) || [];
  for (const r of runs) n = Math.max(n, r.length + 1);
  const fence = '`'.repeat(n);
  const pad = (t.startsWith('`') || t.endsWith('`')) ? ' ' : '';
  return fence + pad + t + pad + fence;
}

function codeLang(el){
  if (!el || !el.getAttribute) return '';
  const explicit = (el.getAttribute('data-lang') || '').trim();
  if (explicit) return explicit;
  const cls = el.getAttribute('class') || '';
  const lm = cls.match(/(?:language|lang)-([\w#+.-]+)/i);
  return lm ? lm[1] : '';
}

function renderPre(el){
  const code = el.querySelector('code') || el;
  const lang = codeLang(code) || codeLang(el);
  let text = (code.textContent || '').replace(/\u00a0/g, ' ').replace(/\n$/, '');
  const tick = text.includes('```') ? '~~~~' : '```';
  return '\n\n' + tick + (lang || '') + '\n' + text + '\n' + tick + '\n\n';
}

function cellAlign(cell){
  const a = (cell.getAttribute('align') || '').toLowerCase();
  if (a === 'center' || a === 'right' || a === 'left') return a;
  const st = /text-align\s*:\s*(left|center|right)/i.exec(cell.getAttribute('style') || '');
  return st ? st[1].toLowerCase() : '';
}

function isChecked(el){
  if (!el) return false;
  if (el.hasAttribute && el.hasAttribute('checked')) return true;
  const aria = (el.getAttribute && el.getAttribute('aria-checked')) || '';
  if (aria === 'true') return true;
  return !!el.checked;
}

function taskState(li){
  const look = [li];
  for (const el of li.children){
    if (el.tagName === 'P' || el.tagName === 'DIV' || el.tagName === 'LABEL') look.push(el);
  }
  for (const box of look){
    for (const c of box.children || []){
      const type = (c.getAttribute && c.getAttribute('type')) || '';
      const role = (c.getAttribute && c.getAttribute('role')) || '';
      if (c.tagName === 'INPUT' && /checkbox/i.test(type)) return isChecked(c);
      if (role === 'checkbox') return isChecked(c);
    }
  }
  return null;
}

function pushText(tokens, raw, marks, preserveWs){
  let t = String(raw || '').replace(/\u00a0/g, ' ').replace(/\u200b/g, '');
  if (!t) return;
  if (!preserveWs){
    t = t.replace(/\s+/g, ' ');
    if (t) tokens.push({ t, marks });
    return;
  }
  const parts = t.split('\n');
  parts.forEach((p, i) => {
    if (p) tokens.push({ t: p, marks });
    if (i < parts.length - 1) tokens.push({ br: true });
  });
}

function tokenizeNodes(nodes, marks, preserveWs, tokens){
  for (const node of nodes){
    if (node.nodeType === 3){
      pushText(tokens, node.nodeValue, marks, preserveWs);
      continue;
    }
    if (node.nodeType !== 1) continue;
    const el = node;
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag)) continue;
    if (tag === 'INPUT') continue;
    if (tag === 'BR'){ tokens.push({ br: true }); continue; }
    if (tag === 'IMG'){
      const md = renderImg(el);
      if (md) tokens.push({ atom: md, marks: NONE });
      continue;
    }
    if (tag === 'CODE'){
      const md = inlineCode(el.textContent || '');
      if (md) tokens.push({ atom: md, marks: { b: marks.b, i: marks.i, s: marks.s } });
      continue;
    }
    if (tag === 'A'){
      const inner = tokensToMarkdown(collectTokens(el.childNodes, marksOf(el, marks), preserveWs)).trim();
      const md = makeLink(inner, el.getAttribute('href') || '');
      if (md) tokens.push({ atom: md, marks: NONE });
      continue;
    }
    if (tag === 'PRE' || tag === 'TABLE' || tag === 'UL' || tag === 'OL' || tag === 'BLOCKQUOTE' || /^H[1-6]$/.test(tag) || tag === 'HR'){
      const md = renderNode(el).trim();
      if (md) tokens.push({ atom: '\n' + md + '\n', marks: NONE });
      continue;
    }
    tokenizeNodes(el.childNodes, marksOf(el, marks), preserveWs || isPreWs(el), tokens);
  }
}

function collectTokens(nodes, marks, preserveWs){
  const tokens = [];
  tokenizeNodes(nodes, marks, preserveWs, tokens);
  return tokens;
}

function tokensToMarkdown(tokens){
  const pieces = [];
  for (const tok of tokens){
    if (tok.br){ pieces.push({ br: true }); continue; }
    if (tok.atom != null){
      pieces.push({ text: tok.atom, marks: tok.marks || NONE });
      continue;
    }
    const t = tok.t || '';
    if (!t) continue;
    const lead = t.match(/^[ \t]+/);
    const leadStr = lead ? lead[0] : '';
    const rest = t.slice(leadStr.length);
    const trail = rest.match(/[ \t]+$/);
    const trailStr = trail ? trail[0] : '';
    const core = trailStr ? rest.slice(0, -trailStr.length) : rest;
    if (leadStr) pieces.push({ text: leadStr, marks: NONE });
    if (core) pieces.push({ text: core, marks: tok.marks || NONE });
    if (trailStr) pieces.push({ text: trailStr, marks: NONE });
  }
  let out = '';
  let cur = { b: false, i: false, s: false };
  function goto(next){
    const n = { b: !!next.b, i: !!next.i, s: !!next.s };
    if (cur.s && !n.s) out += '~~';
    if (cur.i && !n.i) out += '_';
    if (cur.b && !n.b) out += '**';
    if (!cur.b && n.b) out += '**';
    if (!cur.i && n.i) out += '_';
    if (!cur.s && n.s) out += '~~';
    cur = n;
  }
  for (const p of pieces){
    if (p.br){
      goto(NONE);
      if (!out.endsWith('\n')) out += '\n';
      continue;
    }
    if (!p.marks.b && !p.marks.i && !p.marks.s && /^[ \t]+$/.test(p.text) && /[ \t]$/.test(out))
      continue;
    goto(p.marks);
    out += p.text;
  }
  goto(NONE);
  return out;
}

function stringifyInline(nodes, baseMarks){
  return tokensToMarkdown(collectTokens(nodes, baseMarks || NONE, false));
}

function renderList(el, ordered, depth){
  const lines = [];
  let n = parseInt(el.getAttribute('start') || '1', 10);
  if (!isFinite(n) || n < 0) n = 1;
  const lis = Array.from(el.children).filter(c => c.tagName === 'LI');
  for (const li of lis){
    const task = taskState(li);
    const marker = task == null
      ? (ordered ? (n++) + '. ' : '- ')
      : (task ? '- [x] ' : '- [ ] ');
    const body = renderLiBody(li, depth);
    const parts = body.split('\n');
    const pad = '  '.repeat(depth);
    lines.push(pad + marker + (parts[0] || ''));
    const hang = ' '.repeat(marker.length);
    for (let i = 1; i < parts.length; i++){
      const line = parts[i];
      if (!line){ lines.push(''); continue; }
      if (/^\s+/.test(line) || /^\s*([-*+] \[[ xX]\]|[-*+] |\d+\. )/.test(line)) lines.push(line);
      else lines.push(pad + hang + line);
    }
  }
  return lines.join('\n');
}

function renderLiBody(li, depth){
  const chunks = [];
  let inline = [];
  function flush(){
    if (!inline.length) return;
    const s = stringifyInline(inline, NONE).trim();
    inline = [];
    if (s) chunks.push(s);
  }
  for (const child of li.childNodes){
    if (child.nodeType === 1 && (child.tagName === 'UL' || child.tagName === 'OL')){
      flush();
      const nested = renderList(child, child.tagName === 'OL', depth + 1);
      if (nested) chunks.push(nested);
      continue;
    }
    if (child.nodeType === 1 && (child.tagName === 'P' || child.tagName === 'DIV') && hasBlockChild(child)){
      flush();
      const inner = finalize(renderChildren(child)).trim();
      if (inner) chunks.push(inner);
      continue;
    }
    if (child.nodeType === 1 && child.tagName === 'P'){
      flush();
      const s = stringifyInline(child.childNodes, marksOf(child, NONE)).trim();
      if (s) chunks.push(s);
      continue;
    }
    if (child.nodeType === 1 && child.tagName === 'INPUT') continue;
    inline.push(child);
  }
  flush();
  return chunks.join('\n').replace(/\n{3,}/g, '\n\n');
}

function renderTable(table){
  const cap = table.querySelector('caption');
  const rows = Array.from(table.querySelectorAll('tr')).map(tr =>
    Array.from(tr.children).filter(c => c.tagName === 'TD' || c.tagName === 'TH').map(cell => ({
      text: stringifyInline(cell.childNodes, NONE).trim().replace(/\|/g, '\\|').replace(/\n+/g, ' '),
      align: cellAlign(cell),
    }))
  ).filter(r => r.length);
  if (!rows.length) return '';
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const pad = r => {
    const copy = r.slice();
    while (copy.length < width) copy.push({ text: '', align: '' });
    return copy;
  };
  const header = pad(rows[0]);
  const sep = header.map(c => c.align === 'center' ? ':---:' : c.align === 'right' ? '---:' : c.align === 'left' ? ':---' : '---');
  const line = r => '| ' + pad(r).map(c => c.text).join(' | ') + ' |';
  const body = [line(header), '| ' + sep.join(' | ') + ' |'].concat(rows.slice(1).map(line));
  const caption = cap ? stringifyInline(cap.childNodes, NONE).trim() : '';
  return (caption ? caption + '\n\n' : '') + body.join('\n');
}

function renderChildren(el){
  let out = '';
  let inline = [];
  function flush(){
    if (!inline.length) return;
    const t = stringifyInline(inline, NONE).trim();
    inline = [];
    if (t) out += t + '\n';
  }
  for (const n of el.childNodes){
    if (n.nodeType === 3){
      if (!String(n.nodeValue || '').trim()){
        if (inline.length) inline.push(n);
        continue;
      }
      inline.push(n);
      continue;
    }
    if (n.nodeType !== 1) continue;
    if (SKIP_TAGS.has(n.tagName)) continue;
    if (isInlineEl(n)){ inline.push(n); continue; }
    flush();
    out += renderNode(n);
  }
  flush();
  return out;
}

function renderNode(node){
  if (!node) return '';
  if (node.nodeType === 3){
    const t = stringifyInline([node], NONE).trim();
    return t ? t + '\n' : '';
  }
  if (node.nodeType !== 1) return '';
  const el = node;
  const tag = el.tagName;
  if (SKIP_TAGS.has(tag)) return '';
  if (tag === 'BR') return '\n';
  if (tag === 'HR') return '\n\n---\n\n';
  if (tag === 'IMG'){
    const md = renderImg(el);
    return md ? md + '\n' : '';
  }
  if (tag === 'PRE') return renderPre(el);
  if (/^H[1-6]$/.test(tag)){
    const t = stringifyInline(el.childNodes, NONE).trim();
    return t ? '\n\n' + '#'.repeat(+tag[1]) + ' ' + t + '\n\n' : '';
  }
  if (tag === 'P'){
    const t = stringifyInline(el.childNodes, marksOf(el, NONE)).trim();
    return t ? '\n\n' + t + '\n\n' : '\n';
  }
  if (tag === 'BLOCKQUOTE'){
    const inner = finalize(renderChildren(el)).trim();
    if (!inner) return '';
    return '\n\n' + inner.split('\n').map(l => '> ' + l).join('\n') + '\n\n';
  }
  if (tag === 'UL' || tag === 'OL'){
    const md = renderList(el, tag === 'OL', 0);
    return md ? '\n\n' + md + '\n\n' : '';
  }
  if (tag === 'TABLE'){
    const md = renderTable(el);
    return md ? '\n\n' + md + '\n\n' : '';
  }
  if (tag === 'LI'){
    const md = renderList(fakeList(el), false, 0);
    return md ? '\n\n' + md + '\n\n' : '';
  }
  if (LINE_TAGS.has(tag)){
    if (hasBlockChild(el)) return renderChildren(el);
    if (isBlankLine(el)) return '\n';
    const t = stringifyInline(el.childNodes, marksOf(el, NONE)).trim();
    return t ? t + '\n' : '';
  }
  const t = stringifyInline([el], NONE).trim();
  return t ? t + '\n' : '';
}

function fakeList(li){
  const ul = li.ownerDocument.createElement('ul');
  ul.appendChild(li.cloneNode(true));
  return ul;
}

function finalize(md){
  const slots = [];
  const protectedMd = String(md || '').replace(/(```+|~~~~)[^\n]*\n[\s\S]*?\n\1/g, m => {
    slots.push(m);
    return '\u0000F' + (slots.length - 1) + '\u0000';
  });
  const cleaned = protectedMd
    .split('\n')
    .map(line => /^> $/.test(line) ? line : line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .split('\n')
    .map(line => line === '>' ? '> ' : line)
    .join('\n');
  return cleaned.replace(/\u0000F(\d+)\u0000/g, (_, i) => slots[+i]);
}

export function htmlToMarkdown(html){
  const raw = extractFragment(html);
  if (!String(raw || '').trim()) return '';
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  doc.querySelectorAll('script,style,noscript,meta,link,title').forEach(n => n.remove());
  return finalize(renderChildren(doc.body));
}

function normText(s){
  /* 忽略空白：代码编辑器的 HTML 往往不在块与块之间放换行。 */
  return String(s || '').replace(/\u00a0/g, '').replace(/\u200b/g, '').replace(/\s+/g, '');
}

function looksLikeMarkdownSource(plain){
  const s = String(plain || '');
  if (/```/.test(s)) return true;
  if (/^#{1,6} /m.test(s)) return true;
  if (/^\s*(?:[-*+] \[[ xX]\]|[-*+] |\d+\. |> )/m.test(s)) return true;
  if (/\[[^\]]+\]\([^)]+\)/.test(s)) return true;
  if (/\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|`[^`\n]+`/.test(s)) return true;
  return false;
}

/* 结构标签说明这是排版后的文档，而不是给 Markdown 源码套的颜色。 */
function htmlHasStructuralTags(html){
  return /<(h[1-6]|p|strong|b|em|i|s|del|strike|ul|ol|li|table|blockquote|pre|code|a|img|hr)\b/i.test(html);
}

function htmlVisibleText(html){
  const doc = new DOMParser().parseFromString(extractFragment(html), 'text/html');
  return doc.body ? doc.body.textContent || '' : '';
}

/* 纯文本槽里已经是 Markdown 源码，HTML 只是着色包裹时，保留源码。 */
function shouldKeepPlainSource(plain, html){
  if (!looksLikeMarkdownSource(plain)) return false;
  if (htmlHasStructuralTags(html)) return false;
  try {
    return normText(htmlVisibleText(html)) === normText(plain);
  } catch (e) {
    return false;
  }
}

export function pasteTextFromClipboard({ plain, html, plainOnly }){
  const text = String(plain || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (plainOnly || !html || !String(html).trim()) return text;
  if (shouldKeepPlainSource(text, html)) return text;
  let md = '';
  try { md = htmlToMarkdown(html); } catch (e) { md = ''; }
  if (!md || !String(md).trim()) return text;
  return md;
}

export function clipboardToMarkdown(data, plainOnly){
  const plain = data && data.getData ? (data.getData('text/plain') || '') : '';
  let html = '';
  if (!plainOnly && data && data.getData){
    try { html = data.getData('text/html') || ''; } catch (e) { html = ''; }
  }
  return pasteTextFromClipboard({ plain, html, plainOnly: !!plainOnly });
}

/* 块级 Markdown 插到行中间时，前后补换行，避免标题/列表粘进半行。 */
export function fitPastedMarkdown(existing, start, end, text){
  const raw = String(existing || '');
  const t = String(text || '');
  if (!t) return t;
  const blocky = /\n/.test(t)
    || /^(?:#{1,6} |> |```|~~~~|\| )/.test(t)
    || /^(?:[-*+] \[[ xX]\]|[-*+] |\d+\. )/.test(t);
  if (!blocky) return t;
  let out = t;
  const s = Math.max(0, Math.min(start == null ? raw.length : start, raw.length));
  const e = Math.max(s, Math.min(end == null ? s : end, raw.length));
  if (s > 0 && raw[s - 1] !== '\n' && !out.startsWith('\n')) out = '\n' + out;
  if (e < raw.length && raw[e] !== '\n' && !out.endsWith('\n')) out = out + '\n';
  return out;
}
