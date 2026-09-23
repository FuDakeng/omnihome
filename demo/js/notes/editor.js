import { mdRender, mdFallback, mdOutline, outlineItemHtml, outlineBodyHtml, mdLineDiff, renderRevDiffHtml, _mdSlug } from './md.js';
import { S } from './state.js';
import { isMermaidLang, scheduleMermaid } from '../mermaid.js';

  function mermaidViewMap(box){
    if (!box) return new Map();
    if (!S.previewMermaidView.has(box)) S.previewMermaidView.set(box, new Map());
    return S.previewMermaidView.get(box);
  }
  function setPreviewMermaidView(pre, chart){
    pre.classList.toggle('is-mermaid-chart', chart);
    const btn = pre.querySelector('[data-md-code-act="view"]');
    if (btn){
      btn.textContent = chart ? '代码' : '图表';
      btn.title = chart ? '切换为代码' : '切换为图表';
      btn.setAttribute('aria-pressed', chart ? 'true' : 'false');
    }
    if (!chart) return;
    let host = pre.querySelector(':scope > .md-mermaid');
    if (!host){
      host = document.createElement('div');
      host.className = 'md-mermaid';
      host.setAttribute('role', 'img');
      host.setAttribute('aria-label', 'Mermaid 图表');
      host.innerHTML = '<div class="lm-mermaid-chart"></div><div class="lm-mermaid-msg" hidden></div>';
      pre.appendChild(host);
    }
    const code = pre.querySelector('code');
    scheduleMermaid(host, code ? code.textContent : '');
  }

  S.previewFoldSet = function(box){
    if (!box) return new Set();
    if (!S.previewFolded.has(box)) S.previewFolded.set(box, new Set());
    return S.previewFolded.get(box);
  };

  S.enhancePreviewFences = function(box){
    if (!box) return;
    const folded = S.previewFoldSet(box);
    const pres = Array.from(box.querySelectorAll('pre'));
    pres.forEach((pre, i) => {
      if (pre.dataset.codeUi === '1') return;
      pre.dataset.codeUi = '1';
      pre.classList.add('md-code');
      const code = pre.querySelector('code');
      const lang = (code && code.getAttribute('data-lang')) || '';
      const mmd = isMermaidLang(lang);
      const view = mmd && mermaidViewMap(box).get(i) === 'code' ? 'code' : 'chart';
      const tools = document.createElement('div');
      tools.className = 'md-code-tools';
      tools.innerHTML =
        (lang ? '<span class="md-code-lang">' + (window.App ? App.esc(lang) : lang) + '</span>' : '')
        + (mmd
          ? '<button type="button" class="lm-code-btn lm-view-btn" data-md-code-act="view" title="'
            + (view === 'chart' ? '切换为代码' : '切换为图表')
            + '" aria-pressed="' + (view === 'chart' ? 'true' : 'false') + '">'
            + (view === 'chart' ? '代码' : '图表') + '</button>'
          : '')
        + '<button type="button" class="lm-code-btn" data-md-code-act="copy" title="复制">'
        + '<svg class="ic"><use href="#i-copy"/></svg></button>'
        + '<button type="button" class="lm-code-btn" data-md-code-act="fold" title="折叠">'
        + '<svg class="ic"><use href="#i-chev-d"/></svg></button>';
      pre.insertBefore(tools, pre.firstChild);
      if (mmd) setPreviewMermaidView(pre, view === 'chart');
      if (folded.has(i)){
        pre.classList.add('is-folded');
        const fb = tools.querySelector('[data-md-code-act="fold"]');
        if (fb) fb.title = '展开';
      }
    });
  };

  document.addEventListener('mousedown', e => {
    if (e.target.closest && e.target.closest('.md-code-tools, [data-md-code-act]'))
      e.preventDefault();
  });

  document.addEventListener('click', e => {
    const btn = e.target.closest && e.target.closest('[data-md-code-act]');
    if (!btn) return;
    e.preventDefault();
    const pre = btn.closest('pre');
    if (!pre) return;
    const act = btn.dataset.mdCodeAct;
    if (act === 'copy'){
      const code = pre.querySelector('code');
      const text = code ? code.textContent : '';
      const done = () => { if (typeof showToast === 'function') showToast('已复制'); };
      if (navigator.clipboard && navigator.clipboard.writeText)
        navigator.clipboard.writeText(text).then(done).catch(done);
      else done();
    } else if (act === 'fold'){
      pre.classList.toggle('is-folded');
      const on = pre.classList.contains('is-folded');
      btn.title = on ? '展开' : '折叠';
      const box = pre.closest('.md-preview');
      if (box){
        const set = S.previewFoldSet(box);
        const idx = Array.from(box.querySelectorAll('pre')).indexOf(pre);
        if (on) set.add(idx); else set.delete(idx);
      }
    } else if (act === 'view'){
      const box = pre.closest('.md-preview') || pre.parentElement;
      const idx = Array.from(box.querySelectorAll('pre')).indexOf(pre);
      const chart = !pre.classList.contains('is-mermaid-chart');
      mermaidViewMap(box).set(idx, chart ? 'chart' : 'code');
      setPreviewMermaidView(pre, chart);
    }
  });

  S.highlightPreviewCode = function(box){
    if (!box) return;
    if (window.LiveMD && LiveMD.highlightCode){
      const esc = (window.App && App.esc) ? App.esc : s => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      box.querySelectorAll('pre code').forEach(el => {
        if (el.dataset.hl === '1') return;
        if (isMermaidLang(el.getAttribute('data-lang') || '')) return;
        el.dataset.hl = '1';
        el.innerHTML = LiveMD.highlightCode(esc(el.textContent || ''));
      });
    }
    S.enhancePreviewFences(box);
  };

  S.renderPreview = function(){
    $('#edPreview').innerHTML = mdRender($('#edSrc').value) ||
      '<p style="color:var(--om-text-3)">开始输入，右侧实时预览…</p>';
    S.highlightPreviewCode($('#edPreview'));
    S.hydrateImages($('#edPreview'));
    try { $('#edPreview').dispatchEvent(new CustomEvent('omni:preview-rendered', { bubbles: true })); } catch (_) {}
  };

  S.updateStat = function(){
    const n = $('#edSrc').value.length;
    $('#edStat').textContent = n + ' 字';
  };

  /* ---------- 编辑模式（编辑=原地实时渲染 / 分屏 / 预览） ---------- */
  S.setMode = function(mode){
    S.currentMode = mode;
    $$('#edModeSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.edMode === mode));
    const src = $('#edSrc'), pv = $('#edPreview');
    const useLive = !!S.liveEd && mode === 'edit';
    if (S.liveEd){ useLive ? S.liveEd.show() : S.liveEd.hide(); }
    src.style.display = (mode === 'preview' || useLive) ? 'none' : '';
    pv.style.display = mode === 'edit' ? 'none' : '';
    const body = $('.ed-body');
    if (body) body.classList.toggle('single', mode !== 'split');
    if (!useLive) S.renderPreview();
    S.hydrateNow();
  };

  /* #edSrc 输入的统一处理（分屏直编与实时渲染共用） */
  S.onSrcInput = function(){
    S.dirty = true;
    S.renderPreview();
    S.updateStat();
    $('#edFootTime').textContent = '编辑中…';
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(S.save, 900);
  };

  S.initLiveEditor = function(){
    const ta = $('#edSrc');
    if (!ta || !window.LiveMD) return;
    /* 幂等：重复调用先销毁旧实例，避免页内出现两个实时编辑块（
       旧块会抢焦点/选区并破坏分屏布局） */
    if (S.liveEd){ try { S.liveEd.destroy(); } catch (_) {} S.liveEd = null; }
    S.liveEd = LiveMD.attach(ta, {
      uploadImage: f => S.uploadImage(f),
      onImageError: e => showToast('图片上传失败：' + (e.message || e), 'err'),
      afterRebuild: el => S.hydrateImages(el),
      wikiNotes: () => (S.idx || []).filter(n => n && !n.deleted && S.noteVault(n) === S.currentVault).map(n => ({
        id: n.id,
        title: n.title || '未命名笔记',
        folder: n.folder || '',
      })),
      onWiki: (target) => {
        const t = String(target || '').trim();
        if (!t) return;
        const list = S.idx || [];
        const inVault = n => S.noteVault(n) === S.currentVault;
        const label = n => (n.folder ? n.folder + '/' : '') + (n.title || '未命名笔记');
        let n = list.find(x => inVault(x) && label(x) === t);
        if (!n) n = list.find(x => inVault(x) && (x.title || '未命名笔记') === t);
        if (!n) n = list.find(x => (x.title || '未命名笔记') === t || label(x) === t);
        if (n) S.open(n.id);
        else showToast('未找到笔记：' + t);
      },
    });
    S.liveEd.hide();   // 默认显示状态由 setMode 决定
  };

  /* ---------- 图片上传与插入（按钮选择 / 粘贴 / 拖拽共用后端接口） ---------- */
  S.uploadImage = async function(f){
    const fd = new FormData();
    fd.append('file', f);
    const d = await API.upload('/api/notes/assets', fd);
    S.refreshAssets();   // 新附件自动归档进附件分区
    return d.url;
  };

  S.insertImages = async function(files){
    const parts = [];
    for (const f of files){
      try {
        const url = await S.uploadImage(f);
        parts.push(`![${(f.name || 'image').replace(/[\[\]()]/g, '')}](${url})`);
      } catch (e) { showToast('图片上传失败：' + e.message, 'err'); }
    }
    if (!parts.length) return;
    const md = '\n' + parts.join('\n');
    if (S.liveEd && S.liveEd.isShown()){ S.liveEd.insertText(md); return; }
    const ta = $('#edSrc');
    const { selectionStart: s, value: v } = ta;
    ta.value = v.slice(0, s) + md + v.slice(s);
    ta.dispatchEvent(new Event('input'));
    ta.focus();
  };

