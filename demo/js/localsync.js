/* ============================================================
   OmniDesk · 本地笔记双向实时同步（FileSystem Access API）
   ------------------------------------------------------------
   - 授权本地文件夹（showDirectoryPicker，readwrite），句柄存 IndexedDB，
     刷新/重开浏览器自动恢复，无需重新选择。
   - 双向引擎 reconcile()：
       本地新增/修改 .md → 导入/推送到站点；
       站点新增/重命名/删除/编辑 → 写回本地物理文件；
       本地文件被删 → 同步删除站点笔记（单轮 >10 个时暂停防误删）。
   - 冲突策略：LWW（lastModified vs 站点 updated，2 秒内视为同刻，站点优先）。
   - 离线补齐：reconcile 全量对账，断网/关页期间的修改在恢复后自动追平；
     网络失败 15 秒后自动重试。
   - 降级：不支持 showDirectoryPicker 的浏览器（Safari/Firefox）隐藏功能，
     面板给出说明，原有导入/导出不受影响。
   - 防抖：站点保存 800ms 防抖写本地；load() 收敛点 1.5s 防抖触发对账；
     轮询 5s 且仅页面可见时执行，reconcile 有 running 锁防重入。
   ============================================================ */
(() => {
  const DB_NAME = 'omni.localsync', STORE = 'kv';
  const POLL_MS = 5000, DEBOUNCE_SAVE = 800, DEBOUNCE_SITE = 1500;

  const supported = typeof window.showDirectoryPicker === 'function';
  let dir = null;              // FileSystemDirectoryHandle
  let enabled = false;         // 用户开关（暂停/启用）
  let permState = 'prompt';    // queryPermission 结果：granted / prompt / denied
  let running = false;         // reconcile 重入锁
  let lsLoading = false;       // reconcile 内部触发 Notes.load 时抑制回环
  let timer = null, saveT = null, siteT = null;
  let mapping = {};            // relPath -> { id, mtime(ms), synced(s) }
  /* 同步笔记 id 快照：localStorage 同步可读（IndexedDB 是异步的，renderTree 分区需要即时判断） */
  let syncIds = new Set();
  try { syncIds = new Set(JSON.parse(localStorage.getItem('ls_ids') || '[]')); } catch (_) { syncIds = new Set(); }
  let logs = [];               // 面板日志（内存，最近 30 条）
  let lastSync = parseInt(localStorage.getItem('ls_last') || '0', 10);
  let lastToast = 0, pendingChanges = 0;   // 同步通知节流（30s 聚合一次，避免频繁打扰）

  /* ---------- IndexedDB（目录句柄不可序列化进 localStorage） ---------- */
  function idbOpen(){
    return new Promise((res, rej) => {
      const rq = indexedDB.open(DB_NAME, 1);
      rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains(STORE)) rq.result.createObjectStore(STORE); };
      rq.onerror = () => rej(rq.error);
      rq.onsuccess = () => res(rq.result);
    });
  }
  async function idbGet(k){
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const g = db.transaction(STORE, 'readonly').objectStore(STORE).get(k);
      g.onsuccess = () => { db.close(); res(g.result); };
      g.onerror = () => { db.close(); rej(g.error); };
    });
  }
  async function idbSet(k, v){
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(v, k);
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => { db.close(); rej(tx.error); };
    });
  }
  async function idbDel(k){
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(k);
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => { db.close(); rej(tx.error); };
    });
  }

  /* ---------- 工具 ---------- */
  /* 同步范围限定：本地文件夹（mapping）只与"用户笔记 + 线上笔记"的子集同步，
     系统内置笔记（pinned / 每日计划 / 灵感速记）不参与（v0.2.15 BUG 修复） */
  function inSyncScope(n){
    if (!n) return false;
    if (n.pinned) return false;
    const f = (n.folder || '').split('/')[0];
    return f !== '每日计划' && f !== '灵感速记';
  }
  function safeName(s){
    const t = String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim();
    return t || '未命名笔记';
  }
  function expectedPath(n){
    const folder = String(n.folder || '').split('/').filter(Boolean).map(safeName);
    folder.push(safeName(n.title) + '.md');
    return folder.join('/');
  }
  function uniquePath(want, n){
    /* 同目录同名的不同笔记：追加序号防互相覆盖 */
    let p = want, i = 2;
    while (mapping[p] && mapping[p].id !== n.id) p = want.replace(/\.md$/i, '-' + (i++) + '.md');
    return p;
  }
  /* 与后端 _note_to_md 完全一致：标题 H1 + 空行 + 正文 */
  function noteToMd(meta, content){
    const title = (meta && meta.title) || '未命名笔记';
    const body = String(content || '').replace(/^\s+/, '');
    return body.startsWith('#') ? body + '\n' : '# ' + title + '\n\n' + body + '\n';
  }
  /* 读回：首行 H1 作标题并剥离，否则用兜底标题（文件名） */
  function parseMd(text, fallbackTitle){
    const m = /^#\s+(.+)\r?\n?/.exec(String(text || ''));
    if (m) return { title: m[1].trim(), content: String(text).slice(m[0].length).replace(/^\s*\n/, '') };
    return { title: fallbackTitle, content: String(text || '') };
  }
  function log(msg, isErr){
    logs.unshift({ t: Date.now(), msg, err: !!isErr });
    logs = logs.slice(0, 30);
    renderPanel();
  }
  /* mapping 变更后的统一落盘：idb + 同步 id 快照（供目录树「同步笔记」分区即时判断） */
  async function persistMapping(){
    await idbSet('mapping', mapping);
    rebuildSyncIds();
  }
  function rebuildSyncIds(){
    syncIds = new Set(Object.keys(mapping).map(p => mapping[p].id));
    try { localStorage.setItem('ls_ids', JSON.stringify([...syncIds])); } catch (_) {}
  }
  /* 同步变更通知：30 秒节流聚合，一轮对账只弹一次，不频繁打扰 */
  function notifyChanges(n){
    pendingChanges += n;
    const now = Date.now();
    if (now - lastToast >= 30000){
      lastToast = now;
      const c = pendingChanges; pendingChanges = 0;
      showToast('本地同步：' + c + ' 处变更已同步');
    }
  }
  /* 确保站点存在该文件夹路径（后端会自动逐级补齐上级；已存在时 400 忽略）。
     不先建文件夹直接 POST 带 folder 的笔记，笔记会挂到未注册路径下在目录树中不可见 */
  async function ensureFolders(path){
    if (!path) return;
    try { await API.post('/api/notes/folders', { name: path }); } catch (_) { /* 已存在 */ }
  }
  function handleErr(e, what){
    if (e && e.name === 'NotAllowedError'){
      enabled = false; stopPolling(); permState = 'prompt';
      log('文件夹访问权限已被撤销，请在面板中重新授权', true);
      showToast('本地同步：权限已撤销，需重新授权', 'err');
    } else {
      log(what + '失败：' + (e && e.message || e), true);
    }
    renderPanel();
  }

  /* ---------- 文件系统 ---------- */
  async function dirByPath(parts, create){
    let d = dir;
    for (const p of parts) d = await d.getDirectoryHandle(p, { create: !!create });
    return d;
  }
  async function writeFile(relPath, text){
    const parts = relPath.split('/');
    const fname = parts.pop();
    const d = await dirByPath(parts, true);
    const fh = await d.getFileHandle(fname, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
    return (await fh.getFile()).lastModified;
  }
  async function removeFile(relPath){
    try {
      const parts = relPath.split('/');
      const fname = parts.pop();
      const d = await dirByPath(parts, false);
      await d.removeEntry(fname);
    } catch (_) { /* 文件已不在，忽略 */ }
  }
  async function scanDir(root, prefix, out){
    root = root || dir; prefix = prefix || ''; out = out || [];
    for await (const [name, h] of root.entries()){
      if (name.startsWith('.')) continue;                    // 隐藏文件/目录不参与同步
      const rel = prefix ? prefix + '/' + name : name;
      if (h.kind === 'directory') await scanDir(h, rel, out);
      else if (/\.md$/i.test(name)){
        try { out.push({ relPath: rel, handle: h, lastModified: (await h.getFile()).lastModified }); }
        catch (_) { /* 单文件读取失败跳过 */ }
      }
    }
    return out;
  }

  /* ---------- 对账引擎（双向 · LWW） ---------- */
  async function reconcile(reason){
    if (!dir || !enabled || running) return;
    running = true;
    try {
      const files = await scanDir();
      const byPath = {}; files.forEach(f => { byPath[f.relPath] = f; });
      const d = await API.get('/api/notes');                 // 网络失败 → catch 15s 重试
      const notes = d.notes || [];
      /* 补齐缺失的文件夹注册：早期导入的笔记可能挂在未注册路径下，在目录树中不可见（BUG 修复） */
      const haveFolders = new Set(d.folders || []);
      const missingFolders = [...new Set(notes.map(n => (n.folder || '').trim()).filter(Boolean))]
        .filter(fp => !haveFolders.has(fp));
      for (const fp of missingFolders){ await ensureFolders(fp); log('↓ 补齐文件夹注册：' + fp); }
      const byId = {}; notes.forEach(n => { byId[n.id] = n; });
      const idToPath = {}; Object.keys(mapping).forEach(p => { idToPath[mapping[p].id] = p; });
      let changes = 0;

      /* 1) 本地 → 站点：新增导入 / 修改推送（LWW） */
      for (const f of files){
        const m = mapping[f.relPath];
        if (!m){
          const text = await f.handle.getFile().then(x => x.text());
          const parts = f.relPath.split('/'); const fname = parts.pop();
          const parsed = parseMd(text, fname.replace(/\.md$/i, ''));
          await ensureFolders(parts.join('/'));              // 先注册文件夹，否则笔记在树中不可见
          const r = await API.post('/api/notes', { title: parsed.title, tags: [], folder: parts.join('/') });
          await API.put('/api/notes/' + r.id, { content: parsed.content });
          mapping[f.relPath] = { id: r.id, mtime: f.lastModified, synced: Date.now() / 1000 };
          idToPath[r.id] = f.relPath; changes++;
          log('↓ 本地新文件已导入站点：' + f.relPath);
          continue;
        }
        if (f.lastModified <= (m.mtime || 0) + 1000) continue;   // 本地未变
        const note = byId[m.id];
        const text = await f.handle.getFile().then(x => x.text());
        const parsed = parseMd(text, note ? note.title : f.relPath.split('/').pop().replace(/\.md$/i, ''));
        if (!note){
          /* 站点侧已删而本地文件仍在：以本地为准重新导入 */
          const parts = f.relPath.split('/'); parts.pop();
          await ensureFolders(parts.join('/'));
          const r = await API.post('/api/notes', { title: parsed.title, tags: [], folder: parts.join('/') });
          await API.put('/api/notes/' + r.id, { content: parsed.content });
          mapping[f.relPath] = { id: r.id, mtime: f.lastModified, synced: Date.now() / 1000 };
          idToPath[r.id] = f.relPath; changes++;
          log('↓ 站点笔记缺失，按本地文件重建：' + parsed.title);
        } else if ((note.updated || 0) * 1000 > (m.synced || 0) * 1000 + 2000 &&
                   (note.updated || 0) * 1000 > f.lastModified){
          /* 站点更新且晚于本地 → 站点覆盖本地（LWW） */
          const body = (await API.get('/api/notes/' + note.id)).content || '';
          const nm = await writeFile(f.relPath, noteToMd(note, body));
          mapping[f.relPath] = { id: note.id, mtime: nm, synced: note.updated || Date.now() / 1000 };
          changes++;
          log('↑ 站点版本较新，已回写本地：' + f.relPath);
        } else {
          /* 本地更新 → 推送站点 */
          await API.put('/api/notes/' + note.id, { content: parsed.content, title: parsed.title });
          mapping[f.relPath] = { id: note.id, mtime: f.lastModified, synced: Date.now() / 1000 };
          changes++;
          log('↓ 本地修改已推送站点：' + parsed.title);
        }
      }

      /* 2) 本地文件消失 → 删除站点笔记（安全阀：单轮 >10 个暂停）；
     非同步范围的笔记本就不该在 mapping 内，此处双检防误删内置（v0.2.15 BUG 修复） */
      const gone = Object.keys(mapping).filter(p => !byPath[p]);
      if (gone.length > 10){
        log('⚠ 检测到 ' + gone.length + ' 个本地文件同时消失，已暂停删除同步，请人工确认', true);
      } else {
        for (const p of gone){
          const m = mapping[p];
          if (byId[m.id] && inSyncScope(byId[m.id])){
            await API.del('/api/notes/' + m.id).catch(() => {});
            log('↓ 本地文件已删，同步删除站点笔记：' + (byId[m.id].title || p));
            changes++;
          }
          delete mapping[p]; delete idToPath[m.id];
        }
      }

      /* 3) 站点 → 本地：仅同步范围内的笔记（v0.2.15 BUG 修复：不再把所有笔记含内置写入本地） */
      for (const n of notes){
        if (!inSyncScope(n)) continue;          // 内置/常驻笔记不参与本地同步
        const want = uniquePath(expectedPath(n), n);
        const cur = idToPath[n.id];
        if (cur === want && byPath[want]){
          /* 路径未变：仅当站点内容更新且本地文件未动时回写（如速记、其他标签页编辑） */
          const m2 = mapping[want];
          if ((n.updated || 0) > (m2.synced || 0) + 2 &&
              byPath[want].lastModified <= (m2.synced || 0) * 1000 + 2000){
            const body = (await API.get('/api/notes/' + n.id)).content || '';
            const nm = await writeFile(want, noteToMd(n, body));
            mapping[want] = { id: n.id, mtime: nm, synced: n.updated || Date.now() / 1000 };
            changes++;
            log('↑ 站点编辑已回写本地：' + want);
          }
          continue;
        }
        if (cur && cur !== want){ await removeFile(cur); delete mapping[cur]; }
        const body = (await API.get('/api/notes/' + n.id)).content || '';
        const nm = await writeFile(want, noteToMd(n, body));
        mapping[want] = { id: n.id, mtime: nm, synced: n.updated || Date.now() / 1000 };
        idToPath[n.id] = want; changes++;
        log(cur ? '↑ 站点重命名/移动，本地已更新：' + want : '↑ 站点新笔记已写入本地：' + want);
      }

      /* 清理：mapping 中残留的、非同步范围内的 id 立即回收（避免误同步） */
      Object.keys(mapping).forEach(p => {
        const nid = mapping[p].id;
        if (!inSyncScope(byId[nid])){
          /* 该笔记已转内置/被删/不再同步，写到本地后又会被步骤 3 重新写出，
             干脆从 mapping 中抹去，后续 reconcile 不会再去管它 */
          delete mapping[p];
          delete idToPath[nid];
        }
      });

      /* 清理双侧都已消失的残留映射 */
      Object.keys(mapping).forEach(p => { if (!byPath[p] && !byId[mapping[p].id]) delete mapping[p]; });

      await persistMapping();
      lastSync = Date.now(); localStorage.setItem('ls_last', String(lastSync));
      if (changes){
        notifyChanges(changes);
        if (window.Notes){
          lsLoading = true;               // 抑制 Notes.load → onSiteChanged 回环
          try { await Notes.load(); } finally { lsLoading = false; }
        }
      }
    } catch (e){
      handleErr(e, '同步');
      if (!(e && e.name === 'NotAllowedError')) setTimeout(() => reconcile('retry'), 15000);
    } finally {
      running = false;
      renderPanel();
    }
  }

  /* ---------- 轮询 ---------- */
  function startPolling(){
    stopPolling();
    timer = setInterval(() => {
      if (document.visibilityState === 'visible' && !running) reconcile('poll');
    }, POLL_MS);
  }
  function stopPolling(){ if (timer){ clearInterval(timer); timer = null; } }

  /* ---------- 绑定 / 恢复 / 授权 / 解绑 ---------- */
  async function bind(){
    if (!supported) return;
    try {
      const h = await window.showDirectoryPicker({ mode: 'readwrite', id: 'omni-notes', startIn: 'documents' });
      dir = h; permState = 'granted';
      await idbSet('dir', h);
      mapping = (await idbGet('mapping')) || {};
      rebuildSyncIds();
      enabled = true; localStorage.setItem('ls_enabled', '1');
      log('已绑定文件夹「' + h.name + '」，开始首次全量对账（双向合并）');
      renderPanel(); startPolling();
      await reconcile('bind');
    } catch (e){
      if (e && e.name !== 'AbortError') log('绑定失败：' + e.message, true);
    }
  }
  async function restore(){
    if (!supported) return;
    try {
      const h = await idbGet('dir');
      if (!h) return;
      dir = h;
      mapping = (await idbGet('mapping')) || {};
      rebuildSyncIds();
      permState = await h.queryPermission({ mode: 'readwrite' });
      if (permState === 'granted' && localStorage.getItem('ls_enabled') !== '0'){
        enabled = true;
        startPolling();
        reconcile('restore');          // 断网/关页期间的本地修改在此自动补齐
      }
      /* 刷新目录树，让「同步笔记」分区立即按最新 mapping 展示 */
      if (window.Notes){ lsLoading = true; try { await Notes.load(); } finally { lsLoading = false; } }
    } catch (_) { dir = null; }
  }
  async function reauthorize(){
    if (!dir) return;
    try {
      const p = await dir.requestPermission({ mode: 'readwrite' });
      permState = p;
      if (p === 'granted'){
        enabled = true; localStorage.setItem('ls_enabled', '1');
        log('授权已恢复，继续同步');
        startPolling(); reconcile('reauth');
      } else {
        log('未获得授权。若已永久拒绝，请解绑后重新选择文件夹', true);
      }
    } catch (e){ log('授权失败：' + e.message, true); }
    renderPanel();
  }
  async function unbind(){
    if (!await App.confirmModal({ title: '解绑本地文件夹', sub: '仅解除同步关系，不会删除站点笔记或本地文件', okText: '解绑' })) return;
    stopPolling();
    dir = null; enabled = false; mapping = {}; permState = 'prompt';
    await idbDel('dir'); await idbDel('mapping');
    localStorage.removeItem('ls_enabled'); localStorage.removeItem('ls_last');
    syncIds = new Set(); localStorage.removeItem('ls_ids');
    lastSync = 0;
    log('已解绑本地文件夹');
    renderPanel();
    if (window.Notes){ lsLoading = true; try { await Notes.load(); } finally { lsLoading = false; } }
  }
  function toggleEnabled(){
    enabled = !enabled;
    localStorage.setItem('ls_enabled', enabled ? '1' : '0');
    if (enabled){ startPolling(); reconcile('toggle'); log('同步已启用'); }
    else { stopPolling(); log('同步已暂停'); }
    renderPanel();
  }

  /* ---------- 面板 ---------- */
  function fmtTime(ts){ return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—'; }
  function renderPanel(){
    const body = $('#lsBody');
    if (!body || $('#lsMask').hidden) return;
    if (!supported){
      body.innerHTML = `
        <div class="ls-note">当前浏览器不支持 FileSystem Access API（Safari / Firefox 暂不支持）。</div>
        <div class="ls-note">降级方案：请使用 Chrome / Edge 获得双向实时同步；当前浏览器仍可用知识库 ⋯ 菜单的「导入 Markdown / zip」与「导出全部笔记」手动搬运，基础笔记功能不受影响。</div>`;
      return;
    }
    if (!dir){
      body.innerHTML = `
        <div class="ls-note">授权一个本地文件夹后，其中的 Markdown 文件将与知识库<b>双向实时同步</b>：本地编辑自动上站，站点编辑自动落盘；刷新或重开浏览器无需重新授权，断网期间的修改恢复后自动补齐。</div>
        <div class="ls-note" style="color:var(--om-text-3)">冲突采用「最后修改时间优先」策略；本地文件被删除会同步删除站点笔记（单轮超过 10 个自动暂停保护）。</div>
        <div class="ls-btns"><button class="btn btn-primary btn-sm" id="lsBind"><svg class="ic"><use href="#i-folder"/></svg>选择本地笔记文件夹</button></div>`;
      $('#lsBind').addEventListener('click', bind);
      return;
    }
    const stateTxt = !enabled ? '已暂停' : (permState === 'granted' ? (running ? '同步中…' : '实时同步中') : '等待授权');
    body.innerHTML = `
      <div class="ls-stat">
        <div><span class="ls-k">文件夹</span><b>${App.esc(dir.name)}</b></div>
        <div><span class="ls-k">状态</span><b class="${enabled && permState === 'granted' ? 'ls-ok' : 'ls-warn'}">${stateTxt}</b></div>
        <div><span class="ls-k">上次同步</span><b>${fmtTime(lastSync)}</b></div>
        <div><span class="ls-k">映射文件</span><b>${Object.keys(mapping).length} 个</b></div>
      </div>
      <div class="ls-btns">
        ${permState !== 'granted' ? '<button class="btn btn-primary btn-sm" id="lsReauth"><svg class="ic"><use href="#i-key"/></svg>恢复授权</button>' : ''}
        <button class="btn btn-ghost btn-sm" id="lsToggle">${enabled ? '暂停同步' : '启用同步'}</button>
        <button class="btn btn-ghost btn-sm" id="lsNow" ${enabled ? '' : 'disabled'}><svg class="ic"><use href="#i-refresh"/></svg>立即同步</button>
        <button class="btn btn-ghost btn-sm ls-danger" id="lsUnbind">解绑</button>
      </div>
      <div class="ls-log-head">同步日志（最近 ${logs.length} 条）</div>
      <div class="ls-log">${logs.length ? logs.map(l =>
        `<div class="ls-log-item${l.err ? ' err' : ''}"><span class="ls-log-t">${new Date(l.t).toTimeString().slice(0, 8)}</span>${App.esc(l.msg)}</div>`).join('')
        : '<div class="ls-log-item">暂无日志</div>'}</div>`;
    $('#lsReauth')?.addEventListener('click', reauthorize);
    $('#lsToggle').addEventListener('click', () => {
      if (permState !== 'granted'){ reauthorize(); return; }
      toggleEnabled();
    });
    $('#lsNow').addEventListener('click', () => reconcile('manual'));
    $('#lsUnbind').addEventListener('click', unbind);
  }
  function openPanel(){
    $('#lsMask').hidden = false;
    renderPanel();
    if (supported && dir && permState === 'prompt' && enabled){
      /* 恢复授权必须在用户手势里发起 */
      dir.queryPermission({ mode: 'readwrite' }).then(p => { permState = p; renderPanel(); }).catch(() => {});
    }
  }
  function closePanel(){ $('#lsMask').hidden = true; }

  /* ---------- 站点侧钩子 ---------- */
  function onNoteSaved(meta, content){
    if (!dir || !enabled || !meta) return;
    clearTimeout(saveT);
    saveT = setTimeout(async () => {
      try {
        const want = uniquePath(expectedPath(meta), meta);
        const cur = Object.keys(mapping).find(p => mapping[p].id === meta.id);
        if (cur && cur !== want){ await removeFile(cur); delete mapping[cur]; }
        const nm = await writeFile(want, noteToMd(meta, content));
        mapping[want] = { id: meta.id, mtime: nm, synced: Date.now() / 1000 };
        await persistMapping();
        lastSync = Date.now(); localStorage.setItem('ls_last', String(lastSync));
      } catch (e){ handleErr(e, '写入本地'); }
    }, DEBOUNCE_SAVE);
  }
  function onSiteChanged(){
    if (!dir || !enabled || lsLoading) return;
    clearTimeout(siteT);
    siteT = setTimeout(() => reconcile('site'), DEBOUNCE_SITE);
  }

  /* ---------- 初始化 ---------- */
  $('#lsClose')?.addEventListener('click', closePanel);
  $('#lsMask')?.addEventListener('click', e => { if (e.target === $('#lsMask')) closePanel(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#lsMask').hidden) closePanel(); });
  window.addEventListener('online', () => { if (dir && enabled) reconcile('online'); });
  App.onEnter(() => restore());

  window.LocalSync = {
    supported, openPanel, onNoteSaved, onSiteChanged, restore, reconcile,
    /* 目录树「同步笔记」分区依赖的同步判断（同步读内存快照，renderTree 可直接调用） */
    isSyncedId: id => syncIds.has(id),
    isBound: () => !!dir,
    /* v0.2.15 增：把同步笔记移出本地同步区间（拖到线上）时调用，立即从 mapping 中移除该 id，
       同步笔记分区不再显示它，renderTree 自然在「线上笔记」分区看到，UI 立刻一致。
       注意是本地的 mapping/syncIds 清理，不删站点笔记，也不删本地文件 */
    async detachById(id){
      let dirty = false;
      for (const p of Object.keys(mapping)) if (mapping[p].id === id){ delete mapping[p]; dirty = true; }
      if (syncIds.has(id)){ syncIds.delete(id); dirty = true; }
      if (dirty){
        try { localStorage.setItem('ls_ids', JSON.stringify([...syncIds])); } catch (_) {}
        await idbSet('mapping', mapping);
        try { if (window.Notes){ lsLoading = true; await Notes.load(); } } catch (_) {} finally { lsLoading = false; }
      }
    },
    async detachMany(ids){
      let dirty = false;
      const set = new Set(ids);
      for (const p of Object.keys(mapping)) if (set.has(mapping[p].id)){ delete mapping[p]; dirty = true; }
      ids.forEach(id => { if (syncIds.has(id)){ syncIds.delete(id); dirty = true; } });
      if (dirty){
        try { localStorage.setItem('ls_ids', JSON.stringify([...syncIds])); } catch (_) {}
        await idbSet('mapping', mapping);
        try { if (window.Notes){ lsLoading = true; await Notes.load(); } } catch (_) {} finally { lsLoading = false; }
      }
    },
  };
})();
