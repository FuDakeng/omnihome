/* ============================================================
   OmniHome · LiveMD 原地实时渲染 Markdown 编辑器
   ------------------------------------------------------------
   输入 `- 123` 立即原地渲染为列表项。光标所在行改为
   显示原始 Markdown 标记（`- 列表`、`**加粗**`），光标离开后恢复渲染。
   选中文本后直接输入 * / _ / ~ / ` 会按层包裹修饰。输入 [[ 弹出笔记
   模糊搜索并补全双链；从目录拖入笔记也会插入 [[标题]]。
   ```mermaid 围栏会渲染为流程图 / 时序图 / 甘特图等。光标在块内时显示
   源码便于修改，离开后显示图表；工具条可锁定「代码 / 图表」视图。
   切换只改展示，不改 Markdown 原文，也不挪动已记住的编辑位置。
   隐藏的原 textarea 仍是数据源，本组件每次变更回写并派发
   'input' 事件，原有自动保存/统计/待办解析逻辑无需改动。

   LiveMD.attach(textarea, opts) -> inst
     inst.refresh()    从 textarea.value 重建（打开笔记/外部改写后）
     inst.setValue(s)  外部写入并重建
     inst.show()/hide() 编辑模式与其它模式切换
     inst.focus() / inst.destroy()
   ============================================================ */
import { isMermaidLang, scheduleMermaid, mermaidThemeName } from './mermaid.js';

