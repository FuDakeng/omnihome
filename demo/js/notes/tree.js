import { S } from './state.js';

  /* ---------- 加载 ---------- */
  S.load = async function(){
    try {
      const d = await API.get('/api/notes');
      S.idx = d.notes || [];
      S.folders = d.folders || [];
      S.vaults = d.vaults || [];
      S.shares = d.shares || [];
      S.folderVault = d.folderVault || {};
      if (d.currentVault) S.currentVault = d.currentVault;
      else {
        try { S.currentVault = localStorage.getItem(S.VAULT_KEY) || S.VAULT_DEFAULT; } catch (_) {}
      }
      if (!S.vaults.some(v => v.id === S.currentVault)) S.currentVault = S.VAULT_DEFAULT;
      try { localStorage.setItem(S.VAULT_KEY, S.currentVault); } catch (_) {}
      await S.loadAssets();
      S.idx.sort((a, b) => (b.updated || 0) - (a.updated || 0));
      /* trashCount 用后端返回值同步头部（无需展开回收站） */
      if (typeof d.trashCount === 'number'){
        try { localStorage.setItem('om_trash_count', String(d.trashCount)); } catch (_) {}
        const badge = $('#kbTrashBadge');
        if (badge){ badge.textContent = String(d.trashCount); badge.hidden = !d.trashCount; }
      }
      /* 恢复上次打开的标签页（刷新/切视图后），过滤已删除的笔记 */
      try {
        const saved = JSON.parse(localStorage.getItem(S.TABS_KEY) || '[]');
        S.openTabs = saved.filter(id => S.idx.some(n => n.id === id));
      } catch (_) { S.openTabs = []; }
      S.persistTabs();
      S.renderTree();
      S.renderVaultSwitch();
      const inVault = S.idx.filter(n => S.noteVault(n) === S.currentVault);
      const lastTab = S.openTabs[S.openTabs.length - 1];
      if (!S.currentId && lastTab){
        const n = S.idx.find(x => x.id === lastTab);
        if (n && S.noteVault(n) === S.currentVault) S.open(lastTab);
        else if (inVault.length) S.open(inVault[0].id);
      } else if (!S.currentId && inVault.length) S.open(inVault[0].id);
      else if (S.currentId && S.idx.some(n => n.id === S.currentId)){
        const n = S.idx.find(x => x.id === S.currentId);
        if (n && S.noteVault(n) === S.currentVault) S.open(S.currentId);
        else if (inVault.length) S.open(inVault[0].id);
      }
      /* 初始化回收站保留天数缓存（供删除提示显示真实天数；仅首次拉） */
      if (S.trashDays === null){
        API.get('/api/notes/trash').then(d => {
          S.trashDays = (d.trashDays === 0 || d.trashDays) ? d.trashDays : 30;
          S.trash = d.notes || [];
          try { localStorage.setItem('om_trash_count', String(S.trash.length)); } catch (_) {}
          const badge = $('#kbTrashBadge');
          if (badge){ badge.textContent = String(S.trash.length); badge.hidden = !S.trash.length; }
        }).catch(() => {});
      }
    } catch (e) { /* 未登录或网络异常，忽略 */ }
  };

  S.relTime = function(ts){
    const diff = Date.now() / 1000 - ts;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    if (diff < 604800) return Math.floor(diff / 86400) + ' 天前';
    return new Date(ts * 1000).toLocaleDateString('zh-CN');
  };

  S.shareOfNote = function(id){
    const now = Date.now() / 1000;
    return S.shares.find(s => s.kind === 'note' && s.noteId === id && (!s.expireAt || s.expireAt > now));
  };

  S.shareOfFolder = function(f){
    const now = Date.now() / 1000;
    return S.shares.find(s => s.kind === 'folder' && s.folder === f && (!s.expireAt || s.expireAt > now));
  };

  S.treeIcon = function(kind, shared, title){
    const href = kind === 'folder' ? '#i-folder' : (kind === 'star' ? '#i-star' : '#i-note');
    const cls = kind === 'folder' ? 'ic kb-folder-ic' : 'ic ni-icon';
    return `<span class="kb-ic${shared ? ' is-shared' : ''}"${shared ? ` title="${App.esc(title || '已分享')}"` : ''}><svg class="${cls}"><use href="${href}"/></svg></span>`;
  };

  /* ---------- 树状目录渲染（图标 + 标题 + ⋯，单行） ---------- */
  S.noteItemHtml = function(n){
    const pinned = n.pinned;
    const lock = n.readonly ? '<svg class="ic ni-icon" style="color:var(--om-text-3);width:11px;height:11px"><use href="#i-lock"/></svg>' : '';
    return `
      <button class="note-item${n.id === S.currentId ? ' active' : ''}${S.selNotes.has(n.id) ? ' kb-selected' : ''}" data-note-id="${n.id}"${pinned || !S.vaultCanEdit() ? '' : ' draggable="true"'}>
        ${S.treeIcon(pinned ? 'star' : 'note', !!S.shareOfNote(n.id), '此笔记已分享')}${lock}
        <span class="ni-title">${App.esc(n.title || '未命名笔记')}</span>
        ${S.vaultCanEdit() ? `<span class="ni-act" data-note-act="${n.id}" title="笔记操作"><svg class="ic"><use href="#i-more"/></svg></span>` : ''}
      </button>`;
  };

  /* ---------- 树状目录渲染（支持多层文件夹：路径以 / 分隔） ---------- */
  S.folderLabel = f => f.includes('/') ? f.slice(f.lastIndexOf('/') + 1) : f;
  /* 直接子文件夹：路径在 prefix 之下且不再含 / */
  S.childFolders = function(prefix){
    return S.folders.filter(f => {
      const rest = prefix ? (f.startsWith(prefix + '/') ? f.slice(prefix.length + 1) : '') : f;
      return rest && !rest.includes('/');
    });
  };

  /* 子树笔记总数（含所有后代文件夹） */
  S.noteCountIn = f => S.idx.filter(n =>
    !n.pinned && S.noteVault(n) === S.currentVault
    && (n.folder === f || (n.folder || '').startsWith(f + '/'))).length;
  S.renderFolder = function(f, depth){
    const notes = S.idx.filter(n => !n.pinned && n.folder === f && S.noteVault(n) === S.currentVault);
    const subs = S.childFolders(f).filter(s => S.folderOfVault(s) === S.currentVault);
    /* v0.2.25：默认折叠——expanded 集合记录已展开的文件夹（localStorage 持久化），不在集合内即折叠 */
    const open = S.expanded.has(f);
    const locked = f === S.PLAN_FOLDER || f === S.QUICK_FOLDER;   // 内置/专属：不可拖拽挪位
    const inner = subs.map(s => S.renderFolder(s)).join('')
      + (notes.length ? notes.map(n => S.noteItemHtml(n)).join('') : '');
    return `
      <div class="kb-folder${open ? ' open' : ''}${S.currentFolder === f ? ' current' : ''}${!depth ? ' kb-folder-root' : ''}">
        <div class="kb-folder-row${S.selFolders.has(f) ? ' kb-selected' : ''}" data-folder-toggle="${App.esc(f)}"${locked || !S.vaultCanEdit() ? '' : ' draggable="true"'}>
          <svg class="ic kb-chev"><use href="#i-chev-d"/></svg>
          ${S.treeIcon('folder', !!S.shareOfFolder(f), '此文件夹已分享')}
          <span class="kb-folder-name" title="${App.esc(f)}">${App.esc(S.folderLabel(f))}</span>
          <span class="kb-count num">${S.noteCountIn(f)}</span>
          ${locked ? '<span class="chip no-dot" style="font-size:10px;padding:2px 6px" title="系统内置文件夹，不可删除">内置</span>'
            : (!S.vaultCanEdit() ? ''
            : `<button class="icon-btn-xs kb-folder-add" data-kb-add="${App.esc(f)}" title="在此文件夹内新建笔记或子文件夹"><svg class="ic"><use href="#i-plus"/></svg></button>
               <button class="icon-btn-xs kb-folder-more" data-folder-act="${App.esc(f)}" title="文件夹操作：重命名 / 复制 / 导出 / 删除"><svg class="ic"><use href="#i-more"/></svg></button>`)}
        </div>
        <div class="kb-folder-body" ${open ? '' : 'hidden'}>
          ${inner || '<div class="kb-empty">暂无笔记，可新建或拖拽进来</div>'}
        </div>
      </div>`;
  };

  S.renderTree = function(){
    S.idx = S.idx.filter(n => !n.deleted);
    const vis = S.idx.filter(n => S.noteVault(n) === S.currentVault);
    const pinned = vis.filter(n => n.pinned);
    const roots = vis.filter(n => !n.pinned && !n.folder);
    const vaultFolders = S.folders.filter(f => S.folderOfVault(f) === S.currentVault);
    const isSys = S.currentVault === S.VAULT_SYSTEM;
    let html = '';

    html += `
      <div class="kb-sec-title" data-drop-root title="拖拽笔记到此处取消分组">
        <svg class="ic"><use href="#${S.vaultIcon(S.vaultMeta(S.currentVault))}"/></svg>${App.esc(S.vaultLabel(S.currentVault))}
        ${isSys || !S.vaultCanEdit() ? '' : '<button class="icon-btn-xs kb-root-add" data-kb-add="" title="新建笔记或文件夹"><svg class="ic"><use href="#i-plus"/></svg></button>'}
      </div>`;

    if (isSys){
      html += pinned.map(n => S.noteItemHtml(n)).join('');
      if (vaultFolders.includes(S.PLAN_FOLDER)) html += S.renderFolder(S.PLAN_FOLDER);
      if (vaultFolders.includes(S.QUICK_FOLDER)) html += S.renderFolder(S.QUICK_FOLDER);
      if (!pinned.length && !vaultFolders.length)
        html += '<div class="kb-empty">系统内置仓库：生词本、每日计划、灵感速记</div>';
    } else {
      for (const f of S.childFolders('')) if (S.folderOfVault(f) === S.currentVault) html += S.renderFolder(f);
      html += roots.length ? roots.map(n => S.noteItemHtml(n, 0)).join('')
        : '<div class="kb-empty">暂无笔记，点上方「新建」开始</div>';
    }

    const trashCount = +(localStorage.getItem('om_trash_count') || 0);
    const badge = $('#kbTrashBadge');
    if (badge){
      badge.textContent = String(trashCount);
      badge.hidden = !trashCount;
    }

    if (!isSys){
      const assetsHidden = localStorage.getItem(S.ASSET_KEY) === '1';
      html += `
        <div class="kb-sec-title kb-pin-head${assetsHidden ? ' closed' : ''}" data-assets-toggle title="点击隐藏 / 展开附件">
          <svg class="ic kb-pin-chev"><use href="#i-chev-d"/></svg>
          <svg class="ic"><use href="#i-image"/></svg>附件
          <span class="kb-count num">${S.assets.length}</span>
        </div>`;
      if (!assetsHidden){
        html += S.assets.length
          ? S.assets.map(a => `
        <div class="note-item kb-asset${S.selAssets.has(a.name) ? ' kb-selected' : ''}" data-asset-name="${App.esc(a.name)}" draggable="true" title="点击预览，拖入编辑区可引用；按住 ⌘/Ctrl 可多选批量拖入">
          <span class="ni-thumb"><img data-asset-src="/api/notes/assets/${encodeURIComponent(a.name)}" alt="" loading="lazy"></span>
          <div class="ni-text">
            <div class="ni-title">${App.esc(a.name)}</div>
            <div class="ni-sub">${App.esc(a.type || '附件')}${a.size ? ' · ' + S.fmtSize(a.size) : ''}</div>
          </div>
          <button class="kb-asset-del" data-asset-del="${App.esc(a.name)}" title="删除附件（笔记中的引用会变裂图）"><svg class="ic"><use href="#i-trash"/></svg></button>
        </div>`).join('')
          : '<div class="kb-empty">在笔记中添加的图片会自动归档到这里</div>';
      }
    }

    $('#noteTree').innerHTML = html;
    $('#notesCount').textContent =
      `${vis.length} 篇 · ${vaultFolders.length} 个文件夹`;
    S.hydrateImages($('#noteTree'));
    S.updateBatchBar();
  };

  /* ---------- 回收站：树形展开 + 排序 ---------- */
  S.sortTrashNotes = function(arr){
    const a = arr.slice();
    if (S.trashSort === 'updated')
      a.sort((x, y) => (y.updated || 0) - (x.updated || 0));
    else if (S.trashSort === 'title')
      a.sort((x, y) => String(x.deleted_title || x.title || '').localeCompare(
        String(y.deleted_title || y.title || ''), 'zh'));
    else
      a.sort((x, y) => (y.deleted || 0) - (x.deleted || 0));
    return a;
  };

  S.trashNoteRow = function(n){
    return `
      <div class="note-item kb-trash-row" data-trash-id="${App.esc(n.id)}">
        <svg class="ic ni-icon" style="color:var(--om-text-3)"><use href="#i-note"/></svg>
        <span class="ni-title">${App.esc(n.deleted_title || n.title || '未命名笔记')}</span>
        <span class="ni-date">${S.relTime(S.trashSort === 'updated' ? n.updated : n.deleted)}</span>
        <button class="icon-btn-xs kb-trash-restore" data-trash-restore="${App.esc(n.id)}" title="恢复"><svg class="ic"><use href="#i-reply"/></svg></button>
        <button class="icon-btn-xs kb-trash-purge" data-trash-purge="${App.esc(n.id)}" title="永久删除"><svg class="ic"><use href="#i-trash"/></svg></button>
      </div>`;
  };

  S.renderTrashFolder = function(prefix, notes, allFolders){
    const kids = allFolders.filter(f => {
      if (prefix) return f.startsWith(prefix + '/') && !f.slice(prefix.length + 1).includes('/');
      return f && !f.includes('/');
    });
    const here = notes.filter(n => (n.folder || '') === prefix);
    const open = !prefix || S.trashExpanded.has(prefix);
    const inner = kids.map(k => S.renderTrashFolder(k, notes, allFolders)).join('')
      + S.sortTrashNotes(here).map(S.trashNoteRow).join('');
    if (!prefix) return inner || '<div class="kb-trash-empty">该仓库没有已删除笔记</div>';
    const gone = !S.folders.includes(prefix);
    return `
      <div class="kb-folder${open ? ' open' : ''} kb-trash-fold">
        <div class="kb-folder-row" data-trash-fold="${App.esc(prefix)}">
          <svg class="ic kb-chev"><use href="#i-chev-d"/></svg>
          <svg class="ic kb-folder-ic"><use href="#i-folder"/></svg>
          <span class="kb-folder-name">${App.esc(S.folderLabel(prefix))}</span>
          ${gone ? '<span class="chip no-dot" style="font-size:10px;margin-left:6px">已删除</span>' : ''}
          <span class="kb-count num">${notes.filter(n => n.folder === prefix || (n.folder || '').startsWith(prefix + '/')).length}</span>
        </div>
        <div class="kb-folder-body" ${open ? '' : 'hidden'}>${inner || '<div class="kb-empty">空</div>'}</div>
      </div>`;
  };

  S.renderTrashList = function(){
    const body = $('#kbTrashList');
    if (!body) return;
    const sortBar = `<div class="kb-trash-sort">
      <span>排序</span>
      <div class="seg">
        <button type="button" class="seg-btn${S.trashSort === 'deleted' ? ' active' : ''}" data-trash-sort="deleted">删除时间</button>
        <button type="button" class="seg-btn${S.trashSort === 'updated' ? ' active' : ''}" data-trash-sort="updated">修改时间</button>
        <button type="button" class="seg-btn${S.trashSort === 'title' ? ' active' : ''}" data-trash-sort="title">名称</button>
      </div>
    </div>`;
    if (!S.trash.length){ body.innerHTML = sortBar + '<div class="kb-trash-empty">回收站是空的</div>'; return; }
    const vlist = S.trashVaults.length ? S.trashVaults : S.vaults;
    const vname = id => (vlist.find(v => v.id === id) || {}).name || S.vaultLabel(id);
    const byVault = new Map();
    for (const n of S.trash){
      const vid = S.noteVault(n);
      if (!byVault.has(vid)) byVault.set(vid, []);
      byVault.get(vid).push(n);
    }
    const vaultOrder = [...byVault.keys()].sort((a, b) => {
      const rank = id => id === S.VAULT_DEFAULT ? 0 : id === S.VAULT_SYSTEM ? 2 : 1;
      return rank(a) - rank(b) || vname(a).localeCompare(vname(b), 'zh');
    });
    body.innerHTML = sortBar + vaultOrder.map(vid => {
      const notes = byVault.get(vid);
      const folderSet = new Set();
      for (const n of notes){
        const f = n.folder || '';
        if (!f) continue;
        let cur = '';
        f.split('/').forEach(seg => { cur = cur ? cur + '/' + seg : seg; folderSet.add(cur); });
      }
      const allFolders = [...folderSet].sort();
      const meta = S.trashVaults.find(x => x.id === vid) || S.vaults.find(x => x.id === vid) || {};
      const chip = vid === S.VAULT_SYSTEM ? '系统内置' : vid === S.VAULT_DEFAULT ? '默认' : (meta.kind === 'team' ? '团队' : '自建');
      return `
      <div class="kb-trash-vault">
        <div class="kb-trash-vault-head"><svg class="ic"><use href="#${S.vaultIcon(meta)}"/></svg>${App.esc(vname(vid))}<span class="chip no-dot" style="margin-left:8px;font-size:10px">${chip}</span><span class="kb-count num" style="margin-left:auto">${notes.length}</span></div>
        ${S.renderTrashFolder('', notes, allFolders)}
      </div>`;
    }).join('');
  };

  S.loadTrash = async function(){
    try {
      const d = await API.get('/api/notes/trash');
      S.trash = d.notes || [];
      S.trashVaults = d.vaults || S.vaults;
      S.trashDays = (d.trashDays === 0 || d.trashDays) ? d.trashDays : 30;
      const dt = $('#kbTrashDaysTxt');
      if (dt) dt.textContent = S.trashDays === 0 ? '永久' : S.trashDays;
      const cnt = S.trash.length;
      try { localStorage.setItem('om_trash_count', String(cnt)); } catch (_) {}
      const badge = $('#kbTrashBadge');
      if (badge){ badge.textContent = String(cnt); badge.hidden = !cnt; }
      S.renderTrashList();
    } catch (e) { /* 静默 */ }
  };

  S.openTrashModal = function(){
    App.openModal('kbTrashMask');
    S.renderTrashList();
    S.loadTrash();
  };

  S.restoreTrash = async function(id){
    try {
      const r = await API.post('/api/notes/' + encodeURIComponent(id) + '/restore');
      showToast(r.restored ? '已恢复到原位置' : '未在回收站');
      await S.load();
      await S.loadTrash();
    } catch (e) { showToast(e.message, 'err'); }
  };

  S.purgeTrash = async function(id){
    if (!await App.confirmModal({
      title: '永久删除笔记？',
      sub: '该笔记将被彻底从回收站移除，.md 文件一并清除，无法恢复。',
      okText: '永久删除', danger: true,
    })) return;
    try {
      await API.del('/api/notes/trash/' + encodeURIComponent(id));
      showToast('已永久删除');
      await S.load();
      await S.loadTrash();
    } catch (e) { showToast(e.message, 'err'); }
  };

  S.purgeAllTrash = async function(){
    if (!S.trash.length) return;
    if (!await App.confirmModal({
      title: '清空回收站？',
      sub: `回收站共 ${S.trash.length} 篇笔记，全部将永久删除，无法恢复。`,
      okText: '清空', danger: true,
    })) return;
    try {
      const r = await API.post('/api/notes/trash/purge-all');
      showToast(`已清空回收站（${r.purged || 0} 篇）`);
      await S.load();
      await S.loadTrash();
    } catch (e) { showToast(e.message, 'err'); }
  };

  /* 多选操作栏：选中笔记/文件夹时底部滑出，提供批量删除/取消 */
  S.updateBatchBar = function(){
    const bar = $('#kbBatchBar');
    if (!bar) return;
    const n = S.selNotes.size, f = S.selFolders.size;
    if (!n && !f){ bar.hidden = true; return; }
    const parts = [];
    if (n) parts.push(`${n} 篇笔记`);
    if (f) parts.push(`${f} 个文件夹`);
    $('#kbBatchCount').textContent = '已选 ' + parts.join(' + ');
    bar.hidden = false;
  };

  S.clearAllSel = function(){
    S.selNotes.clear(); S.selFolders.clear(); S.selAssets.clear();
    S.updateBatchBar();
  };

  /* ---------- 显式多选模式：入口在树头 ⋯ 菜单（原「多选」按钮位置已改为回收站） ---------- */
  S.setSelMode = function(on){
    S.selMode = on;
    $('.kb-tree')?.classList.toggle('sel-mode', on);
    if (!on) S.clearAllSel();
    else S.renderTree();
  };

