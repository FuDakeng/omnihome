import { mdRender, mdFallback, mdOutline, outlineItemHtml, outlineBodyHtml, mdLineDiff, renderRevDiffHtml, _mdSlug } from './md.js';
import { S } from './state.js';

  /* ---------- 打开 / 保存 ---------- */
  S.open = async function(id){
    if (!S.idx.find(n => n.id === id)) return;
    if (id !== S.currentId && S.dirty) await S.save();
    /* 标签页登记：新开追加到末尾，已存在则仅切换激活 */
    if (!S.openTabs.includes(id)){ S.openTabs.push(id); S.persistTabs(); }
    S.currentId = id;
    const meta = S.idx.find(n => n.id === id);
    if (meta && S.noteVault(meta) !== S.currentVault){
      S.currentVault = S.noteVault(meta);
      try { localStorage.setItem(S.VAULT_KEY, S.currentVault); } catch (_) {}
      S.renderVaultSwitch();
    }
    S.setReadonly(!!(meta && meta.readonly) || !S.vaultCanEdit());
    try {
      const d = await API.get('/api/notes/' + id);
      $('#edSrc').value = d.content;
      $('#edTitle').value = (d.title != null && d.title !== '') ? d.title : (meta ? meta.title : '');
      if (meta && d.title) meta.title = d.title;
      S.lastKnownUpdated = d.updated || Math.floor(Date.now() / 1000);
      S.dirty = false;
      S.renderPreview();
      if (S.liveEd) S.liveEd.refresh();
      S.hydrateNow();   // 附件图片水合（鉴权取图 → data URL）
      S.renderTree();
      S.renderTabs();
      S.updateCrumb();
      S.updateStat();
      if (typeof window.enterKbEditor === 'function') enterKbEditor(true);
      if (window.isPhone && isPhone() && S.currentMode === 'split') S.setMode('edit');
      const ob = $('#mdOutlineBody');
      if (ob) ob.innerHTML = outlineBodyHtml($('#edSrc').value);
      const op = $('#mdOutlinePanel');
      if (op && op.hidden && !(window.isPhone && isPhone())){
        op.hidden = false;
        requestAnimationFrame(() => op.classList.add('open'));
      }
    } catch (e) {
      /* 打开失败：撤回标签登记 */
      S.openTabs = S.openTabs.filter(t => t !== id);
      S.persistTabs();
      S.renderTabs();
      showToast(e.message, 'err');
    }
  };

  S.create = async function(folder){
    if (!S.vaultCanEdit()){ showToast('此仓库为只读', 'err'); return; }
    try {
      if (S.currentVault === S.VAULT_SYSTEM && folder === undefined){
        showToast('系统内置仓库不可新建普通笔记，请先切换到默认仓库', 'err');
        return;
      }
      const dest = folder !== undefined ? folder
        : (S.isBuiltin(S.currentFolder) ? '' : S.currentFolder);
      const meta = await API.post('/api/notes',
        { title: '未命名笔记', tags: [], folder: dest, vault: S.currentVault });
      S.idx.unshift(meta);
      S.renderTree();
      await S.open(meta.id);
      goView('notes');
      $('#edTitle').focus();
      $('#edTitle').select();
    } catch (e) { showToast(e.message, 'err'); }
  };

  S.save = async function(){
    if (!S.currentId) return;
    if ($('#edTitle').readOnly) return;   // 只读笔记不落库（防延时保存串页）
    try {
      await API.put('/api/notes/' + S.currentId, {
        content: $('#edSrc').value,
        title: $('#edTitle').value.trim() || '未命名笔记',
      });
      S.dirty = false;
      S.lastKnownUpdated = Math.floor(Date.now() / 1000);
      const meta = S.idx.find(n => n.id === S.currentId);
      if (meta){ meta.title = $('#edTitle').value.trim() || '未命名笔记'; meta.updated = Date.now() / 1000; }
      $('#edFootTime').textContent = '已自动保存（刚刚）';
      S.renderTree();
      S.renderTabs();
    } catch (e) { showToast('保存失败：' + e.message, 'err'); }
  };

  S.del = async function(id){
    const meta = S.idx.find(n => n.id === id);
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
        const it = S.idx.find(n => n.id === id);
        if (it){ it.deleted = r.id ? Math.floor(Date.now()/1000) : Date.now()/1000; it.deleted_title = it.title; }
      } else {
        S.selNotes.delete(id);
        S.idx = S.idx.filter(n => n.id !== id);
      }
      S.openTabs = S.openTabs.filter(t => t !== id);   // 同步关闭对应标签页
      S.persistTabs();
      if (S.currentId === id){
        S.currentId = null;
        $('#edSrc').value = ''; $('#edTitle').value = ''; S.renderPreview();
        if (S.liveEd) S.liveEd.refresh();
        S.updateCrumb();
      }
      S.renderTabs();
      if (meta.pinned){
        showToast('常驻笔记已自动重建');
        await S.load();   // 后端拉取时自动重建常驻笔记
        return;
      }
      if (!S.currentId){
        /* 删的是当前页：优先切到剩余标签页，无标签才回落第一篇 */
        if (S.openTabs.length) S.open(S.openTabs[S.openTabs.length - 1]);
        else if (S.idx.length) S.open(S.idx[0].id);
      }
      S.renderTree();
      if (r && r.softDeleted){
        /* 保留天数：loadTrash 拉过就有真实值；未知时用中性文案（v0.2.23 BUG 修复：
           原文案写死「保留 N 天」，与设置里 30 天对不上造成误导） */
        showToast(S.trashDays === 0 ? '已移到回收站（未设自动清理）'
          : S.trashDays ? `已移到回收站（保留 ${S.trashDays} 天）` : '已移到回收站');
        /* 徽标 +1（本地估算，下次 load 对齐） */
        try {
          const c = parseInt(localStorage.getItem('om_trash_count') || '0', 10) + 1;
          localStorage.setItem('om_trash_count', String(c));
          const badge = $('#kbTrashBadge');
          if (badge){ badge.textContent = String(c); badge.hidden = false; }
        } catch (_) {}
        S.loadTrash();   // 后台刷新真实计数与列表（弹层开着也同步）
      } else {
        showToast('已删除');
      }
    } catch (e) { showToast(e.message, 'err'); }
  };

  /* ---------- 文件夹（支持在文件夹内再建文件夹） ---------- */
  S.newFolder = async function(parent = ''){
    if (!S.vaultCanEdit()){ showToast('此仓库为只读', 'err'); return; }
    const name = await App.promptModal({
      title: parent ? `在「${S.folderLabel(parent)}」内新建子文件夹` : '新建文件夹',
      sub: '可以把笔记拖入文件夹归类整理，文件夹支持多层嵌套',
      placeholder: '文件夹名称，如：工作',
    });
    if (!name) return;
    if (name.includes('/')){ showToast('文件夹名称不能包含 /', 'err'); return; }
    const full = parent ? parent + '/' + name.trim() : name.trim();
    try {
      await API.post('/api/notes/folders', { name: full, vault: S.currentVault });
      if (parent){ S.expanded.add(parent); S.persistExpanded(); }   // 展开父级让新文件夹可见
      S.currentFolder = full;
      await S.load();
      showToast(`文件夹「${name.trim()}」已创建`);
    } catch (e) { showToast(e.message, 'err'); }
  };

  S.delFolder = async function(name){
    const hasSub = S.folders.some(f => f.startsWith(name + '/'));
    if (!await App.confirmModal({
      title: `删除文件夹「${S.folderLabel(name)}」？`,
      sub: hasSub
        ? '内部子文件夹将一并删除，其中的笔记全部移入回收站（可恢复，原文件夹在恢复时自动重建）。'
        : '其中的笔记将全部移入回收站（可恢复，原文件夹在恢复时自动重建）。',
      okText: '删除', danger: true,
    })) return;
    try {
      const r = await API.del('/api/notes/folders/' + encodeURIComponent(name));
      if (S.currentFolder === name) S.currentFolder = '';
      S.expanded.delete(name); S.persistExpanded();
      await S.load();
      showToast(`文件夹已删除（${(r && r.trashed) || 0} 篇笔记进回收站）`);
      if (r && r.trashed) S.loadTrash();
    } catch (e) { showToast(e.message, 'err'); }
  };

  /* ---------- 文件夹 ⋯ 操作菜单：重命名 / 复制 / 导出 / 删除（0.2.21 起替代悬浮删除钮） ---------- */
  S.openFolderMenu = function(anchor, f){
    S.kbMenu(anchor, [
      ['重命名文件夹', 'i-pen', async () => {
        const name = await App.promptModal({
          title: '重命名文件夹', sub: `「${S.folderLabel(f)}」的子文件夹与笔记将一并迁移`,
          value: S.folderLabel(f), placeholder: '新名称',
        });
        if (!name) return;
        const trimmed = name.trim();
        if (!trimmed || trimmed === S.folderLabel(f)) return;
        if (trimmed.includes('/')){ showToast('文件夹名称不能包含 /', 'err'); return; }
        const parent = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
        const newF = parent ? parent + '/' + trimmed : trimmed;
        if (S.folders.includes(newF)){ showToast('同级已存在同名文件夹', 'err'); return; }
        try {
          await API.post('/api/notes/folders', { name: newF });
          /* 迁移子文件夹树（后端自动逐级补齐；已存在时 400 忽略） */
          for (const p of S.folders.filter(x => x.startsWith(f + '/')))
            await API.post('/api/notes/folders', { name: newF + p.slice(f.length) }).catch(() => {});
          /* 迁移本级与全部子级笔记 */
          const moving = S.idx.filter(n => n.folder === f || (n.folder || '').startsWith(f + '/'));
          for (const n of moving)
            await API.put('/api/notes/' + n.id, { folder: newF + (n.folder || '').slice(f.length) });
          /* 删旧文件夹树：笔记已迁空，后端「内容上移」逻辑不会再触发 */
          await API.del('/api/notes/folders/' + encodeURIComponent(f));
          S.expanded.add(f); S.persistExpanded();
          if (S.currentFolder === f) S.currentFolder = newF;
          await S.load();
          showToast(`文件夹已重命名为「${trimmed}」`);
        } catch (e) { showToast(e.message, 'err'); }
      }],
      ['分享文件夹', 'i-link', () => S.openShareModal({ kind: 'folder', folder: f, name: S.folderLabel(f) })],
      ['复制文件夹', 'i-copy', () => S.copyFolder(f)],
      ['导出文件夹', 'i-download', () => API.dl('/api/notes/folder/export?path=' + encodeURIComponent(f))],
      ['删除文件夹', 'i-trash', () => S.delFolder(f)],
    ]);
  };

  /* 复制文件夹：递归建同名子树，逐篇拉正文新建副本（目标名自动避重） */
  S.copyFolder = async function(f){
    const parent = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    const base = S.folderLabel(f) + ' 副本';
    let label = base, i = 2;
    while (S.folders.includes(parent ? parent + '/' + label : label)) label = base + i++;
    const newF = parent ? parent + '/' + label : label;
    try {
      await API.post('/api/notes/folders', { name: newF });
      for (const p of S.folders.filter(x => x.startsWith(f + '/')))
        await API.post('/api/notes/folders', { name: newF + p.slice(f.length) }).catch(() => {});
      const src = S.idx.filter(n => !n.pinned && (n.folder === f || (n.folder || '').startsWith(f + '/')));
      for (const n of src){
        const d = await API.get('/api/notes/' + n.id);
        const r = await API.post('/api/notes',
          { title: n.title || '未命名笔记', tags: n.tags || [], folder: newF + (n.folder || '').slice(f.length) });
        await API.put('/api/notes/' + r.id, { content: d.content || '' });
      }
      await S.load();
      showToast(src.length ? `已复制文件夹（${src.length} 篇笔记）` : '已复制空文件夹');
    } catch (e) { showToast(e.message, 'err'); }
  };

  S.moveNote = async function(id, folder){
    try {
      await API.put('/api/notes/' + id, { folder });
      const meta = S.idx.find(n => n.id === id);
      const prevFolder = meta ? meta.folder : '';
      if (meta) meta.folder = folder;
      S.renderTree();
      showToast(folder ? `已移入文件夹「${folder}」` : '已移出文件夹');
    } catch (e) { showToast(e.message, 'err'); }
  };

  /* 批量移动笔记（多选拖拽） */
  S.moveNotes = async function(ids, folder){
    if (ids.length === 1){ await S.moveNote(ids[0], folder); return; }
    try {
      for (const id of ids){
        await API.put('/api/notes/' + id, { folder });
        const meta = S.idx.find(n => n.id === id);
        if (meta) meta.folder = folder;
      }
            S.renderTree();
      showToast(`${ids.length} 篇笔记${folder ? `已移入「${folder}」` : '已移出文件夹'}`);
    } catch (e) { showToast(e.message, 'err'); }
  };

  /* 批量移动文件夹：重挂路径（含子孙） + 笔记归属同步，后端整体保存 */
  S.moveFolders = async function(ids, target){
    const repath = (f, o, n) =>
      f === o ? n : (f.startsWith(o + '/') ? n + f.slice(o.length) : f);
    let fl = S.folders.slice();
    const moved = [];
    for (const f of ids){
      if (f === S.PLAN_FOLDER || f === S.QUICK_FOLDER) continue;
      if (target === f || target.startsWith(f + '/')) continue;   // 不允许移入自身/子孙（兜底）
      const dest = target ? target + '/' + S.folderLabel(f) : S.folderLabel(f);
      if (dest === f) continue;
      if (fl.includes(dest)){
        showToast(`「${S.folderLabel(target)}」内已存在同名文件夹`, 'err');
        continue;
      }
      fl = fl.map(x => repath(x, f, dest));
      moved.push([f, dest]);
    }
    if (!moved.length) return;
    try {
      /* 先算出受影响笔记，再依次落库 */
      const noteMoves = [];
      for (const n of S.idx){
        const f = n.folder || '';
        for (const [o, nw] of moved){
          if (f === o || f.startsWith(o + '/')){ noteMoves.push([n, repath(f, o, nw)]); break; }
        }
      }
      await API.put('/api/notes/folders', { S.folders: fl });
      for (const [n, nf] of noteMoves){
        await API.put('/api/notes/' + n.id, { folder: nf });
        n.folder = nf;
      }
      S.expanded.clear(); S.persistExpanded();
      await S.load();
      showToast(moved.length > 1
        ? `已移动 ${moved.length} 个文件夹`
        : `文件夹已移到${target ? `「${S.folderLabel(target)}」内` : '仓库根目录'}`);
    } catch (e) { showToast(e.message, 'err'); }
  };