export const LiveMD = (() => {
  const E = s => { const d = document.createElement('div'); d.innerHTML = s; return d.firstChild; };
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = s => esc(s).replace(/"/g, '&quot;');

  /* ---------- 块级语法标记 ---------- */
  function parseMarker(line){
    let m;
    if ((m = line.match(/^ {0,3}(-{3,}|\*{3,}|_{3,}) *$/))) return { raw: m[0], type: 'hr' };
    /* 任务：行首可缩进；- / * / +；「-」和「[」之间的空格可省（-[ ]） */
    if ((m = line.match(/^([ \t]*)([-*+])[ \t]?\[([ xX])\]/))) {
      let raw = m[0];
      if (line[raw.length] === ' ' || line[raw.length] === '\t') raw += line[raw.length];
      return { raw, type: 'todo', checked: m[3] !== ' ', indent: m[1] };
    }
    if ((m = line.match(/^[-*+] /)))         return { raw: m[0], type: 'li' };
    if ((m = line.match(/^#{1,6} /)))        return { raw: m[0], type: 'h', level: m[0].length - 1 };
    if ((m = line.match(/^> /)))             return { raw: m[0], type: 'quote' };
    if ((m = line.match(/^(\d+)\. /)))       return { raw: m[0], type: 'oli', num: +m[1] };
    return null;
  }
  const contPrefix = mk =>
    mk ? (mk.type === 'todo' ? (mk.indent || '') + '- [ ] ' : mk.type === 'li' ? '- '
        : mk.type === 'oli' ? (mk.num + 1) + '. ' : mk.type === 'quote' ? '> ' : '') : '';

  /* ---------- 行内语法渲染（行内代码内不再解析） ---------- */
  function inlineHtml(s){
    let out = '', i = 0;
    while (i < s.length){
      const ch = s[i];
      if (ch === '!'){
        const m = s.slice(i).match(/^!\[([^\]]*)\]\(([^)]*)\)/);
        if (m){
          /* 图片：data-pre 存完整语法（含地址），序列化时无损还原 */
          out += `<img class="lm-img" src="${m[2] ? escAttr(m[2]) : 'data:,'}" alt="${escAttr(m[1])}" data-pre="![${escAttr(m[1])}](${escAttr(m[2])})" contenteditable="false" draggable="false">`;
          i += m[0].length; continue;
        }
      } else if (ch === '`'){
        const m = s.slice(i).match(/^`([^`]+)`/);
        if (m){ out += '<code class="lm-c" data-pre="`" data-post="`">' + esc(m[1]) + '</code>'; i += m[0].length; continue; }
      } else if (ch === '*'){
        const two = s.slice(i).match(/^\*\*(.+?)\*\*/);
        const one = !two && s.slice(i).match(/^\*([^*\s][^*]*)\*/);
        const m = two || one, tag = two ? 'b' : 'i', mk = two ? '**' : '*';
        if (m){ out += `<${tag} data-pre="${mk}" data-post="${mk}">${inlineHtml(m[1])}</${tag}>`; i += m[0].length; continue; }
      } else if (ch === '_' && (i === 0 || !/[A-Za-z0-9]/.test(s[i - 1]))){
        const two = s.slice(i).match(/^__(.+?)__/);
        const one = !two && s.slice(i).match(/^_([^_\s][^_]*?)_(?![A-Za-z0-9])/);
        const m = two || one, tag = two ? 'b' : 'i', mk = two ? '__' : '_';
        if (m){ out += `<${tag} data-pre="${mk}" data-post="${mk}">${inlineHtml(m[1])}</${tag}>`; i += m[0].length; continue; }
      } else if (ch === '~'){
        const m = s.slice(i).match(/^~~(.+?)~~/);
        if (m){ out += `<s data-pre="~~" data-post="~~">${inlineHtml(m[1])}</s>`; i += m[0].length; continue; }
      } else if (ch === '['){
        /* Obsidian 式笔记引用 [[标题]] / [[标题|别名]]：整段 data-raw 无损还原 */
        if (s[i + 1] === '['){
          const wiki = s.slice(i).match(/^\[\[([^\[\]\n]+?)\]\]/);
          if (wiki){
            const body = wiki[1];
            const pipe = body.indexOf('|');
            const target = (pipe >= 0 ? body.slice(0, pipe) : body).trim();
            const alias = (pipe >= 0 ? body.slice(pipe + 1) : target).trim() || target;
            if (target){
              out += `<a class="lm-wiki" href="#" data-raw="${escAttr(wiki[0])}" data-wiki="${escAttr(target)}" contenteditable="false">${esc(alias)}</a>`;
              i += wiki[0].length; continue;
            }
          }
        }
        /* 行内链接 [text](url)（文本可编辑，序列化经 data-pre/post 无损还原） */
        const m = s.slice(i).match(/^\[([^\]]+)\]\(([^)\s]+)(\s+["'][^"']*["'])?\)/);
        if (m){
          /* 前缀/后缀分开存，行内改文字或光标行展开原文时都能无损还原 */
          const post = '](' + m[2] + (m[3] || '') + ')';
          out += `<a class="lm-a" href="${escAttr(m[2])}" target="_blank" rel="noopener noreferrer" data-pre="[" data-post="${escAttr(post)}">${esc(m[1])}</a>`;
          i += m[0].length; continue;
        }
      } else if (ch === '<'){
        /* 自动链接 <url> / <mail@x> */
        const m = s.slice(i).match(/^<(https?:\/\/[^>\s]+|mailto:[^>\s]+|[^>\s@]+@[^>\s@]+\.[^>\s@]+)>/);
        if (m){
          out += `<a class="lm-a" href="${escAttr(m[1])}" target="_blank" rel="noopener noreferrer" data-pre="<" data-post=">">${esc(m[1])}</a>`;
          i += m[0].length; continue;
        }
      }
      out += esc(ch); i++;
    }
    return out;
  }

  /* ---------- 表格块实时序列化：单元格可直接编辑，读 DOM 现行内容拼回 Markdown ---------- */
  const TBL_ALIGN_OF = c => /^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : /^:-+/.test(c) ? 'left' : '';
  function cellTextOf(cell){
    return Array.from(cell.childNodes).map(rawOfNode).join('');
  }
  function tableLiveRaw(tbl){
    try {
      const orig = (tbl.dataset.tableRaw || '').split('\n');
      const align = orig.length > 1
        ? orig[1].replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => TBL_ALIGN_OF(c.trim()))
        : [];
      const escCell = c => String(c == null ? '' : c).replace(/\|/g, '\\|').trim();
      const mk = cells => '| ' + cells.map(escCell).join(' | ') + ' |';
      const n = tbl.querySelectorAll('thead th').length || (tbl.querySelector('tbody tr') || { children: [] }).children.length;
      const sep = '| ' + Array.from({ length: n }, (_, k) => {
        const a = align[k] || '';
        return a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---';
      }).join(' | ') + ' |';
      const head = Array.from(tbl.querySelectorAll('thead th')).map(cellTextOf);
      const rows = Array.from(tbl.querySelectorAll('tbody tr')).map(tr =>
        Array.from(tr.children).filter(c => c.tagName === 'TD').map(cellTextOf));
      return [mk(head), sep].concat(rows.map(mk)).join('\n');
    } catch (e) {
      return tbl.dataset.tableRaw || '';
    }
  }

  /* ---------- 序列化：DOM -> 原始 Markdown ---------- */
  function rawOfNode(n){
    if (n.nodeType === 3) return n.data;
    if (n.tagName === 'BR') return '';
    if (n.dataset && n.dataset.tableRaw !== undefined) return tableLiveRaw(n);   // 表格：读现行单元格内容
    const inner = Array.from(n.childNodes).map(rawOfNode).join('');
    if (n.dataset && n.dataset.raw !== undefined) return n.dataset.raw;
    if (n.dataset && n.dataset.pre !== undefined) return n.dataset.pre + inner + (n.dataset.post || '');
    return inner;
  }
  const lineRaw = el => el.dataset && el.dataset.tableRaw !== undefined
    ? tableLiveRaw(el)
    : Array.from(el.childNodes).map(rawOfNode).join('');
  const fragRaw = f => Array.from(f.childNodes).map(rawOfNode).join('');
  /* 走到 (container, offset) 为止的原始长度。半截行内标记只计已越过的 data-pre，
     未走到元素结尾时不计 data-post，避免选区把闭合 ** 算进起点。 */
  function rawUntil(scope, container, offset){
    let count = 0;
    const walk = node => {
      if (node === container){
        if (node.nodeType === 3){ count += Math.min(offset, node.data.length); return true; }
        const kids = node.childNodes;
        const n = Math.min(offset, kids.length);
        for (let i = 0; i < n; i++) count += rawOfNode(kids[i]).length;
        return true;
      }
      if (node.nodeType === 3){ count += node.data.length; return false; }
      if (!node.tagName || node.tagName === 'BR') return false;
      if (node.dataset && node.dataset.raw !== undefined){
        count += node.dataset.raw.length;
        return false;
      }
      const hasPre = !!(node.dataset && node.dataset.pre !== undefined);
      if (hasPre) count += node.dataset.pre.length;
      for (const ch of node.childNodes){ if (walk(ch)) return true; }
      if (hasPre) count += (node.dataset.post || '').length;
      return false;
    };
    walk(scope);
    return count;
  }

  /* ---------- 代码块语法高亮（纯视觉：对已转义文本包 token span，不影响序列化回写） ---------- */
  /* 分组：注释 → 字符串 → 数字 → 关键字；`.` 不匹配换行，天然按行止住 */
  const HL_RE = /(\/\/.*|\/\*[\s\S]*?\*\/|#.*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)|\b(\d+(?:\.\d+)?)\b|\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|import|export|from|default|try|catch|finally|throw|async|await|yield|typeof|instanceof|in|of|delete|void|null|undefined|true|false|this|def|lambda|pass|raise|with|as|elif|None|True|False|and|or|not|is|public|private|static|final|int|long|float|double|boolean|char|struct|interface|package|fn|match|impl|mut|use)\b/g;
  function highlightCode(s){
    return s.replace(HL_RE, (m, com, str, num) =>
      com ? `<span class="hl-com">${com}</span>`
      : str ? `<span class="hl-str">${str}</span>`
      : num ? `<span class="hl-num">${num}</span>`
      : `<span class="hl-kw">${m}</span>`);
  }

  function codeToolsHtml(lang){
    const view = isMermaidLang(lang)
      ? '<button type="button" class="lm-code-btn lm-view-btn" data-lm-code-act="view" title="切换为图表" aria-pressed="false">图表</button>'
      : '';
    return '<span class="lm-code-tools" data-raw="" contenteditable="false">'
      + view
      + '<button type="button" class="lm-code-btn" data-lm-code-act="copy" title="复制">'
      + '<svg class="ic"><use href="#i-copy"/></svg></button>'
      + '<button type="button" class="lm-code-btn" data-lm-code-act="fold" title="折叠">'
      + '<svg class="ic"><use href="#i-chev-d"/></svg></button></span>';
  }

  function copyText(s){
    const t = String(s == null ? '' : s);
    if (navigator.clipboard && navigator.clipboard.writeText)
      return navigator.clipboard.writeText(t).catch(() => copyTextFallback(t));
    return Promise.resolve(copyTextFallback(t));
  }
  function copyTextFallback(t){
    const el = document.createElement('textarea');
    el.value = t; el.setAttribute('readonly', '');
    el.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(el); el.select();
    try { document.execCommand('copy'); } catch (_) {}
    el.remove();
  }

  /* ---------- 阶梯全选：行 → 文本块/代码块 → 全文 ---------- */
  function lineBounds(text, pos){
    const start = text.lastIndexOf('\n', pos - 1) + 1;
    let end = text.indexOf('\n', pos);
    if (end < 0) end = text.length;
    return { start, end };
  }
  function lineIndexAt(arr, pos){
    let p = 0;
    for (let i = 0; i < arr.length; i++){
      const end = p + arr[i].length;
      if (pos <= end) return i;
      p = end + 1;
    }
    return Math.max(0, arr.length - 1);
  }
  function lineAbs(arr, i){
    let p = 0;
    for (let k = 0; k < i; k++) p += arr[k].length + 1;
    return p;
  }
  function isFenceLine(l){ return /^(```|~~~)/.test(String(l || '').trim()); }
  function isPipeRow(l){ return l.includes('|') && /^\s*\|.*\|\s*$/.test(String(l || '').trim()); }
  function fenceBounds(text, pos){
    const arr = text.split('\n');
    const li = lineIndexAt(arr, pos);
    let open = -1;
    for (let i = 0; i < arr.length; i++){
      if (!isFenceLine(arr[i])) continue;
      if (open < 0){ open = i; continue; }
      if (li >= open && li <= i)
        return { start: lineAbs(arr, open), end: lineAbs(arr, i) + arr[i].length };
      open = -1;
    }
    if (open >= 0 && li >= open)
      return { start: lineAbs(arr, open), end: text.length };
    return null;
  }
  function tableBounds(text, pos){
    const arr = text.split('\n');
    const li = lineIndexAt(arr, pos);
    if (!isPipeRow(arr[li])) return null;
    let a = li, b = li;
    while (a > 0 && isPipeRow(arr[a - 1])) a--;
    while (b + 1 < arr.length && isPipeRow(arr[b + 1])) b++;
    if (b === a) return null;
    return { start: lineAbs(arr, a), end: lineAbs(arr, b) + arr[b].length };
  }
  function isListish(l){
    const mk = parseMarker(String(l || ''));
    return !!(mk && (mk.type === 'li' || mk.type === 'oli' || mk.type === 'todo' || mk.type === 'quote'));
  }
  function listBounds(text, pos){
    const arr = text.split('\n');
    const li = lineIndexAt(arr, pos);
    if (!isListish(arr[li])) return null;
    let a = li, b = li;
    while (a > 0 && isListish(arr[a - 1])) a--;
    while (b + 1 < arr.length && isListish(arr[b + 1])) b++;
    if (b === a) return null;
    return { start: lineAbs(arr, a), end: lineAbs(arr, b) + arr[b].length };
  }
  function paraBounds(text, pos){
    const arr = text.split('\n');
    const li = lineIndexAt(arr, pos);
    if (!String(arr[li] || '').trim()) return lineBounds(text, pos);
    const mk = parseMarker(arr[li]);
    if (mk && (mk.type === 'h' || mk.type === 'hr')) return lineBounds(text, pos);
    let a = li, b = li;
    const isBreak = l => {
      const s = String(l || '');
      if (!s.trim()) return true;
      if (isFenceLine(s) || isPipeRow(s) || isListish(s)) return true;
      const m = parseMarker(s);
      if (m && (m.type === 'h' || m.type === 'hr')) return true;
      return false;
    };
    while (a > 0 && !isBreak(arr[a - 1])) a--;
    while (b + 1 < arr.length && !isBreak(arr[b + 1])) b++;
    return { start: lineAbs(arr, a), end: lineAbs(arr, b) + arr[b].length };
  }
  /* 实时渲染下列表标记（- / 1. / 复选框）不在可见选区内，只允许跳过行首语法标记 */
  function prefixSlack(text, start){
    const nl = text.indexOf('\n', start);
    const line = text.slice(start, nl < 0 ? text.length : nl);
    const mk = parseMarker(line);
    return mk ? mk.raw.length : 0;
  }
  function coversRange(cur, target, text){
    if (!cur || !target) return false;
    if (cur.start === target.start && cur.end === target.end) return true;
    if (!(cur.end > cur.start) || !(target.end > target.start)) return false;
    if (cur.start < target.start || cur.end > target.end + 1) return false;
    const slack = prefixSlack(text, target.start);
    const startOk = cur.start - target.start <= slack;
    const endOk = target.end - cur.end <= slack || cur.end === target.end + 1;
    return startOk && endOk;
  }
  function nextExpandRange(text, selStart, selEnd){
    text = String(text == null ? '' : text);
    const len = text.length;
    let a = Math.max(0, Math.min(len, selStart == null ? 0 : selStart));
    let b = Math.max(0, Math.min(len, selEnd == null ? a : selEnd));
    if (a > b){ const t = a; a = b; b = t; }
    const all = { start: 0, end: len };
    const line = lineBounds(text, a);
    const block = fenceBounds(text, a) || tableBounds(text, a) || listBounds(text, a)
      || paraBounds(text, a) || line;
    const cur = { start: a, end: b };
    if (coversRange(cur, all, text)) return all;
    if (coversRange(cur, block, text) && !coversRange(block, all, text)) return all;
    if (coversRange(cur, line, text) && !coversRange(line, block, text)) return block;
    if (coversRange(cur, line, text) && coversRange(line, block, text) && !coversRange(block, all, text)) return all;
    return line;
  }

  function attach(ta, opts = {}){
    const root = E('<div class="livemd" contenteditable="true" spellcheck="false"></div>');
    ta.parentNode.insertBefore(root, ta.nextSibling);
    ta.style.setProperty('display', 'none', 'important');
    let composing = false, alive = true;
    let activeSrc = null, srcLock = false, pointerDown = false, wikiHold = false, wikiPress = null;
    root.dataset.placeholder = ta.getAttribute('placeholder') || '';

    const lines = () => Array.from(root.children);
    const serializeAll = () => lines().map(lineRaw).join('\n');
    const commitNoRebuild = () => {
      ta.value = serializeAll();
      try { ta.dispatchEvent(new Event('input')); } catch (e) {}
      updatePh();
    };

    /* ---------- 括号配对高亮：输入光标移到括号旁时同时点亮另一半 ---------- */
    const BR_OPEN = '([{',
          BR_PAIR = { '(': ')', '[': ']', '{': '}', ')': '(', ']': '[', '}': '{' };
    let brNodes = [], lastBrKey = '';
    function clearBr(){
      brNodes.forEach(s => {
        const p = s.parentNode;
        if (!p) return;
        s.replaceWith(document.createTextNode(s.textContent));
        p.normalize();
      });
      brNodes = []; lastBrKey = '';
    }
    function wrapChar(node, offset){
      try {
        const r = document.createRange();
        r.setStart(node, offset); r.setEnd(node, offset + 1);
        const s = document.createElement('span');
        s.className = 'lm-br';
        r.surroundContents(s);
        brNodes.push(s);
      } catch (e) {}
    }
    function findBrMatch(text, i){
      const ch = text[i], target = BR_PAIR[ch];
      const dir = BR_OPEN.includes(ch) ? 1 : -1;
      let depth = 0;
      for (let j = i + dir; j >= 0 && j < text.length; j += dir){
        if (text[j] === ch) depth++;
        else if (text[j] === target){ if (!depth) return j; depth--; }
      }
      return -1;
    }
    /* 按原始文本偏移在行内定位 DOM 落点（data-raw 标记按源码长度计，不按可见字形） */
    function pointAtRaw(line, off){
      if (line.dataset && line.dataset.tableRaw !== undefined) return null;   // 表格块不可编辑
      const walk = arr => {
        for (const n of arr){
          if (n.nodeType === 3){
            if (off <= n.data.length) return { node: n, offset: off };
            off -= n.data.length; continue;
          }
          if (n.tagName === 'BR') continue;
          if (n.dataset && n.dataset.raw !== undefined){
            const len = n.dataset.raw.length;
            if (off < len){
              const parent = n.parentNode;
              return { node: parent, offset: Array.from(parent.childNodes).indexOf(n) };
            }
            off -= len; continue;
          }
          if (n.dataset && n.dataset.pre !== undefined){
            const pre = n.dataset.pre, post = n.dataset.post || '';
            if (off < pre.length){
              const parent = n.parentNode;
              return { node: parent, offset: Array.from(parent.childNodes).indexOf(n) };
            }
            off -= pre.length;
            const innerLen = Array.from(n.childNodes).map(rawOfNode).join('').length;
            if (off <= innerLen){
              const r = walk(Array.from(n.childNodes));
              if (r) return r;
              return { node: n, offset: n.childNodes.length };
            }
            off -= innerLen;
            if (off <= post.length){
              const parent = n.parentNode;
              return { node: parent, offset: Array.from(parent.childNodes).indexOf(n) + 1 };
            }
            off -= post.length; continue;
          }
          const r = walk(Array.from(n.childNodes));
          if (r) return r;
        }
        return null;
      };
      return walk(Array.from(line.childNodes)) || { node: line, offset: line.childNodes.length };
    }
    /* 全文原始偏移 → DOM 落点 */
    function domPointAt(gi){
      const ls = lines();
      let pos = 0;
      for (const ln of ls){
        const len = lineRaw(ln).length;
        if (gi <= pos + len) return pointAtRaw(ln, gi - pos);
        pos += len + 1;
      }
      return null;
    }

    /* ---------- 表格块：解析 / 渲染 / 原地修改 ---------- */
    function isTableRow(l){ return l.includes('|') && /^\s*\|.*\|\s*$/.test(l.trim()); }
    function isTableSep(l){
      if (!l.includes('-') || !l.includes('|')) return false;
      /* 去首尾 | 后，剩余字符只能由 [\s:| -] 组成，且至少含一个 '-'（即存在分隔段） */
      const core = l.trim().replace(/^\|/, '').replace(/\|$/, '');
      if (!/^[\s:| -]+$/.test(core)) return false;
      return /-/.test(core.replace(/[\s|:]/g, ''));
    }
    const splitRow = r => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
    function renderTable(rows, srcI){
      const cells = rows.map(splitRow);
      const head = cells[0] || [];
      const align = (cells[1] || []).map(c =>
        /^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : /^:-+/.test(c) ? 'left' : '');
      const body = cells.slice(2);
      const al = a => a ? ' align="' + a + '"' : '';
      /* 单元格可直接编辑；行/列拖拽手柄悬浮在边缘显示；工具条默认隐藏，选中行/列时才出现 */
      let h = '<thead><tr>';
      head.forEach((c, k) => {
        h += '<th' + al(align[k]) + ' contenteditable="true" data-ci="' + k + '">'
          + '<span class="lm-colh" draggable="true" title="拖拽调整列顺序"></span>'
          + (inlineHtml(c) || ' ') + '</th>';
      });
      h += '</tr></thead>';
      let b = '<tbody>';
      body.forEach((r, ri) => {
        b += '<tr data-ri="' + ri + '">';
        head.forEach((_, k) => {
          b += '<td' + al(align[k]) + ' contenteditable="true">'
            + (k === 0 ? '<span class="lm-rowh" draggable="true" title="拖拽调整行顺序"></span>' : '')
            + (inlineHtml(r[k] || '') || ' ') + '</td>';
        });
        b += '</tr>';
      });
      b += '</tbody>';
      const raw = escAttr(rows.join('\n'));
      return '<div class="lm-table" data-src-i="' + srcI + '" data-table-raw="' + raw + '">'
        + '<div class="lm-tbar" hidden>'
        + '<span class="lm-tname">表格</span>'
        + '<span class="lm-tsel-hint" data-t-hint></span>'
        + '<button type="button" data-t-act="insbefore" hidden></button>'
        + '<button type="button" data-t-act="insafter" hidden></button>'
        + '<button type="button" data-t-act="del" class="lm-tdanger" hidden></button>'
        + '</div><table>' + h + b + '</table></div>';
    }
    /* 修改表格：fn(cells) 就地改（cells[0] 表头、cells[1] 对齐行、其余数据行），改完重建。
       数据源必须读现行 DOM（单元格可能已编辑，data-table-raw 只是初始快照） */
    function tableMutate(tblEl, fn){
      const raw = tableLiveRaw(tblEl);
      const cells = raw.split('\n').map(splitRow);
      fn(cells);
      if (cells.length < 3) return;                       // 至少保留表头+分隔+1 数据行；列数 ≤1 由调用方拦在 fn 内
      const next = cells.map(row => '| ' + row.map(c => String(c == null ? '' : c)).join(' | ') + ' |').join('\n');
      let start = 0;
      for (const ln of lines()){
        if (ln === tblEl) break;
        start += lineRaw(ln).length + 1;
      }
      const full = serializeAll();
      const nfull = full.slice(0, start) + next + full.slice(start + raw.length);
      ta.value = nfull;
      try { ta.dispatchEvent(new Event('input')); } catch (e) {}
      rebuild(nfull);
    }

    /* ---------- 表格交互辅助：定位 / 焦点 / 行列选中 ---------- */
    function tableIndexOf(tblEl){
      let k = 0;
      for (const ln of lines()){
        if (ln === tblEl) return k;
        if (ln.classList && ln.classList.contains('lm-table')) k++;
      }
      return -1;
    }
    const nthTable = k => root.querySelectorAll('.lm-table')[k] || null;
    function cellPos(tbl, cell){
      const tr = cell.closest('tr');
      return {
        tr,
        head: cell.tagName === 'TH',
        ri: Array.from(tbl.querySelectorAll('tbody tr')).indexOf(tr),
        ci: Array.from(tr.children).filter(c => c.tagName === 'TD' || c.tagName === 'TH').indexOf(cell),
        rows: tbl.querySelectorAll('tbody tr').length,
      };
    }
    function focusCell(cell){
      if (!cell) return;
      cell.focus();
      try {
        const r = document.createRange();
        r.selectNodeContents(cell); r.collapse(false);
        const s = window.getSelection();
        s.removeAllRanges(); s.addRange(r);
      } catch (_) {}
    }
    function focusCellAt(tbl, ri, ci){
      const tr = tbl.querySelectorAll('tbody tr')[ri];
      if (!tr) return;
      const cs = Array.from(tr.children).filter(c => c.tagName === 'TD');
      if (cs.length) focusCell(cs[Math.min(Math.max(ci, 0), cs.length - 1)]);
    }
    function clearTableSel(){
      root.querySelectorAll('.lm-tsel').forEach(n => n.classList.remove('lm-tsel'));
      root.querySelectorAll('.lm-table').forEach(t => {
        delete t.dataset.tselKind; delete t.dataset.tselIdx;
        const bar = t.querySelector('.lm-tbar');
        if (bar) bar.hidden = true;
      });
    }
    /* 点单元格选中所在行；点表头选中所在列；同步更新浮动工具条按钮 */
    function selectCell(cell){
      const tbl = cell.closest('.lm-table');
      if (!tbl) return;
      clearTableSel();
      const bar = tbl.querySelector('.lm-tbar');
      if (!bar) return;
      const btn = a => bar.querySelector('[data-t-act="' + a + '"]');
      const hint = bar.querySelector('[data-t-hint]');
      const show = (b, txt) => { if (b){ b.hidden = false; b.textContent = txt; } };
      if (cell.tagName === 'TH'){
        const { ci } = cellPos(tbl, cell);
        cell.classList.add('lm-tsel');
        tbl.dataset.tselKind = 'col'; tbl.dataset.tselIdx = ci;
        if (hint) hint.textContent = '已选中第 ' + (ci + 1) + ' 列';
        show(btn('insbefore'), '左插列');
        show(btn('insafter'), '右插列');
        show(btn('del'), '删列');
      } else {
        const { tr, ri } = cellPos(tbl, cell);
        if (tr) tr.classList.add('lm-tsel');
        tbl.dataset.tselKind = 'row'; tbl.dataset.tselIdx = ri;
        if (hint) hint.textContent = '已选中第 ' + (ri + 1) + ' 行';
        show(btn('insbefore'), '上插行');
        show(btn('insafter'), '下插行');
        show(btn('del'), '删行');
      }
      bar.hidden = false;
    }
    /* Enter 下移 / Shift+Enter 上移 / Tab 右移 / Shift+Tab 左移；末行回车自动追加新行 */
    function tableCellNav(cell, dir, shift){
      const tbl = cell.closest('.lm-table');
      if (!tbl) return;
      const { tr, head, ri, ci, rows } = cellPos(tbl, cell);
      if (dir === 'right'){
        const siblings = Array.from(tr.children).filter(c => c.tagName === 'TD' || c.tagName === 'TH');
        const next = siblings[siblings.indexOf(cell) + (shift ? -1 : 1)];
        if (next){ focusCell(next); return; }
        const trs = Array.from(tbl.querySelectorAll('tr'));
        const ti = trs.indexOf(tr) + (shift ? -1 : 1);
        if (ti >= 0 && ti < trs.length){
          const cs = Array.from(trs[ti].children).filter(c => c.tagName === 'TD' || c.tagName === 'TH');
          focusCell(shift ? cs[cs.length - 1] : cs[0]);
          return;
        }
        if (!shift) caretAfterTable(tbl);   // Tab 到表格最后一格再按 → 跳出表格继续写正文（光标不再困在表内）
        return;
      }
      let nri = ri + (shift ? -1 : 1);
      if (head){ focusCellAt(tbl, Math.max(0, nri), ci); return; }
      if (!shift && nri >= rows){
        /* 末行回车：追加新行后跳到新行同列 */
        const tk = tableIndexOf(tbl);
        tableMutate(tbl, cells => cells.push(cells[0].map(() => '')));
        const nt = nthTable(tk);
        if (nt) focusCellAt(nt, nt.querySelectorAll('tbody tr').length - 1, ci);
        return;
      }
      focusCellAt(tbl, nri, ci);
    }
    /* 把光标落到表格之后：表格是文档最后一行时自动补空行，避免光标无处可点 */
    function caretAfterTable(tbl){
      const arr = serializeAll().split('\n');
      const idx = lines().indexOf(tbl);
      if (idx < 0) return;
      if (idx >= arr.length - 1) arr.push('');   // 表格在文末：补一个空行供光标落脚
      const nraw = arr.join('\n');
      ta.value = nraw;
      try { ta.dispatchEvent(new Event('input')); } catch (e) {}
      rebuild(nraw);
      let off = 0;
      for (let i = 0; i <= idx; i++) off += arr[i].length + 1;
      restoreCaret(off);                           // 表格末行的换行之后 = 下一行开头
    }
    /* 表格内光标 → 距表格开头的 raw 偏移（工具栏包裹/选区计算用） */
    function rawOffsetInTable(tbl, container, offset){
      const rawFull = tableLiveRaw(tbl);
      try {
        let cell = null;
        if (container.nodeType === 3) cell = container.parentElement ? container.parentElement.closest('td, th') : null;
        else if (container.closest) cell = container.closest('td, th');
        if (!cell || !tbl.contains(cell)) return rawFull.length;
        const tr = cell.closest('tr');
        const ci = Array.from(tr.children).filter(c => c.tagName === 'TD' || c.tagName === 'TH').indexOf(cell);
        const inCell = rawUntil(cell, container, offset);
        const rawRows = rawFull.split('\n');
        const rowIdx = tr.parentNode.tagName === 'THEAD' ? 0
          : 2 + Array.from(tbl.querySelectorAll('tbody tr')).indexOf(tr);
        const cellsOfRow = splitRow(rawRows[rowIdx] || '');
        let acc = 0;
        for (let i = 0; i < rowIdx; i++) acc += (rawRows[i] || '').length + 1;
        acc += 2;                              // 行首 "| "
        for (let k = 0; k < ci; k++) acc += String(cellsOfRow[k] == null ? '' : cellsOfRow[k]).length + 3;   // 单元格间 " | "
        return Math.min(acc + inCell.length, rawFull.length);
      } catch (_) {
        return rawFull.length;
      }
    }

    let foldedOrds = new Set();
    function snapCodeFolds(){
      foldedOrds = new Set();
      let i = 0;
      root.querySelectorAll('.lm-fence-open').forEach(el => {
        if (el.classList.contains('is-folded')) foldedOrds.add(i);
        i++;
      });
    }
    function setCodeFold(openEl, on){
      if (!openEl) return;
      openEl.classList.toggle('is-folded', on);
      const foldBtn = openEl.querySelector('[data-lm-code-act="fold"]');
      if (foldBtn) foldBtn.title = on ? '展开' : '折叠';
      let n = openEl.nextElementSibling;
      while (n && n.classList.contains('lm-code')){
        n.classList.toggle('is-folded', on);
        n = n.nextElementSibling;
      }
      if (n && n.classList.contains('lm-fence-close')) n.classList.toggle('is-folded', on);
      const panel = openEl.querySelector(':scope > .lm-mermaid');
      if (panel) panel.classList.toggle('is-folded', on);
    }
    function applyCodeFolds(){
      let i = 0;
      root.querySelectorAll('.lm-fence-open').forEach(el => {
        if (foldedOrds.has(i)) setCodeFold(el, true);
        i++;
      });
    }
    function codeBodyOf(openEl){
      const parts = [];
      let n = openEl.nextElementSibling;
      while (n && n.classList.contains('lm-code')){
        parts.push(lineRaw(n));
        n = n.nextElementSibling;
      }
      return parts.join('\n');
    }

    /* ---------- Mermaid：代码视图 / 图表视图。锁定状态按块序号记住，重建后还原 ---------- */
    const mermaidMode = new Map();
    const mermaidCaret = new Map();
    function listMermaidBlocks(){
      const out = [];
      root.querySelectorAll('.lm-fence-open').forEach(el => {
        if (!isMermaidLang(el.dataset.lang || '')) return;
        let n = el.nextElementSibling, closed = false;
        while (n){
          if (n.classList.contains('lm-fence-open')) break;
          if (n.classList.contains('lm-fence-close')){ closed = true; break; }
          n = n.nextElementSibling;
        }
        if (closed) out.push(el);
      });
      return out;
    }
    function blockOffsets(openEl){
      let start = 0;
      for (const ln of lines()){
        if (ln === openEl) break;
        start += lineRaw(ln).length + 1;
      }
      const openLen = lineRaw(openEl).length;
      let end = start + openLen;
      let bodyStart = end;
      let n = openEl.nextElementSibling;
      if (n && (n.classList.contains('lm-code') || n.classList.contains('lm-fence-close')))
        bodyStart = end + 1;
      while (n && (n.classList.contains('lm-code') || n.classList.contains('lm-fence-close'))){
        end += 1 + lineRaw(n).length;
        if (n.classList.contains('lm-fence-close')) break;
        n = n.nextElementSibling;
      }
      return { start, end, bodyStart, openEnd: start + openLen };
    }
    function mermaidViewFor(el, ord, caretOff){
      const locked = mermaidMode.get(ord);
      if (locked === 'code' || locked === 'chart') return locked;
      if (caretOff == null) return 'chart';
      const r = blockOffsets(el);
      return caretOff >= r.start && caretOff <= r.end ? 'code' : 'chart';
    }
    function nudgeMermaidCaret(off){
      if (off == null) return off;
      const blocks = listMermaidBlocks();
      const len = serializeAll().length;
      for (let i = 0; i < blocks.length; i++){
        const el = blocks[i];
        const r = blockOffsets(el);
        if (off < r.start || off > r.end) continue;
        if (mermaidViewFor(el, i, off) !== 'chart') return off;
        if (off <= r.openEnd) return off;
        if (r.end < len) return r.end + 1;
        return Math.min(r.openEnd, len);
      }
      return off;
    }
    function ensureMermaidPanel(openEl){
      let panel = openEl.querySelector(':scope > .lm-mermaid');
      if (panel) return panel;
      panel = document.createElement('div');
      panel.className = 'lm-mermaid';
      panel.setAttribute('contenteditable', 'false');
      panel.dataset.raw = '';
      panel.setAttribute('role', 'img');
      panel.setAttribute('aria-label', 'Mermaid 图表');
      panel.innerHTML = '<div class="lm-mermaid-chart"></div><div class="lm-mermaid-msg" hidden></div>';
      openEl.appendChild(panel);
      return panel;
    }
    function setMermaidView(openEl, view){
      const chart = view === 'chart';
      openEl.classList.toggle('is-mermaid-chart', chart);
      openEl.dataset.mmdView = view;
      const btn = openEl.querySelector('[data-lm-code-act="view"]');
      if (btn){
        btn.textContent = chart ? '代码' : '图表';
        btn.title = chart ? '切换为代码' : '切换为图表';
        btn.setAttribute('aria-pressed', chart ? 'true' : 'false');
      }
      let panel = openEl.querySelector(':scope > .lm-mermaid');
      if (chart){
        panel = ensureMermaidPanel(openEl);
        panel.hidden = false;
        panel.classList.toggle('is-folded', openEl.classList.contains('is-folded'));
        const src = codeBodyOf(openEl).replace(/\s+$/, '');
        const theme = mermaidThemeName();
        const chartBox = panel.querySelector('.lm-mermaid-chart');
        const hasSvg = !!(chartBox && chartBox.querySelector('svg'));
        const fresh = panel.dataset.mmdSrc === src && panel.dataset.mmdTheme === theme && hasSvg;
        if (!fresh) scheduleMermaid(panel, src);
      } else if (panel){
        panel.hidden = true;
      }
      let n = openEl.nextElementSibling;
      while (n && n.classList.contains('lm-code')){
        n.classList.toggle('is-mermaid-hidden', chart);
        n = n.nextElementSibling;
      }
    }
    function applyMermaidViews(caretOff){
      listMermaidBlocks().forEach((el, ord) => {
        setMermaidView(el, mermaidViewFor(el, ord, caretOff));
      });
    }
    function syncMermaidFromCaret(){
      const off = globalOffset();
      if (off == null) return;
      const nudged = nudgeMermaidCaret(off);
      if (nudged !== off) restoreCaret(nudged);
      else applyMermaidViews(off);
    }

    function updateFencePairFocus(){
      root.querySelectorAll('.lm-fence-pair-caret').forEach(n => n.classList.remove('lm-fence-pair-caret'));
      if (root.getAttribute('contenteditable') === 'false') return;
      const el = caretLineEl();
      if (!el) return;
      if (el.classList.contains('lm-fence-close')){
        let n = el.previousElementSibling;
        while (n && !n.classList.contains('lm-fence-open')) n = n.previousElementSibling;
        if (n) n.classList.add('lm-fence-pair-caret');
      } else if (el.classList.contains('lm-fence-open')){
        let n = el.nextElementSibling;
        while (n && n.classList.contains('lm-code')) n = n.nextElementSibling;
        if (n && n.classList.contains('lm-fence-close')) n.classList.add('lm-fence-pair-caret');
      }
    }

    /* ---------- 单行渲染（非围栏、非表格）：离开光标行时按原文重新渲染 ---------- */
    function singleLineHtml(line, i){
      const mk = parseMarker(line);
      if (mk){
        if (mk.type === 'hr'){
          return `<div class="lm-line lm-hrline" data-src-i="${i}"><hr class="lm-hr" data-raw="${esc(mk.raw)}" contenteditable="false"></div>`;
        }
        const rest = line.slice(mk.raw.length);
        let inner;
        if (mk.type === 'todo'){
          inner = `<span class="lm-cb${mk.checked ? ' on' : ''}" data-checked="${mk.checked ? 1 : 0}" data-raw="${esc(mk.raw)}" contenteditable="false">${mk.checked ? '☑' : '☐'}</span>`;
        } else {
          const glyph = mk.type === 'li' ? '&bull;' : mk.type === 'h' ? '#'.repeat(mk.level)
                      : mk.type === 'quote' ? '&gt;' : esc(mk.raw.trim());
          inner = `<span class="lm-mk" data-raw="${esc(mk.raw)}" contenteditable="false">${glyph}</span>`;
        }
        const ind = mk.indent && mk.indent.length ? ` style="--lm-ind:${mk.indent.length}"` : '';
        return `<div class="lm-line lm-${mk.type}${mk.type === 'h' ? ' lm-h lm-h' + mk.level : ''}" data-src-i="${i}"${ind}>${inner}${inlineHtml(rest) || '<br>'}</div>`;
      }
      return `<div class="lm-line" data-src-i="${i}">${inlineHtml(line) || '<br>'}</div>`;
    }

    /* ---------- 全量重建（含代码围栏状态） ---------- */
    function rebuild(raw){
      clearBr();   // 重建前清除括号高亮包裹，避免残留节点
      activeSrc = null;
      snapCodeFolds();
      const st = root.scrollTop;
      const srcLines = raw === '' ? [''] : raw.split('\n');
      let fence = false;
      const html = [];
      for (let i = 0; i < srcLines.length; i++){
        const line = srcLines[i], trim = line.trim();
        if (/^(```|~~~)/.test(trim)){
          const opening = !fence;
          fence = !fence;
          const lang = opening ? (trim.replace(/^(```|~~~)/, '').trim().split(/\s+/)[0] || '') : '';
          const langAttr = opening && /^[\w+#.-]+$/.test(lang) ? ` data-lang="${escAttr(lang)}"` : '';
          const role = opening ? 'lm-fence-open' : 'lm-fence-close';
          const mermaidCls = opening && isMermaidLang(lang) ? ' lm-fence-mermaid' : '';
          const tools = opening ? codeToolsHtml(lang) : '';
          html.push(`<div class="lm-line lm-fence ${role}${mermaidCls}" data-src-i="${i}"${langAttr}>${esc(line) || '<br>'}${tools}</div>`);
          continue;
        }
        if (fence){ html.push(`<div class="lm-line lm-code" data-src-i="${i}">${highlightCode(esc(line)) || '<br>'}</div>`); continue; }
        /* 表格：本行是管道行 且 下一行是对齐分隔行 */
        if (isTableRow(line) && srcLines[i + 1] && isTableSep(srcLines[i + 1])){
          const t0 = i;
          const rows = [line, srcLines[i + 1]];   // 表头 + 对齐分隔行
          i += 2;
          while (srcLines[i] && srcLines[i].trim() && isTableRow(srcLines[i])){ rows.push(srcLines[i]); i++; }
          html.push(renderTable(rows, t0));
          continue;
        }
        html.push(singleLineHtml(line, i));
      }
      root.innerHTML = html.join('');
      applyCodeFolds();
      applyMermaidViews(null);
      updatePh();
      if (!histNo) histPush();          // 每次重建后记录新状态（供 Ctrl+Z 回退）
      root.scrollTop = st;
      /* 重建完成广播：查找高亮等外部标注需要重打 */
      try { root.dispatchEvent(new CustomEvent('omni:livemd-rebuild', { bubbles: true })); } catch (_) {}
      if (typeof opts.afterRebuild === 'function'){
        try { opts.afterRebuild(root); } catch (_) {}
      }
    }

    function updatePh(){
      root.classList.toggle('is-empty', serializeAll() === '');
    }

    /* ---------- 撤销 / 重做历史栈 ----------
       内容可编辑区经过程序化 rebuild 后原生撤销栈会失效，
       这里维护纯文本快照栈：每次 rebuild 入栈，undo/redo 出栈重建。 */
    let hist = [], histIdx = -1, histNo = false;
    function histPush(){
      if (histNo) return;
      const s = serializeAll();
      if (hist[histIdx] === s) return;      // 与当前一致：不重复入栈
      hist.length = histIdx + 1;            // 丢弃重做分支
      hist.push(s);
      if (hist.length > 200) hist.shift();
      histIdx = hist.length - 1;
    }
    function restoreHist(idx){
      histNo = true;
      histIdx = idx;
      const raw = hist[idx] == null ? '' : hist[idx];
      ta.value = raw;
      try { ta.dispatchEvent(new Event('input')); } catch (e) {}
      rebuild(raw);
      histNo = false;
    }

    /* ---------- 光标的“原始文本偏移”计算 ---------- */
    function rawOffset(container, offset){
      if (container === root){
        let off = 0; const ls = lines();
        for (let i = 0; i < Math.min(offset, ls.length); i++) off += lineRaw(ls[i]).length + 1;
        return off;
      }
      let node = container;
      while (node.parentNode !== root) node = node.parentNode;
      if (node.dataset && node.dataset.tableRaw !== undefined){
        /* 表格行：基于现行源码精确定位表格内偏移 */
        let base = 0;
        for (const ln of lines()){
          if (ln === node) break;
          base += lineRaw(ln).length + 1;
        }
        return base + rawOffsetInTable(node, container, offset);
      }
      let base = 0;
      for (const ln of lines()){
        if (ln === node) break;
        base += lineRaw(ln).length + 1;
      }
      return base + rawUntil(node, container, offset);
    }
    function offsetOfRange(r){
      if (!r || (r.startContainer !== root && !root.contains(r.startContainer))) return null;
      return rawOffset(r.startContainer, r.startOffset);
    }
    function globalOffset(){
      const sel = window.getSelection();
      if (!sel.rangeCount) return null;
      return offsetOfRange(sel.getRangeAt(0));
    }
    /* 选区在原始 Markdown 中的 [start, end)；折叠选区时 start === end */
    function selectionRawRange(){
      const sel = window.getSelection();
      if (!sel.rangeCount) return null;
      const r = sel.getRangeAt(0);
      if (r.startContainer !== root && !root.contains(r.startContainer)) return null;
      let a = rawOffset(r.startContainer, r.startOffset);
      let b = r.collapsed ? a : rawOffset(r.endContainer, r.endOffset);
      if (typeof a !== 'number') return null;
      if (typeof b !== 'number') b = a;
      if (a > b){ const t = a; a = b; b = t; }
      return { start: a, end: b };
    }
    function selectRawRange(start, end){
      applyMermaidViews(start);
      const sel = window.getSelection();
      sel.removeAllRanges();
      const raw = serializeAll();
      start = Math.max(0, Math.min(raw.length, start == null ? 0 : start));
      end = Math.max(start, Math.min(raw.length, end == null ? start : end));
      if (end <= start){
        restoreCaret(start);
        return;
      }
      const p1 = domPointAt(start);
      const p2 = domPointAt(end);
      const applyLineEls = () => {
        const ls = lines();
        let pos = 0, startLn = null, endLn = null;
        for (const ln of ls){
          const len = lineRaw(ln).length;
          if (!startLn && start <= pos + len) startLn = ln;
          if (end > pos) endLn = ln;
          pos += len + 1;
        }
        if (startLn && endLn){
          const r = document.createRange();
          r.setStart(startLn, 0);
          r.setEnd(endLn, endLn.childNodes.length);
          sel.addRange(r);
          return true;
        }
        return false;
      };
      if (p1 && p2){
        try {
          const r = document.createRange();
          r.setStart(p1.node, p1.offset);
          r.setEnd(p2.node, p2.offset);
          sel.addRange(r);
          const got = selectionRawRange();
          if (got && (got.end - got.start) + 2 >= (end - start)) return;
          sel.removeAllRanges();
        } catch (_) {}
      }
      applyLineEls();
    }
    /* 在源码偏移区间上包一层纯视觉 span（无 data-raw，序列化仍走内部文本） */
    function markRange(start, end, cls){
      if (!(end > start) || !cls) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(n){
          if (!n.data) return NodeFilter.FILTER_REJECT;
          const p = n.parentElement;
          if (!p || p.closest('button, .lm-code-tools, .lm-tbar, .lm-rowh, .lm-colh, .lm-find, .' + cls))
            return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const hits = [];
      while (walker.nextNode()){
        const n = walker.currentNode;
        let a;
        try { a = rawOffset(n, 0); } catch (_) { continue; }
        if (typeof a !== 'number') continue;
        const b = a + n.data.length;
        if (b <= start || a >= end) continue;
        hits.push({ n, from: Math.max(0, start - a), to: Math.min(n.data.length, end - a) });
      }
      for (let i = hits.length - 1; i >= 0; i--){
        const h = hits[i];
        if (h.to <= h.from) continue;
        let node = h.n;
        try {
          if (h.from > 0) node = node.splitText(h.from);
          if (h.to - h.from < node.data.length) node.splitText(h.to - h.from);
          const span = document.createElement('span');
          span.className = cls;
          node.parentNode.replaceChild(span, node);
          span.appendChild(node);
        } catch (_) {}
      }
    }
    /* 拖拽落点 → 原始文本偏移（落在编辑器外则追加到文末） */
    function offsetFromPoint(x, y){
      const r = document.caretRangeFromPoint
        ? document.caretRangeFromPoint(x, y) : null;
      if (!r) return serializeAll().length;
      const off = offsetOfRange(r);
      return off == null ? serializeAll().length : off;
    }

    /* ---------- 光标还原（偏移落点决定渲染/还原） ---------- */
    function rawifyNode(n){
      const t = document.createTextNode(rawOfNode(n));
      n.replaceWith(t);
      return t;
    }
    function setSel(node, offset){
      const r = document.createRange();
      if (node.nodeType === 3) r.setStart(node, Math.min(offset, node.data.length));
      else { r.setStart(node, Math.min(offset, node.childNodes.length)); }
      r.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(r);
    }
    function caretAfter(n){
      const r = document.createRange();
      r.setStartAfter(n); r.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(r);
    }
    function caretEndOf(n){
      const r = document.createRange();
      r.selectNodeContents(n); r.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(r);
    }

    function restoreInLine(line, off){
      if (line.dataset && line.dataset.tableRaw !== undefined){ caretAfter(line); return; }
      const walk = arr => {
        for (const n of arr){
          if (n.nodeType === 3){
            if (off <= n.data.length){ setSel(n, off); return true; }
            off -= n.data.length; continue;
          }
          if (n.tagName === 'BR'){
            if (off === 0){ setSel(line, Array.from(line.childNodes).indexOf(n)); return true; }
            continue;
          }
          if (n.dataset && n.dataset.raw !== undefined){
            const len = n.dataset.raw.length;
            if (off < len){ const t = rawifyNode(n); setSel(t, off); return true; }   /* 光标进入标记内：还原原始文本 */
            if (off === len){ caretAfter(n); return true; }                            /* 恰在标记后：保持渲染 */
            off -= len; continue;
          }
          if (n.dataset && n.dataset.pre !== undefined){
            const pre = n.dataset.pre, post = n.dataset.post || '';
            if (off < pre.length){ const t = rawifyNode(n); setSel(t, off); return true; }
            off -= pre.length;
            const innerLen = Array.from(n.childNodes).map(rawOfNode).join('').length;
            if (off <= innerLen){ if (walk(Array.from(n.childNodes))) return true; caretEndOf(n); return true; }
            off -= innerLen;
            if (off <= post.length){ caretEndOf(n); return true; }                     /* 恰在闭合标记处：保持渲染 */
            off -= post.length; continue;
          }
          if (walk(Array.from(n.childNodes))) return true;
        }
        return false;
      };
      if (!walk(Array.from(line.childNodes))) caretEndOf(line);
    }

    function restoreCaret(off){
      if (off == null) return;
      off = nudgeMermaidCaret(off);
      let pos = 0;
      let placed = false;
      const ls = lines();
      for (const ln of ls){
        const len = lineRaw(ln).length;
        if (off <= pos + len){ placeOnLine(ln, off - pos); placed = true; break; }
        pos += len + 1;
      }
      if (!placed && ls.length) caretEndOf(ls[ls.length - 1]);
      /* 光标落定后立刻判断 [[ ，不必等 selectionchange（程序化选区有时不派发） */
      if (!composing && !pointerDown) syncWiki();
      applyMermaidViews(off);
    }

    /* 可编辑且非表格/代码行：光标落在该行时整行改为原文，便于直接改标记符号 */
    function canSource(line){
      if (!line || !line.classList) return false;
      if (root.getAttribute('contenteditable') === 'false') return false;
      if (line.dataset && line.dataset.tableRaw !== undefined) return false;
      if (line.classList.contains('lm-code') || line.classList.contains('lm-fence')) return false;
      return true;
    }
    function leaveSource(line){
      if (!line || !line.isConnected || !line.classList.contains('lm-src')) return line;
      const raw = lineRaw(line);
      const i = line.getAttribute('data-src-i') || '0';
      const box = document.createElement('div');
      box.innerHTML = singleLineHtml(raw, i);
      const neu = box.firstElementChild;
      if (neu) line.replaceWith(neu);
      if (activeSrc === line) activeSrc = null;
      return neu || line;
    }
    /* 把一行换成原始 Markdown 文本，并把光标放到行内偏移 localOff */
    function sourceifyLine(line, localOff){
      if (!line || !canSource(line)) return;
      if (activeSrc && activeSrc !== line && activeSrc.isConnected) leaveSource(activeSrc);
      if (!line.classList.contains('lm-src')){
        const raw = lineRaw(line);
        line.classList.add('lm-src');
        line.dataset.lmSrc = '1';
        while (line.firstChild) line.removeChild(line.firstChild);
        if (!raw) line.appendChild(document.createElement('br'));
        else line.appendChild(document.createTextNode(raw));
      }
      activeSrc = line;
      if (localOff != null) restoreInLine(line, localOff);
    }
    function placeOnLine(line, localOff){
      if (!canSource(line)){
        if (activeSrc && activeSrc.isConnected) leaveSource(activeSrc);
        activeSrc = null;
        restoreInLine(line, localOff);
        return;
      }
      const mk = parseMarker(lineRaw(line));
      /* 任务行：光标进入「- [ ]」标记内部才展开源码；点复选框或编辑正文保持勾选框 */
      if (mk && mk.type === 'todo'){
        if (activeSrc && activeSrc !== line && activeSrc.isConnected) leaveSource(activeSrc);
        if (localOff < mk.raw.length){
          const sel = window.getSelection();
          const collapsed = !sel || !sel.rangeCount || sel.isCollapsed;
          if (collapsed && !pointerDown && !composing) sourceifyLine(line, localOff);
          else restoreInLine(line, localOff);
          return;
        }
        const shown = line.classList.contains('lm-src') ? leaveSource(line) : line;
        if (activeSrc === line) activeSrc = null;
        restoreInLine(shown, localOff);
        return;
      }
      const sel = window.getSelection();
      const collapsed = !sel || !sel.rangeCount || sel.isCollapsed;
      if (collapsed && !pointerDown && !composing) sourceifyLine(line, localOff);
      else restoreInLine(line, localOff);
    }
    /* 折叠光标移到新行时，把上一行渲染回去、当前行展开为原文 */
    function syncSourceFromSelection(){
      if (!alive || composing || srcLock || pointerDown || wikiHold) return;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
      const el = caretLineEl();
      if (!el || !canSource(el)){
        if (activeSrc && activeSrc.isConnected){
          srcLock = true;
          try { leaveSource(activeSrc); } finally { srcLock = false; }
        }
        activeSrc = null;
        return;
      }
      if (el.classList.contains('lm-src')){
        const mk = parseMarker(lineRaw(el));
        if (!(mk && mk.type === 'todo')){ activeSrc = el; return; }
      }
      const off = globalOffset();
      if (off == null) return;
      srcLock = true;
      try { restoreCaret(off); }
      finally { srcLock = false; }
    }

    /* ---------- 输入管线：序列化 → 回写 textarea → 重建 → 还原光标 ---------- */
    let tblDirty = false;
    function pipeline(){
      if (!alive || composing) return;
      const cur = caretLineEl();
      /* 图表 SVG 插进只读区也会冒泡 input。源码没变就不要重建，否则会把刚画好的图清掉再画。 */
      if (!(cur && cur.dataset && cur.dataset.tableRaw !== undefined) && serializeAll() === ta.value) return;
      if (cur && cur.dataset && cur.dataset.tableRaw !== undefined){
        /* 表格单元格内：只回写源码不重建（重建会丢单元格内光标），
           光标离开表格后由 onSelChange 统一刷新内联渲染 */
        const traw = serializeAll();
        if (ta.value !== traw) ta.value = traw;
        try { ta.dispatchEvent(new Event('input')); } catch (e) {}
        tblDirty = true;
        updatePh();
        if (!histNo) histPush();
        return;
      }
      const off = globalOffset();
      const raw = serializeAll();
      if (ta.value !== raw) ta.value = raw;
      try { ta.dispatchEvent(new Event('input')); } catch (e) {}
      rebuild(raw);
      restoreCaret(off);
    }

    /* 取光标所在行及行内偏移 */
    function caretLineInfo(){
      const sel = window.getSelection();
      if (!sel.rangeCount) return null;
      const r = sel.getRangeAt(0);
      if (!root.contains(r.startContainer)) return null;
      let line = r.startContainer;
      while (line && line.parentNode !== root) line = line.parentNode;
      if (!line) return null;
      return { line, r, sel, textBefore: lineRaw(line).slice(0, rawUntil(line, r.startContainer, r.startOffset)) };
    }

    /* ---------- 按键：Enter 续行 / Backspace 还原与并段 ---------- */
    function onKeydown(e){
      if (composing || e.isComposing) return;

      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey
          && String(e.key || '').toLowerCase() === 'a'){
        e.preventDefault();
        const raw = serializeAll();
        const rng = selectionRawRange();
        const a = rng ? rng.start : (globalOffset() || 0);
        const b = rng ? rng.end : a;
        const next = nextExpandRange(raw, a, b);
        selectRawRange(next.start, next.end);
        return;
      }

      /* 表格单元格内：Enter 下移 / Tab 右移；退格/删除交给原生，跳过下方标记还原逻辑 */
      const inCell = e.target.closest ? e.target.closest('.lm-table td, .lm-table th') : null;
      if (inCell){
        if (e.key === 'Enter' || e.key === 'Tab'){
          e.preventDefault();
          tableCellNav(inCell, e.key === 'Enter' ? 'down' : 'right', e.shiftKey);
          return;
        }
        if (e.key === 'Backspace' || e.key === 'Delete') return;
      }

      if (e.key === 'Enter' && e.shiftKey){
        /* Shift+Enter：软换行，映射为原始文本的一个空格 */
        e.preventDefault();
        document.execCommand('insertText', false, ' ');
        return;
      }

      if (e.key === 'Enter' && !e.shiftKey){
        e.preventDefault();
        const off = globalOffset(); if (off == null) return;
        const arr = serializeAll().split('\n');
        let pos = 0, li = 0;
        for (li = 0; li < arr.length; li++){
          if (off <= pos + arr[li].length) break;
          pos += arr[li].length + 1;
        }
        const local = off - pos, cur = arr[li] || '';
        const mk = parseMarker(cur);
        if (mk && mk.type !== 'hr' && cur.trim() === mk.raw.trim()){              /* 空列表项回车：退出列表 */
          arr[li] = '';
          const nraw = arr.join('\n');
          ta.value = nraw;
          try { ta.dispatchEvent(new Event('input')); } catch (er) {}
          rebuild(nraw);
          restoreCaret(pos);
          return;
        }
        const head = cur.slice(0, local), tail = cur.slice(local);
        const pref = contPrefix(mk);
        arr.splice(li, 1, head, pref + tail);
        const nraw = arr.join('\n');
        ta.value = nraw;
        try { ta.dispatchEvent(new Event('input')); } catch (er) {}
        rebuild(nraw);
        restoreCaret(pos + head.length + 1 + pref.length);
        return;
      }

      if (e.key === 'Backspace'){
        const sel = window.getSelection();
        if (!sel.rangeCount || !sel.isCollapsed) return;
        const info = caretLineInfo(); if (!info) return;
        const { line, r } = info;

        /* 光标容器为行元素：前一子节点是语法节点时先还原 */
        if (r.startContainer.nodeType === 1 && r.startOffset > 0){
          const child = r.startContainer.childNodes[r.startOffset - 1];
          if (child && child.dataset && (child.dataset.raw !== undefined || child.dataset.pre !== undefined)){
            e.preventDefault();
            const t = rawifyNode(child);
            setSel(t, t.data.length);
            commitNoRebuild();
            return;
          }
        }

        /* 文本光标：前面只有空白且行首是渲染标记 → 还原为原始文本（不删内容） */
        if (/^\s*$/.test(info.textBefore)){
          const mkNode = Array.from(line.children).find(c => c.dataset && c.dataset.raw !== undefined);
          if (mkNode && line.firstElementChild === mkNode){
            e.preventDefault();
            const t = rawifyNode(mkNode);
            setSel(t, t.data.length);
            commitNoRebuild();
            return;
          }
          /* 行首退格且无标记：并入上一行 */
          if (info.textBefore === ''){
            const ls = lines(); const idx = ls.indexOf(line);
            if (idx > 0){
              e.preventDefault();
              const prevRaw = lineRaw(ls[idx - 1]);
              const curRaw = lineRaw(line);
              const arr = serializeAll().split('\n');
              arr[idx - 1] = prevRaw + curRaw; arr.splice(idx, 1);
              const nraw = arr.join('\n');
              let base = 0;
              for (let i = 0; i < idx - 1; i++) base += arr[i].length + 1;
              ta.value = nraw;
              try { ta.dispatchEvent(new Event('input')); } catch (er) {}
              rebuild(nraw);
              restoreCaret(base + prevRaw.length);
            }
            return;
          }
        }

        /* 紧邻行内语法开标记之后（如 **|文本）：还原并删除一个标记字符 */
        const cont = r.startContainer;
        if (cont.nodeType === 3 && r.startOffset === 0 && !cont.previousSibling
            && cont.parentNode.dataset && cont.parentNode.dataset.pre !== undefined){
          const span = cont.parentNode;
          e.preventDefault();
          const preLen = span.dataset.pre.length;
          const t = rawifyNode(span);
          t.data = t.data.slice(0, preLen - 1) + t.data.slice(preLen);
          setSel(t, preLen - 1);
          commitNoRebuild();
          return;
        }

        /* 前一兄弟是行内语法节点：先还原为原始文本，下次退格逐字删除 */
        if (cont.nodeType === 3 && r.startOffset === 0){
          const pn = cont.previousSibling;
          if (pn && pn.dataset && pn.dataset.pre !== undefined){
            e.preventDefault();
            const t = rawifyNode(pn);
            setSel(t, t.data.length);
            commitNoRebuild();
            return;
          }
        }
      }
    }

    /* 选区起点若在表格内，返回该表格行元素（块级/行级插入需把落点移到表格后） */
    function selTableLine(){
      const sel = window.getSelection();
      if (!sel.rangeCount) return null;
      let n = sel.getRangeAt(0).startContainer;
      if (n !== root && !root.contains(n)) return null;
      while (n && n.parentNode !== root) n = n.parentNode;
      return n && n.dataset && n.dataset.tableRaw !== undefined ? n : null;
    }
    function tableEndOffset(tbl){
      let p = 0;
      for (const ln of lines()){
        p += lineRaw(ln).length + 1;
        if (ln === tbl) break;
      }
      return Math.min(p, serializeAll().length);
    }

    /* ---------- 在指定偏移插入原始文本（粘贴 / 插图共用）；endPos 有值时覆盖 [pos, endPos) ---------- */
    function insertRawAt(pos, text, endPos){
      const raw = serializeAll();
      let start = pos == null ? raw.length : pos;
      start = Math.max(0, Math.min(start, raw.length));
      let end = endPos == null ? start : endPos;
      end = Math.max(start, Math.min(end, raw.length));
      const nraw = raw.slice(0, start) + text + raw.slice(end);
      ta.value = nraw;
      try { ta.dispatchEvent(new Event('input')); } catch (e) {}
      rebuild(nraw);
      restoreCaret(start + text.length);
    }

    /* ---------- 图片插入：上传后以 Markdown 图片语法写入（逐个追加） ---------- */
    async function insertFiles(files, point){
      if (!opts.uploadImage || !files.length) return;
      let pos = point ? offsetFromPoint(point.x, point.y) : globalOffset();
      if (pos == null) pos = serializeAll().length;
      for (const f of files){
        try {
          const url = await opts.uploadImage(f);
          const name = (f.name || 'image').replace(/[\[\]()]/g, '');
          const prefix = pos > 0 ? '\n' : '';
          const suffix = pos < serializeAll().length ? '\n' : '';
          const md = prefix + `![${name}](${url})` + suffix;
          insertRawAt(pos, md);
          pos += md.length;
        } catch (e) {
          if (opts.onImageError) opts.onImageError(e);
        }
      }
    }

    /* ---------- 粘贴：图片走上传，纯文本插入并拆行 ---------- */
    function onPaste(e){
      const files = Array.from((e.clipboardData || {}).files || [])
        .filter(f => /^image\//.test(f.type));
      if (files.length && opts.uploadImage){ e.preventDefault(); insertFiles(files); return; }
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text/plain');
      if (!text) return;
      const rng = selectionRawRange(); if (!rng) return;
      insertRawAt(rng.start, text.replace(/\r/g, ''), rng.end);
    }
    /* 复制/剪切：写入 Markdown 源码，而不是渲染后的 · / ☑ 等可见符号 */
    function onCopy(e){
      const rng = selectionRawRange();
      if (!rng || rng.end <= rng.start) return;
      const md = serializeAll().slice(rng.start, rng.end);
      e.preventDefault();
      try { e.clipboardData.setData('text/plain', md); }
      catch (_) { copyText(md); }
    }
    function onCut(e){
      const rng = selectionRawRange();
      if (!rng || rng.end <= rng.start) return;
      const md = serializeAll().slice(rng.start, rng.end);
      e.preventDefault();
      try { e.clipboardData.setData('text/plain', md); }
      catch (_) { copyText(md); }
      insertRawAt(rng.start, '', rng.end);
    }

    /* ---------- 任务列表点击勾选 / 表格行列选中与增删 ---------- */
    function onClick(e){
      const codeAct = e.target.closest ? e.target.closest('[data-lm-code-act]') : null;
      if (codeAct && root.contains(codeAct)){
        e.preventDefault();
        const open = codeAct.closest('.lm-fence-open');
        if (!open) return;
        const act = codeAct.dataset.lmCodeAct;
        if (act === 'copy'){
          copyText(codeBodyOf(open)).then(() => {
            if (typeof showToast === 'function') showToast('已复制');
          });
        } else if (act === 'fold'){
          const on = !open.classList.contains('is-folded');
          setCodeFold(open, on);
          snapCodeFolds();
        } else if (act === 'view'){
          const blocks = listMermaidBlocks();
          const ord = blocks.indexOf(open);
          if (ord < 0) return;
          const range = blockOffsets(open);
          const showingChart = open.classList.contains('is-mermaid-chart');
          const next = showingChart ? 'code' : 'chart';
          if (!showingChart){
            const cur = globalOffset();
            if (cur != null && cur >= range.start && cur <= range.end) mermaidCaret.set(ord, cur);
          }
          mermaidMode.set(ord, next);
          if (next === 'code'){
            const off = mermaidCaret.has(ord) ? mermaidCaret.get(ord) : range.bodyStart;
            root.focus();
            restoreCaret(Math.max(0, Math.min(off, serializeAll().length)));
          } else {
            applyMermaidViews(range.end + 1);
            const cur = globalOffset();
            if (cur != null && cur >= range.start && cur <= range.end)
              restoreCaret(Math.min(range.end + 1, serializeAll().length));
          }
        }
        return;
      }
      /* 表格浮动工具条：按当前选中的行/列执行插入/删除 */
      const tAct = e.target.closest('[data-t-act]');
      if (tAct){
        e.preventDefault();
        const wrap = tAct.closest('.lm-table');
        if (!wrap || !wrap.dataset.tselKind) return;
        const kind = wrap.dataset.tselKind, idx = +wrap.dataset.tselIdx;
        const tk = tableIndexOf(wrap);
        const act = tAct.dataset.tAct;
        tableMutate(wrap, cells => {
          if (kind === 'row'){
            const ri = idx + 2;                       // cells[0] 表头、[1] 分隔行，数据行从 2 起
            if (act === 'insbefore') cells.splice(ri, 0, cells[0].map(() => ''));
            else if (act === 'insafter') cells.splice(ri + 1, 0, cells[0].map(() => ''));
            else if (act === 'del' && cells.length > 3) cells.splice(ri, 1);
          } else {
            if (act === 'insbefore') cells.forEach(r => r.splice(idx, 0, ''));
            else if (act === 'insafter') cells.forEach(r => r.splice(idx + 1, 0, ''));
            else if (act === 'del' && cells[0].length > 1) cells.forEach(r => r.splice(idx, 1));
          }
        });
        /* 重建后把选中还给同行/同列（越界则钳制） */
        const nt = nthTable(tk);
        if (nt){
          if (kind === 'row'){
            const trs = nt.querySelectorAll('tbody tr');
            const tr = trs[Math.min(idx, trs.length - 1)];
            if (tr && tr.children[0]) selectCell(tr.children[0]);
          } else {
            const ths = nt.querySelectorAll('thead th');
            const th = ths[Math.min(idx, ths.length - 1)];
            if (th) selectCell(th);
          }
        }
        return;
      }
      /* 点单元格：选中所在行；点表头：选中所在列（不干扰光标落点） */
      const cell = e.target.closest('.lm-table th, .lm-table td');
      if (cell){ selectCell(cell); return; }
      /* 点表格下方留白区（表格是块级行，padding 区域可命中）→ 光标跳到表格之后；
         手柄/浮动工具条区域除外（拖拽与按钮交互不受干扰） */
      const tblWrap = e.target.closest ? e.target.closest('.lm-table') : null;
      if (tblWrap && !e.target.closest('.lm-rowh, .lm-colh, .lm-tbar')){
        clearTableSel();
        caretAfterTable(tblWrap);
        return;
      }
      /* 点到表格外：清除所有表格选中 */
      clearTableSel();
      const cb = e.target.closest('.lm-cb');
      if (!cb || !root.contains(cb)) return;
      e.preventDefault();
      toggleCheckbox(cb);
    }
    let cbToggleAt = 0;
    function toggleCheckbox(cb){
      const now = Date.now();
      if (now - cbToggleAt < 350) return;
      cbToggleAt = now;
      const line = cb.closest('.lm-line');
      const idx = lines().indexOf(line);
      if (idx < 0) return;
      const off = globalOffset();
      const arr = serializeAll().split('\n');
      const cur = arr[idx] || '';
      const mk = parseMarker(cur);
      if (!mk || mk.type !== 'todo') return;
      const nextBox = mk.checked ? '[ ]' : '[x]';
      arr[idx] = cur.slice(0, mk.raw.length).replace(/\[[ xX]\]/, nextBox) + cur.slice(mk.raw.length);
      const nraw = arr.join('\n');
      ta.value = nraw;
      try { ta.dispatchEvent(new Event('input')); } catch (er) {}
      rebuild(nraw);
      restoreCaret(off);
      if (opts.onToggle) opts.onToggle(idx, arr[idx]);
    }

    /* 表格行/列拖拽调序：仅从边缘悬浮手柄发起，不与单元格编辑冲突 */
    function onTableDrag(e, phase){
      const tgt = e.target;
      const isEl = tgt && tgt.closest;
      if (phase === 'start'){
        const rh = isEl ? tgt.closest('.lm-rowh') : null;
        const ch = isEl ? tgt.closest('.lm-colh') : null;
        if (rh){
          const tr = rh.closest('tr');
          if (!tr || tr.dataset.ri == null) return;
          e.dataTransfer.setData('application/x-omni-trow', tr.dataset.ri);
          e.dataTransfer.effectAllowed = 'move';
          tr.classList.add('lm-tdrag');
        } else if (ch){
          const th = ch.closest('th');
          if (!th) return;
          const ci = Array.from(th.parentNode.children).filter(n => n.tagName === 'TH').indexOf(th);
          e.dataTransfer.setData('application/x-omni-tcol', String(ci));
          e.dataTransfer.effectAllowed = 'move';
          th.classList.add('lm-tdrag');
        }
      } else if (phase === 'over'){
        const types = Array.from(e.dataTransfer.types || []);
        if (types.includes('application/x-omni-trow') && isEl && tgt.closest('tr[data-ri]')){
          e.preventDefault(); e.dataTransfer.dropEffect = 'move';
          const tr = tgt.closest('tr[data-ri]');
          const wrap = tr.closest('.lm-table');
          clearTableDropMarks(wrap);
          /* 虚线预览：按悬停点在上半/下半决定插到该行上方/下方 */
          const r = tr.getBoundingClientRect();
          const side = e.clientY < r.top + r.height / 2 ? 'top' : 'bottom';
          tr.classList.add('lm-drop-' + side);
          tr.dataset.dropSide = side;
        } else if (types.includes('application/x-omni-tcol') && isEl && tgt.closest('.lm-table th')){
          e.preventDefault(); e.dataTransfer.dropEffect = 'move';
          const th = tgt.closest('.lm-table th');
          const wrap = th.closest('.lm-table');
          clearTableDropMarks(wrap);
          const r = th.getBoundingClientRect();
          const side = e.clientX < r.left + r.width / 2 ? 'left' : 'right';
          th.classList.add('lm-drop-' + side);
          th.dataset.dropSide = side;
        }
      } else if (phase === 'drop'){
        const types = Array.from(e.dataTransfer.types || []);
        if (types.includes('application/x-omni-trow')){
          const tr = isEl ? tgt.closest('tr[data-ri]') : null;
          if (!tr) return;
          const from = e.dataTransfer.getData('application/x-omni-trow');
          if (from === '' || from === tr.dataset.ri) return;
          e.preventDefault();
          const wrap = tr.closest('.lm-table');
          clearTableDropMarks(wrap);
          if (!wrap) return;
          tableMutate(wrap, cells => {
            const fi = +from + 2, ri = +tr.dataset.ri + 2;   // 表头与分隔行不可移动；预览侧决定插入方位（原位挪动无视觉变化）
            const moved = cells.splice(fi, 1)[0];
            cells.splice(ri, 0, moved);
          });
        } else if (types.includes('application/x-omni-tcol')){
          const th = isEl ? tgt.closest('.lm-table th') : null;
          if (!th) return;
          const from = e.dataTransfer.getData('application/x-omni-tcol');
          if (from === '') return;
          const wrap = th.closest('.lm-table');
          clearTableDropMarks(wrap);
          if (!wrap) return;
          const to = Array.from(th.parentNode.children).filter(n => n.tagName === 'TH').indexOf(th);
          if (+from === to) return;
          e.preventDefault();
          tableMutate(wrap, cells => {
            const fi = +from;
            cells.forEach(r => { const v = r.splice(fi, 1)[0]; r.splice(to, 0, v == null ? '' : v); });
          });
        }
      }
    }
    /* 清除拖拽虚线预览（换目标/落点/结束时调用） */
    function clearTableDropMarks(scope){
      if (!scope || !scope.querySelectorAll) return;
      scope.querySelectorAll('.lm-drop-top, .lm-drop-bottom, .lm-drop-left, .lm-drop-right')
        .forEach(n => { n.classList.remove('lm-drop-top', 'lm-drop-bottom', 'lm-drop-left', 'lm-drop-right'); delete n.dataset.dropSide; });
    }
    root.addEventListener('dragstart', e => onTableDrag(e, 'start'));
    root.addEventListener('dragover', e => onTableDrag(e, 'over'));
    root.addEventListener('drop', e => onTableDrag(e, 'drop'));
    root.addEventListener('dragend', () => {
      root.querySelectorAll('.lm-tdrag').forEach(n => n.classList.remove('lm-tdrag'));
      root.querySelectorAll('.lm-table').forEach(clearTableDropMarks);
    });

    /* ---------- 选区变化：光标行标记（标题 # 显隐） + 括号配对 ---------- */
    function caretLineEl(){
      const sel = window.getSelection();
      if (!sel.rangeCount) return null;
      const r = sel.getRangeAt(0);
      if (!root.contains(r.startContainer)) return null;
      let n = r.startContainer;
      while (n && n.parentNode !== root) n = n.parentNode;
      return n;
    }
    function caretBrackets(){
      const sel = window.getSelection();
      if (composing || !sel.rangeCount || !sel.isCollapsed){ clearBr(); return; }
      const off = globalOffset();
      if (off == null){ clearBr(); return; }
      const full = serializeAll();
      let gi = -1;
      const before = full[off - 1], at = full[off];
      if (before && BR_PAIR[before]) gi = off - 1;
      else if (at && BR_PAIR[at]) gi = off;
      if (gi < 0){ clearBr(); return; }
      const key = gi + ':' + full[gi] + ':' + full.length;
      if (key === lastBrKey && brNodes.length) return;
      clearBr();
      const mj = findBrMatch(full, gi);
      if (mj < 0) return;
      const p1 = domPointAt(gi);
      if (!p1) return;
      lastBrKey = key;
      wrapChar(p1.node, p1.offset);
      /* 首处包裹会切分文本节点，另一括号落点须基于包裹后的 DOM 重新定位 */
      const p2 = domPointAt(mj);
      if (p2) wrapChar(p2.node, p2.offset);
      /* wrap 会切分文本节点，把光标复位到原偏移避免跳动 */
      restoreCaret(off);
    }
    let selTimer = 0;
    function onSelChange(){
      if (!root.isConnected || selTimer || srcLock) return;
      selTimer = requestAnimationFrame(() => {
        selTimer = 0;
        if (!alive || srcLock) return;
        if (wikiHold || (wikiPop && wikiPop.contains(document.activeElement))) return;
        /* 光标离开表格后，把刚才编辑过的表格刷新一次内联渲染（加粗/链接等） */
        let el = caretLineEl();
        if (tblDirty && (!el || !el.dataset || el.dataset.tableRaw === undefined)){
          tblDirty = false;
          const off = globalOffset();
          rebuild(serializeAll());
          restoreCaret(off);
          el = caretLineEl();
        }
        if (!pointerDown && !composing) syncSourceFromSelection();
        el = caretLineEl();
        for (const x of root.querySelectorAll('.lm-caret'))
          if (x !== el) x.classList.remove('lm-caret');
        if (el) el.classList.add('lm-caret');
        updateFencePairFocus();
        if (!pointerDown && !composing) syncMermaidFromCaret();
        if (!pointerDown && !composing) caretBrackets();
        if (!pointerDown && !composing) syncWiki();
      });
    }

    /* 浏览器选中一整行时，选区常停在下一行开头（或从上一行末尾起算），
       原始偏移会把换行算进去。行内标记不能跨行，否则闭合符号落到邻行、语法匹配失败。 */
    function trimEdgeNewlines(raw, start, end){
      if (end < start){ const t = start; start = end; end = t; }
      start = Math.max(0, Math.min(raw.length, start));
      end = Math.max(start, Math.min(raw.length, end));
      while (start < end && raw.charAt(start) === '\n') start++;
      while (end > start && raw.charAt(end - 1) === '\n') end--;
      return { start, end };
    }
    /* 在 [start, end) 上加标记。先剥掉两端换行；中间还有换行时按行分别包裹，空行不动。
       返回 null 表示剥掉换行后没有可标记的文本。caret 落在最后一行正文末尾（闭合标记之前）。 */
    function wrapMarkedSpan(raw, start, end, pre, suf){
      const span = trimEdgeNewlines(raw, start, end);
      if (span.end <= span.start) return null;
      const inner = raw.slice(span.start, span.end);
      const parts = inner.split('\n');
      const wrapped = parts.map(line => line ? (pre + line + suf) : line).join('\n');
      let caret = span.start;
      let pos = span.start;
      parts.forEach((line, i) => {
        if (line) caret = pos + pre.length + line.length;
        pos += (line ? pre.length + line.length + suf.length : 0) + (i < parts.length - 1 ? 1 : 0);
      });
      const single = parts.length === 1;
      return {
        raw: raw.slice(0, span.start) + wrapped + raw.slice(span.end),
        selStart: span.start + (single ? pre.length : 0),
        selEnd: span.start + (single ? pre.length + inner.length : wrapped.length),
        caret
      };
    }

    /* ---------- 选区上直接输入修饰符：* 斜体、再按加粗、~ 删除线、` 行内代码 ---------- */
    const MARK_MAX = { '*': 3, '_': 2, '~': 2, '`': 1 };
    function applyMarkerText(text){
      if (!text || root.getAttribute('contenteditable') === 'false') return false;
      const ch = text[0];
      const max = MARK_MAX[ch];
      if (!max || [...text].some(c => c !== ch)) return false;
      const rng = selectionRawRange();
      if (!rng || rng.end <= rng.start) return false;
      let raw = serializeAll();
      const span = trimEdgeNewlines(raw, rng.start, rng.end);
      if (span.end <= span.start) return false;
      let start = span.start, end = span.end;
      const inner = raw.slice(start, end);
      if (inner.includes('\n')){
        const mk = ch.repeat(Math.min(text.length, max));
        const wrapped = wrapMarkedSpan(raw, start, end, mk, mk);
        if (!wrapped) return false;
        ta.value = wrapped.raw;
        try { ta.dispatchEvent(new Event('input')); } catch (_) {}
        rebuild(wrapped.raw);
        selectRawRange(wrapped.selStart, wrapped.selEnd);
        return true;
      }
      let outside = 0;
      while (outside < max
          && start - (outside + 1) >= 0
          && end + outside < raw.length
          && raw[start - 1 - outside] === ch
          && raw[end + outside] === ch) outside++;
      if (outside >= max){
        raw = raw.slice(0, start - outside) + inner + raw.slice(end + outside);
        start -= outside;
        end = start + inner.length;
      } else {
        const add = Math.min(text.length, max - outside);
        const mk = ch.repeat(add);
        raw = raw.slice(0, start) + mk + inner + mk + raw.slice(end);
        start += mk.length;
        end = start + inner.length;
      }
      ta.value = raw;
      try { ta.dispatchEvent(new Event('input')); } catch (_) {}
      rebuild(raw);
      selectRawRange(start, end);
      return true;
    }

    /* ---------- [[ 笔记引用：模糊搜索弹层 ---------- */
    const wikiPop = document.createElement('div');
    wikiPop.className = 'lm-wiki-pop';
    wikiPop.hidden = true;
    wikiPop.innerHTML = '<input class="lm-wiki-q" type="text" enterkeyhint="search" autocomplete="off" spellcheck="false" placeholder="搜索笔记，回车插入引用" aria-label="搜索笔记">'
      + '<div class="lm-wiki-list" role="listbox"></div>';
    document.body.appendChild(wikiPop);
    const wikiInput = wikiPop.querySelector('.lm-wiki-q');
    const wikiList = wikiPop.querySelector('.lm-wiki-list');
    let wikiSession = null, wikiActive = 0, wikiDismissedAt = 0;

    function wikiScore(q, title, folder){
      const query = String(q || '').trim().toLowerCase();
      if (!query) return 1;
      const hay = (title + '\n' + folder).toLowerCase();
      const at = hay.indexOf(query);
      if (at >= 0) return 300 - Math.min(at, 200) + (title.toLowerCase().startsWith(query) ? 80 : 0);
      let i = 0;
      for (const c of hay){ if (c === query[i]) i++; if (i >= query.length) return 40; }
      return 0;
    }
    function wikiItems(q){
      if (typeof opts.wikiNotes !== 'function') return [];
      let all = [];
      try { all = opts.wikiNotes() || []; } catch (_) { all = []; }
      const scored = [];
      for (const n of all){
        const title = String((n && n.title) || '未命名笔记');
        const folder = String((n && n.folder) || '');
        const score = wikiScore(q, title, folder);
        if (score > 0) scored.push({ id: n.id, title, folder, score });
      }
      scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'zh'));
      return scored.slice(0, 20);
    }
    function wikiLinkText(item, items){
      const title = String(item.title || '未命名笔记').replace(/[\[\]\n]/g, '').trim() || '未命名笔记';
      const dup = items.filter(n => n.title === item.title).length > 1;
      if (dup && item.folder) return (item.folder + '/' + title).replace(/[\[\]\n]/g, '');
      return title;
    }
    function renderWikiList(){
      const items = wikiItems(wikiInput.value);
      wikiList.replaceChildren();
      if (!items.length){
        const empty = document.createElement('div');
        empty.className = 'lm-wiki-empty';
        empty.textContent = wikiInput.value.trim() ? '没有匹配的笔记' : '没有可引用的笔记';
        wikiList.appendChild(empty);
        wikiActive = 0;
        return items;
      }
      if (wikiActive >= items.length) wikiActive = items.length - 1;
      if (wikiActive < 0) wikiActive = 0;
      items.forEach((it, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lm-wiki-item' + (idx === wikiActive ? ' is-on' : '');
        btn.setAttribute('role', 'option');
        const t = document.createElement('span');
        t.className = 'lm-wiki-title';
        t.textContent = it.title;
        btn.appendChild(t);
        const sub = document.createElement('span');
        sub.className = 'lm-wiki-folder';
        sub.textContent = it.folder || '根目录';
        btn.appendChild(sub);
        btn.addEventListener('pointerdown', ev => ev.preventDefault());
        btn.addEventListener('click', () => acceptWiki(it, items));
        wikiList.appendChild(btn);
      });
      const on = wikiList.querySelector('.is-on');
      if (on) on.scrollIntoView({ block: 'nearest' });
      return items;
    }
    function positionWiki(rect){
      const margin = 8;
      wikiPop.style.left = '0px';
      wikiPop.style.top = '0px';
      const w = wikiPop.offsetWidth || 280;
      const h = wikiPop.offsetHeight || 200;
      let left = rect.left;
      let top = rect.bottom + 6;
      if (left + w > window.innerWidth - margin) left = window.innerWidth - margin - w;
      if (left < margin) left = margin;
      if (top + h > window.innerHeight - margin) top = Math.max(margin, rect.top - h - 6);
      wikiPop.style.left = left + 'px';
      wikiPop.style.top = top + 'px';
    }
    function caretClientRect(){
      const sel = window.getSelection();
      if (sel && sel.rangeCount){
        const r = sel.getRangeAt(0).cloneRange();
        r.collapse(true);
        const rect = r.getBoundingClientRect();
        if (rect && (rect.width || rect.height)) return rect;
      }
      const el = caretLineEl();
      if (el) return el.getBoundingClientRect();
      return { left: 16, top: 80, bottom: 100, width: 0, height: 20 };
    }
    function hideWiki(silent){
      wikiHold = false;
      wikiSession = null;
      wikiPop.hidden = true;
      if (silent) wikiDismissedAt = Date.now();
    }
    function wikiQueryAtCaret(){
      const info = caretLineInfo();
      if (!info) return null;
      const m = info.textBefore.match(/\[\[([^\]\n]*)$/);
      if (!m) return null;
      const off = globalOffset();
      if (off == null) return null;
      return { q: m[1], start: off - m[0].length, end: off };
    }
    function openWiki(hit){
      const rect = caretClientRect();
      wikiSession = { start: hit.start, end: hit.end, rect };
      wikiActive = 0;
      wikiPop.hidden = false;
      wikiInput.value = hit.q || '';
      renderWikiList();
      positionWiki(rect);
      wikiHold = true;
      wikiInput.focus();
      const n = wikiInput.value.length;
      try { wikiInput.setSelectionRange(n, n); } catch (_) {}
    }
    function syncWiki(){
      if (typeof opts.wikiNotes !== 'function') return;
      if (root.getAttribute('contenteditable') === 'false'){ hideWiki(); return; }
      if (Date.now() - wikiDismissedAt < 280) return;
      if (!wikiPop.hidden && wikiHold) return;
      const sel = window.getSelection();
      if (sel && sel.rangeCount && !sel.isCollapsed){ hideWiki(); return; }
      const cur = caretLineEl();
      if (cur && (cur.classList.contains('lm-code') || cur.classList.contains('lm-fence'))){ hideWiki(); return; }
      const hit = wikiQueryAtCaret();
      if (!hit){ hideWiki(); return; }
      if (!wikiPop.hidden && wikiSession && wikiSession.start === hit.start) return;
      openWiki(hit);
    }
    function acceptWiki(item, items){
      if (!wikiSession || !item) return;
      const list = items || wikiItems(wikiInput.value);
      const text = '[[' + wikiLinkText(item, list) + ']]';
      const start = wikiSession.start, end = wikiSession.end;
      hideWiki(true);
      root.focus();
      insertRawAt(start, text, end);
    }
    function closeWikiToEditor(){
      const end = wikiSession ? wikiSession.end : null;
      hideWiki(true);
      root.focus();
      if (end != null) restoreCaret(end);
    }
    wikiInput.addEventListener('input', () => {
      wikiActive = 0;
      renderWikiList();
      if (wikiSession && wikiSession.rect) positionWiki(wikiSession.rect);
    });
    wikiInput.addEventListener('keydown', e => {
      const items = wikiItems(wikiInput.value);
      if (e.key === 'ArrowDown'){
        e.preventDefault();
        wikiActive = Math.min(items.length - 1, wikiActive + 1);
        renderWikiList();
      } else if (e.key === 'ArrowUp'){
        e.preventDefault();
        wikiActive = Math.max(0, wikiActive - 1);
        renderWikiList();
      } else if (e.key === 'Enter'){
        e.preventDefault();
        if (items[wikiActive]) acceptWiki(items[wikiActive], items);
      } else if (e.key === 'Escape'){
        e.preventDefault();
        closeWikiToEditor();
      }
    });
    function onDocPointerDown(e){
      const t = e.target;
      if (!wikiPop.hidden && t && !wikiPop.contains(t)) hideWiki(true);
      if (!t || !root.contains(t)) return;
      const cb = t.closest && t.closest('.lm-cb');
      if (cb){
        e.preventDefault();
        toggleCheckbox(cb);
        return;
      }
      const wiki = t.closest && t.closest('.lm-wiki');
      if (wiki){
        e.preventDefault();
        wikiPress = wiki;
        return;
      }
      pointerDown = true;
    }
    function onPointerUp(e){
      if (wikiPress){
        const wiki = wikiPress;
        wikiPress = null;
        if (root.contains(wiki) && typeof opts.onWiki === 'function')
          opts.onWiki(wiki.dataset.wiki || wiki.textContent || '');
        return;
      }
      if (!pointerDown) return;
      pointerDown = false;
      syncSourceFromSelection();
    }

    root.addEventListener('input', (e) => {
      if (e && e.target && e.target.closest && e.target.closest('img')) return;
      pipeline();
    });
    root.addEventListener('beforeinput', e => {
      if (composing || e.isComposing) return;
      if (!e.data || e.inputType !== 'insertText') return;
      if (!applyMarkerText(e.data)) return;
      e.preventDefault();
    });
    root.addEventListener('keydown', onKeydown);
    root.addEventListener('paste', onPaste);
    root.addEventListener('copy', onCopy);
    root.addEventListener('cut', onCut);
    root.addEventListener('click', onClick);
    root.addEventListener('mousedown', e => {
      const t = e.target;
      /* 点复选框只切换勾选，不把光标送进「- [ ]」以免整行变成源码 */
      if (t.closest && t.closest('.lm-cb')){
        e.preventDefault();
        return;
      }
      if (t.closest && t.closest('.lm-code-tools, [data-lm-code-act], .lm-mermaid'))
        e.preventDefault();
      const fence = t.closest && t.closest('.lm-fence-open.is-mermaid-chart');
      if (fence && root.contains(fence) && !(t.closest && t.closest('[data-lm-code-act]')))
        e.preventDefault();
    });
    /* 本机图片拖入编辑区 → 上传并插入；笔记目录拖入 → [[标题]] */
    function dragTypes(dt){ return Array.from((dt && dt.types) || []); }
    root.addEventListener('dragover', e => {
      const types = dragTypes(e.dataTransfer);
      const note = types.includes('text/omni-note');
      const file = opts.uploadImage && types.includes('Files');
      if (!note && !file) return;
      if (note && root.getAttribute('contenteditable') === 'false') return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      root.classList.add('lm-drop');
    });
    root.addEventListener('dragleave', e => {
      if (e.relatedTarget && root.contains(e.relatedTarget)) return;
      root.classList.remove('lm-drop');
    });
    root.addEventListener('drop', e => {
      root.classList.remove('lm-drop');
      const types = dragTypes(e.dataTransfer);
      if (types.includes('text/omni-note') && root.getAttribute('contenteditable') !== 'false'){
        e.preventDefault();
        e.stopPropagation();
        let items = [];
        try { items = JSON.parse(e.dataTransfer.getData('text/omni-note') || '[]'); } catch (_) { items = []; }
        if (!Array.isArray(items) || !items.length) return;
        const md = items.map(n => {
          const title = String((n && n.title) || '未命名笔记').replace(/[\[\]\n]/g, '').trim() || '未命名笔记';
          return '[[' + title + ']]';
        }).join(' ');
        const pos = offsetFromPoint(e.clientX, e.clientY);
        insertRawAt(pos, md);
        root.focus();
        return;
      }
      const files = Array.from((e.dataTransfer || {}).files || [])
        .filter(f => /^image\//.test(f.type));
      if (!files.length || !opts.uploadImage) return;
      e.preventDefault();
      insertFiles(files, { x: e.clientX, y: e.clientY });
    });
    document.addEventListener('selectionchange', onSelChange);
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('pointerup', onPointerUp);
    root.addEventListener('compositionstart', () => { composing = true; });
    root.addEventListener('compositionend', () => { composing = false; pipeline(); });

    /* ---------- 选区包裹（工具栏加粗/斜体等）：有选区包住，无选区插入占位 ---------- */
    function wrapSelection(pre, suf, ph){
      const sel = window.getSelection();
      if (sel.rangeCount && !sel.isCollapsed && root.contains(sel.anchorNode)){
        const r = sel.getRangeAt(0);
        const s = rawOffset(r.startContainer, r.startOffset);
        const e = rawOffset(r.endContainer, r.endOffset);
        const wrapped = wrapMarkedSpan(serializeAll(), s, e, pre, suf);
        if (wrapped){
          ta.value = wrapped.raw;
          try { ta.dispatchEvent(new Event('input')); } catch (_) {}
          rebuild(wrapped.raw);
          restoreCaret(wrapped.caret);
          return true;
        }
      }
      const pos = (sel.rangeCount && root.contains(sel.anchorNode))
        ? rawOffset(sel.anchorNode, sel.anchorOffset) : serializeAll().length;
      const phText = ph || '';
      const raw = serializeAll();
      const next = raw.slice(0, pos) + pre + phText + suf + raw.slice(pos);
      ta.value = next;
      try { ta.dispatchEvent(new Event('input')); } catch (_) {}
      rebuild(next);
      if (phText){
        /* 光标落在占位符中间并选中它 */
        const r = document.createRange();
        const p1 = domPointAt(pos + pre.length);
        const p2 = domPointAt(pos + pre.length + phText.length);
        if (p1 && p2){
          r.setStart(p1.node, p1.offset);
          r.setEnd(p2.node, p2.offset);
          const s2 = window.getSelection();
          s2.removeAllRanges(); s2.addRange(r);
        } else restoreCaret(pos + pre.length);
      } else {
        restoreCaret(pos + pre.length);
      }
      root.focus();
      return true;
    }

    /* ---------- 当前行行首插入前缀（标题 / 列表 / 引用） ---------- */
    function lineInsert(prefix){
      let off = globalOffset();
      const tl = selTableLine();
      if (tl) off = tableEndOffset(tl);   // 光标在表格内：落到表格后的新行，避免插坏表格源码
      if (off == null) return;
      const arr = serializeAll().split('\n');
      let p = 0, li = 0;
      for (li = 0; li < arr.length; li++){
        if (off <= p + arr[li].length) break;
        p += arr[li].length + 1;
      }
      insertRawAt(p, prefix);
    }

    const inst = {
      refresh(){ rebuild(ta.value); },
      undo(){ if (histIdx > 0){ restoreHist(histIdx - 1); return true; } return false; },
      redo(){ if (histIdx < hist.length - 1){ restoreHist(histIdx + 1); return true; } return false; },
      wrapSelection,
      lineInsert,
      selectionRange: selectionRawRange,
      selectRange: selectRawRange,
      markRange,
      setValue(s){ ta.value = s; rebuild(s); try { ta.dispatchEvent(new Event('input')); } catch (e) {} },
      insertText(text){
        const tl = selTableLine();
        if (tl){ insertRawAt(tableEndOffset(tl), text); return; }  // 块级内容不插进表格内部，落在表格之后
        const rng = selectionRawRange();
        if (!rng){ insertRawAt(serializeAll().length, text); return; }
        insertRawAt(rng.start, text, rng.end);
      },
      scrollToLine(i){
        i = +i;
        if (!isFinite(i) || i < 0) return;
        let el = root.querySelector('[data-src-i="' + i + '"]');
        if (!el){
          const all = Array.from(root.querySelectorAll('[data-src-i]'));
          for (let k = all.length - 1; k >= 0; k--){
            if (+all[k].dataset.srcI <= i){ el = all[k]; break; }
          }
          el = el || all[0];
        }
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      },
      show(){ root.style.display = ''; ta.style.removeProperty('display'); ta.style.setProperty('display', 'none', 'important'); rebuild(ta.value); },
      hide(){ root.style.display = 'none'; ta.style.removeProperty('display'); },
      isShown(){ return root.style.display !== 'none'; },
      focus(){ root.focus(); },
      destroy(){
        alive = false;
        hideWiki();
        wikiPop.remove();
        root.remove(); ta.style.removeProperty('display');
        document.removeEventListener('selectionchange', onSelChange);
        document.removeEventListener('pointerdown', onDocPointerDown, true);
        document.removeEventListener('pointerup', onPointerUp);
      },
      el: root
    };
    rebuild(ta.value);
    return inst;
  }

  return { attach, highlightCode, nextExpandRange };
})();
window.LiveMD = LiveMD;
