import { S } from './state.js';

  S.persistExpanded = function(){
    try { localStorage.setItem(S.EXPAND_KEY, JSON.stringify([...expanded])); } catch (_) {}
  };

  S.isPlan = f => f === S.PLAN_FOLDER || f.startsWith(S.PLAN_FOLDER + '/');
  S.isQuick = f => f === S.QUICK_FOLDER || f.startsWith(S.QUICK_FOLDER + '/');
  S.isBuiltin = f => S.isPlan(f) || S.isQuick(f);
  S.noteVault = function(n){
    if (n && n.pinned) return S.VAULT_SYSTEM;
    if (S.isBuiltin((n && n.folder) || '')) return S.VAULT_SYSTEM;
    if (n && n.vault) return n.vault;
    return S.VAULT_DEFAULT;
  };

  S.folderOfVault = function(f){
    const v = S.folderVault[f];
    if (Array.isArray(v)) {
      if (v.indexOf(S.currentVault) >= 0) return S.currentVault;
      return v[0] || (S.isBuiltin(f) ? S.VAULT_SYSTEM : S.VAULT_DEFAULT);
    }
    if (v) return v;
    return S.isBuiltin(f) ? S.VAULT_SYSTEM : S.VAULT_DEFAULT;
  };

  S.vaultMeta = function(id){ return S.vaults.find(v => v.id === id) || { id: id, name: id, kind: 'user' }; };

  S.vaultLabel = function(id){ return S.vaultMeta(id).name || id; };

  S.vaultIcon = function(v){
    return (v && v.kind === 'team') ? 'i-users' : 'i-inbox';
  };

  S.vaultKindTag = function(v){
    if (v.kind === 'system') return '（内置）';
    if (v.kind === 'default') return '（默认）';
    if (v.kind === 'team') return v.isOwner ? '（团队 · 我创建）' : (v.canEdit ? '（团队）' : '（团队 · 只读）');
    return '';
  };

  S.canDeleteVault = function(v){
    if (!v) return false;
    if (v.kind === 'user') return true;
    if (v.kind === 'team' && v.isOwner) return true;
    return false;
  };

  S.vaultCanEdit = function(id){
    const v = S.vaultMeta(id || S.currentVault);
    if (v.kind === 'team' && v.canEdit === false && !v.isOwner) return false;
    return true;
  };

  S.vaultSyncBlock = function(v){
    v = v || S.vaultMeta(S.currentVault);
    if ((v && v.kind === 'system') || (v && v.id === S.VAULT_SYSTEM) || S.currentVault === S.VAULT_SYSTEM)
      return '系统内置仓库不可与 Obsidian 同步，无法开启。';
    if (v && v.kind === 'team' && !v.isOwner && v.canEdit === false)
      return '你对此团队仓库只有只读权限，无法开启 Obsidian 同步。';
    return '';
  };

  S.vaultSyncSwitchLocked = function(v){
    v = v || S.vaultMeta(S.currentVault);
    if (v && v.kind === 'team' && !v.isOwner)
      return '仅创建人可开关此团队仓库的同步。';
    return '';
  };

  S.fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB'
    : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
  /* Markdown 渲染见 notes/md.js */
  S.jumpToHeading = function(id, line, live, root){
    line = line === '' || line == null ? NaN : +line;
    if (live && live.isShown && live.isShown() && typeof live.scrollToLine === 'function' && isFinite(line)){
      live.scrollToLine(line);
      return;
    }
    const el = id
      ? (root ? root.querySelector('[id="' + String(id).replace(/"/g, '') + '"]') : document.getElementById(id))
      : null;
    if (el){ el.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    const ta = $('#edSrc');
    if (ta && S.currentMode !== 'preview' && isFinite(line)){
      const lines = ta.value.split('\n');
      let pos = 0;
      for (let i = 0; i < line && i < lines.length; i++) pos += lines[i].length + 1;
      try {
        ta.focus();
        ta.setSelectionRange(pos, pos);
        const lh = parseFloat(getComputedStyle(ta).lineHeight) || 22;
        ta.scrollTop = Math.max(0, line * lh - 48);
      } catch (_) {}
    }
  };

  S.renderVaultSwitch = function(){
    const btn = $('#kbVaultBtn');
    if (!btn) return;
    const v = S.vaultMeta(S.currentVault);
    const nameEl = $('#kbVaultName');
    if (nameEl){
      const ro = v.kind === 'team' && !v.isOwner && v.canEdit === false;
      nameEl.textContent = (v.name || '笔记仓库') + (ro ? ' · 只读' : '');
    }
    btn.dataset.kind = v.kind || 'user';
    const ic = btn.querySelector('svg.ic:not(.kb-vault-chev) use');
    if (ic) ic.setAttribute('href', '#' + S.vaultIcon(v));
    if (v.kind === 'team' && !v.isOwner && v.canEdit === false)
      btn.title = '团队仓库（只读）';
    else if (v.kind === 'team')
      btn.title = '团队笔记仓库';
    else
      btn.title = '切换笔记仓库';
  };

  S.selectVault = async function(id){
    if (!id || id === S.currentVault) return;
    S.currentVault = id;
    try { localStorage.setItem(S.VAULT_KEY, id); } catch (_) {}
    try { await API.put('/api/notes/vaults/select', { vault: id }); } catch (_) {}
    S.currentId = null;
    S.renderVaultSwitch();
    S.renderTree();
    const first = S.idx.find(n => !n.deleted && S.noteVault(n) === id);
    if (first) S.open(first.id);
  };

  S.createVault = async function(){
    const name = await App.promptModal({ title: '新建笔记仓库', sub: '为不同项目或设备分开存放笔记', placeholder: '仓库名称' });
    if (name == null) return;
    try {
      const r = await API.post('/api/notes/vaults', { name: name.trim() || '未命名仓库' });
      showToast('仓库已创建');
      await S.load();
      if (r && r.id) await S.selectVault(r.id);
    } catch (e) { showToast(e.message, 'err'); }
  };

  S.renameVault = async function(){
    const v = S.vaultMeta(S.currentVault);
    if (v.kind === 'system'){ showToast('系统内置仓库不可重命名', 'err'); return; }
    const name = await App.promptModal({ title: '重命名仓库', value: v.name || '' });
    if (name == null) return;
    try {
      await API.put('/api/notes/vaults/' + encodeURIComponent(S.currentVault), { name: name.trim() });
      showToast('已重命名');
      await S.load();
    } catch (e) { showToast(e.message, 'err'); }
  };

  S.deleteCurrentVault = async function(){
    const v = S.vaultMeta(S.currentVault);
    if (!S.canDeleteVault(v)){ showToast('该仓库不可删除', 'err'); return; }
    if (!await App.confirmModal({
      title: '删除笔记仓库？', danger: true, okText: '永久删除',
      sub: `「${v.name}」及其全部笔记、文件夹将永久删除，不可恢复。默认仓库与系统内置仓库不受影响。`,
    })) return;
    try {
      await API.del('/api/notes/vaults/' + encodeURIComponent(S.currentVault));
      S.currentVault = S.VAULT_DEFAULT;
      showToast('仓库及其中的笔记、文件夹已删除');
      await S.load();
    } catch (e) { showToast(e.message, 'err'); }
  };

