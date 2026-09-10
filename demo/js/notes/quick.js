/* 仪表盘灵感速记内嵌卡 */
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
        { title: '灵感速记', tags: ['灵感'], folder: QUICK_FOLDER, vault: 'system' });
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
        { title, tags: ['灵感'], folder: QUICK_FOLDER, vault: 'system' });
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
            { title: quickTitle || '灵感速记', tags: ['灵感'], folder: QUICK_FOLDER, vault: 'system' });
          quickId = meta.id;
          try { localStorage.setItem(LAST_KEY, quickId); } catch (e2) {}
          await API.put('/api/notes/' + quickId, { content: cur });
          Notes.load();
        }
        $('#quickNoteTime').textContent = '已自动保存 ' +
          new Date().toTimeString().slice(0, 5);
      } catch (e) {
        $('#quickNoteTime').textContent = '保存失败';
        showToast('速记保存失败：' + e.message);
      }
    }, 800);
  });

  $('#quickNoteNew').addEventListener('click', newNote);
  App.onEnter(() => ensureQuick().catch(e => showToast('速记加载失败：' + e.message)));
})();
