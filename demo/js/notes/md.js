/* OmniHome · Markdown 渲染 / 大纲 / 版本 diff（供知识库与分享页复用） */
export const _mdSlug = s => (String(s == null ? '' : s)
  .replace(/<[^>]*>/g, '')
  .toLowerCase()
  .replace(/[\s\u3000]+/g, '-')
  .replace(/[^\w\u4e00-\u9fa5-]/g, '')
  .replace(/-+/g, '-')
  .replace(/^-+|-+$/g, '')) || 'sec';

/* ---------- marked 配置（v12 renderer 签名：heading(text,level,raw)） ---------- */
/* 每次 parse 都新建 renderer：标题计数按「单次文档」算，避免跨多次渲染累积出 h-x-3 */
export function _mdMakeRenderer(App){
  const esc = s => App.esc(s == null ? '' : String(s));
  const marked = (typeof window !== 'undefined' && window.marked);
  const r = new marked.Renderer();
  const used = Object.create(null);
  r.heading = function(text, level, raw){
    const base = _mdSlug(raw == null ? text : raw);
    const n = used[base] || 0;
    used[base] = n + 1;
    return '<h' + level + ' id="h-' + (n ? base + '-' + n : base) + '">' + text + '</h' + level + '>\n';
  };
  r.link = function(href, title, text){
    const t = title ? ' title="' + esc(title) + '"' : '';
    const ext = /^https?:\/\//i.test(href || '') ? ' target="_blank" rel="noopener noreferrer"' : '';
    return '<a href="' + esc(href) + '"' + t + ext + '>' + text + '</a>';
  };
  r.code = function(code, lang){
    const l = String(lang || '').trim().split(/\s+/)[0];
    const cls = /^[\w+#.-]+$/.test(l) ? ' class="language-' + l + '" data-lang="' + l + '"' : '';
    return '<pre><code' + cls + '>' + esc(code) + '</code></pre>\n';
  };
  return r;
}

/* ---------- 主入口 ---------- */
export function mdRender(src, ctx){
  ctx = ctx || {};
  const md = src == null ? '' : String(src);
  if (!md.trim()) return '';
  const marked = ctx.marked || (typeof window !== 'undefined' && window.marked);
  if (marked){
    try {
      const html = marked.parse(md, {
        gfm: true, breaks: false,
        renderer: _mdMakeRenderer(ctx.App || { esc: s => String(s) }),
      });
      const DP = ctx.DOMPurify || (typeof window !== 'undefined' && window.DOMPurify);
      if (DP){
        return DP.sanitize(html, {
          ADD_ATTR: ['target', 'rel', 'align', 'checked', 'disabled', 'type', 'id', 'data-lang'],
        });
      }
      return html;
    } catch (e) { /* 落回内置渲染 */ }
  }
  return mdFallback(md, ctx.App || { esc: s => String(s) });
}

/* ============================================================
   内置兜底渲染器
   覆盖：代码块 / 标题 / 分隔线 / 引用 / 表格（含对齐）/
        列表（有序·无序·任务·嵌套） / 图片 / 行内链接 /
        参考链接 / 自动链接 / 裸链接 / 强调 / 行内代码 / 换行
   ============================================================ */
export function mdFallback(md, App){
  const esc = s => App.esc(s == null ? '' : String(s));
  const NUL = '\u0000';

  /* 1) 代码块占位：内部内容不再参与语法解析 */
  const fences = [];
  let src = String(md).replace(/```([\w+#.-]*)[ \t]*\n?([\s\S]*?)```/g, (m, lang, code) => {
    const l = /^[\w+#.-]+$/.test(lang) ? ' class="language-' + lang + '" data-lang="' + lang + '"' : '';
    fences.push('<pre><code' + l + '>' + esc(code.replace(/\n$/, '')) + '</code></pre>');
    return NUL + 'F' + (fences.length - 1) + NUL;
  });

  /* 2) 参考式链接/图片定义  [id]: url "title" */
  const refs = Object.create(null);
  src = src.replace(/^ {0,3}\[([^\]^]+)\]:\s*(\S+)(?:\s+["'(]([^"')]*)["')])?\s*$/gm,
    (m, id, url, title) => {
      refs[id.trim().toLowerCase()] = { url: esc(url), title: title ? esc(title) : '' };
      return '';
    });

  /* ---------- 行内 ---------- */
  function inline(t){
    const codes = [];
    t = t.replace(/`([^`]+)`/g, (m, c) => {
      codes.push('<code>' + esc(c) + '</code>');
      return NUL + 'C' + (codes.length - 1) + NUL;
    });
    t = esc(t);
    /* 图片：行内 / 参考 */
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
      (m, alt, url, ti) => '<img src="' + esc(url) + '" alt="' + alt + '"' + (ti ? ' title="' + ti + '"' : '') + '>');
    t = t.replace(/!\[([^\]]*)\]\[([^\]]*)\]/g, (m, alt, id) => {
      const r = refs[(id || alt).trim().toLowerCase()];
      return r ? '<img src="' + r.url + '" alt="' + alt + '"' + (r.title ? ' title="' + r.title + '"' : '') + '>' : m;
    });
    /* 行内链接 */
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
      (m, tx, url, ti) => '<a href="' + esc(url) + '"' + (ti ? ' title="' + ti + '"' : '') + '>' + tx + '</a>');
    /* 参考链接 [text][id] / [text][] */
    t = t.replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (m, tx, id) => {
      const r = refs[(id || tx).trim().toLowerCase()];
      return r ? '<a href="' + r.url + '"' + (r.title ? ' title="' + r.title + '"' : '') + '>' + tx + '</a>' : m;
    });
    /* 自动链接 <url> / <mail> */
    t = t.replace(/&lt;((?:https?|mailto):[^&\s]+|[^&\s@]+@[^&\s@]+\.[^&\s@]+)&gt;/g,
      (m, u) => '<a href="' + esc(u) + '">' + u + '</a>');
    /* 裸链接 */
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<>)\]]+)/g,
      (m, p, u) => p + '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + u + '</a>');
    /* 强调 */
    t = t.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
         .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
         .replace(/__([^_]+)__/g, '<strong>$1</strong>')
         .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
         .replace(/(^|[^_\w])_([^_\s][^_]*)_/g, '$1<em>$2</em>')
         .replace(/~~([^~]+)~~/g, '<del>$1</del>');
    /* 行尾两空格 = 硬换行 */
    t = t.replace(/ {2,}$/gm, '<br>');
    return t.replace(new RegExp(NUL + 'C(\\d+)' + NUL, 'g'), (m, n) => codes[+n]);
  }

  /* ---------- 列表（递归支持缩进嵌套） ---------- */
  const ITEM_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  function parseList(lines, i, base){
    const items = [];
    while (i < lines.length){
      const ln = lines[i];
      if (!ln.trim()){
        const nx = lines[i + 1];
        if (nx && ITEM_RE.test(nx)){ i++; continue; }   // 松散列表：空行后仍是列表项
        break;
      }
      const m = ln.match(ITEM_RE);
      if (!m) break;
      const ind = m[1].length;
      if (ind < base) break;
      if (ind > base){                                  // 更深的缩进 → 作为上一项的子列表
        const sub = parseList(lines, i, ind);
        if (items.length) items[items.length - 1].sub = sub.html;
        i = sub.i;
        continue;
      }
      const ordered = /\d/.test(m[2]);
      let text = m[3], checked = null;
      const tm = text.match(/^\[([ xX])\]\s+(.*)$/);
      if (tm){ checked = tm[1] !== ' '; text = tm[2]; }
      items.push({ text: inline(text), checked, sub: '' });
      i++;
    }
    if (!items.length) return { html: '', i };
    const ordered = /\d/.test(lines[i - 1] && (lines[i - 1].match(ITEM_RE) || [])[2] || '');
    const tag = ordered ? 'ol' : 'ul';
    let html = '<' + tag + '>';
    items.forEach(it => {
      const cb = it.checked === null ? ''
        : '<input type="checkbox" disabled' + (it.checked ? ' checked' : '') + '> ';
      html += '<li>' + cb + it.text + it.sub + '</li>';
    });
    return { html: html + '</' + tag + '>', i };
  }

  /* ---------- 块级 ---------- */
  const lines = src.split('\n');
  const out = [];
  let i = 0;
  const splitRow = r => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());

  while (i < lines.length){
    const ln = lines[i];
    const fenceM = ln.trim().match(new RegExp('^' + NUL + 'F(\\d+)' + NUL + '$'));
    if (fenceM){ out.push(fences[+fenceM[1]]); i++; continue; }
    if (!ln.trim()){ i++; continue; }

    /* 分隔线 */
    if (/^ {0,3}([-*_])\s*(?:\1\s*){2,}$/.test(ln)){ out.push('<hr>'); i++; continue; }

    /* 标题 */
    let m = ln.match(/^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m){
      const lv = m[1].length;
      out.push('<h' + lv + ' id="h-' + _mdSlug(m[2]) + '">' + inline(m[2]) + '</h' + lv + '>');
      i++; continue;
    }

    /* 引用（可嵌套，递归渲染内部） */
    if (/^ {0,3}>/.test(ln)){
      const buf = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])){
        buf.push(lines[i].replace(/^ {0,3}>\s?/, ''));
        i++;
      }
      out.push('<blockquote>' + mdFallback(buf.join('\n'), App) + '</blockquote>');
      continue;
    }

    /* 表格：本行含 |，且下一行是对齐分隔行 */
    const nxt = lines[i + 1] || '';
    if (ln.indexOf('|') >= 0 && nxt.indexOf('-') >= 0 &&
        /^ {0,3}\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(nxt)){
      const head = splitRow(ln);
      const align = splitRow(nxt).map(c =>
        /^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : /^:-+/.test(c) ? 'left' : '');
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0){
        rows.push(splitRow(lines[i]));
        i++;
      }
      const cell = (txt, al) => (al ? ' align="' + al + '"' : '');
      let th = '<tr>';
      head.forEach((c, k) => { th += '<th' + cell(c, align[k]) + '>' + inline(c) + '</th>'; });
      th += '</tr>';
      let tb = '';
      rows.forEach(r => {
        tb += '<tr>';
        head.forEach((_, k) => {
          tb += '<td' + cell('', align[k]) + '>' + inline(r[k] == null ? '' : r[k]) + '</td>';
        });
        tb += '</tr>';
      });
      out.push('<table><thead>' + th + '</thead><tbody>' + tb + '</tbody></table>');
      continue;
    }

    /* 列表 */
    if (ITEM_RE.test(ln)){
      const r = parseList(lines, i, (ln.match(ITEM_RE) || [])[1].length);
      out.push(r.html);
      i = r.i;
      continue;
    }

    /* 段落：连续非空行合并 */
    const buf = [];
    while (i < lines.length && lines[i].trim() &&
           !/^ {0,3}(#{1,6})\s/.test(lines[i]) && !/^ {0,3}>/.test(lines[i]) &&
           !ITEM_RE.test(lines[i]) &&
           lines[i].trim().indexOf(NUL + 'F') !== 0){
      buf.push(lines[i]);
      i++;
    }
    if (buf.length) out.push('<p>' + inline(buf.join('\n')).replace(/\n/g, '<br>') + '</p>');
    else i++;
  }
  return out.join('\n');
}

/* ---------- 大纲提取（供目录跳转） ---------- */
export function mdOutline(src){
  const out = [];
  const used = Object.create(null);
  const re = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const lines = String(src == null ? '' : src).split('\n');
  let inFence = false;
  lines.forEach((ln, idx) => {
    if (/^\s*```/.test(ln)){ inFence = !inFence; return; }
    if (inFence) return;
    const m = ln.match(re);
    if (m){
      const base = _mdSlug(m[2]);
      const n = used[base] || 0;
      used[base] = n + 1;
      out.push({ level: m[1].length, text: m[2], id: 'h-' + (n ? base + '-' + n : base), line: idx });
    }
  });
  return out;
}
export function outlineItemHtml(h, targetKey){
  const esc = (window.App && App.esc) ? App.esc : (s => String(s == null ? '' : s));
  return '<button class="md-outline-item lv' + h.level + '" ' + (targetKey || 'data-target') + '="' +
    esc(h.id) + '" data-line="' + h.line + '" title="跳到「' +
    esc(h.text) + '」">' + esc(h.text) + '</button>';
}
export function outlineBodyHtml(src, targetKey){
  const items = mdOutline(src);
  return items.length
    ? items.map(h => outlineItemHtml(h, targetKey)).join('')
    : '<div class="md-outline-empty">当前笔记没有标题</div>';
}

