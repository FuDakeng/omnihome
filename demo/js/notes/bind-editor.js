import { mdRender, mdFallback, mdOutline, outlineItemHtml, outlineBodyHtml, mdLineDiff, renderRevDiffHtml, _mdSlug } from './md.js';
import { S } from './state.js';

S.bindEditor = function () {/* ---------- 工具条：快捷格式（实时渲染 / 源码双模式，均可撤销） ---------- */
    const imgInput = document.createElement('input');
    imgInput.type = 'file'; imgInput.accept = 'image/*'; imgInput.multiple = true;
    imgInput.style.display = 'none';
    document.body.appendChild(imgInput);
    imgInput.addEventListener('change', () => {
      const files = Array.from(imgInput.files || []);
      imgInput.value = '';
      if (files.length) S.insertImages(files);
    });

    const ta = $('#edSrc');
    const liveOn = () => S.liveEd && S.liveEd.isShown();

    /* 源码模式：用 execCommand 插入，浏览器原生撤销栈保留（Ctrl+Z 可回退） */
    function srcInsert(text){
      ta.focus();
      document.execCommand('insertText', false, text);
      ta.dispatchEvent(new Event('input'));
    }
    /* 包裹选中文本；无选中时插入占位符并选中占位符 */
    function wrapSel(pre, suf, placeholder){
      const ph = placeholder || '';
      if (liveOn()){ S.liveEd.wrapSelection(pre, suf, ph); return; }
      const s = ta.selectionStart, e = ta.selectionEnd;
      const sel = ta.value.slice(s, e);
      const mid = sel || ph;
      ta.focus();
      document.execCommand('insertText', false, pre + mid + suf);
      const pos = s + pre.length;
      if (!sel && ph) ta.setSelectionRange(pos, pos + ph.length);
      else if (sel) ta.setSelectionRange(pos, pos + mid.length);
      ta.dispatchEvent(new Event('input'));
    }
    /* 当前行首插入前缀（标题 / 列表 / 引用 / 任务） */
    function linePrefix(prefix){
      if (liveOn()){ S.liveEd.lineInsert(prefix); return; }
      const s = ta.selectionStart;
      const ls = ta.value.lastIndexOf('\n', s - 1) + 1;   // 光标所在行行首
      ta.focus();
      ta.setSelectionRange(ls, ls);
      document.execCommand('insertText', false, prefix);
      ta.setSelectionRange(ls + prefix.length, ls + prefix.length);
      ta.dispatchEvent(new Event('input'));
    }
    /* 光标处插入整块 Markdown */
    function insertRaw(md){
      if (liveOn()){ S.liveEd.insertText(md); return; }
      srcInsert(md);
    }

    /* ---------- 大纲 ---------- */
    function renderOutline(){
      const body = $('#mdOutlineBody');
      if (!body) return;
      body.innerHTML = outlineBodyHtml(ta.value);
    }
    function openOutline(){
      const p = $('#mdOutlinePanel');
      if (!p) return;
      renderOutline();
      p.hidden = false;   // 仅首次去掉初始 hidden 属性，之后由宽度动画接管
      /* 下一帧再上 open 类，display 恢复后才能触发过渡动画 */
      requestAnimationFrame(() => p.classList.add('open'));
      $('#mdOutlineBtn')?.classList.add('on');
    }
    function closeOutline(){
      const p = $('#mdOutlinePanel');
      if (!p) return;
      /* 不设 hidden：宽度塌缩为 0 的过渡同时驱动编辑器平滑变宽，
         若设 hidden 会触发 display:none 导致布局瞬跳 */
      p.classList.remove('open');
      $('#mdOutlineBtn')?.classList.remove('on');
    }
    function toggleOutline(){
      $('#mdOutlinePanel')?.classList.contains('open') ? closeOutline() : openOutline();
    }
    /* 大纲按钮由 ACT['outline'] 统一分发，不在此单独绑定，避免一次点击触发两次开关 */
    $('#mdOutlineClose')?.addEventListener('click', closeOutline);
    $('#mdOutlineBody')?.addEventListener('click', e => {
      const it = e.target.closest('[data-target]');
      if (!it) return;
      S.jumpToHeading(it.dataset.target, it.dataset.line, S.liveEd);
    });

    /* ---------- 查找 / 替换 ---------- */
    let findMatches = [], findIdx = -1;
    let findScope = null, findScopePending = null;
    function readEditorSelection(){
      if (liveOn() && S.liveEd && typeof S.liveEd.selectionRange === 'function'){
        const rng = S.liveEd.selectionRange();
        if (rng && rng.end > rng.start) return { start: rng.start, end: rng.end };
        return null;
      }
      const s = ta.selectionStart, e = ta.selectionEnd;
      if (typeof s === 'number' && e > s) return { start: s, end: e };
      return null;
    }
    function activeFindScope(){
      if (!findScope || !(findScope.end > findScope.start)) return null;
      const n = ta.value.length;
      return { start: Math.max(0, Math.min(n, findScope.start)), end: Math.max(0, Math.min(n, findScope.end)) };
    }
    function updateFindScopeHint(){
      const el = $('#mdFindScope');
      if (!el) return;
      const sc = activeFindScope();
      el.hidden = !sc;
    }
    function collectMatches(q){
      const v = ta.value, out = [];
      if (!q) return out;
      const sc = activeFindScope();
      const from = sc ? sc.start : 0;
      const to = sc ? sc.end : v.length;
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      re.lastIndex = from;
      let m;
      while ((m = re.exec(v)) != null){
        if (m.index + q.length > to) break;
        out.push(m.index);
        if (out.length >= 500) break;
      }
      return out;
    }
    function clearFindMark(){
      document.querySelectorAll('.lm-find').forEach(s => {
        const p = s.parentNode;
        if (!p) return;
        while (s.firstChild) p.insertBefore(s.firstChild, s);
        s.remove();
        try { p.normalize(); } catch (_) {}
      });
    }
    function clearScopeMark(){
      document.querySelectorAll('.lm-find-scope').forEach(s => {
        const p = s.parentNode;
        if (!p) return;
        while (s.firstChild) p.insertBefore(s.firstChild, s);
        s.remove();
        try { p.normalize(); } catch (_) {}
      });
    }
    function markScopeSpans(){
      clearFindMark();
      clearScopeMark();
      const sc = activeFindScope();
      if (!sc) return;
      if (liveOn() && S.liveEd && typeof S.liveEd.markRange === 'function')
        S.liveEd.markRange(sc.start, sc.end, 'lm-find-scope');
    }
    function keepEditorSelection(e){
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (t.closest('.ed-btn, .seg-btn, .md-findbar, #mdFindBtn')) e.preventDefault();
    }
    /* 全部匹配高亮：逐个文本节点内包裹 .lm-find（无 dataset，不影响序列化） */
    function markFindSpans(q){
      clearFindMark();
      if (!q) return;
      const boxes = [];
      if (liveOn()) boxes.push(S.liveEd.el);
      const pv = $('#edPreview');
      const sc = activeFindScope();
      if (pv && pv.style.display !== 'none' && !sc) boxes.push(pv);
      const ql = q.toLowerCase();
      const lineOffs = [];
      let srcLines = null;
      if (sc && liveOn()){
        srcLines = ta.value.split('\n');
        let p = 0;
        for (let i = 0; i < srcLines.length; i++){ lineOffs[i] = p; p += srcLines[i].length + 1; }
      }
      for (const box of boxes){
        const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT, {
          acceptNode(n){
            const v = n.nodeValue;
            if (!v || v.indexOf(ql) < 0 && v.toLowerCase().indexOf(ql) < 0) return NodeFilter.FILTER_REJECT;
            const p = n.parentElement;
            if (!p || p.closest('button, .lm-find, .lm-tbar, .lm-sel, .lm-drag, .lm-hint, .lm-more, .lm-rowh, .lm-colh, .lm-code-tools, .md-code-tools')) return NodeFilter.FILTER_REJECT;
            if (sc && liveOn() && srcLines){
              const line = p.closest('.lm-line, .lm-table');
              const si = line && line.dataset ? +line.dataset.srcI : NaN;
              if (isFinite(si) && lineOffs[si] != null){
                const ls = lineOffs[si], le = ls + (srcLines[si] || '').length;
                if (le < sc.start || ls >= sc.end) return NodeFilter.FILTER_REJECT;
              }
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        });
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        for (const node of nodes){
          const lower = node.nodeValue.toLowerCase();
          const pos = [];
          let from = 0, i;
          while ((i = lower.indexOf(ql, from)) >= 0 && pos.length < 200){ pos.push(i); from = i + q.length; }
          let cur = node;
          for (let k = pos.length - 1; k >= 0; k--){   // 倒序包裹，避免分割影响前面偏移
            const tail = cur.splitText(pos[k]);
            tail.splitText(q.length);
            const span = document.createElement('span');
            span.className = 'lm-find';
            tail.parentNode.replaceChild(span, tail);
            span.appendChild(tail);
          }
        }
      }
    }
    /* 当前匹配突出：全文扫描算序号 → 按文档顺序取第 k 个高亮 */
    function markCurrent(pos, q){
      if (!liveOn()) return;
      const spans = S.liveEd.el.querySelectorAll('.lm-find');
      spans.forEach(s => s.classList.remove('lm-find-cur'));
      let k = findIdx;
      if (k < 0 || !activeFindScope()){
        const v = ta.value, low = v.toLowerCase(), ql = q.toLowerCase();
        k = 0; let i = 0, j;
        while ((j = low.indexOf(ql, i)) >= 0 && j < pos){ k++; i = j + q.length; }
      }
      const cur = spans[k];
      if (cur){
        cur.classList.add('lm-find-cur');
        try { cur.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
      }
    }
    let markTimer = 0;
    function scheduleMark(){   // 输入过程中防抖重标，避免每键一次全量包裹
      clearTimeout(markTimer);
      markTimer = setTimeout(() => {
        if ($('#mdFindBar') && !$('#mdFindBar').hidden){
          markScopeSpans();
          markFindSpans($('#mdFindInput').value);
        }
      }, 160);
    }
    function doFind(dir){   // 0=重新定位第一个 1=下一个 -1=上一个（循环跳转）
      const q = $('#mdFindInput').value;
      findMatches = collectMatches(q);
      const cnt = $('#mdFindCount');
      markScopeSpans();
      if (!q || !findMatches.length){
        findIdx = -1;
        cnt.textContent = '0 / 0';
        clearFindMark();
        updateFindScopeHint();
        return;
      }
      if (dir === 0) findIdx = 0;
      else findIdx = (((findIdx < 0 ? 0 : findIdx + dir) % findMatches.length) + findMatches.length) % findMatches.length;
      const pos = findMatches[findIdx];
      const sc = activeFindScope();
      if (!liveOn()){
        if (sc) ta.setSelectionRange(sc.start, sc.end);
        else ta.setSelectionRange(pos, pos + q.length);
      }
      markFindSpans(q);
      markCurrent(pos, q);
      cnt.textContent = (findIdx + 1) + ' / ' + findMatches.length;
      updateFindScopeHint();
    }
    function doReplaceOne(){
      const q = $('#mdFindInput').value, rp = $('#mdReplaceInput').value;
      if (!q || findIdx < 0 || findIdx >= findMatches.length) return;
      const v = ta.value, pos = findMatches[findIdx];
      const next = v.slice(0, pos) + rp + v.slice(pos + q.length);
      const delta = rp.length - q.length;
      if (findScope && findScope.end > findScope.start) findScope.end += delta;
      ta.value = next;
      ta.dispatchEvent(new Event('input'));
      if (liveOn()) S.liveEd.setValue(next);
      doFind(1);
      if (findMatches.length === 0) showToast('已无匹配项');
    }
    function doReplaceAll(){
      const q = $('#mdFindInput').value, rp = $('#mdReplaceInput').value;
      if (!q) return;
      const v = ta.value;
      const sc = activeFindScope();
      let next, n = 0;
      if (sc){
        const slice = v.slice(sc.start, sc.end);
        const parts = slice.split(q);
        n = Math.max(0, parts.length - 1);
        const mid = parts.join(rp);
        next = v.slice(0, sc.start) + mid + v.slice(sc.end);
        findScope = { start: sc.start, end: sc.start + mid.length };
      } else {
        const parts = v.split(q);
        n = Math.max(0, parts.length - 1);
        next = parts.join(rp);
      }
      if (next === v){ showToast('无匹配项'); return; }
      ta.value = next;
      ta.dispatchEvent(new Event('input'));
      if (liveOn()) S.liveEd.setValue(next);
      findMatches = []; findIdx = -1;
      $('#mdFindCount').textContent = '0 / 0';
      updateFindScopeHint();
      showToast(sc ? `已替换选区内 ${n} 处` : '已全部替换');
    }
    function openFindBar(){
      const bar = $('#mdFindBar');
      if (!bar) return;
      if (bar.hidden){
        findScope = findScopePending || readEditorSelection();
        findScopePending = null;
        bar.hidden = false;
        $('#mdFindBtn')?.classList.add('on');
        updateFindScopeHint();
        markScopeSpans();
        $('#mdFindInput').focus();
        doFind(0);
      } else closeFindBar();
    }
    function closeFindBar(){
      const sc = activeFindScope();
      $('#mdFindBar').hidden = true;
      $('#mdFindBtn')?.classList.remove('on');
      findScopePending = null;
      clearFindMark();
      clearScopeMark();
      findScope = null;
      updateFindScopeHint();
      if (liveOn()){
        S.liveEd.focus();
        if (sc && typeof S.liveEd.selectRange === 'function') S.liveEd.selectRange(sc.start, sc.end);
      } else {
        ta.focus();
        if (sc) ta.setSelectionRange(sc.start, sc.end);
      }
    }
    /* 查找按钮由 ACT['find'] 统一分发，不在此单独绑定（避免一次点击开又关） */
    $('.ed-bar')?.addEventListener('mousedown', e => {
      if (e.target.closest && e.target.closest('#mdFindBtn'))
        findScopePending = readEditorSelection();
      keepEditorSelection(e);
    });
    $('#mdFindBar')?.addEventListener('mousedown', e => {
      const rng = readEditorSelection();
      if (rng) findScope = rng;
      keepEditorSelection(e);
      if (rng){
        updateFindScopeHint();
        requestAnimationFrame(markScopeSpans);
      }
    });
    $('#mdFindClose')?.addEventListener('click', closeFindBar);
    $('#mdFindNext')?.addEventListener('click', () => doFind(1));
    $('#mdFindPrev')?.addEventListener('click', () => doFind(-1));
    $('#mdFindInput')?.addEventListener('input', () => { findIdx = -1; doFind(0); });
    $('#mdFindInput')?.addEventListener('keydown', e => {
      if (e.key === 'Enter'){ e.preventDefault(); doFind(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') closeFindBar();
    });
    /* 实时编辑器重建后（输入/撤销等）高亮会随之销毁，防抖重打 */
    document.addEventListener('omni:livemd-rebuild', e => {
      if (!liveOn() || e.target !== S.liveEd.el) return;
      scheduleMark();
    });
    /* 预览重渲染后同样重打 */
    document.addEventListener('omni:preview-rendered', () => {
      if ($('#mdFindBar') && !$('#mdFindBar').hidden){
        markScopeSpans();
        markFindSpans($('#mdFindInput').value);
      }
    });
    $('#mdReplaceOne')?.addEventListener('click', doReplaceOne);
    $('#mdReplaceAll')?.addEventListener('click', doReplaceAll);

    /* ---------- 工具栏按钮分发 ---------- */
    const ACT = {
      'bold':        () => wrapSel('**', '**', '加粗文本'),
      'italic':      () => wrapSel('*', '*', '斜体文本'),
      'strike':      () => wrapSel('~~', '~~', '删除线文本'),
      'inline-code': () => wrapSel('`', '`', 'code'),
      'h1':          () => linePrefix('# '),
      'h2':          () => linePrefix('## '),
      'h3':          () => linePrefix('### '),
      'ul':          () => linePrefix('- '),
      'ol':          () => linePrefix('1. '),
      'task':        () => linePrefix('- [ ] '),
      'quote':       () => linePrefix('> '),
      'code':        () => wrapSel('```\n', '\n```', '代码'),
      'link':        () => wrapSel('[', '](https://)', '链接文本'),
      'image':       () => imgInput.click(),
      'table':       () => insertRaw('\n| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n|  |  |  |\n'),
      'outline':     () => toggleOutline(),
      'find':        () => openFindBar(),
    };
    $$('.ed-btn').forEach(btn => btn.addEventListener('click', () => {
      const fn = ACT[btn.dataset.act];
      if (fn) fn();
    }));

    /* ---------- 撤销 / 重做（实时渲染模式接管；源码模式交给 textarea 原生） ---------- */
    document.addEventListener('keydown', e => {
      const k = String(e.key || '').toLowerCase();
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (k === 'a' && !e.shiftKey){
        const t = e.target;
        if (t && t.tagName === 'TEXTAREA' && (t.id === 'edSrc' || t.id === 'kbShareSrc') && !t.readOnly){
          e.preventDefault();
          const next = window.LiveMD && LiveMD.nextExpandRange
            ? LiveMD.nextExpandRange(t.value, t.selectionStart, t.selectionEnd)
            : null;
          if (next) t.setSelectionRange(next.start, next.end);
        }
        return;
      }
      if (!liveOn()) return;
      if (k === 'z'){
        if (e.shiftKey){ if (S.liveEd.redo()) e.preventDefault(); }
        else if (S.liveEd.undo()) e.preventDefault();
      } else if (k === 'y'){
        if (S.liveEd.redo()) e.preventDefault();
      }
    });};
