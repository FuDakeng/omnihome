import { S } from './state.js';

  /* ---------- 多笔记标签页 ---------- */
  S.persistTabs = function(){
    try { localStorage.setItem(S.TABS_KEY, JSON.stringify(S.openTabs)); } catch (_) {}
  };

  S.tabTitle = function(id){
    const m = S.idx.find(n => n.id === id);
    return m ? (m.title || '未命名笔记') : '(已删除)';
  };

  S.renderTabs = function(){
    const bar = $('#edTabs');
    if (!bar) return;
    bar.hidden = S.openTabs.length === 0;
    bar.innerHTML = S.openTabs.map(id => {
      const m = S.idx.find(n => n.id === id);
      const t = S.tabTitle(id);
      return `<button class="ed-tab${id === S.currentId ? ' active' : ''}" data-tab="${App.esc(id)}" title="${App.esc(t)}">
        ${m && m.readonly ? '<svg class="ic ed-tab-lock"><use href="#i-lock"/></svg>' : ''}
        <span>${App.esc(t)}</span>
        <span class="ed-tab-x" data-tab-x="${App.esc(id)}" title="关闭标签页"><svg class="ic"><use href="#i-close"/></svg></span>
      </button>`;
    }).join('');
  };

  /* 关闭标签页：若关的是当前页，切到相邻页；全部关完则清空编辑器 */
  S.closeTab = async function(id){
    const i = S.openTabs.indexOf(id);
    if (i < 0) return;
    S.openTabs.splice(i, 1);
    S.persistTabs();
    if (id === S.currentId){
      const nxt = S.openTabs[Math.min(i, S.openTabs.length - 1)];
      S.currentId = null; S.dirty = false;
      if (nxt) await S.open(nxt);
      else S.clearEditor();
    }
    S.renderTabs();
  };

  S.clearEditor = function(){
    S.currentId = null; S.dirty = false;
    $('#edSrc').value = ''; $('#edTitle').value = '';
    S.setReadonly(false);
    S.renderPreview();
    if (S.liveEd) S.liveEd.refresh();
    S.updateCrumb(); S.updateStat();
    $('#edFootTime').textContent = '尚未保存';
  };

  /* ---------- 只读模式：标题/正文不可编辑，工具栏与查找条隐藏 ---------- */
  S.setReadonly = function(on){
    const card = $('#edCard');
    if (!card) return;
    card.classList.toggle('ed-readonly', on);
    $('#edTitle').readOnly = on;
    $('#edSrc').readOnly = on;
    if (S.liveEd && S.liveEd.el) S.liveEd.el.setAttribute('contenteditable', on ? 'false' : 'true');
    clearTimeout(S.saveTimer);   // 防止上一篇的延时保存串到只读页
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
  };

  /* ---------- 笔记悬浮操作菜单（⋯ 按钮弹出） ---------- */
  S.openNoteMenu = function(anchor, id){
    const meta = S.idx.find(n => n.id === id);
    if (!meta) return;
    S.kbMenu(anchor, [
      ['查看详细', 'i-search', () => S.showNoteInfo(id)],
      ['版本管理', 'i-clock', () => S.openRevModal(id)],
      ['分享笔记', 'i-link', () => S.openShareModal({ kind: 'note', noteId: id, name: meta.title })],
      ['在新标签页打开', 'i-note', () => S.open(id)],
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
          if (id === S.currentId){ $('#edTitle').value = name.trim(); S.updateCrumb(); }
          S.renderTree(); S.renderTabs();
        } catch (e) { showToast('重命名失败：' + e.message, 'err'); }
      }],
      ['创建副本', 'i-copy', async () => {
        try {
          const d = await API.get('/api/notes/' + id);
          const r = await API.post('/api/notes',
            { title: (meta.title || '未命名笔记') + ' 副本', tags: meta.tags || [], folder: meta.folder || '' });
          await API.put('/api/notes/' + r.id, { content: d.content || '' });
          showToast('副本已创建并打开');
          await S.load();
          S.open(r.id);
        } catch (e) { showToast('创建副本失败：' + e.message, 'err'); }
      }],
      [meta.readonly ? '解除只读' : '设为只读', 'i-lock', async () => {
        try {
          await API.put('/api/notes/' + id, { readonly: !meta.readonly });
          meta.readonly = !meta.readonly;
          if (id === S.currentId) S.setReadonly(!!meta.readonly);
          S.renderTree(); S.renderTabs();
          showToast(meta.readonly ? '已设为只读' : '已解除只读');
        } catch (e) { showToast(e.message, 'err'); }
      }],
      ['删除笔记', 'i-trash', () => S.del(id)],
    ]);
  };

  /* ---------- 笔记详情弹层（v0.2.25：⋯ 菜单 → 查看详细） ---------- */
  S.showNoteInfo = async function(id){
    const meta = S.idx.find(n => n.id === id);
    if (!meta) return;
    $('#kbInfoTitle').textContent = meta.title || '未命名笔记';
    $('#kbInfoUpdated').textContent = new Date((meta.updated || 0) * 1000)
      .toLocaleString('zh-CN', { hour12: false });
    $('#kbInfoType').textContent = meta.pinned ? 'Markdown 笔记（常驻）'
      : meta.readonly ? 'Markdown 笔记（只读）' : 'Markdown 笔记';
    $('#kbInfoFolder').textContent = meta.folder || '未分组';
    $('#kbInfoChars').textContent = '…';
    $('#kbInfoSize').textContent = '…';
    App.openModal('kbInfoMask');
    try {
      const d = await API.get('/api/notes/' + encodeURIComponent(id));
      const content = d.content || '';
      const text = content.replace(/\s+/g, '');           // 去空白后的字符数（正文字数口径）
      const bytes = new Blob([content]).size;             // UTF-8 字节数
      $('#kbInfoChars').textContent = text.length.toLocaleString('zh-CN') + ' 字';
      $('#kbInfoSize').textContent = App.fmtBytes(bytes);
    } catch (e) {
      $('#kbInfoChars').textContent = '读取失败';
      $('#kbInfoSize').textContent = '—';
    }
  };

  /* 编辑器顶栏面包屑：知识库 / <folder path> / <note title>
     单击"知识库"清空当前选择；单击文件夹段滚动并展开该目录。 */
  S.updateCrumb = function(){
    const el = $('#edCrumb');
    if (!el) return;
    if (!S.currentId){
      el.innerHTML = '<span class="ed-crumb-item current">知识库</span>';
      return;
    }
    const meta = S.idx.find(n => n.id === S.currentId);
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
  };

