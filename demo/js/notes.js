/* ============================================================
   OmniDesk · 知识库（Markdown 笔记管理）
   树状目录（文件夹 + 笔记） + 原地实时渲染编辑 / 分屏 / 预览 + 自动保存。
   存储：每篇笔记一个 .md 文件（服务端）；
   常驻笔记（今日计划 / 生词本）删除后由后端自动重建。
   ============================================================ */
const Notes = (() => {
  let idx = [];            // [{id,title,tags,folder,pinned,updated}]
  let folders = [];        // [文件夹名]
  let currentId = null;
  let currentMode = 'split';
  let currentFolder = '';  // 新建笔记的默认文件夹（最近点选的）
  const collapsed = new Set();
  let dirty = false;
  let saveTimer = null;
  let liveEd = null;       // LiveMD 实例（原地实时渲染）
  let selNotes = new Set();    // ctrl/cmd 多选：笔记 id 集合
  let selFolders = new Set();  // ctrl/cmd 多选：文件夹路径集合
  let selAssets = new Set();   // ctrl/cmd 多选：附件名集合（拖动可批量引用入编辑区）
  let selMode = false;         // 显式多选模式：开启后普通点击即勾选（免按 ⌘/Ctrl）
  let dragState = null;        // 当前拖拽 {kind: 'note'|'folder', ids: []}
  let assets = [];             // 附件分区清单 [{name, type, size, ts}]
  let openTabs = [];           // 多笔记标签页：已打开笔记 id 的有序列表，末位为当前页候选
  const TABS_KEY = 'omni.kb.tabs';   // 标签页持久化，刷新后恢复上次打开的笔记

  /* 系统内置文件夹：每日计划/灵感速记不可删不可挪（与后端常量一致） */
  const PLAN_FOLDER = '每日计划',
        QUICK_FOLDER = '灵感速记';
  const PIN_KEY = 'omni.kb.pinned.hidden';
  const ASSET_KEY = 'omni.kb.assets.hidden';
  const SYNC_KEY = 'omni.kb.sync.hidden';   // 「同步笔记」分区折叠状态
  let trash = [];                        // 当前加载的回收站条目（弹层打开时拉取）
  let trashDays = null;                  // 回收站保留天数（后端下发；null=未知）
  const isPlan = f => f === PLAN_FOLDER || f.startsWith(PLAN_FOLDER + '/');
  const isQuick = f => f === QUICK_FOLDER || f.startsWith(QUICK_FOLDER + '/');
  const isBuiltin = f => isPlan(f) || isQuick(f);
  const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB'
    : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';

  /* ---------- Markdown 渲染 ----------
     主路径 marked（本地 vendor，GFM 全支持：表格 / 参考链接 / 自动链接 / 任务列表 / 删除线）
     兜底 mdFallback（本地与 CDN 都失败时，覆盖常用语法）
     标题自动加 id 锚点，供大纲按钮跳转。 */

  const _mdSlug = s => (String(s == null ? '' : s)
    .replace(/<[^>]*>/g, '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')) || 'sec';

  /* ---------- marked 配置（v12 renderer 签名：heading(text,level,raw)） ---------- */
  /* 每次 parse 都新建 renderer：标题计数按「单次文档」算，避免跨多次渲染累积出 h-x-3 */
  function _mdMakeRenderer(App){
    const esc = s => App.esc(s == null ? '' : String(s));
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
  function mdRender(src, ctx){
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
  function mdFallback(md, App){
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
  function mdOutline(src){
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

  /* ---------- 附件分区 ---------- */
  async function loadAssets(){
    try { assets = (await API.get('/api/notes/assets')).assets || []; }
    catch (e) { assets = []; }
  }
  /* 上传成功后刷新附件分区清单 */
  function refreshAssets(){ loadAssets().then(renderTree); }

  /* 点击附件：把引用插入当前笔记（可在任意 .md 中显示）
     拖动到编辑区：drop 时在光标位置插入 */
  function insertAssetRef(name){
    if (!currentId){ showToast('请先打开一篇笔记，再插入附件引用', 'err'); return; }
    const alt = name.replace(/[\[\]()]/g, '');
    const md = '![' + alt + '](/api/notes/assets/' + encodeURIComponent(name) + ')';
    if (liveEd && liveEd.isShown()){ liveEd.insertText('\n' + md + '\n'); showToast('已插入附件引用'); return; }
    const ta = $('#edSrc');
    ta.value = ta.value.replace(/\s+$/, '') + '\n' + md + '\n';
    ta.dispatchEvent(new Event('input'));
    showToast('已插入附件引用');
  }

  /* 导入 Markdown / zip：弹文件选择 → POST → 提示并刷新 */
  function importMd(){
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.zip,.markdown';
    input.style.display = 'none';
    input.onchange = async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      try {
        const r = await fetch('/api/notes/import-md', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + API.getToken() },
          body: fd,
        });
        if (!r.ok) throw new Error((await r.json()).detail || ('HTTP ' + r.status));
        const d = await r.json();
        showToast(`导入完成：${d.imported} 个${d.skipped ? '（跳过 '+d.skipped+' 个非 .md）' : ''}`);
        await load();
      } catch (e) { showToast('导入失败：' + e.message, 'err'); }
    };
    document.body.appendChild(input);
    input.click();
  }

  /* 点击附件图片 → 灯箱预览；点击删除按钮 → 删除附件 */
  function showAssetPreview(name){
    const url = '/api/notes/assets/' + encodeURIComponent(name);
    const lb = $('#assetLightbox');
    lb.querySelector('img').src = url;
    lb.dataset.name = name;
    lb.hidden = false;                       // HTML 默认带 hidden 属性，必须先去掉
    lb.classList.add('open');
  }
  function closeAssetPreview(){
    const lb = $('#assetLightbox');
    lb.classList.remove('open');
    lb.hidden = true;                        // 恢复 hidden，关掉 [.asset-lightbox[hidden]] 的 display:none
  }
  async function deleteAsset(name){
    const ok = await App.confirmModal({
      title: '删除附件？',
      sub: `「${name}」删除后，引用该附件的笔记将出现裂图，且无法撤销。`,
      okText: '删除', danger: true,
    });
    if (!ok) return;
    try {
      await API.del('/api/notes/assets/' + encodeURIComponent(name));
      showToast('附件已删除');
      refreshAssets();
      closeAssetPreview();
    } catch (e) { showToast(e.message, 'err'); }
  }

  /* ---------- 附件图片水合：fetch 带鉴权头 → data URL ----------
     <img> 裸请求不带 Authorization 会被 401 拦截成裂图，
     这里改为 JS 携带凭证取回后转 data URL，彻底规避鉴权裂图。 */
  const hydrated = new WeakSet();
  function hydrateImages(box){
    if (!box) return;
    box.querySelectorAll('img').forEach(img => {
      /* data-asset-src 承载原始附件地址（如目录缩略图）：src 初始留空，
         避免浏览器先发裸请求撞 401 触发 onerror 变 📎 */
      let s = img.getAttribute('data-asset-src') || img.getAttribute('src') || '';
      if (!s.startsWith('/api/notes/assets/') || hydrated.has(img)) return;
      hydrated.add(img);
      s = s.split('?')[0];   // 去掉旧式 token 参数，统一走带凭证的 fetch
      fetch(s, { headers: { Authorization: 'Bearer ' + API.getToken() } })
        .then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); })
        .then(b => {
          const rd = new FileReader();
          rd.onload = () => {
            img.removeAttribute('onerror');   // data URL 不会失败，去掉 📎 兜底防误触
            img.src = rd.result;
          };
          rd.readAsDataURL(b);
        })
        .catch(() => {});   // 失败保持占位，下次水合重试
    });
  }
  /* 对当前笔记可见的编辑 / 预览区持续水合（覆盖实时渲染重建时机） */
  let hyTimer = 0;
  function hydrateNow(){
    clearInterval(hyTimer);
    const run = () => {
      if (liveEd && liveEd.isShown()) hydrateImages(liveEd.el);
      const pv = $('#edPreview');
      if (pv && pv.style.display !== 'none') hydrateImages(pv);
    };
    run();
    hyTimer = setInterval(run, 800);
    setTimeout(() => clearInterval(hyTimer), 3200);
  }

  /* ---------- 加号小菜单（选择新建笔记 / 文件夹） ---------- */
  function kbMenu(btn, items){
    document.querySelectorAll('.kb-menu').forEach(m => m.remove());
    const menu = document.createElement('div');
    menu.className = 'kb-menu';
    items.forEach(([label, icon, fn]) => {
      const b = document.createElement('button');
      b.innerHTML = `<svg class="ic"><use href="#${icon}"/></svg>${label}`;
      b.addEventListener('click', () => { menu.remove(); fn(); });
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    let top = r.bottom + 6;
    if (top + menu.offsetHeight > innerHeight - 8) top = r.top - menu.offsetHeight - 6;
    menu.style.left = Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = top + 'px';
    setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  }
  function openKbMenu(btn, folder){
    kbMenu(btn, [
      ['新建笔记', 'i-note', () => create(folder)],
      ['新建文件夹', 'i-folder', () => newFolder(folder)],
    ]);
  }

  /* ---------- 快速删除横条（拖入即删，多选批量） ---------- */
  function showTrash(){
    const t = $('#kbTrash'); if (!t || !dragState) return;
    $('#kbTrashHint').textContent = dragState.kind === 'note'
      ? `拖到此处删除 ${dragState.ids.length} 篇笔记`
      : `拖到此处删除 ${dragState.ids.length} 个文件夹（笔记上移一层）`;
    t.hidden = false;
  }
  function hideTrash(){
    const t = $('#kbTrash'); if (!t) return;
    t.hidden = true; t.classList.remove('drop-del');
  }

  /* ---------- 加载 ---------- */
  async function load(){
    try {
      const d = await API.get('/api/notes');
      idx = d.notes || [];
      folders = d.folders || [];
      await loadAssets();
      idx.sort((a, b) => (b.updated || 0) - (a.updated || 0));
      /* trashCount 用后端返回值同步头部（无需展开回收站） */
      if (typeof d.trashCount === 'number'){
        try { localStorage.setItem('om_trash_count', String(d.trashCount)); } catch (_) {}
        const badge = $('#kbTrashBadge');
        if (badge){ badge.textContent = String(d.trashCount); badge.hidden = !d.trashCount; }
      }
      /* 恢复上次打开的标签页（刷新/切视图后），过滤已删除的笔记 */
      try {
        const saved = JSON.parse(localStorage.getItem(TABS_KEY) || '[]');
        openTabs = saved.filter(id => idx.some(n => n.id === id));
      } catch (_) { openTabs = []; }
      persistTabs();
      renderTree();
      const lastTab = openTabs[openTabs.length - 1];
      if (!currentId && lastTab) open(lastTab);
      else if (!currentId && idx.length) open(idx[0].id);
      /* 重新进入视图时重拉当前笔记正文，覆盖仪表盘速记等外部更新 */
      else if (currentId && idx.some(n => n.id === currentId)) open(currentId);
      /* 本地同步钩子：load() 是所有站点侧变更（建/删/改名/导入/移动）的收敛点，
         防抖触发双向对账；reconcile 内部回调 Notes.load 时由 lsLoading 标志抑制回环 */
      if (window.LocalSync) LocalSync.onSiteChanged();
      /* 初始化回收站保留天数缓存（供删除提示显示真实天数；仅首次拉） */
      if (trashDays === null){
        API.get('/api/notes/trash').then(d => {
          trashDays = (d.trashDays === 0 || d.trashDays) ? d.trashDays : 30;
          trash = d.notes || [];
          try { localStorage.setItem('om_trash_count', String(trash.length)); } catch (_) {}
          const badge = $('#kbTrashBadge');
          if (badge){ badge.textContent = String(trash.length); badge.hidden = !trash.length; }
        }).catch(() => {});
      }
    } catch (e) { /* 未登录或网络异常，忽略 */ }
  }

  function relTime(ts){
    const diff = Date.now() / 1000 - ts;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    if (diff < 604800) return Math.floor(diff / 86400) + ' 天前';
    return new Date(ts * 1000).toLocaleDateString('zh-CN');
  }

  /* ---------- 树状目录渲染（按设计图：图标 + 标题 + 修改日期，单行） ---------- */
  function noteItemHtml(n, depth){
    const pinned = n.pinned;
    /* 只读笔记标题旁挂小锁；悬浮时日期位换成 ⋯ 操作按钮（弹菜单，不遮挡标题文本） */
    const lock = n.readonly ? '<svg class="ic ni-icon" style="color:var(--om-text-3);width:11px;height:11px"><use href="#i-lock"/></svg>' : '';
    /* 嵌套层级：嵌套在多级文件夹里的笔记行也用 inline margin-left 与兄弟文件夹行对齐（v0.2.23 加强） */
    const extraPad = (depth || 0) * 14;
    return `
      <button class="note-item${n.id === currentId ? ' active' : ''}${selNotes.has(n.id) ? ' kb-selected' : ''}" data-note-id="${n.id}"${pinned ? '' : ' draggable="true"'}>
        <svg class="ic ni-icon"><use href="${pinned ? '#i-star' : '#i-note'}"/></svg>${lock}
        <span class="ni-title" style="margin-left:${extraPad}px">${App.esc(n.title || '未命名笔记')}</span>
        <span class="ni-date">${relTime(n.updated)}</span>
        <span class="ni-act" data-note-act="${n.id}" title="笔记操作：新标签页打开 / 重命名 / 副本 / 只读 / 删除"><svg class="ic"><use href="#i-more"/></svg></span>
      </button>`;
  }

  /* ---------- 树状目录渲染（支持多层文件夹：路径以 / 分隔） ---------- */
  const folderLabel = f => f.includes('/') ? f.slice(f.lastIndexOf('/') + 1) : f;
  /* 直接子文件夹：路径在 prefix 之下且不再含 / */
  function childFolders(prefix){
    return folders.filter(f => {
      const rest = prefix ? (f.startsWith(prefix + '/') ? f.slice(prefix.length + 1) : '') : f;
      return rest && !rest.includes('/');
    });
  }
  /* 子树笔记总数（含所有后代文件夹） */
  const noteCountIn = f => idx.filter(n =>
    !n.pinned && (n.folder === f || (n.folder || '').startsWith(f + '/'))).length;

  function renderFolder(f, depth){
    const notes = idx.filter(n => !n.pinned && n.folder === f);
    const subs = childFolders(f);
    const open = !collapsed.has(f);
    const locked = f === PLAN_FOLDER || f === QUICK_FOLDER;   // 内置/专属：不可拖拽挪位
    const d = depth || 0;
    /* 缩进完全靠 row 自带的 inline padding-left 表达（每层精确 +14px），
       这样 CSS .kb-folder-body 不再 padding-left，多层嵌套时标题仍能完整显示（v0.2.23 加强） */
    const rowPad = 8 + d * 14;
    const inner = subs.map(s => renderFolder(s, d + 1)).join('')
      + (notes.length ? notes.map(n => noteItemHtml(n, d + 1)).join('') : '');
    return `
      <div class="kb-folder${open ? ' open' : ''}${currentFolder === f ? ' current' : ''}${d === 0 ? ' kb-folder-root' : ''}">
        <div class="kb-folder-row${selFolders.has(f) ? ' kb-selected' : ''}" style="padding-left:${rowPad}px" data-folder-toggle="${App.esc(f)}"${locked ? '' : ' draggable="true"'}>
          <svg class="ic kb-chev"><use href="#i-chev-d"/></svg>
          <svg class="ic kb-folder-ic"><use href="#i-folder"/></svg>
          <span class="kb-folder-name" title="${App.esc(f)}">${App.esc(folderLabel(f))}</span>
          <span class="kb-count num">${noteCountIn(f)}</span>
          ${locked ? '<span class="chip no-dot" style="font-size:10px;padding:2px 6px" title="系统内置文件夹，不可删除">内置</span>'
            : `<button class="icon-btn-xs kb-folder-add" data-kb-add="${App.esc(f)}" title="在此文件夹内新建笔记或子文件夹"><svg class="ic"><use href="#i-plus"/></svg></button>
               <button class="icon-btn-xs kb-folder-more" data-folder-act="${App.esc(f)}" title="文件夹操作：重命名 / 复制 / 导出 / 删除"><svg class="ic"><use href="#i-more"/></svg></button>`}
        </div>
        <div class="kb-folder-body" ${open ? '' : 'hidden'}>
          ${inner || '<div class="kb-empty">暂无笔记，可新建或拖拽进来</div>'}
        </div>
      </div>`;
  }

  function renderTree(){
    /* v0.2.15 增：被软删的笔记不进任何分区（拖入删除横条软删后不调 load 的场景兜底） */
    idx = idx.filter(n => !n.deleted);
    const pinned = idx.filter(n => n.pinned);
    /* 同步笔记所在的一级目录集合：这些文件夹整体归入「同步笔记」分区。
   必须排除内置根（每日计划 / 灵感速记）——否则被同步过的内置文件夹会永远挂在
   syncRoots 里、在线上笔记区不可见且删不掉（v0.2.23 BUG 修复） */
    const isSynced = id => !!(window.LocalSync && LocalSync.isSyncedId(id));
    const syncRoots = new Set();
    for (const n of idx){
      if (n.pinned || !isSynced(n.id) || !n.folder) continue;
      const root = n.folder.split('/')[0];
      if (root !== PLAN_FOLDER && root !== QUICK_FOLDER) syncRoots.add(root);
    }
    const roots = idx.filter(n => !n.pinned && !n.folder && !isSynced(n.id));
    const pinHidden = localStorage.getItem(PIN_KEY) === '1';
    let html = '';

    /* 「线上笔记」分区（原「我的笔记」）：非同步的普通文件夹与未分组笔记归入此区 */
    html += `
      <div class="kb-sec-title" data-drop-root title="拖拽笔记到此处取消分组">
        <svg class="ic"><use href="#i-inbox"/></svg>线上笔记
        <button class="icon-btn-xs kb-root-add" data-kb-add="" title="新建笔记或文件夹"><svg class="ic"><use href="#i-plus"/></svg></button>
      </div>`;
    for (const f of childFolders('')) if (!isBuiltin(f) && !syncRoots.has(f)) html += renderFolder(f);
    html += roots.length ? roots.map(n => noteItemHtml(n, 0)).join('')
      : '<div class="kb-empty">暂无笔记，点上方「新建笔记」开始</div>';

    /* 回收站不再做侧栏分区（v0.2.23 BUG 修复）：入口收进树头「回收站」按钮，弹浮层展示。
   trashCount 同步到顶部按钮徽标 */
    const trashCount = +(localStorage.getItem('om_trash_count') || 0);
    const badge = $('#kbTrashBadge');
    if (badge){
      badge.textContent = String(trashCount);
      badge.hidden = !trashCount;
    }

    /* 「同步笔记」分区：绑定本地文件夹后，同步相关的文件/文件夹全部归入此区 */
    const syncCount = idx.filter(n => !n.pinned && isSynced(n.id)).length;
    const syncHidden = localStorage.getItem(SYNC_KEY) === '1';
    html += `
      <div class="kb-sec-title kb-pin-head${syncHidden ? ' closed' : ''}" data-sync-toggle title="点击隐藏 / 展开同步笔记分区">
        <svg class="ic kb-pin-chev"><use href="#i-chev-d"/></svg>
        <svg class="ic"><use href="#i-swap"/></svg>同步笔记
        <span class="kb-count num">${syncCount}</span>
      </div>`;
    if (!syncHidden){
      if (syncCount){
        for (const f of [...syncRoots].sort()) html += renderFolder(f);
        html += idx.filter(n => !n.pinned && !n.folder && isSynced(n.id)).map(n => noteItemHtml(n, 0)).join('');
      } else {
        html += '<div class="kb-empty">尚未绑定：知识库 ⋯ 菜单 → 本地文件夹同步</div>';
      }
    }

    /* 附件分区：.md 中上传的图片/附件自动归档于此，点击把引用插入当前笔记 */
    const assetsHidden = localStorage.getItem(ASSET_KEY) === '1';
    html += `
      <div class="kb-sec-title kb-pin-head${assetsHidden ? ' closed' : ''}" data-assets-toggle title="点击隐藏 / 展开附件分区">
        <svg class="ic kb-pin-chev"><use href="#i-chev-d"/></svg>
        <svg class="ic"><use href="#i-image"/></svg>附件
        <span class="kb-count num">${assets.length}</span>
      </div>`;
    if (!assetsHidden){
      html += assets.length
        ? assets.map(a => `
      <div class="note-item kb-asset${selAssets.has(a.name) ? ' kb-selected' : ''}" data-asset-name="${App.esc(a.name)}" draggable="true" title="点击预览，拖入编辑区可引用；按住 ⌘/Ctrl 可多选批量拖入">
        <span class="ni-thumb"><img data-asset-src="/api/notes/assets/${encodeURIComponent(a.name)}" alt="" loading="lazy" onerror="this.parentNode.textContent='📎'"></span>
        <div class="ni-text">
          <div class="ni-title">${App.esc(a.name)}</div>
          <div class="ni-sub">${App.esc(a.type || '附件')}${a.size ? ' · ' + fmtSize(a.size) : ''}</div>
        </div>
        <button class="kb-asset-del" data-asset-del="${App.esc(a.name)}" title="删除附件（笔记中的引用会变裂图）"><svg class="ic"><use href="#i-trash"/></svg></button>
      </div>`).join('')
        : '<div class="kb-empty">在笔记中添加的图片会自动归档到这里</div>';
    }

    /* 系统内置置底：常驻笔记 + 每日计划/灵感速记文件夹，点击标题可整体隐藏 */
    const builtinCount = pinned.length
      + idx.filter(n => !n.pinned && isBuiltin(n.folder || '')).length;
    html += `
      <div class="kb-sec-title kb-pin-head${pinHidden ? ' closed' : ''}" data-pin-toggle title="点击隐藏 / 展开系统内置项">
        <svg class="ic kb-pin-chev"><use href="#i-chev-d"/></svg>系统内置
        <span class="kb-count num">${builtinCount}</span>
      </div>`;
    if (!pinHidden){
      html += pinned.map(n => noteItemHtml(n, 0)).join('');
      if (folders.includes(PLAN_FOLDER)) html += renderFolder(PLAN_FOLDER);
      if (folders.includes(QUICK_FOLDER)) html += renderFolder(QUICK_FOLDER);
    }

    $('#noteTree').innerHTML = html;
    $('#notesCount').textContent =
      `${idx.length} 篇笔记 · ${folders.length} 个文件夹 · 支持 Markdown · 自动保存`;
    /* 目录树附件缩略图水合：裸 <img> 请求不带凭证会被 401 拦成裂图（拖图上传后“图片损坏”的根因） */
    hydrateImages($('#noteTree'));
    updateBatchBar();
  }

  /* ---------- 回收站（v0.2.23 改为弹层：入口在树头「回收站」按钮） ---------- */
  function renderTrashList(){
    const body = $('#kbTrashList');
    if (!body) return;
    if (!trash.length){ body.innerHTML = '<div class="kb-trash-empty">回收站是空的</div>'; return; }
    body.innerHTML = trash.map(n => `
      <div class="note-item kb-trash-row" data-trash-id="${App.esc(n.id)}" title="${App.esc(n.deleted_title || n.title || '未命名笔记')} · ${relTime(n.deleted)}删除">
        <svg class="ic ni-icon" style="color:var(--om-text-3)"><use href="#i-trash"/></svg>
        <span class="ni-title">${App.esc(n.deleted_title || n.title || '未命名笔记')}</span>
        <span class="ni-date">${relTime(n.deleted)}</span>
        <button class="icon-btn-xs kb-trash-restore" data-trash-restore="${App.esc(n.id)}" title="恢复到原文件夹"><svg class="ic"><use href="#i-reply"/></svg></button>
        <button class="icon-btn-xs kb-trash-purge" data-trash-purge="${App.esc(n.id)}" title="永久删除"><svg class="ic"><use href="#i-trash"/></svg></button>
      </div>`).join('');
  }
  /* 拉回收站 + trashDays 显示 */
  async function loadTrash(){
    try {
      const d = await API.get('/api/notes/trash');
      trash = d.notes || [];
      trashDays = (d.trashDays === 0 || d.trashDays) ? d.trashDays : 30;
      const dt = $('#kbTrashDaysTxt');
      if (dt) dt.textContent = trashDays === 0 ? '永久' : trashDays;
      const cnt = trash.length;
      try { localStorage.setItem('om_trash_count', String(cnt)); } catch (_) {}
      const badge = $('#kbTrashBadge');
      if (badge){ badge.textContent = String(cnt); badge.hidden = !cnt; }
      renderTrashList();
    } catch (e) { /* 静默 */ }
  }
  function openTrashModal(){
    App.openModal('kbTrashMask');
    renderTrashList();
    loadTrash();
  }
  async function restoreTrash(id){
    try {
      const r = await API.post('/api/notes/' + encodeURIComponent(id) + '/restore');
      showToast(r.restored ? '已恢复到原位置' : '未在回收站');
      await load();
      await loadTrash();
    } catch (e) { showToast(e.message, 'err'); }
  }
  async function purgeTrash(id){
    if (!await App.confirmModal({
      title: '永久删除笔记？',
      sub: '该笔记将被彻底从回收站移除，.md 文件一并清除，无法恢复。',
      okText: '永久删除', danger: true,
    })) return;
    try {
      await API.del('/api/notes/trash/' + encodeURIComponent(id));
      showToast('已永久删除');
      await load();
      await loadTrash();
    } catch (e) { showToast(e.message, 'err'); }
  }
  async function purgeAllTrash(){
    if (!trash.length) return;
    if (!await App.confirmModal({
      title: '清空回收站？',
      sub: `回收站共 ${trash.length} 篇笔记，全部将永久删除，无法恢复。`,
      okText: '清空', danger: true,
    })) return;
    try {
      const r = await API.post('/api/notes/trash/purge-all');
      showToast(`已清空回收站（${r.purged || 0} 篇）`);
      await load();
      await loadTrash();
    } catch (e) { showToast(e.message, 'err'); }
  }

  /* 多选操作栏：选中笔记/文件夹时底部滑出，提供批量删除/取消 */
  function updateBatchBar(){
    const bar = $('#kbBatchBar');
    if (!bar) return;
    const n = selNotes.size, f = selFolders.size;
    if (!n && !f){ bar.hidden = true; return; }
    const parts = [];
    if (n) parts.push(`${n} 篇笔记`);
    if (f) parts.push(`${f} 个文件夹`);
    $('#kbBatchCount').textContent = '已选 ' + parts.join(' + ');
    bar.hidden = false;
  }
  function clearAllSel(){
    selNotes.clear(); selFolders.clear(); selAssets.clear();
    updateBatchBar();
  }

  /* ---------- 显式多选模式：入口在树头 ⋯ 菜单（原「多选」按钮位置已改为回收站） ---------- */
  function setSelMode(on){
    selMode = on;
    $('.kb-tree')?.classList.toggle('sel-mode', on);
    if (!on) clearAllSel();
    else renderTree();
  }

  /* ---------- 多笔记标签页 ---------- */
  function persistTabs(){
    try { localStorage.setItem(TABS_KEY, JSON.stringify(openTabs)); } catch (_) {}
  }
  function tabTitle(id){
    const m = idx.find(n => n.id === id);
    return m ? (m.title || '未命名笔记') : '(已删除)';
  }
  function renderTabs(){
    const bar = $('#edTabs');
    if (!bar) return;
    bar.hidden = openTabs.length === 0;
    bar.innerHTML = openTabs.map(id => {
      const m = idx.find(n => n.id === id);
      const t = tabTitle(id);
      return `<button class="ed-tab${id === currentId ? ' active' : ''}" data-tab="${App.esc(id)}" title="${App.esc(t)}">
        ${m && m.readonly ? '<svg class="ic ed-tab-lock"><use href="#i-lock"/></svg>' : ''}
        <span>${App.esc(t)}</span>
        <span class="ed-tab-x" data-tab-x="${App.esc(id)}" title="关闭标签页"><svg class="ic"><use href="#i-close"/></svg></span>
      </button>`;
    }).join('');
  }
  /* 关闭标签页：若关的是当前页，切到相邻页；全部关完则清空编辑器 */
  async function closeTab(id){
    const i = openTabs.indexOf(id);
    if (i < 0) return;
    openTabs.splice(i, 1);
    persistTabs();
    if (id === currentId){
      const nxt = openTabs[Math.min(i, openTabs.length - 1)];
      currentId = null; dirty = false;
      if (nxt) await open(nxt);
      else clearEditor();
    }
    renderTabs();
  }
  function clearEditor(){
    currentId = null; dirty = false;
    $('#edSrc').value = ''; $('#edTitle').value = '';
    setReadonly(false);
    renderPreview();
    if (liveEd) liveEd.refresh();
    updateCrumb(); updateStat();
    $('#edFootTime').textContent = '尚未保存';
  }

  /* ---------- 只读模式：标题/正文不可编辑，工具栏与查找条隐藏 ---------- */
  function setReadonly(on){
    const card = $('#edCard');
    if (!card) return;
    card.classList.toggle('ed-readonly', on);
    $('#edTitle').readOnly = on;
    $('#edSrc').readOnly = on;
    if (liveEd && liveEd.el) liveEd.el.setAttribute('contenteditable', on ? 'false' : 'true');
    clearTimeout(saveTimer);   // 防止上一篇的延时保存串到只读页
    /* 只读提示芯片：挂在标题正上方右对齐（原顶栏操作区已随 0.2.18 移除） */
    let chip = card.querySelector('.ed-ro-line');
    if (on){
      if (!chip){
        chip = document.createElement('div');
        chip.className = 'ed-ro-line';
        chip.innerHTML = '<span class="chip no-dot ed-readonly-chip"><svg class="ic"><use href="#i-lock"/></svg>只读</span>';
        $('#edTitle').insertAdjacentElement('beforebegin', chip);
      }
    } else if (chip) chip.remove();
  }

  /* ---------- 笔记悬浮操作菜单（⋯ 按钮弹出） ---------- */
  function openNoteMenu(anchor, id){
    const meta = idx.find(n => n.id === id);
    if (!meta) return;
    kbMenu(anchor, [
      ['在新标签页打开', 'i-note', () => open(id)],
      ['导出为 .md', 'i-download', () => API.dl('/api/notes/' + id + '/export')],
      ['重命名', 'i-pen', async () => {
        const name = await App.promptModal({
          title: '重命名笔记', sub: '输入新标题',
          value: meta.title, okText: '保存',
        });
        if (!name || !name.trim()) return;
        try {
          await API.put('/api/notes/' + id, { title: name.trim() });
          meta.title = name.trim();
          if (id === currentId){ $('#edTitle').value = name.trim(); updateCrumb(); }
          renderTree(); renderTabs();
        } catch (e) { showToast('重命名失败：' + e.message, 'err'); }
      }],
      ['创建副本', 'i-copy', async () => {
        try {
          const d = await API.get('/api/notes/' + id);
          const r = await API.post('/api/notes',
            { title: (meta.title || '未命名笔记') + ' 副本', tags: meta.tags || [], folder: meta.folder || '' });
          await API.put('/api/notes/' + r.id, { content: d.content || '' });
          showToast('副本已创建并打开');
          await load();
          open(r.id);
        } catch (e) { showToast('创建副本失败：' + e.message, 'err'); }
      }],
      [meta.readonly ? '解除只读' : '设为只读', 'i-lock', async () => {
        try {
          await API.put('/api/notes/' + id, { readonly: !meta.readonly });
          meta.readonly = !meta.readonly;
          if (id === currentId) setReadonly(!!meta.readonly);
          renderTree(); renderTabs();
          showToast(meta.readonly ? '已设为只读' : '已解除只读');
        } catch (e) { showToast(e.message, 'err'); }
      }],
      ['删除笔记', 'i-trash', () => del(id)],
    ]);
  }

  /* ---------- 打开 / 保存 ---------- */
  async function open(id){
    if (!idx.find(n => n.id === id)) return;
    if (id !== currentId && dirty) await save();
    /* 标签页登记：新开追加到末尾，已存在则仅切换激活 */
    if (!openTabs.includes(id)){ openTabs.push(id); persistTabs(); }
    currentId = id;
    const meta = idx.find(n => n.id === id);
    setReadonly(!!(meta && meta.readonly));
    try {
      const d = await API.get('/api/notes/' + id);
      $('#edSrc').value = d.content;
      $('#edTitle').value = meta ? meta.title : '';
      dirty = false;
      renderPreview();
      if (liveEd) liveEd.refresh();
      hydrateNow();   // 附件图片水合（鉴权取图 → data URL）
      renderTree();
      renderTabs();
            updateCrumb();
      updateStat();
      /* 打开笔记后自动渲染右侧大纲（用户可点大纲按钮隐藏）。
         renderOutline/openOutline 定义在 init() 内部，此处不可见，故内联渲染。 */
      const ob = $('#mdOutlineBody');
      if (ob){
        const items = mdOutline($('#edSrc').value);
        ob.innerHTML = items.length
          ? items.map(h =>
              '<button class="md-outline-item lv' + h.level + '" data-target="' + h.id + '" title="跳到「' +
              App.esc(h.text) + '」">' + App.esc(h.text) + '</button>').join('')
          : '<div class="md-outline-empty">当前笔记没有标题</div>';
      }
      const op = $('#mdOutlinePanel');
      /* 面板收起态不再用 hidden 判断（改由宽度动画控制），这里只在首次打开时滑出 */
      if (op && op.hidden){
        op.hidden = false;
        /* 下一帧再加 open 类，display 恢复后才能触发滑入动画 */
        requestAnimationFrame(() => op.classList.add('open'));
      }
    } catch (e) {
      /* 打开失败：撤回标签登记 */
      openTabs = openTabs.filter(t => t !== id);
      persistTabs();
      renderTabs();
      showToast(e.message, 'err');
    }
  }

  async function create(folder){
    try {
      /* 笔记只允许建在「线上笔记」分区：默认最近点选的文件夹，内置文件夹回落根 */
      const dest = folder !== undefined ? folder
        : (isBuiltin(currentFolder) ? '' : currentFolder);
      const meta = await API.post('/api/notes',
        { title: '未命名笔记', tags: [], folder: dest });
      idx.unshift(meta);
      renderTree();
      await open(meta.id);
      goView('notes');
      $('#edTitle').focus();
      $('#edTitle').select();
    } catch (e) { showToast(e.message, 'err'); }
  }

  async function save(){
    if (!currentId) return;
    if ($('#edTitle').readOnly) return;   // 只读笔记不落库（防延时保存串页）
    try {
      await API.put('/api/notes/' + currentId, {
        content: $('#edSrc').value,
        title: $('#edTitle').value.trim() || '未命名笔记',
      });
      dirty = false;
      const meta = idx.find(n => n.id === currentId);
      if (meta){ meta.title = $('#edTitle').value.trim() || '未命名笔记'; meta.updated = Date.now() / 1000; }
      $('#edFootTime').textContent = '已自动保存（刚刚）';
      renderTree();
      renderTabs();
      /* 本地同步钩子：防抖写入本地物理文件（未绑定时空操作） */
      if (window.LocalSync) LocalSync.onNoteSaved(meta || idx.find(n => n.id === currentId), $('#edSrc').value);
    } catch (e) { showToast('保存失败：' + e.message, 'err'); }
  }

  async function del(id){
    const meta = idx.find(n => n.id === id);
    if (!meta) return;
    const msg = meta.pinned
      ? `「${meta.title}」是常驻笔记，删除后将立即自动重建一篇新的，确定继续？`
      : '删除这篇笔记？\n\n笔记会进入回收站（可在设置中配置保留天数），期间可从回收站恢复。';
    if (!await App.confirmModal({ title: '删除笔记', sub: msg, okText: '删除到回收站', danger: !meta.pinned })) return;
    try {
      const r = await API.del('/api/notes/' + id);
      /* v0.2.15：普通笔记后端改为软删除（进回收站），pinned 仍然直接删（随后端自动重建），
         因此前端不要再本地把 idx.filter(n.id !== id)，否则从回收站恢复时找不到条目 */
      if (r && r.softDeleted){
        /* 把 idx 里的元信息标记为 deleted，但保留记录（同步不会丢失） */
        const it = idx.find(n => n.id === id);
        if (it){ it.deleted = r.id ? Math.floor(Date.now()/1000) : Date.now()/1000; it.deleted_title = it.title; }
      } else {
        selNotes.delete(id);
        idx = idx.filter(n => n.id !== id);
      }
      openTabs = openTabs.filter(t => t !== id);   // 同步关闭对应标签页
      persistTabs();
      if (currentId === id){
        currentId = null;
        $('#edSrc').value = ''; $('#edTitle').value = ''; renderPreview();
        if (liveEd) liveEd.refresh();
        updateCrumb();
      }
      renderTabs();
      if (meta.pinned){
        showToast('常驻笔记已自动重建');
        await load();   // 后端拉取时自动重建常驻笔记
        return;
      }
      if (!currentId){
        /* 删的是当前页：优先切到剩余标签页，无标签才回落第一篇 */
        if (openTabs.length) open(openTabs[openTabs.length - 1]);
        else if (idx.length) open(idx[0].id);
      }
      renderTree();
      if (r && r.softDeleted){
        /* 保留天数：loadTrash 拉过就有真实值；未知时用中性文案（v0.2.23 BUG 修复：
           原文案写死「保留 N 天」，与设置里 30 天对不上造成误导） */
        showToast(trashDays === 0 ? '已移到回收站（未设自动清理）'
          : trashDays ? `已移到回收站（保留 ${trashDays} 天）` : '已移到回收站');
        /* 徽标 +1（本地估算，下次 load 对齐） */
        try {
          const c = parseInt(localStorage.getItem('om_trash_count') || '0', 10) + 1;
          localStorage.setItem('om_trash_count', String(c));
          const badge = $('#kbTrashBadge');
          if (badge){ badge.textContent = String(c); badge.hidden = false; }
        } catch (_) {}
        loadTrash();   // 后台刷新真实计数与列表（弹层开着也同步）
      } else {
        showToast('已删除');
      }
    } catch (e) { showToast(e.message, 'err'); }
  }

  /* ---------- 文件夹（支持在文件夹内再建文件夹） ---------- */
  async function newFolder(parent = ''){
    const name = await App.promptModal({
      title: parent ? `在「${folderLabel(parent)}」内新建子文件夹` : '新建文件夹',
      sub: '可以把笔记拖入文件夹归类整理，文件夹支持多层嵌套',
      placeholder: '文件夹名称，如：工作',
    });
    if (!name) return;
    if (name.includes('/')){ showToast('文件夹名称不能包含 /', 'err'); return; }
    const full = parent ? parent + '/' + name.trim() : name.trim();
    try {
      await API.post('/api/notes/folders', { name: full });
      if (parent) collapsed.delete(parent);   // 展开父级让新文件夹可见
      currentFolder = full;
      await load();
      showToast(`文件夹「${name.trim()}」已创建`);
    } catch (e) { showToast(e.message, 'err'); }
  }

  async function delFolder(name){
    const hasSub = folders.some(f => f.startsWith(name + '/'));
    if (!await App.confirmModal({
      title: `删除文件夹「${folderLabel(name)}」？`,
      sub: hasSub
        ? '其中的笔记会移到上级文件夹，内部子文件夹将一并删除（笔记本身不会删除）。'
        : '其中的笔记将移到上级文件夹，笔记本身不会删除。',
      okText: '删除', danger: true,
    })) return;
    try {
      await API.del('/api/notes/folders/' + encodeURIComponent(name));
      if (currentFolder === name) currentFolder = '';
      collapsed.delete(name);
      await load();
      showToast('文件夹已删除');
    } catch (e) { showToast(e.message, 'err'); }
  }

  /* ---------- 文件夹 ⋯ 操作菜单：重命名 / 复制 / 导出 / 删除（0.2.21 起替代悬浮删除钮） ---------- */
  function openFolderMenu(anchor, f){
    kbMenu(anchor, [
      ['重命名文件夹', 'i-pen', async () => {
        const name = await App.promptModal({
          title: '重命名文件夹', sub: `「${folderLabel(f)}」的子文件夹与笔记将一并迁移`,
          value: folderLabel(f), placeholder: '新名称',
        });
        if (!name) return;
        const trimmed = name.trim();
        if (!trimmed || trimmed === folderLabel(f)) return;
        if (trimmed.includes('/')){ showToast('文件夹名称不能包含 /', 'err'); return; }
        const parent = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
        const newF = parent ? parent + '/' + trimmed : trimmed;
        if (folders.includes(newF)){ showToast('同级已存在同名文件夹', 'err'); return; }
        try {
          await API.post('/api/notes/folders', { name: newF });
          /* 迁移子文件夹树（后端自动逐级补齐；已存在时 400 忽略） */
          for (const p of folders.filter(x => x.startsWith(f + '/')))
            await API.post('/api/notes/folders', { name: newF + p.slice(f.length) }).catch(() => {});
          /* 迁移本级与全部子级笔记 */
          const moving = idx.filter(n => n.folder === f || (n.folder || '').startsWith(f + '/'));
          for (const n of moving)
            await API.put('/api/notes/' + n.id, { folder: newF + (n.folder || '').slice(f.length) });
          /* 删旧文件夹树：笔记已迁空，后端「内容上移」逻辑不会再触发 */
          await API.del('/api/notes/folders/' + encodeURIComponent(f));
          collapsed.delete(f);
          if (currentFolder === f) currentFolder = newF;
          await load();
          showToast(`文件夹已重命名为「${trimmed}」`);
        } catch (e) { showToast(e.message, 'err'); }
      }],
      ['复制文件夹', 'i-copy', () => copyFolder(f)],
      ['导出文件夹', 'i-download', () => API.dl('/api/notes/folder/export?path=' + encodeURIComponent(f))],
      ['删除文件夹', 'i-trash', () => delFolder(f)],
    ]);
  }

  /* 复制文件夹：递归建同名子树，逐篇拉正文新建副本（目标名自动避重） */
  async function copyFolder(f){
    const parent = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    const base = folderLabel(f) + ' 副本';
    let label = base, i = 2;
    while (folders.includes(parent ? parent + '/' + label : label)) label = base + i++;
    const newF = parent ? parent + '/' + label : label;
    try {
      await API.post('/api/notes/folders', { name: newF });
      for (const p of folders.filter(x => x.startsWith(f + '/')))
        await API.post('/api/notes/folders', { name: newF + p.slice(f.length) }).catch(() => {});
      const src = idx.filter(n => !n.pinned && (n.folder === f || (n.folder || '').startsWith(f + '/')));
      for (const n of src){
        const d = await API.get('/api/notes/' + n.id);
        const r = await API.post('/api/notes',
          { title: n.title || '未命名笔记', tags: n.tags || [], folder: newF + (n.folder || '').slice(f.length) });
        await API.put('/api/notes/' + r.id, { content: d.content || '' });
      }
      await load();
      showToast(src.length ? `已复制文件夹（${src.length} 篇笔记）` : '已复制空文件夹');
    } catch (e) { showToast(e.message, 'err'); }
  }

  async function moveNote(id, folder){
    try {
      await API.put('/api/notes/' + id, { folder });
      const meta = idx.find(n => n.id === id);
      const prevFolder = meta ? meta.folder : '';
      if (meta) meta.folder = folder;
      renderTree();
            showToast(folder ? `已移入文件夹「${folder}」` : '已移回线上笔记');
      /* 同步笔记移出本地同步区间：立即从 mapping 移除 + 触发对账（v0.2.15 BUG 修复：
         否则 syncIds 还留 id，下一轮 renderTree 仍把它藏到「同步笔记」分区，线上看不到） */
      if (window.LocalSync && prevFolder && folder !== prevFolder){
        const rootFrom = prevFolder.split('/')[0];
        const rootTo = (folder || '').split('/')[0];
        if (rootFrom !== rootTo) LocalSync.detachById(id);
      }
    } catch (e) { showToast(e.message, 'err'); }
  }

  /* 批量移动笔记（多选拖拽） */
  async function moveNotes(ids, folder){
    if (ids.length === 1){ await moveNote(ids[0], folder); return; }
    try {
      for (const id of ids){
        await API.put('/api/notes/' + id, { folder });
        const meta = idx.find(n => n.id === id);
        if (meta) meta.folder = folder;
      }
            renderTree();
      showToast(`${ids.length} 篇笔记${folder ? `已移入「${folder}」` : '已移回线上笔记'}`);
      /* 同步范围整体脱离：统一 detach（v0.2.15 BUG 修复） */
      if (window.LocalSync && folder !== undefined) LocalSync.detachMany(ids);
    } catch (e) { showToast(e.message, 'err'); }
  }

  /* 批量移动文件夹：重挂路径（含子孙） + 笔记归属同步，后端整体保存 */
  async function moveFolders(ids, target){
    const repath = (f, o, n) =>
      f === o ? n : (f.startsWith(o + '/') ? n + f.slice(o.length) : f);
    let fl = folders.slice();
    const moved = [];
    for (const f of ids){
      if (f === PLAN_FOLDER || f === QUICK_FOLDER) continue;
      if (target === f || target.startsWith(f + '/')) continue;   // 不允许移入自身/子孙（兜底）
      const dest = target ? target + '/' + folderLabel(f) : folderLabel(f);
      if (dest === f) continue;
      if (fl.includes(dest)){
        showToast(`「${folderLabel(target)}」内已存在同名文件夹`, 'err');
        continue;
      }
      fl = fl.map(x => repath(x, f, dest));
      moved.push([f, dest]);
    }
    if (!moved.length) return;
    try {
      /* 先算出受影响笔记，再依次落库 */
      const noteMoves = [];
      for (const n of idx){
        const f = n.folder || '';
        for (const [o, nw] of moved){
          if (f === o || f.startsWith(o + '/')){ noteMoves.push([n, repath(f, o, nw)]); break; }
        }
      }
      await API.put('/api/notes/folders', { folders: fl });
      for (const [n, nf] of noteMoves){
        await API.put('/api/notes/' + n.id, { folder: nf });
        n.folder = nf;
      }
      collapsed.clear();
      await load();
      showToast(moved.length > 1
        ? `已移动 ${moved.length} 个文件夹`
        : `文件夹已移到${target ? `「${folderLabel(target)}」内` : '线上笔记'}`);
    } catch (e) { showToast(e.message, 'err'); }
  }

  /* 编辑器顶栏面包屑：知识库 / <folder path> / <note title>
     单击"知识库"清空当前选择；单击文件夹段滚动并展开该目录。 */
  function updateCrumb(){
    const el = $('#edCrumb');
    if (!el) return;
    if (!currentId){
      el.innerHTML = '<span class="ed-crumb-item current">知识库</span>';
      return;
    }
    const meta = idx.find(n => n.id === currentId);
    if (!meta){ el.innerHTML = ''; return; }
    const folder = (meta.folder || '').trim('/');
    const parts = folder ? folder.split('/').filter(Boolean) : [];
    let html = '<span class="ed-crumb-item" data-crumb="root">知识库</span>';
    parts.forEach((seg, i) => {
      const pathSoFar = parts.slice(0, i + 1).join('/');
      html += '<span class="ed-crumb-sep">/</span>';
      html += '<span class="ed-crumb-item" data-crumb="folder" data-folder="' + App.esc(pathSoFar) + '">' + App.esc(seg) + '</span>';
    });
    html += '<span class="ed-crumb-sep">/</span>';
    html += '<span class="ed-crumb-item current">' + App.esc(meta.title || '未命名笔记') + '</span>';
    el.innerHTML = html;
  }

  function renderPreview(){
    $('#edPreview').innerHTML = mdRender($('#edSrc').value) ||
      '<p style="color:var(--om-text-3)">开始输入，右侧实时预览…</p>';
    /* 预览区附件图片水合：鉴权取图转 data URL，避免裸请求被 401 拦截 */
    hydrateImages($('#edPreview'));
    /* 预览重渲染广播：查找高亮需重打 */
    try { $('#edPreview').dispatchEvent(new CustomEvent('omni:preview-rendered', { bubbles: true })); } catch (_) {}
  }

  function updateStat(){
    const n = $('#edSrc').value.length;
    $('#edStat').textContent = n + ' 字';
  }

  /* ---------- 编辑模式（编辑=原地实时渲染 / 分屏 / 预览） ---------- */
  function setMode(mode){
    currentMode = mode;
    $$('#edModeSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.edMode === mode));
    const src = $('#edSrc'), pv = $('#edPreview');
    const useLive = !!liveEd && mode === 'edit';
    if (liveEd){ useLive ? liveEd.show() : liveEd.hide(); }
    src.style.display = (mode === 'preview' || useLive) ? 'none' : '';
    pv.style.display = mode === 'edit' ? 'none' : '';
    const body = $('.ed-body');
    if (body) body.classList.toggle('single', mode !== 'split');
    if (!useLive) renderPreview();
    hydrateNow();
  }

  /* #edSrc 输入的统一处理（分屏直编与实时渲染共用） */
  function onSrcInput(){
    dirty = true;
    renderPreview();
    updateStat();
    $('#edFootTime').textContent = '编辑中…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 900);
  }

  function initLiveEditor(){
    const ta = $('#edSrc');
    if (!ta || !window.LiveMD) return;
    /* 幂等：重复调用先销毁旧实例，避免页内出现两个实时编辑块（
       旧块会抢焦点/选区并破坏分屏布局） */
    if (liveEd){ try { liveEd.destroy(); } catch (_) {} liveEd = null; }
    liveEd = LiveMD.attach(ta, {
      uploadImage,
      onImageError: e => showToast('图片上传失败：' + (e.message || e), 'err'),
    });
    liveEd.hide();   // 默认显示状态由 setMode 决定
  }

  /* ---------- 图片上传与插入（按钮选择 / 粘贴 / 拖拽共用后端接口） ---------- */
  async function uploadImage(f){
    const fd = new FormData();
    fd.append('file', f);
    const d = await API.upload('/api/notes/assets', fd);
    refreshAssets();   // 新附件自动归档进附件分区
    return d.url;
  }

  async function insertImages(files){
    const parts = [];
    for (const f of files){
      try {
        const url = await uploadImage(f);
        parts.push(`![${(f.name || 'image').replace(/[\[\]()]/g, '')}](${url})`);
      } catch (e) { showToast('图片上传失败：' + e.message, 'err'); }
    }
    if (!parts.length) return;
    const md = '\n' + parts.join('\n');
    if (liveEd && liveEd.isShown()){ liveEd.insertText(md); return; }
    const ta = $('#edSrc');
    const { selectionStart: s, value: v } = ta;
    ta.value = v.slice(0, s) + md + v.slice(s);
    ta.dispatchEvent(new Event('input'));
    ta.focus();
  }

  /* ---------- 事件 ---------- */
  function init(){
    /* 新建笔记：所有 + 号按钮都通过 kbMenu 弹出选择，不再常驻顶栏。
       原来 #noteNew / #folderNew 已从 HTML 移除，相应绑定也清掉。 */
    App.onEnter(load);

    /* 顶部 "..." 溢出菜单：导入 / 导出（设计图把显眼按钮收纳收起） */
    $('#notesOverflowBtn')?.addEventListener('click', () => kbMenu($('#notesOverflowBtn'), [
      ['多选模式', 'i-check', () => setSelMode(!selMode)],
      ['导入 Markdown / zip', 'i-download', () => importMd()],
      ['导出全部笔记', 'i-upload', () => API.dl('/api/notes/all')],
      ['本地文件夹同步', 'i-swap', () => window.LocalSync && LocalSync.openPanel()],
    ]));
    /* 回收站按钮（v0.2.23 BUG 修复：替代原「多选」按钮位置，弹浮层而非侧栏分区） */
    $('#kbTrashBtn')?.addEventListener('click', () => openTrashModal());
    $('#kbTrashClose')?.addEventListener('click', () => App.closeModal('kbTrashMask'));
    $('#kbTrashPurgeAll')?.addEventListener('click', purgeAllTrash);
    $('#kbTrashMask')?.addEventListener('click', e => { if (e.target === $('#kbTrashMask')) App.closeModal('kbTrashMask'); });
    /* 编辑区顶栏由全局 .topbar 承载（#globalSearch 等 demo.js 已绑）；
       此处不再绑定 kbBack / kbEditorSearch / kbAvatar / kbDate */
    /* 单篇导出/删除已随 0.2.18 顶栏移除，入口收进笔记悬浮 ⋯ 菜单（openNoteMenu） */

    /* ---------- 桌面拖拽 .md 文件 / 文件夹 → 导入（支持嵌套结构） ---------- */
    const dropTarget = $('#noteTree');   // 容器同时承载 .kb-tree-body 类（用于拖拽高亮）
    if (dropTarget){
      dropTarget.addEventListener('dragover', e => {
        if (e.dataTransfer.types.includes('Files')){
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          dropTarget.classList.add('kb-drop-active');
        }
      });
      dropTarget.addEventListener('dragleave', e => {
        if (!dropTarget.contains(e.relatedTarget)) dropTarget.classList.remove('kb-drop-active');
      });
      dropTarget.addEventListener('drop', async e => {
        e.preventDefault();
        dropTarget.classList.remove('kb-drop-active');
        const dt = e.dataTransfer;
        if (!dt) return;
        /* 本机图片 → 直接上传为附件（自动归档进附件分区）；其余文件继续走 .md/.zip 导入 */
        const files = Array.from(dt.files || []);
        const imgs = files.filter(f => f.type && f.type.startsWith('image/'));
        if (imgs.length){
          let ok = 0, fail = 0;
          for (const f of imgs){
            try { await uploadImage(f); ok++; }
            catch (err){ fail++; showToast('上传失败：' + (err.message || f.name), 'err'); }
          }
          if (ok){ refreshAssets(); showToast(`已上传 ${ok} 个附件，已归档到附件分区${fail ? `（${fail} 个失败）` : ''}`); }
          if (files.length === imgs.length) return;   // 全是图片，无需导入
        }
        const items = Array.from(dt.items || []).filter(it => {
          const f = it.getAsFile && it.getAsFile();
          return !(f && f.type && f.type.startsWith('image/'));   // 图片已另行处理
        });
        if (!items.length) return;
        /* 单个 .md / .zip 文件 → 直接走 multipart 端点 */
        if (items.length === 1){
          const f = items[0].getAsFile && items[0].getAsFile();
          if (f && (f.name.toLowerCase().endsWith('.md') || f.name.toLowerCase().endsWith('.zip'))){
            await dropUploadSingle(f);
            return;
          }
        }
        /* 多文件 / 文件夹：用 webkitGetAsEntry 递归收集 */
        const collected = [];
        for (const it of items){
          if (typeof it.webkitGetAsEntry !== 'function') continue;
          const entry = it.webkitGetAsEntry();
          if (entry) await walkEntry(entry, '', collected);
        }
        if (!collected.length){
          showToast('未发现 .md 文件（已自动忽略 macOS 资源垃圾与系统文件）', 'err');
          return;
        }
        await dropUploadMulti(collected);
      });
    }

    function readEntries(reader, out, prefix){
      /* prefix 透传到子项，让后端 import-files 看到完整相对路径以建对应文件夹 */
      return new Promise(resolve => {
        function readBatch(){
          reader.readEntries(async entries => {
            if (!entries.length) return resolve();
            for (const e of entries) await walkEntry(e, prefix || '', out);
            readBatch();
          });
        }
        readBatch();
      });
    }
    async function walkEntry(entry, prefix, out){
      if (entry.isFile){
        if (!entry.name.toLowerCase().endsWith('.md')) return;
        if (entry.name.startsWith('._') || entry.name === 'Thumbs.db' || entry.name === '.DS_Store') return;
        const file = await new Promise(r => entry.file(r));
        const text = await file.text();
        out.push({ path: (prefix || '') + entry.name, content: text });
      } else if (entry.isDirectory){
        /* 子文件夹用 父prefix + 文件夹名 + '/' 作为下一级前缀，
           否则后端 import-files 把所有 md 全部建到根目录、嵌套结构丢失（v0.2.15 BUG 修复） */
        await readEntries(entry.createReader(), out, (prefix || '') + entry.name + '/');
      }
    }
    async function dropUploadSingle(file){
      const fd = new FormData();
      fd.append('file', file);
      try {
        const r = await fetch('/api/notes/import-md', {
          method: 'POST', headers: { 'Authorization': 'Bearer ' + API.getToken() }, body: fd,
        });
        if (!r.ok) throw new Error((await r.json()).detail || ('HTTP ' + r.status));
        const d = await r.json();
        showToast(`导入 ${d.imported} 个笔记${d.skipped ? '（跳过 ' + d.skipped + ' 个）' : ''}`);
        await load();
      } catch (e) { showToast('导入失败：' + e.message, 'err'); }
    }
    async function dropUploadMulti(files){
      try {
        const r = await fetch('/api/notes/import-files', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + API.getToken(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ files }),
        });
        if (!r.ok) throw new Error((await r.json()).detail || ('HTTP ' + r.status));
        const d = await r.json();
        showToast(`导入 ${d.imported} 篇笔记${d.skipped ? '（跳过 ' + d.skipped + ' 个非 .md）' : ''}`);
        await load();
      } catch (e) { showToast('导入失败：' + e.message, 'err'); }
    }
    /* 面包屑点击（已移至底部状态栏）：根清空选择，文件夹段展开并滚动到该目录 */
    $('#edCrumb')?.addEventListener('click', e => {
      const root = e.target.closest('[data-crumb=root]');
      if (root){
        if (currentId){
          openTabs = openTabs.filter(t => t !== currentId);   // 同步关闭当前标签页
          persistTabs();
          currentId = null; $('#edSrc').value=''; $('#edTitle').value=''; renderPreview(); updateCrumb(); renderTree(); renderTabs();
        }
        return;
      }
      const f = e.target.closest('[data-crumb=folder]');
      if (f){
        const path = f.dataset.folder;
        if (collapsed.has(path)){ collapsed.delete(path); renderTree(); }
        setTimeout(() => {
          const row = document.querySelector('[data-folder-toggle="' + path + '"]');
          row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }, 50);
      }
    });

    /* 多笔记标签页栏：点击切换笔记，× 关闭标签页 */
    $('#edTabs')?.addEventListener('click', e => {
      const x = e.target.closest('[data-tab-x]');
      if (x){ e.stopPropagation(); closeTab(x.dataset.tabX); return; }
      const t = e.target.closest('[data-tab]');
      if (t && t.dataset.tab !== currentId) open(t.dataset.tab);
    });

    /* 附件灯箱：关闭 / 删除 / 点击背景关闭
       注意：#assetLightbox 在页面底部，晚于本脚本执行，若直接绑在元素上会因 ?. 短路而永不生效。
       必须用 document 委托，运行时元素已存在也能命中。 */
    document.addEventListener('click', e => {
      if (!e.target.closest || !e.target.closest('#assetLightbox')) return;
      if (e.target.closest('[data-asset-close]')) closeAssetPreview();
      else if (e.target.closest('[data-asset-del]')){
        const name = $('#assetLightbox').dataset.name;
        if (name) deleteAsset(name);
      }
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && $('#assetLightbox')?.classList.contains('open')) closeAssetPreview();
    });

    /* 编辑区拖入附件 → 在光标处插入引用 */
    const edSrc = $('#edSrc');
    if (edSrc){
      edSrc.addEventListener('dragover', e => {
        if (e.dataTransfer.types.includes('text/omni-asset') || e.dataTransfer.types.includes('text/plain')){
          e.preventDefault();
          edSrc.classList.add('drop-target');
        }
      });
      edSrc.addEventListener('dragleave', () => edSrc.classList.remove('drop-target'));
      edSrc.addEventListener('drop', e => {
        edSrc.classList.remove('drop-target');
        if (e.dataTransfer.types.includes('text/omni-asset')){
          e.preventDefault();
          const md = e.dataTransfer.getData('text/plain');
          if (md){
            if (liveEd && liveEd.isShown()){
              liveEd.insertText('\n' + md + '\n');
              showToast('已插入附件引用');
            } else {
              const ta = edSrc;
              ta.value = ta.value.slice(0, ta.selectionStart) + '\n' + md + '\n' + ta.value.slice(ta.selectionStart);
              ta.dispatchEvent(new Event('input'));
              ta.focus();
              showToast('已插入附件引用');
            }
          }
        }
      });
    }

    /* 进入知识库视图时刷新（覆盖仪表盘速记新建等跨视图变化） */
    document.addEventListener('view-change', e => {
      if (e.detail === 'notes') load();
    });
    /* 设置/其他模块清理完垃圾数据后触发刷新 */
    document.addEventListener('kb-refresh', () => load());
    /* 注意：v0.2.8 起知识库改为固定 3 栏布局（kb-layout），目录折叠功能已随
       #kbSideToggle / .note-layout 一并移除——不要再在这里引用它们，
       否则 init() 在此抛 TypeError，其后所有事件绑定（树点击/编辑模式/工具栏…）全部失效 */
    /* #noteDel 顶栏按钮已随 0.2.18 移除，删除入口在悬浮 ⋯ 菜单；旧绑定同步删掉防空引用崩溃 */

    /* 树：点击（打开笔记 / 展开文件夹 / 新建 / 删文件夹 / 分区折叠 / 多选勾选 / 悬浮操作菜单） */
    $('#noteTree').addEventListener('click', e => {
      const nact = e.target.closest('[data-note-act]');
      if (nact){ e.stopPropagation(); openNoteMenu(nact, nact.dataset.noteAct); return; }
      const ndel = e.target.closest('[data-note-del]');
      if (ndel){ e.stopPropagation(); del(ndel.dataset.noteDel); return; }
      const kadd = e.target.closest('[data-kb-add]');
      if (kadd){ e.stopPropagation(); openKbMenu(kadd, kadd.dataset.kbAdd); return; }
      const fact = e.target.closest('[data-folder-act]');
      if (fact){ e.stopPropagation(); openFolderMenu(fact, fact.dataset.folderAct); return; }
      const add = e.target.closest('[data-folder-add]');
      if (add){
        e.stopPropagation();
        newFolder(add.dataset.folderAdd);
        return;
      }
      if (e.target.closest('[data-pin-toggle]')){
        localStorage.setItem(PIN_KEY, localStorage.getItem(PIN_KEY) === '1' ? '0' : '1');
        renderTree();
        return;
      }
      if (e.target.closest('[data-assets-toggle]')){
        localStorage.setItem(ASSET_KEY, localStorage.getItem(ASSET_KEY) === '1' ? '0' : '1');
        renderTree();
        return;
      }
      if (e.target.closest('[data-sync-toggle]')){
        localStorage.setItem(SYNC_KEY, localStorage.getItem(SYNC_KEY) === '1' ? '0' : '1');
        renderTree();
        return;
      }
      /* 回收站条目：恢复 / 永久删（列表在弹层内，document 委托免时序问题） */
      if (e.target.closest('[data-trash-restore]')){
        e.stopPropagation();
        restoreTrash(e.target.closest('[data-trash-restore]').dataset.trashRestore);
        return;
      }
      if (e.target.closest('[data-trash-purge]')){
        e.stopPropagation();
        purgeTrash(e.target.closest('[data-trash-purge]').dataset.trashPurge);
        return;
      }
      const assetDel = e.target.closest('[data-asset-del]');
      if (assetDel){ e.stopPropagation(); deleteAsset(assetDel.dataset.assetDel); return; }
      const assetRow = e.target.closest('[data-asset-name]');
      if (assetRow){
        /* ⌘/Ctrl 点选或多选模式下点选：多选附件待批量拖入编辑区；普通点击预览，Alt+点击插入引用 */
        if (e.ctrlKey || e.metaKey || selMode){
          const name = assetRow.dataset.assetName;
          selAssets.has(name) ? selAssets.delete(name) : selAssets.add(name);
          renderTree();
          return;
        }
        selAssets.clear();
        if (e.altKey) insertAssetRef(assetRow.dataset.assetName);
        else showAssetPreview(assetRow.dataset.assetName);
        return;
      }
      const row = e.target.closest('[data-folder-toggle]');
      if (row){
        const f = row.dataset.folderToggle;
        if (e.ctrlKey || e.metaKey || selMode){
          /* ctrl/cmd 点选：多选文件夹待批量挪动（内置/专属不可选） */
          if (f !== PLAN_FOLDER && f !== QUICK_FOLDER){
            selFolders.has(f) ? selFolders.delete(f) : selFolders.add(f);
            renderTree();
          }
          return;
        }
        /* 普通点击：退出多选状态，避免选中效果残留 */
        selNotes.clear(); selFolders.clear(); selAssets.clear();
        if (collapsed.has(f)) collapsed.delete(f); else collapsed.add(f);
        currentFolder = f;
        renderTree();
        return;
      }
      const btn = e.target.closest('[data-note-id]');
      if (btn){
        const id = btn.dataset.noteId;
        const meta = idx.find(n => n.id === id);
        if ((e.ctrlKey || e.metaKey || selMode) && meta && !meta.pinned){
          selNotes.has(id) ? selNotes.delete(id) : selNotes.add(id);
          renderTree();
          return;
        }
        selNotes.clear(); selFolders.clear(); selAssets.clear();   // 普通点击清除多选残留（BUG 修复）
        open(id);
      }
    });

    /* 树：拖拽笔记/文件夹 → 文件夹 / 根目录（多选时批量挪动） */
    const tree = $('#noteTree');
    tree.addEventListener('dragstart', e => {
      const item = e.target.closest ? e.target.closest('[data-note-id]') : null;
      const row = e.target.closest ? e.target.closest('[data-folder-toggle]') : null;
      const assetRow = e.target.closest ? e.target.closest('[data-asset-name]') : null;
      if (item){
        const id = item.dataset.noteId;
        if (!selNotes.has(id)) selNotes = new Set([id]);
        selFolders.clear();
        dragState = { kind: 'note', ids: [...selNotes] };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', id);
        setTimeout(() => item.classList.add('dragging'), 0);
        showTrash();
        return;
      }
      if (row){
        const f = row.dataset.folderToggle;
        if (f === PLAN_FOLDER || f === QUICK_FOLDER){ e.preventDefault(); return; }
        if (!selFolders.has(f)) selFolders = new Set([f]);
        selNotes.clear();
        dragState = { kind: 'folder', ids: [...selFolders] };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', f);
        setTimeout(() => row.classList.add('dragging'), 0);
        showTrash();
      }
      if (assetRow){
        /* 拖动附件 → 编辑区可在光标位置插入引用；多选时批量插入 */
        const name = assetRow.dataset.assetName;
        const names = selAssets.has(name) ? [...selAssets] : [name];
        const mds = names.map(nm => '![' + nm.replace(/[\[\]()]/g, '') + '](/api/notes/assets/' + encodeURIComponent(nm) + ')');
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/omni-asset', names.join('\n'));
        e.dataTransfer.setData('text/plain', mds.join('\n'));
      }
    });
    tree.addEventListener('dragend', e => {
      const item = e.target.closest ? e.target.closest('[data-note-id], [data-folder-toggle]') : null;
      if (item) item.classList.remove('dragging');
      dragState = null;
      hideTrash();
      $$('.kb-drop-hint', tree).forEach(x => x.classList.remove('kb-drop-hint'));
    });
    tree.addEventListener('dragover', e => {
      if (!dragState) return;
      const drop = e.target.closest ? e.target.closest('[data-folder-toggle], [data-drop-root]') : null;
      if (!drop) return;
      if (dragState.kind === 'folder'){
        const t = drop.dataset.folderToggle || '';
        /* 不允许把文件夹拖入自身或子孙 */
        if (t && dragState.ids.some(f => t === f || t.startsWith(f + '/'))) return;
      }
      e.preventDefault();
      drop.classList.add('kb-drop-hint');
    });
    tree.addEventListener('dragleave', e => {
      const drop = e.target.closest ? e.target.closest('[data-folder-toggle], [data-drop-root]') : null;
      if (drop) drop.classList.remove('kb-drop-hint');
    });
    tree.addEventListener('drop', async e => {
      const drop = e.target.closest ? e.target.closest('[data-folder-toggle], [data-drop-root]') : null;
      if (!drop || !dragState) return;
      e.preventDefault();
      drop.classList.remove('kb-drop-hint');
      const target = drop.dataset.folderToggle || '';
      const { kind, ids } = dragState;
      dragState = null;
      if (kind === 'note') await moveNotes(ids, target);
      else await moveFolders(ids, target);
      selNotes.clear(); selFolders.clear();
    });

    /* 批量删除：拖入删除横条与底部多选操作栏共用 */
    async function bulkDeleteNotes(ids){
      const metas = ids.map(id => idx.find(n => n.id === id)).filter(Boolean);
      if (metas.some(n => n.pinned)) showToast('内置笔记已跳过（删除后会自动重建，无需手动删）');
      const delIds = metas.filter(n => !n.pinned).map(n => n.id);
      if (!delIds.length) return;
      let failed = 0;
      for (const id of delIds){
        await API.del('/api/notes/' + id).catch(() => { failed++; });
      }
      idx = idx.filter(n => !delIds.includes(n.id));
      openTabs = openTabs.filter(t => !delIds.includes(t));   // 同步清理被删笔记的标签页
      persistTabs();
      /* 徽标 +N（v0.2.23：批量删除同样进回收站） */
      try {
        const c = parseInt(localStorage.getItem('om_trash_count') || '0', 10) + delIds.length;
        localStorage.setItem('om_trash_count', String(c));
        const badge = $('#kbTrashBadge');
        if (badge){ badge.textContent = String(c); badge.hidden = false; }
      } catch (_) {}
      showToast(`已移到回收站 ${delIds.length} 篇笔记`);
      if (delIds.includes(currentId)){
        currentId = null; dirty = false;
        $('#edSrc').value = ''; $('#edTitle').value = ''; renderPreview();
        if (liveEd) liveEd.refresh();
        updateCrumb();
        if (openTabs.length) open(openTabs[openTabs.length - 1]);
        else if (idx.length) open(idx[0].id);
      }
      selNotes.clear();
      renderTree();
      renderTabs();
      showToast(delIds.length - failed > 0
        ? `已移到回收站 ${delIds.length - failed} 篇笔记${failed ? `（${failed} 篇失败）` : ''}`
        : '删除失败');
      if (delIds.length - failed > 0) loadTrash();   // 后台刷新真实计数
    }
    async function bulkDeleteFolders(ids){
      const dels = ids.filter(f => f !== PLAN_FOLDER && f !== QUICK_FOLDER);
      if (!dels.length) return;
      const ok = await App.confirmModal({
        title: dels.length > 1 ? `删除 ${dels.length} 个文件夹？`
          : `删除文件夹「${folderLabel(dels[0])}」？`,
        sub: '其中的笔记会移到上级文件夹，内部子文件夹将一并删除（笔记本身不会删除）。',
        okText: '删除', danger: true,
      });
      if (!ok) return;
      for (const f of dels){
        await API.del('/api/notes/folders/' + encodeURIComponent(f))
          .catch(e2 => showToast(e2.message, 'err'));
        if (currentFolder === f) currentFolder = '';
        collapsed.delete(f);
      }
      selFolders.clear();
      await load();
      showToast(dels.length > 1 ? `已删除 ${dels.length} 个文件夹` : '文件夹已删除');
    }

    /* 快速删除横条：拖拽落到此处即删（多选批量；内置项自动跳过） */
    const trash = $('#kbTrash');
    trash.addEventListener('dragover', e => {
      if (!dragState) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      trash.classList.add('drop-del');
    });
    trash.addEventListener('dragleave', () => trash.classList.remove('drop-del'));
    trash.addEventListener('drop', async e => {
      if (!dragState) return;
      e.preventDefault();
      const { kind, ids } = dragState;
      dragState = null;
      hideTrash();
      $$('.kb-drop-hint', tree).forEach(x => x.classList.remove('kb-drop-hint'));
      if (kind === 'note') await bulkDeleteNotes(ids);
      else await bulkDeleteFolders(ids);
    });

    /* 多选操作栏：批量删除 / 取消选择 */
    $('#kbBatchDel')?.addEventListener('click', async () => {
      const noteIds = [...selNotes], folderIds = [...selFolders];
      if (!noteIds.length && !folderIds.length) return;
      if (noteIds.length) await bulkDeleteNotes(noteIds);
      if (folderIds.length) await bulkDeleteFolders(folderIds);
      clearAllSel();
      renderTree();
    });
    $('#kbBatchClear')?.addEventListener('click', () => {
      clearAllSel();
      renderTree();
    });

    $('#edSrc').addEventListener('input', onSrcInput);
    $('#edTitle').addEventListener('input', () => {
      dirty = true;
      /* 标签页标题实时跟随（保存落库时再同步目录树） */
      const meta = idx.find(n => n.id === currentId);
      if (meta){ meta.title = $('#edTitle').value.trim() || '未命名笔记'; renderTabs(); }
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 900);
    });
    $$('#edModeSeg .seg-btn').forEach(b =>
      b.addEventListener('click', () => setMode(b.dataset.edMode)));

    /* ---------- 工具条：快捷格式（实时渲染 / 源码双模式，均可撤销） ---------- */
    const imgInput = document.createElement('input');
    imgInput.type = 'file'; imgInput.accept = 'image/*'; imgInput.multiple = true;
    imgInput.style.display = 'none';
    document.body.appendChild(imgInput);
    imgInput.addEventListener('change', () => {
      const files = Array.from(imgInput.files || []);
      imgInput.value = '';
      if (files.length) insertImages(files);
    });

    const ta = $('#edSrc');
    const liveOn = () => liveEd && liveEd.isShown();

    /* 源码模式：用 execCommand 插入，浏览器原生撤销栈保留（Ctrl+Z 可回退） */
    function srcInsert(text){
      ta.focus();
      document.execCommand('insertText', false, text);
      ta.dispatchEvent(new Event('input'));
    }
    /* 包裹选中文本；无选中时插入占位符并选中占位符 */
    function wrapSel(pre, suf, placeholder){
      const ph = placeholder || '';
      if (liveOn()){ liveEd.wrapSelection(pre, suf, ph); return; }
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
      if (liveOn()){ liveEd.lineInsert(prefix); return; }
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
      if (liveOn()){ liveEd.insertText(md); return; }
      srcInsert(md);
    }

    /* ---------- 大纲 ---------- */
    function renderOutline(){
      const body = $('#mdOutlineBody');
      if (!body) return;
      const items = mdOutline(ta.value);
      body.innerHTML = items.length
        ? items.map(h =>
            '<button class="md-outline-item lv' + h.level + '" data-target="' + h.id + '" title="跳到「' +
            App.esc(h.text) + '」">' + App.esc(h.text) + '</button>').join('')
        : '<div class="md-outline-empty">当前笔记没有标题</div>';
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
      const id = it.dataset.target;
      if (currentMode !== 'split' && currentMode !== 'preview') setMode('split');
      setTimeout(() => {
        const el = document.getElementById(id);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        else showToast('该标题刚编辑过，预览尚未刷新', 'err');
      }, 80);
    });

    /* ---------- 查找 / 替换 ---------- */
    let findMatches = [], findIdx = -1;
    function collectMatches(q){
      const v = ta.value, out = [];
      if (!q) return out;
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      let m;
      while ((m = re.exec(v)) != null){ out.push(m.index); if (out.length >= 500) break; }
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
    /* 全部匹配高亮：逐个文本节点内包裹 .lm-find（无 dataset，不影响序列化） */
    function markFindSpans(q){
      clearFindMark();
      if (!q) return;
      const boxes = [];
      if (liveOn()) boxes.push(liveEd.el);
      const pv = $('#edPreview');
      if (pv && pv.style.display !== 'none') boxes.push(pv);
      const ql = q.toLowerCase();
      for (const box of boxes){
        const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT, {
          acceptNode(n){
            const v = n.nodeValue;
            if (!v || v.indexOf(ql) < 0 && v.toLowerCase().indexOf(ql) < 0) return NodeFilter.FILTER_REJECT;
            const p = n.parentElement;
            if (!p || p.closest('button, .lm-find, .lm-tbar, .lm-sel, .lm-drag, .lm-hint, .lm-more, .lm-rowh, .lm-colh')) return NodeFilter.FILTER_REJECT;
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
      const v = ta.value, low = v.toLowerCase(), ql = q.toLowerCase();
      let k = 0, i = 0, j;
      while ((j = low.indexOf(ql, i)) >= 0 && j < pos){ k++; i = j + q.length; }
      const spans = liveEd.el.querySelectorAll('.lm-find');
      spans.forEach(s => s.classList.remove('lm-find-cur'));
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
        if ($('#mdFindBar') && !$('#mdFindBar').hidden) markFindSpans($('#mdFindInput').value);
      }, 160);
    }
    function doFind(dir){   // 0=重新定位第一个 1=下一个 -1=上一个（循环跳转）
      const q = $('#mdFindInput').value;
      findMatches = collectMatches(q);
      const cnt = $('#mdFindCount');
      if (!findMatches.length){
        findIdx = -1;
        cnt.textContent = '0 / 0';
        clearFindMark();
        return;
      }
      if (dir === 0) findIdx = 0;
      else findIdx = (((findIdx < 0 ? 0 : findIdx + dir) % findMatches.length) + findMatches.length) % findMatches.length;
      const pos = findMatches[findIdx];
      ta.setSelectionRange(pos, pos + q.length);
      markFindSpans(q);
      markCurrent(pos, q);
      cnt.textContent = (findIdx + 1) + ' / ' + findMatches.length;
    }
    function doReplaceOne(){
      const q = $('#mdFindInput').value, rp = $('#mdReplaceInput').value;
      if (!q || findIdx < 0 || findIdx >= findMatches.length) return;
      const v = ta.value, pos = findMatches[findIdx];
      const next = v.slice(0, pos) + rp + v.slice(pos + q.length);
      ta.value = next;
      ta.dispatchEvent(new Event('input'));
      if (liveOn()) liveEd.setValue(next);
      doFind(1);
      if (findMatches.length === 0) showToast('已无匹配项');
    }
    function doReplaceAll(){
      const q = $('#mdFindInput').value, rp = $('#mdReplaceInput').value;
      if (!q) return;
      const v = ta.value;
      const next = v.split(q).join(rp);
      if (next === v){ showToast('无匹配项'); return; }
      ta.value = next;
      ta.dispatchEvent(new Event('input'));
      if (liveOn()) liveEd.setValue(next);
      findMatches = []; findIdx = -1;
      $('#mdFindCount').textContent = '0 / 0';
      showToast('已全部替换');
    }
    function openFindBar(){
      const bar = $('#mdFindBar');
      if (!bar) return;
      if (bar.hidden){
        bar.hidden = false;
        $('#mdFindBtn')?.classList.add('on');
        $('#mdFindInput').focus();
        doFind(0);
      } else closeFindBar();
    }
    function closeFindBar(){
      $('#mdFindBar').hidden = true;
      $('#mdFindBtn')?.classList.remove('on');
      clearFindMark();
      ta.focus();
    }
    /* 查找按钮由 ACT['find'] 统一分发，不在此单独绑定（避免一次点击开又关） */
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
      if (!liveOn() || e.target !== liveEd.el) return;
      scheduleMark();
    });
    /* 预览重渲染后同样重打 */
    document.addEventListener('omni:preview-rendered', () => {
      if ($('#mdFindBar') && !$('#mdFindBar').hidden) markFindSpans($('#mdFindInput').value);
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
      if (!liveOn()) return;
      const k = e.key.toLowerCase();
      if (!(e.metaKey || e.ctrlKey)) return;
      if (k === 'z'){
        if (e.shiftKey){ if (liveEd.redo()) e.preventDefault(); }
        else if (liveEd.undo()) e.preventDefault();
      } else if (k === 'y'){
        if (liveEd.redo()) e.preventDefault();
      }
    });

    initLiveEditor();
    /* 默认进入实时渲染编辑模式（marked 不可用时自动回退源码+预览） */
    setMode('edit');
  }

  return { init, load, open, create };
})();
Notes.init();

