/* ============================================================
   OmniDesk · 快捷导航（书签）
   增删改查 · 动态分类管理（新建/重命名/删除/隐藏/拖拽排序）·「全部」内置分类
   书签拖拽排序（含跨分类） · ⌘+1~9 快捷键按分类独立编号（每分类前 9 个）
   搜索 + 标签多选筛选 · 页面分类点击切换 / 仪表盘悬浮切换（可点击锁定）。
   站点图标后端代理自动获取 / 内置图标自选 · 描述与标签 · AI 智能填充。
   书签导入 / 导出（标准 Netscape HTML 格式）。
   页面大卡片展示完整信息；仪表盘磁贴简化（图标/标题/地址 + 悬浮详情）。
   ============================================================ */
const Bookmarks = (() => {
  let bms = [];
  let cats = [];
  let filter = '';
  let tagSel = new Set();   // 标签多选筛选（OR 语义）
  let activeCat = 'all';
  let dashActive = '';      // 仪表盘当前悬浮的分类（快捷键回落用）
  let lockedCat = '';       // 仪表盘锁定的分类（锁定后悬浮不再切换）
  let editingId = null;
  let editIcon = '';      // '' = 自动获取网站图标；'sym:i-xxx' = 内置图标
  let editHue = 243;
  let dragEl = null;      // 书签磁贴拖拽
  let dragFromAll = false;
  let catDrag = null;     // 分类标签拖拽
  let sel = new Set();    // 多选书签 id
  let dragIds = [];       // 本次拖拽涉及的书签（拖动已选中卡片 = 全部选中项一起）
  let droppedCat = false; // 拖放到分类标签（跳过排序持久化）
  let droppedBar = false; // 拖放到批量条快速删除（跳过排序持久化）
  const HINT_NORMAL = '拖动选中卡片到左侧分类可快速归类';
  const HINT_DRAG = '松手到此横条可快速删除';

  /* 拖拽期间批量条常显作为删除落点；拖拽结束恢复选中态展示 */
  function batchDragMode(on, n){
    const bar = $('#bmBatch');
    if (!bar) return;
    bar.classList.toggle('drag-mode', on);
    bar.classList.remove('drop-del');
    if (on){
      bar.hidden = false;
      $('#bmBatchN').textContent = `拖拽 ${n} 个`;
      $('#bmBatchHint').textContent = HINT_DRAG;
    } else {
      $('#bmBatchHint').textContent = HINT_NORMAL;
      bar.hidden = !sel.size;
      if (sel.size) $('#bmBatchN').textContent = `已选 ${sel.size} 个`;
    }
  }

  const catName = id => (cats.find(c => c.id === id) || { name: '未分类' }).name;
  /* bms 在 load / persist 后始终按 order 升序，即用户设置的书签顺序 */
  const sorted = () => [...bms].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const catList = cat => cat === 'all' ? sorted() : sorted().filter(b => b.cat === cat);
  const visibleCats = () => cats.filter(c => !c.hidden);

  /* ---------- 渲染 ---------- */
  /* 站点图标走后端代理（部分网络下第三方图标服务不可达）；
     <img> 无法带 Authorization 头，token 以查询参数附加 */
  const favUrl = url => '/api/favicon?url=' + encodeURIComponent(url) +
                        '&token=' + encodeURIComponent(API.getToken());

  /* 图标提速：把加载成功过的图标地址按域名缓存到本地。
     后续刷新页面 / 切换分类时直接命中浏览器磁盘缓存，不再出现空白等待；
     缓存地址失效（如 token 过期）时 onerror 会自动回落重新拉取一次 */
  const FAV_KEY = 'omni.favicon.cache.v1';
  let favCache = {};
  try { favCache = JSON.parse(localStorage.getItem(FAV_KEY) || '{}'); } catch (e) { favCache = {}; }
  function favFor(url){
    try {
      const host = new URL(url).host;
      if (host && favCache[host]) return favCache[host];
    } catch (e) {}
    return favUrl(url);
  }
  window.__omniFavOk = img => {
    try {
      const host = new URL(img.dataset.bmUrl).host;
      if (!host || favCache[host] === img.src) return;
      favCache[host] = img.src;
      const ks = Object.keys(favCache);
      if (ks.length > 400) delete favCache[ks[0]];
      localStorage.setItem(FAV_KEY, JSON.stringify(favCache));
    } catch (e) {}
  };
  window.__omniFavErr = img => {
    if (img.dataset.fb !== '1' && img.dataset.bmUrl){
      img.dataset.fb = '1';              // 缓存命中失败：换新地址重试一次
      img.src = favUrl(img.dataset.bmUrl);
      return;
    }
    img.remove();                        // 仍失败：退回首字母头像
  };

  function iconHtml(bm){
    const hue = bm.hue ?? 243;
    const letter = App.esc((bm.name || '?').trim().charAt(0).toUpperCase());
    if (bm.icon && bm.icon.startsWith('sym:')){
      return `<span class="bm-fav sym" style="--fav:${hue}"><svg class="ic"><use href="#${App.esc(bm.icon.slice(4))}"/></svg></span>`;
    }
    if (bm.url){
      /* 默认自动获取网站图标；加载失败时移除 <img>，退回首字母头像 */
      return `<span class="bm-fav" style="--fav:${hue}"><img src="${favFor(bm.url)}" data-bm-url="${App.esc(bm.url)}" alt="" loading="lazy">${letter}</span>`;
    }
    return `<span class="bm-fav" style="--fav:${hue}">${letter}</span>`;
  }

  function bindFavImgs(root){
    (root || document).querySelectorAll('img[data-bm-url]').forEach(img => {
      if (img.dataset.favBound) return;
      img.dataset.favBound = '1';
      img.addEventListener('load', () => window.__omniFavOk(img));
      img.addEventListener('error', () => window.__omniFavErr(img));
    });
  }

  function hostOf(url){
    if (!url) return '本地工具';
    try { return new URL(/^https?:\/\//.test(url) ? url : 'https://' + url).host; }
    catch (e) { return url; }
  }

  /* 悬浮详情：完整标题 / URL / 描述 / 标签 / 分类（仪表盘磁贴与卡片通用） */
  function tipOf(bm){
    const lines = [bm.name];
    if (bm.url) lines.push(bm.url);
    if (bm.desc) lines.push(bm.desc);
    if ((bm.tags || []).length) lines.push('标签：' + bm.tags.join('、'));
    lines.push('分类：' + catName(bm.cat));
    return lines.join('\n');
  }

  /* 页面大卡片：完整展示图标 / 名称 / 地址 / 描述 / 标签 / 分类 */
  function cardHtml(bm, pos){
    const key = pos > 0 && pos <= 9
      ? `<span class="bm-key num" title="快捷键 ⌘+${pos}">${pos}</span>` : '';
    const tags = (bm.tags || []).map(t => `<span class="bm-tag">${App.esc(t)}</span>`).join('');
    return `<div class="bm-tile bm-card${sel.has(bm.id) ? ' sel' : ''}" data-bm-id="${bm.id}" draggable="true" title="${App.esc(tipOf(bm))}">
      <span class="bm-check" data-bm-sel="${bm.id}" title="选择 / 多选"><svg class="ic"><use href="#i-check"/></svg></span>
      <div class="bmc-top">
        ${iconHtml(bm)}
        <div class="bmc-info"><div class="bm-name">${App.esc(bm.name)}</div>
        <div class="bm-url">${App.esc(bm.url || '本地工具')}</div></div>
        ${key}
      </div>
      ${bm.desc ? `<div class="bmc-desc">${App.esc(bm.desc)}</div>` : ''}
      <div class="bmc-foot">
        ${tags ? `<div class="bm-tags">${tags}</div>` : '<span></span>'}
        <span class="chip no-dot bm-cat-chip">${App.esc(catName(bm.cat))}</span>
      </div>
      <span class="bm-x" data-bm-del="${bm.id}" title="删除"><svg class="ic"><use href="#i-close"/></svg></span>
      <span class="bm-e" data-bm-edit="${bm.id}" title="编辑"><svg class="ic"><use href="#i-pen"/></svg></span>
    </div>`;
  }

  /* 仪表盘磁贴：仅图标 / 标题 / 地址，标题过长省略，悬浮看完整信息 */
  function dashTileHtml(bm, pos){
    const key = pos > 0 && pos <= 9
      ? `<span class="bm-key num" title="快捷键 ⌘+${pos}">${pos}</span>` : '';
    return `<div class="bm-tile" data-bm-id="${bm.id}" title="${App.esc(tipOf(bm))}">
      ${key}
      ${iconHtml(bm)}
      <div style="min-width:0"><div class="bm-name">${App.esc(bm.name)}</div>
      <div class="bm-url">${App.esc(bm.url || '本地工具')}</div></div>
    </div>`;
  }

  function visible(cat){
    const q = (filter || '').toLowerCase();
    return bms.filter(b => (cat === 'all' || b.cat === cat) &&
      (!tagSel.size || (b.tags || []).some(t => tagSel.has(t))) &&
      (!q || (b.name || '').toLowerCase().includes(q) || (b.url || '').toLowerCase().includes(q) ||
       (b.desc || '').toLowerCase().includes(q) ||
       (b.tags || []).some(t => (t || '').toLowerCase().includes(q))));
  }

  function emptyPanel(){
    return `<div class="empty" style="grid-column:1/-1;background:var(--om-surface);border:1px dashed var(--om-border-strong);border-radius:var(--om-radius-lg)">
        <div class="empty-ic"><svg class="ic"><use href="#i-inbox"/></svg></div>
        <div class="empty-title">此分类暂无书签</div>
        <div class="empty-sub">点击右上角「新建书签」添加，或将其他分类的磁贴拖拽到这里</div>
      </div>`;
  }

  /* ---------- 分类标签与面板（动态渲染，隐藏分类不展示） ---------- */
  function renderTabs(){
    const group = $('#bmTabs');
    const shown = visibleCats();
    if (!shown.find(c => c.id === activeCat)) activeCat = (shown[0] || { id: 'none' }).id;
    const hidden = cats.filter(c => c.hidden);
    group.innerHTML = shown.map(c => {
      const n = c.id === 'all' ? bms.length : bms.filter(b => b.cat === c.id).length;
      const builtin = c.id === 'all' || c.id === 'none';
      return `
      <button class="tab ${c.id === activeCat ? 'active' : ''}" data-cat="${c.id}" draggable="true"
        title="${builtin ? '内置分类 · 可隐藏 · 拖拽可调整位置' : '拖拽调整分类顺序'}">
        ${App.esc(c.name)}
        <span class="bm-cat-n num">${n}</span>
        <span class="tab-ops">
          <i data-cat-hide="${c.id}" title="隐藏分类"><svg class="ic"><use href="#i-eye-off"/></svg></i>
          ${builtin ? '' : `
          <i data-cat-edit="${c.id}" title="重命名分类"><svg class="ic"><use href="#i-pen"/></svg></i>
          <i data-cat-del="${c.id}" title="删除分类"><svg class="ic"><use href="#i-close"/></svg></i>`}
        </span>
      </button>`;
    }).join('') +
      `<button class="tab tab-add" data-cat-add title="新建分类"><svg class="ic"><use href="#i-plus"/></svg>分类</button>` +
      (hidden.length ? `<button class="tab tab-add" data-cat-hidden title="管理已隐藏的分类"><svg class="ic"><use href="#i-eye"/></svg>已隐藏 ${hidden.length}</button>` : '');
    bindHoverTabs(group, false);   // 页面：点击切换（悬浮不切换）
  }

  function renderPanels(){
    const wrap = $('#bmPanels');
    if (!wrap) return;
    wrap.innerHTML = visibleCats().map(c =>
      `<div class="bm-grid" data-qpanel="${c.id}" id="bmGrid-${c.id}" ${c.id === activeCat ? '' : 'hidden'}></div>`).join('');
  }

  /* 导航视图：按当前分类渲染大卡片（快捷键角标 = 该分类内位置） */
  function renderView(){
    visibleCats().forEach(c => {
      const grid = $(`#bmGrid-${c.id}`);
      if (!grid) return;
      const order = catList(c.id);
      const list = visible(c.id);
      grid.innerHTML = list.length
        ? list.map(b => cardHtml(b, order.indexOf(b) + 1)).join('') : emptyPanel();
    });
    $('#bmCount').textContent =
      `共 ${bms.length} 个书签 · ${visibleCats().length} 个分类 · ⌘+1~9 打开当前分类前 9 个 · ⌘+点击多选，拖到左侧分类快速归类`;
    bindFavImgs();
  }

  /* ---------- 仪表盘快捷导航卡（简化展示，只读，悬浮切换分类 + 点击锁定） ---------- */
  function renderDashTabs(){
    const group = $('#dashBmTabs');
    if (!group) return;
    const shown = visibleCats();
    const first = (shown[0] || { id: 'none' }).id;
    if (!dashActive || !shown.find(c => c.id === dashActive)) dashActive = first;
    /* 锁定项被隐藏 / 删除时自动解锁 */
    if (lockedCat && !shown.find(c => c.id === lockedCat)) lockedCat = '';
    group.innerHTML = shown.map(c =>
      `<button class="tab${c.id === dashActive ? ' active' : ''}${lockedCat === c.id ? ' locked' : ''}" data-cat="${c.id}"
        title="悬浮切换 · 点击锁定，再点解锁">${App.esc(c.name)}<svg class="ic tab-lock"><use href="#i-lock"/></svg></button>`).join('');
    bindHoverTabs(group, true);   // 仪表盘：悬浮切换 + 点击锁定
  }

  function renderDashPanels(){
    const wrap = $('#quickNavPanels');
    if (!wrap) return;
    wrap.innerHTML = '';
    const first = (visibleCats()[0] || { id: 'none' }).id;
    visibleCats().forEach(c => {
      const g = document.createElement('div');
      g.className = 'bm-grid';
      g.dataset.qpanel = c.id;
      g.id = 'quickNavGrid-' + c.id;
      g.hidden = c.id !== (dashActive || first);
      wrap.appendChild(g);
    });
  }

  function renderDash(){
    visibleCats().forEach(c => {
      const g = $('#quickNavGrid-' + c.id);
      if (!g) return;
      const list = visible(c.id);   // 「全部」与各分类一致展示全部书签
      g.innerHTML = list.length
        ? list.map((b, i) => dashTileHtml(b, i + 1)).join('') : emptyHint();
    });
    bindFavImgs();
  }
  function emptyHint(){
    return '<div style="grid-column:1/-1;font-size:12px;color:var(--om-text-3);padding:10px">该分类暂无书签</div>';
  }

  /* 标签绑定：hover=true 悬浮即切换（仪表盘，支持点击锁定）；否则仅点击切换（页面）。
     锁定后：悬浮其它分类不再切换；再次点击被锁定的分类解锁，
     点击其它分类则切换并把锁定转移到新分类。 */
  function syncTabLock(group){
    $$('.tab[data-cat]', group).forEach(t =>
      t.classList.toggle('locked', !!lockedCat && t.dataset.cat === lockedCat));
  }
  function bindHoverTabs(group, hover){
    const scope = group.closest('.card') || group.closest('.view') || document;
    const isView = group.id === 'bmTabs';
    const activate = tab => {
      $$('.tab[data-cat]', group).forEach(t => t.classList.toggle('active', t === tab));
      $$('[data-qpanel]', scope).forEach(p => p.hidden = p.dataset.qpanel !== tab.dataset.cat);
      if (isView) activeCat = tab.dataset.cat;
      else dashActive = tab.dataset.cat;
    };
    $$('.tab[data-cat]', group).forEach(tab => {
      if (hover) tab.addEventListener('mouseenter', () => {
        if (window.isPhone && isPhone()) return;
        /* 已锁定且悬浮的不是锁定项：不切换 */
        if (lockedCat && tab.dataset.cat !== lockedCat) return;
        activate(tab);
      });
      tab.addEventListener('click', e => {
        /* 点到标签内的重命名/删除/隐藏小图标时不切换分类 */
        if (e.target.closest('.tab-ops')) return;
        activate(tab);
        if (hover){
          lockedCat = lockedCat === tab.dataset.cat ? '' : tab.dataset.cat;
          syncTabLock(group);
        }
      });
    });
  }

  function renderAll(){
    bms = sorted();
    renderTabs(); renderPanels(); renderView();
    renderDashTabs(); renderDashPanels(); renderDash();
  }

  /* ---------- 数据操作 ---------- */
  async function loadCats(){
    try { cats = await API.get('/api/bookmark-cats'); } catch (e) { cats = []; }
    if (!cats.length){
      cats = [{ id: 'all', name: '全部' }, { id: 'common', name: '常用' },
              { id: 'none', name: '未分类' }];
    }
    cats.forEach(c => { c.hidden = !!c.hidden; });
    /* 内置分类兜底：「全部」始终存在（位置由用户决定） */
    if (!cats.find(c => c.id === 'all')) cats.unshift({ id: 'all', name: '全部', hidden: false });
    if (!cats.find(c => c.id === 'none')) cats.push({ id: 'none', name: '未分类', hidden: false });
  }

  async function load(){
    await loadCats();
    try { bms = await API.get('/api/bookmarks'); } catch (e) { bms = []; }
    /* 历史书签的分类若已不存在，归入未分类 */
    const ids = new Set(cats.map(c => c.id));
    bms.forEach(b => { if (!ids.has(b.cat)) b.cat = 'none'; });
    /* 清理已不存在的选中项（如其他端删除） */
    const exist = new Set(bms.map(b => b.id));
    sel = new Set([...sel].filter(id => exist.has(id)));
    /* 首次使用的默认书签由后端播种（删光后不会自动重生） */
    renderAll();
    syncSelUi();
  }

  /* 拖拽落定后持久化。inAll：在「全部」面板内拖动 = 仅调整全局顺序（分类不变）；
     否则按分类面板 DOM 顺序重建（含跨分类移动）。
     筛选状态下未渲染的书签保留原相对顺序，不会丢失。 */
  async function persistOrder(inAll){
    const seen = new Set();
    const next = [];
    if (inAll){
      const grid = $('#bmGrid-all');
      if (grid) $$('.bm-tile[data-bm-id]', grid).forEach(el => {
        const bm = bms.find(b => b.id === el.dataset.bmId);
        if (bm && !seen.has(bm.id)){ bm.order = next.length; seen.add(bm.id); next.push(bm); }
      });
    } else {
      cats.filter(c => c.id !== 'all').forEach(c => {
        const grid = $(`#bmGrid-${c.id}`);
        if (!grid) return;
        $$('.bm-tile[data-bm-id]', grid).forEach(el => {
          const bm = bms.find(b => b.id === el.dataset.bmId);
          if (bm && !seen.has(bm.id)){
            bm.cat = c.id; bm.order = next.length; seen.add(bm.id); next.push(bm);
          }
        });
      });
    }
    bms.filter(b => !seen.has(b.id)).forEach(b => { b.order = next.length; next.push(b); });
    bms = next;
    renderView(); renderDash();
    await API.put('/api/bookmarks', bms).catch(e => showToast(e.message, 'err'));
  }

  /* ---------- 多选与批量归类 / 删除 ---------- */
  function syncSelUi(){
    $$('#bookmarksView .bm-tile[data-bm-id]').forEach(t =>
      t.classList.toggle('sel', sel.has(t.dataset.bmId)));
    const bar = $('#bmBatch');
    if (!bar) return;
    bar.hidden = !sel.size;
    if (sel.size) $('#bmBatchN').textContent = `已选 ${sel.size} 个`;
  }
  function toggleSel(id){
    if (sel.has(id)) sel.delete(id); else sel.add(id);
    syncSelUi();
  }
  function clearSel(){
    sel.clear();
    syncSelUi();
  }

  /* 拖拽选中书签到左侧分类标签：快速归类（追加到目标分类末尾，其余书签保持相对顺序） */
  async function dropSelToCat(cid){
    const ids = new Set(dragIds);
    const moved = bms.filter(b => ids.has(b.id));
    if (!moved.length) return;
    moved.forEach(b => { b.cat = cid; });
    bms = [...bms.filter(b => !ids.has(b.id)), ...moved];
    bms.forEach((b, i) => { b.order = i; });
    clearSel();
    renderTabs(); renderView(); renderDash();
    showToast(`已将 ${moved.length} 个书签移入「${catName(cid)}」`);
    await API.put('/api/bookmarks', bms).catch(e => showToast(e.message, 'err'));
  }

  /* ---------- 分类管理 ---------- */
  async function addCat(){
    const name = await App.promptModal({
      title: '新建分类',
      sub: '书签可按分类归组管理，新分类将插入「未分类」之前',
      placeholder: '分类名称，如：工具箱',
    });
    if (!name) return;
    try {
      const cat = await API.post('/api/bookmark-cats', { name });
      await loadCats();
      if (cat && cat.id) activeCat = cat.id;
      renderAll();
      showToast(`已新建分类「${name}」`);
    } catch (e) { showToast(e.message, 'err'); }
  }

  async function renameCat(cid){
    const old = catName(cid);
    const name = await App.promptModal({ title: '重命名分类', value: old, placeholder: '新的分类名称' });
    if (!name || name === old) return;
    try {
      await API.put('/api/bookmark-cats/' + cid, { name });
      await loadCats();
      renderAll();
      showToast('分类已重命名');
    } catch (e) { showToast(e.message, 'err'); }
  }

  async function delCat(cid){
    const n = bms.filter(b => b.cat === cid).length;
    const ok = await App.confirmModal({
      title: `删除分类「${catName(cid)}」？`,
      sub: n ? `其下 ${n} 个书签将移入「未分类」，书签本身不会删除。` : '该分类下暂无书签。',
      okText: '删除', danger: true,
    });
    if (!ok) return;
    try {
      await API.del('/api/bookmark-cats/' + cid);
      if (activeCat === cid) activeCat = 'none';
      await loadCats();
      try { bms = await API.get('/api/bookmarks'); } catch (e) {}
      renderAll();
      showToast('分类已删除');
    } catch (e) { showToast(e.message, 'err'); }
  }

  async function persistCatOrder(){
    const group = $('#bmTabs');
    const order = $$('.tab[data-cat]', group).map(t => t.dataset.cat);
    const shown = order.map(id => cats.find(c => c.id === id)).filter(Boolean);
    const hidden = cats.filter(c => c.hidden);
    if (shown.length + hidden.length !== cats.length) return;   // 渲染中途，忽略
    /* 可见分类按新顺序，隐藏分类保持追加在后 */
    cats = [...shown, ...hidden];
    renderDashTabs(); renderDashPanels(); renderDash();
    await saveCats('分类顺序保存失败：');
  }

  /* 整体保存分类（含隐藏标记） */
  async function saveCats(errPrefix){
    await API.put('/api/bookmark-cats',
      cats.map(c => ({ id: c.id, name: c.name, hidden: !!c.hidden })))
      .catch(e => showToast((errPrefix || '保存失败：') + e.message, 'err'));
  }

  /* ---------- 分类隐藏 / 恢复 ---------- */
  async function hideCat(cid){
    const c = cats.find(x => x.id === cid);
    if (!c) return;
    c.hidden = true;
    if (activeCat === cid) activeCat = 'all';
    await saveCats();
    renderAll();
    showToast(`已隐藏分类「${c.name}」，可在「已隐藏」中恢复`);
  }

  async function showCat(cid){
    const c = cats.find(x => x.id === cid);
    if (!c) return;
    c.hidden = false;
    await saveCats();
    renderAll();
    openHiddenModal();   // 刷新弹窗列表
    showToast(`已恢复分类「${c.name}」`);
  }

  function openHiddenModal(){
    const hidden = cats.filter(c => c.hidden);
    $('#bmHiddenList').innerHTML = hidden.length
      ? hidden.map(c => `
        <div class="set-row">
          <div class="set-row-info"><div class="set-row-label">${App.esc(c.name)}</div>
            <div class="set-row-sub">${bms.filter(b => b.cat === c.id).length} 个书签</div></div>
          <button class="btn btn-outline btn-sm" data-cat-show="${c.id}"><svg class="ic"><use href="#i-eye"/></svg>恢复显示</button>
        </div>`).join('')
      : '<div style="font-size:12px;color:var(--om-text-3)">没有已隐藏的分类</div>';
    App.openModal('bmHiddenMask');
  }

  /* ---------- 编辑器 ---------- */
  function openEditor(bm){
    editingId = bm ? bm.id : null;
    editIcon = (bm && bm.icon) || '';
    editHue = (bm && bm.hue) ?? 243;
    $('#bmCat').innerHTML = cats.filter(c => c.id !== 'all').map(c =>
      `<option value="${c.id}">${App.esc(c.name)}</option>`).join('');
    $('#bmName').value = bm ? bm.name : '';
    $('#bmUrl').value = bm ? bm.url : '';
    $('#bmDesc').value = bm ? (bm.desc || '') : '';
    $('#bmTags').value = bm ? (bm.tags || []).join(', ') : '';
    $('#bmCat').value = bm ? bm.cat
      : (activeCat !== 'all' && activeCat !== 'none' ? activeCat
        : (cats.find(c => c.id !== 'all' && c.id !== 'none') || {}).id || 'none');
    markIconOpt();
    syncIconPreview();
    $('#bmModalTitle').textContent = bm ? '编辑书签' : '新建书签';
    App.openModal('bmMask');
    setTimeout(() => $(bm ? '#bmName' : '#bmUrl').focus(), 80);
  }

  /* URL 变化后自动填充名称（仅在名称为空时，尽量短） */
  let nameTimer = null;
  function autoName(){
    const url = $('#bmUrl').value.trim();
    if (!url || $('#bmName').value.trim()) return;
    const full = /^https?:\/\//.test(url) ? url : 'https://' + url;
    API.get('/api/site-meta?url=' + encodeURIComponent(full)).then(m => {
      if (!$('#bmName').value.trim() && m && m.name){
        $('#bmName').value = m.name;
        syncIconPreview();
      }
    }).catch(() => {});
  }

  function markIconOpt(){
    $$('#bmIconPicker .bm-icon-opt').forEach(o =>
      o.classList.toggle('on', o.dataset.bmIcon === editIcon ||
        (!editIcon && o.dataset.bmIcon === '')));
  }

  function syncIconPreview(){
    const el = $('#bmIconPreview');
    el.style.setProperty('--fav', editHue);
    const name = $('#bmName').value.trim() || '?';
    const url = $('#bmUrl').value.trim();
    if (editIcon.startsWith('sym:')){
      el.innerHTML = `<svg class="ic"><use href="#${editIcon.slice(4)}"/></svg>`;
      return;
    }
    const letter = App.esc(name.charAt(0).toUpperCase());
    if (url){
      el.innerHTML = `<img src="${favUrl(/^https?:\/\//.test(url) ? url : 'https://' + url)}" alt="">${letter}`;
      el.querySelector('img')?.addEventListener('error', ev => ev.target.remove());
    } else {
      el.textContent = letter;
    }
  }

  /* AI 智能填充：分类 / 描述 / 标签 */
  async function aiFill(){
    const name = $('#bmName').value.trim(), url = $('#bmUrl').value.trim();
    if (!name && !url) return showToast('请先填写名称或网址', 'err');
    const btn = $('#bmAi');
    btn.disabled = true;
    btn.innerHTML = '<svg class="ic" style="animation:omSpin .8s linear infinite"><use href="#i-refresh"/></svg>分析中…';
    try {
      const cfg = await API.get('/api/ai-config');
      if (!cfg.enabled){
        showToast('AI 智能未启用，请先在 设置 → AI 智能 中配置', 'err');
        return;
      }
      const r = await API.post('/api/ai/analyze-bookmark', {
        name, url, desc: $('#bmDesc').value.trim(),
        cats: cats.filter(c => c.id !== 'all').map(c => ({ id: c.id, name: c.name })),
      });
      if (r.desc) $('#bmDesc').value = r.desc;
      if (r.tags && r.tags.length) $('#bmTags').value = r.tags.join(', ');
      if (r.catId && $(`#bmCat option[value="${r.catId}"]`)) $('#bmCat').value = r.catId;
      showToast('AI 填充完成，请确认后保存');
    } catch (e) { showToast('AI 填充失败：' + e.message, 'err'); }
    finally {
      btn.disabled = false;
      btn.innerHTML = '<svg class="ic"><use href="#i-zap"/></svg>AI 填充';
    }
  }

  /* ---------- 标签多选筛选 ---------- */
  function allTags(){
    return [...new Set(bms.flatMap(b => b.tags || []))].sort((a, b) => a.localeCompare(b, 'zh'));
  }

  function renderTagPanel(){
    const tags = allTags();
    $('#bmTagPanel').innerHTML = tags.length
      ? tags.map(t => `
        <label class="tag-opt"><input type="checkbox" value="${App.esc(t)}" ${tagSel.has(t) ? 'checked' : ''}>
        <span>${App.esc(t)}</span><span class="num tag-opt-n">${bms.filter(b => (b.tags || []).includes(t)).length}</span></label>`).join('') +
        (tagSel.size ? '<button class="btn btn-ghost btn-sm" id="bmTagClear" style="width:100%">清除筛选</button>' : '')
      : '<div class="drop-empty">暂无标签，可在编辑书签时添加</div>';
    const badge = $('#bmTagCount');
    badge.hidden = !tagSel.size;
    badge.textContent = tagSel.size;
  }

  function toggleTagPanel(open){
    const panel = $('#bmTagPanel');
    if (open){ renderTagPanel(); panel.hidden = false; }
    else panel.hidden = true;
  }

  /* ---------- 导入 / 导出（标准 Netscape Bookmark HTML） ---------- */
  function exportHtml(){
    if (!bms.length) return showToast('暂无书签可导出', 'err');
    const byCat = {};
    sorted().forEach(b => { (byCat[b.cat] = byCat[b.cat] || []).push(b); });
    const list = cats.filter(c => c.id !== 'all' && (byCat[c.id] || []).length);
    const ts = Math.round(Date.now() / 1000);
    const lines = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>',
      '<!-- 由万事屋导出 -->',
      '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
      '<TITLE>Bookmarks</TITLE>', '<H1>Bookmarks</H1>', '<DL><p>'];
    list.forEach(c => {
      lines.push(`  <DT><H3>${App.esc(c.name)}</H3>`, '  <DL><p>');
      byCat[c.id].forEach(b => {
        const tags = (b.tags || []).join(',');
        lines.push(`    <DT><A HREF="${App.esc(b.url)}" ADD_DATE="${ts}"` +
          (tags ? ` TAGS="${App.esc(tags)}"` : '') + `>${App.esc(b.name)}</A>`);
        if (b.desc) lines.push(`    <DD>${App.esc(b.desc)}`);
      });
      lines.push('  </DL><p>');
    });
    lines.push('</DL><p>');
    const blob = new Blob([lines.join('\n')], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'omnihome-bookmarks.html';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
    showToast(`已导出 ${bms.length} 个书签`);
  }

  /* 递归解析 <DL>：文件夹（<H3>+<DL>）映射为分类，<A> 映射为书签 */
  function parseDl(dl, catId, out, ensureCat){
    [...dl.children].forEach(dt => {
      if (dt.tagName !== 'DT') return;
      const h3 = dt.querySelector(':scope > h3');
      const sub = dt.querySelector(':scope > dl');
      if (h3 && sub){
        parseDl(sub, ensureCat(h3.textContent.trim()), out, ensureCat);
        return;
      }
      const a = dt.querySelector(':scope > a');
      if (!a) return;
      const url = a.getAttribute('href') || '';
      if (!/^https?:/i.test(url)) return;
      const dd = dt.nextElementSibling;
      out.push({
        name: a.textContent.trim() || url,
        url,
        cat: catId,
        desc: dd && dd.tagName === 'DD' ? dd.textContent.trim().slice(0, 60) : '',
        tags: (a.getAttribute('tags') || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 8),
      });
    });
  }

  async function importHtml(file){
    let doc;
    try {
      doc = new DOMParser().parseFromString(await file.text(), 'text/html');
    } catch (e) { return showToast('文件解析失败', 'err'); }
    const root = doc.querySelector('dl');
    if (!root) return showToast('未识别到书签内容（需 Netscape HTML 格式）', 'err');
    const items = [];
    const ensureCat = name => {
      if (!name) return 'none';
      let c = cats.find(x => x.name === name);
      if (!c){
        c = { id: 'imp_' + name, name };   // 占位，稍后统一建类
      }
      return c.id;
    };
    parseDl(root, 'none', items, ensureCat);
    if (!items.length) return showToast('文件中没有有效书签', 'err');
    const exist = new Set(bms.map(b => (b.url || '').toLowerCase()));
    let added = 0, skipped = 0;
    try {
      for (const it of items){
        if (exist.has((it.url || '').toLowerCase())){ skipped++; continue; }
        let cid = it.cat;
        if (cid.startsWith('imp_')){
          const name = cid.slice(4);
          let c = cats.find(x => x.name === name);
          if (!c){
            try { c = await API.post('/api/bookmark-cats', { name }); } catch (e) { c = { id: 'none' }; }
            cats.push(c);
          }
          it.cat = cid = c.id;
          /* 同名文件夹下的后续书签复用已建分类 */
          items.forEach(x => { if (x.cat === 'imp_' + name) x.cat = cid; });
        }
        await API.post('/api/bookmarks', it);
        exist.add((it.url || '').toLowerCase());
        added++;
      }
      await load();
      showToast(`导入完成：新增 ${added} 个${skipped ? `，跳过重复 ${skipped} 个` : ''}`);
    } catch (e) {
      await load();
      showToast('导入中断：' + e.message, 'err');
    }
  }

  /* ---------- 事件 ---------- */
  function init(){
    /* 新建 / 编辑保存 */
    $('#bmNew').addEventListener('click', () => openEditor(null));
    $$('.js-bm-add').forEach(b => b.addEventListener('click', () => openEditor(null)));
    $('#bmCancel').addEventListener('click', () => App.closeModal('bmMask'));
    $('#bmSave').addEventListener('click', async () => {
      const name = $('#bmName').value.trim(), url = $('#bmUrl').value.trim(), cat = $('#bmCat').value;
      if (!name) return showToast('请填写名称（或先填写网址自动识别）', 'err');
      const desc = $('#bmDesc').value.trim();
      const tags = $('#bmTags').value.split(/[,，]/).map(t => t.trim()).filter(Boolean).slice(0, 8);
      const payload = { name, url, cat, icon: editIcon, desc, tags };
      try {
        if (editingId) await API.put('/api/bookmarks/' + editingId, payload);
        else await API.post('/api/bookmarks', payload);
        App.closeModal('bmMask');
        showToast(editingId ? '书签已更新' : '书签已添加');
        await load();
      } catch (e) { showToast(e.message, 'err'); }
    });

    /* 导入 / 导出 */
    $('#bmExportBtn').addEventListener('click', exportHtml);
    $('#bmImportBtn').addEventListener('click', () => $('#bmImportFile').click());
    $('#bmImportFile').addEventListener('change', e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) importHtml(f);
    });

    /* 图标选择 / 自动预览（网址或名称变化时刷新「自动」图标） */
    $('#bmIconPicker').addEventListener('click', e => {
      const opt = e.target.closest('.bm-icon-opt');
      if (!opt) return;
      editIcon = opt.dataset.bmIcon;
      markIconOpt();
      syncIconPreview();
    });
    $('#bmUrl').addEventListener('input', () => {
      syncIconPreview();
      clearTimeout(nameTimer);
      nameTimer = setTimeout(autoName, 700);
    });
    $('#bmUrl').addEventListener('blur', autoName);
    $('#bmName').addEventListener('input', syncIconPreview);
    $('#bmAi').addEventListener('click', aiFill);

    /* 筛选：关键词 + 标签多选 */
    $('#bmSearch').addEventListener('input', e => { filter = e.target.value; renderView(); });
    $('#bmTagBtn').addEventListener('click', e => {
      e.stopPropagation();
      toggleTagPanel($('#bmTagPanel').hidden);
    });
    $('#bmTagPanel').addEventListener('change', e => {
      const cb = e.target.closest('input[type="checkbox"]');
      if (!cb) return;
      if (cb.checked) tagSel.add(cb.value); else tagSel.delete(cb.value);
      renderTagPanel(); renderView();
    });
    $('#bmTagPanel').addEventListener('click', e => {
      e.stopPropagation();
      if (e.target.closest('#bmTagClear')){
        tagSel.clear();
        renderTagPanel(); renderView();
      }
    });
    document.addEventListener('click', e => {
      if (!$('#bmTagPanel').hidden && !e.target.closest('.dropdown')) toggleTagPanel(false);
    });

    /* 分类标签：新建 / 重命名 / 删除 / 隐藏（事件委托） */
    $('#bmTabs').addEventListener('click', e => {
      const add = e.target.closest('[data-cat-add]');
      if (add) return addCat();
      const hiddenBtn = e.target.closest('[data-cat-hidden]');
      if (hiddenBtn) return openHiddenModal();
      const hide = e.target.closest('[data-cat-hide]');
      if (hide) return hideCat(hide.dataset.catHide);
      const edit = e.target.closest('[data-cat-edit]');
      if (edit) return renameCat(edit.dataset.catEdit);
      const del = e.target.closest('[data-cat-del]');
      if (del) return delCat(del.dataset.catDel);
    });

    /* 隐藏分类管理弹窗：恢复显示 */
    $('#bmHiddenMask').addEventListener('click', e => {
      const show = e.target.closest('[data-cat-show]');
      if (show) showCat(show.dataset.catShow);
    });
    $('#bmHiddenClose').addEventListener('click', () => App.closeModal('bmHiddenMask'));

    /* 分类标签拖拽排序（含「全部」标签） */
    $('#bmTabs').addEventListener('dragstart', e => {
      const tab = e.target.closest ? e.target.closest('.tab[data-cat]') : null;
      if (!tab) return;
      catDrag = tab;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', tab.dataset.cat); } catch (_) {}
    });
    $('#bmTabs').addEventListener('dragover', e => {
      if (!catDrag) return;
      const tab = e.target.closest ? e.target.closest('.tab[data-cat]') : null;
      if (!tab || tab === catDrag) return;
      e.preventDefault();
      const rect = tab.getBoundingClientRect();
      if (e.clientX < rect.left + rect.width / 2) tab.before(catDrag);
      else tab.after(catDrag);
    });
    $('#bmTabs').addEventListener('dragend', () => {
      if (!catDrag) return;
      catDrag = null;
      persistCatOrder();
    });

    /* 书签拖到左侧分类标签：快速归类（支持多选一起拖） */
    $('#bmTabs').addEventListener('dragover', e => {
      if (!dragEl || catDrag) return;
      const tab = e.target.closest ? e.target.closest('.tab[data-cat]') : null;
      if (!tab || tab.dataset.cat === 'all') return;   // 「全部」不能作为归类目标
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      $$('.tab', $('#bmTabs')).forEach(t => t.classList.toggle('drop-over', t === tab));
    });
    $('#bmTabs').addEventListener('drop', e => {
      if (!dragEl) return;
      const tab = e.target.closest ? e.target.closest('.tab[data-cat]') : null;
      if (!tab || tab.dataset.cat === 'all') return;
      e.preventDefault();
      $$('.tab.drop-over', $('#bmTabs')).forEach(t => t.classList.remove('drop-over'));
      droppedCat = true;
      dropSelToCat(tab.dataset.cat);
    });

    /* 点击磁贴打开 / 编辑 / 删除 / 多选（事件委托，覆盖仪表盘与导航视图） */
    document.addEventListener('click', async e => {
      const selBtn = e.target.closest('[data-bm-sel]');
      if (selBtn){
        e.stopPropagation();
        toggleSel(selBtn.dataset.bmSel);
        return;
      }
      const del = e.target.closest('[data-bm-del]');
      if (del){
        e.stopPropagation();
        const bm = bms.find(b => b.id === del.dataset.bmDel);
        const ok = await App.confirmModal({
          title: '删除书签',
          sub: bm ? `确定删除「${bm.name}」？此操作不可恢复。` : '确定删除该书签？',
          okText: '删除', danger: true,
        });
        if (!ok) return;
        sel.delete(del.dataset.bmDel);
        await API.del('/api/bookmarks/' + del.dataset.bmDel).catch(err => showToast(err.message, 'err'));
        await load();
        return;
      }
      const edit = e.target.closest('[data-bm-edit]');
      if (edit){
        e.stopPropagation();
        openEditor(bms.find(b => b.id === edit.dataset.bmEdit));
        return;
      }
      const tile = e.target.closest('.bm-tile[data-bm-id]');
      if (tile){
        const id = tile.dataset.bmId;
        /* 导航页：⌘/Ctrl+点击选择；已处于多选状态时点击直接切换选中 */
        if (tile.closest('#bookmarksView') && (e.metaKey || e.ctrlKey || sel.size)){
          toggleSel(id);
          return;
        }
        const bm = bms.find(b => b.id === id);
        if (bm && bm.url) window.open(/^https?:\/\//.test(bm.url) ? bm.url : 'https://' + bm.url, '_blank');
      }
    });

    /* 批量操作条（多选后出现）：批量删除 / 取消选择 */
    $('#bmBatchDel').addEventListener('click', async () => {
      const ids = [...sel];
      if (!ids.length) return;
      const ok = await App.confirmModal({
        title: '批量删除书签',
        sub: `确定删除选中的 ${ids.length} 个书签？此操作不可恢复。`,
        okText: '删除', danger: true,
      });
      if (!ok) return;
      let failed = 0;
      for (const id of ids){
        await API.del('/api/bookmarks/' + id).catch(() => { failed++; });
      }
      sel.clear();
      await load();
      if (failed) showToast(`删除完成，${failed} 个失败`, 'err');
      else showToast(`已删除 ${ids.length} 个书签`);
    });
    $('#bmBatchClear').addEventListener('click', clearSel);

    /* 拖拽落到底部批量条 = 快速删除（多选一起删，无需二次确认） */
    const batch = $('#bmBatch');
    batch.addEventListener('dragover', e => {
      if (!dragEl || !dragIds.length) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      batch.classList.add('drop-del');
    });
    batch.addEventListener('dragleave', () => batch.classList.remove('drop-del'));
    batch.addEventListener('drop', async e => {
      if (!dragEl || !dragIds.length) return;
      e.preventDefault();
      batch.classList.remove('drop-del');
      const ids = [...dragIds];
      droppedBar = true;
      let failed = 0;
      for (const id of ids){
        await API.del('/api/bookmarks/' + id).catch(() => { failed++; });
      }
      ids.forEach(id => sel.delete(id));
      await load();
      if (failed) showToast(`删除完成，${failed} 个失败`, 'err');
      else showToast(`已删除 ${ids.length} 个书签`);
    });

    /* 书签拖拽排序（导航视图内，可跨分类；「全部」面板内拖动 = 全局排序） */
    document.addEventListener('dragstart', e => {
      const tile = e.target.closest ? e.target.closest('#bookmarksView .bm-tile[data-bm-id]') : null;
      if (!tile) return;
      dragEl = tile;
      dragFromAll = (tile.closest('.bm-grid') || {}).dataset?.qpanel === 'all';
      /* 拖动已选中的卡片 = 全部选中项一起移动；否则仅当前一个 */
      dragIds = sel.has(tile.dataset.bmId) ? [...sel] : [tile.dataset.bmId];
      /* 多选拖拽虚影：堆叠卡片 + 计数角标，体现多磁贴一起拖 */
      if (dragIds.length > 1){
        const ghost = document.createElement('div');
        ghost.className = 'bm-drag-ghost';
        const name = (tile.querySelector('.bm-name') || {}).textContent || '';
        ghost.innerHTML = `<div class="bm-dg-tile"><span class="bm-dg-name">${App.esc(name)}</span></div>` +
          `<span class="bm-dg-n num">${dragIds.length}</span>`;
        ghost.style.left = '-9999px'; ghost.style.top = '-9999px';
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 40, 24);
        setTimeout(() => ghost.remove(), 300);
      }
      /* 拖拽期间批量条常显，作为「拖到这里删除」的落点 */
      batchDragMode(true, dragIds.length);
      tile.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', tile.dataset.bmId); } catch (_) {}
    });
    document.addEventListener('dragend', () => {
      $$('.tab.drop-over').forEach(t => t.classList.remove('drop-over'));
      batchDragMode(false);
      if (!dragEl) return;
      const inAll = dragFromAll;
      const skipPersist = droppedCat || droppedBar;   // 已按快速归类 / 删除落定，不重复持久化
      dragEl.classList.remove('dragging');
      dragEl = null;
      dragIds = [];
      droppedCat = false;
      droppedBar = false;
      if (!skipPersist) persistOrder(inAll);
    });
    /* 委托到面板容器：动态生成的分类面板也能接收拖放。
       判定逻辑与仪表盘一致（阅读序 + 卡片中心），插入后布局不会来回抖动 */
    const panels = $('#bmPanels');
    panels.addEventListener('dragover', e => {
      if (!dragEl) return;
      const grid = e.target.closest ? e.target.closest('#bmPanels .bm-grid[data-qpanel]') : null;
      if (!grid) return;
      /* 「全部」面板与分类面板不混拖，避免语义混乱 */
      if ((grid.dataset.qpanel === 'all') !== dragFromAll) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const others = $$('.bm-tile[data-bm-id]:not(.dragging)', grid);
      let ref = null;
      for (const el of others){
        const r = el.getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2 ||
            (e.clientY <= r.bottom && e.clientX < r.left + r.width / 2)){
          ref = el; break;
        }
      }
      if (ref){
        if (ref.previousElementSibling !== dragEl) grid.insertBefore(dragEl, ref);
      } else if (grid.lastElementChild !== dragEl){
        grid.appendChild(dragEl);
      }
    });
    panels.addEventListener('drop', e => e.preventDefault());

    /* 全局快捷键：⌘/Ctrl + 1~9 按分类独立编号，打开当前分类的前 9 个书签。
       在快捷导航页按当前选中分类；其他页面按仪表盘悬浮的分类（默认首个）。 */
    document.addEventListener('keydown', e => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const n = parseInt(e.key, 10);
      if (!n || n < 1 || n > 9) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const onView = $('#bookmarksView').classList.contains('active');
      const cat = onView ? activeCat
        : (dashActive && visibleCats().find(c => c.id === dashActive) ? dashActive
          : (visibleCats()[0] || { id: 'all' }).id);
      const bm = catList(cat)[n - 1];
      if (!bm || !bm.url) return;
      e.preventDefault();
      window.open(/^https?:\/\//.test(bm.url) ? bm.url : 'https://' + bm.url, '_blank');
      showToast(`⌘${n} → ${bm.name}`);
    });
  }

  return { init, load, openEditor };
})();
Bookmarks.init();
App.onEnter(() => Bookmarks.load());

export { Bookmarks };
window.Bookmarks = Bookmarks;