export function mdLineDiff(oldT, newT){
  const a = String(oldT || '').split('\n');
  const b = String(newT || '').split('\n');
  const n = a.length, m = b.length;
  if (!n && !m) return [];
  if (n * m > 900000){
    if (oldT === newT) return [{ type: 'eq', text: oldT }];
    return [{ type: 'del', text: oldT }, { type: 'add', text: newT }];
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 1; i <= n; i++){
    for (let j = 1; j <= m; j++){
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : (dp[i - 1][j] >= dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1]);
    }
  }
  const raw = [];
  let i = n, j = m;
  while (i > 0 && j > 0){
    if (a[i - 1] === b[j - 1]){ raw.push({ type: 'eq', text: a[i - 1] }); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]){ raw.push({ type: 'del', text: a[--i] }); }
    else raw.push({ type: 'add', text: b[--j] });
  }
  while (i > 0) raw.push({ type: 'del', text: a[--i] });
  while (j > 0) raw.push({ type: 'add', text: b[--j] });
  raw.reverse();
  const out = [];
  for (let k = 0; k < raw.length; k++){
    if (raw[k].type === 'del' && raw[k + 1] && raw[k + 1].type === 'add'){
      out.push({ type: 'mod', old: raw[k].text, text: raw[k + 1].text });
      k++;
    } else out.push(raw[k]);
  }
  return out;
}
export function renderRevDiffHtml(oldT, newT){
  const esc = (typeof window !== 'undefined' && window.App && App.esc)
    ? App.esc : (s => String(s == null ? '' : s));
  const rows = mdLineDiff(oldT, newT);
  if (!rows.length) return '<div class="kb-empty">两份内容均为空</div>';
  const kindLabel = { add: '新增', del: '删除', mod: '修改' };
  const kindChip = { add: 'success', del: 'danger', mod: 'info' };
  const parts = [];
  let eqRun = [];
  const flushEq = () => {
    if (!eqRun.length) return;
    const n = eqRun.length;
    const show = (s) => '<div class="rev-line eq">' + esc(s) + '</div>';
    if (n <= 6) eqRun.forEach(s => parts.push(show(s)));
    else {
      parts.push(show(eqRun[0]), show(eqRun[1]));
      parts.push('<div class="rev-skip">··· 省略 ' + (n - 4) + ' 行未改 ···</div>');
      parts.push(show(eqRun[n - 2]), show(eqRun[n - 1]));
    }
    eqRun = [];
  };
  rows.forEach(r => {
    if (r.type === 'eq'){ eqRun.push(r.text); return; }
    flushEq();
    const chip = '<span class="chip ' + (kindChip[r.type] || '') + ' no-dot">' + (kindLabel[r.type] || r.type) + '</span>';
    if (r.type === 'mod'){
      parts.push('<div class="rev-hunk">' + chip
        + '<div class="rev-line del">' + esc(r.old) + '</div>'
        + '<div class="rev-line add">' + esc(r.text) + '</div></div>');
    } else {
      parts.push('<div class="rev-hunk">' + chip
        + '<div class="rev-line ' + r.type + '">' + esc(r.text) + '</div></div>');
    }
  });
  flushEq();
  const changed = rows.some(r => r.type !== 'eq');
  if (!changed) return '<div class="kb-empty">该版本与当前内容相同</div>' + parts.join('');
  return parts.join('');
}