/* ---------- 仪表盘「灵感速记」内嵌卡：默认打开上次记录的笔记 ---------- */
(() => {
  const QUICK_FOLDER = '灵感速记';
  const LAST_KEY = 'omni.quicknote.lastId';
  let quickId = null, quickTitle = '';
  const src = $('#quickNoteSrc');
  if (!src) return;
  let timer = null;
  /* 原地实时渲染编辑器（隐藏 textarea 仍是数据源） */
  const live = window.LiveMD ? LiveMD.attach(src) : null;

  function fmtTs(ts){
    const diff = Date.now() / 1000 - ts;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    return new Date(ts * 1000).toLocaleDateString('zh-CN');
  }

  /* 「灵感速记」专属文件夹兜底补齐（与后端一致：删除后再拉取自动重建） */
  async function ensureFolder(folderList){
    if (!(folderList || []).includes(QUICK_FOLDER))
      await API.post('/api/notes/folders', { name: QUICK_FOLDER }).catch(() => {});
  }

  async function loadNote(meta){
    const note = await API.get('/api/notes/' + meta.id);
    quickId = meta.id;
    quickTitle = meta.title || '';
    src.value = note.content;
    if (live) live.refresh();
    try { localStorage.setItem(LAST_KEY, quickId); } catch (e) {}
    const chip = $('#quickNoteChip');
    chip.textContent = quickTitle || '未命名笔记';
    chip.title = '当前打开：' + (quickTitle || '未命名笔记') + '（点击重命名）';
    updateStat();
    $('#quickNoteTime').textContent =
      meta.updated ? '上次保存 · ' + fmtTs(meta.updated) : '就绪';
  }

  async function ensureQuick(){
    const d = await API.get('/api/notes');
    const list = d.notes || [];
    await ensureFolder(d.folders);
    let lastId = '';
    try { lastId = localStorage.getItem(LAST_KEY) || ''; } catch (e) {}
    /* 优先打开上次记录的笔记；找不到则取最近更新的非常驻笔记 */
    let hit = (lastId && list.find(n => n.id === lastId))
      || list.filter(n => !n.pinned)
             .sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
    if (!hit){
      hit = await API.post('/api/notes',
        { title: '灵感速记', tags: ['灵感'], folder: QUICK_FOLDER });
      Notes.load();   // 新建后同步知识库列表，确保笔记页可见
    }
    await loadNote(hit);
  }

  /* 新建一篇空白笔记（存入「灵感速记」文件夹） */
  async function newNote(){
    try {
      const d = await API.get('/api/notes');
      await ensureFolder(d.folders);
      const t = new Date(), p = x => String(x).padStart(2, '0');
      const title = `灵感速记 ${p(t.getMonth() + 1)}-${p(t.getDate())} ` +
        `${p(t.getHours())}:${p(t.getMinutes())}`;
      const meta = await API.post('/api/notes',
        { title, tags: ['灵感'], folder: QUICK_FOLDER });
      Notes.load();
      await loadNote(meta);
      if (live) live.focus(); else src.focus();
      showToast('已新建空白笔记，保存在知识库「灵感速记」文件夹');
    } catch (e) { showToast('新建笔记失败：' + e.message); }
  }

  /* 点击标题芯片：给当前速记文档命名 */
  $('#quickNoteChip').addEventListener('click', async () => {
    if (!quickId) return;
    const name = await App.promptModal({
      title: '笔记命名',
      sub: '为当前速记文档起个名字，会同步到知识库',
      value: quickTitle,
      placeholder: '如：产品灵感 08-29',
    });
    if (!name || name === quickTitle) return;
    try {
      await API.put('/api/notes/' + quickId, { title: name });
      quickTitle = name;
      const chip = $('#quickNoteChip');
      chip.textContent = name;
      chip.title = '当前打开：' + name + '（点击重命名）';
      showToast(`已命名为「${name}」`);
    } catch (e) { showToast('命名失败：' + e.message, 'err'); }
  });

  function updateStat(){
    $('#quickNoteStat').textContent = src.value.length + ' 字';
  }

  src.addEventListener('input', () => {
    updateStat();
    $('#quickNoteTime').textContent = '输入中…';
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        try {
          await API.put('/api/notes/' + quickId, { content: src.value });
        } catch (e) {
          /* id 可能已失效（知识库里删除过）：同标题重建一篇再写入 */
          const cur = src.value;
          const d = await API.get('/api/notes');
          await ensureFolder(d.folders);
          const meta = await API.post('/api/notes',
            { title: quickTitle || '灵感速记', tags: ['灵感'], folder: QUICK_FOLDER });
          quickId = meta.id;
          try { localStorage.setItem(LAST_KEY, quickId); } catch (e2) {}
          await API.put('/api/notes/' + quickId, { content: cur });
          Notes.load();
        }
        $('#quickNoteTime').textContent = '已自动保存 ' +
          new Date().toTimeString().slice(0, 5);
        window.LocalSync?.onSiteChanged();   // 速记不经 Notes.save，单独触发对账
      } catch (e) {
        $('#quickNoteTime').textContent = '保存失败';
        showToast('速记保存失败：' + e.message);
      }
    }, 800);
  });

  $('#quickNoteNew').addEventListener('click', newNote);
  App.onEnter(() => ensureQuick().catch(e => showToast('速记加载失败：' + e.message)));
})();
