/* ============================================================
   OmniDesk · 仪表盘组件编辑
   布局持久化（顺序 / 收纳 / 尺寸） + 编辑模式 + 拖拽排序（虚影预览）
   + 拖拽调大小（右下角手柄：横向按列吸附，纵向按 20px 吸附）。
   自定义尺寸仅在宽屏生效；窗口收窄时回落 col-* 自带的响应式规则，
   避免窄屏上出现被压扁的卡片。
   ============================================================ */
const Dash = (() => {
  /* 组件注册表：id → 标题与图标（与 index.html 的 data-widget 对应） */
  const WIDGETS = {
    monitor:   { title: '系统监控',     icon: 'i-activity' },
    quicknav:  { title: '快捷导航',     icon: 'i-bookmark' },
    calendar:  { title: '日历',         icon: 'i-clock' },
    word:      { title: '每日单词',     icon: 'i-note' },
    vault:     { title: '密码保险库',   icon: 'i-shield' },
    quicknote: { title: '灵感速记',     icon: 'i-pen' },
    plan:      { title: '今日计划',     icon: 'i-check' },
    toolbox:   { title: '实用工具箱',   icon: 'i-wrench' },
  };
  const DEFAULT_ORDER = Object.keys(WIDGETS);

  /* 尺寸拖拽边界：跨列 3~12（低于 3 列卡片内容无法阅读），高度 160px 起按 20px 吸附 */
  const COL_MIN = 3, COL_MAX = 12;
  const H_MIN = 160, H_STEP = 20, H_MAX = 2000;
  const SIZE_MIN_W = 1281;   // 低于该视口宽度不启用自定义尺寸

  let removed = [];
  let sizes = {};            // 组件 id -> { col, h }
  let editing = false;
  let dragCard = null;
  let placeholder = null;
  let resizing = null;       // { card, id, x0, y0, w0, h0, col, h }

  const grid = $('#dashGrid');

  const cards = () => $$('#dashGrid [data-widget]');
  const cardOf = id => grid.querySelector(`[data-widget="${id}"]`);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sizeEnabled = () => window.innerWidth >= SIZE_MIN_W;

  /* ---------- 布局读写 ---------- */
  async function load(){
    let order = [];
    try {
      const d = await API.get('/api/dashboard');
      order = (d.order || []).filter(id => WIDGETS[id]);
      removed = (d.removed || []).filter(id => WIDGETS[id]);
      sizes = (d.sizes && typeof d.sizes === 'object' && !Array.isArray(d.sizes))
        ? d.sizes : {};
    } catch (e) { /* 未登录或网络异常：保持默认布局 */ }
    apply(order);
    applyAllSizes();
  }

  /* 按保存顺序重排卡片（未记录的组件按默认顺序补在末尾），收纳的隐藏 */
  function apply(order){
    const seq = [...order, ...DEFAULT_ORDER.filter(id => !order.includes(id))];
    seq.forEach(id => {
      const c = cardOf(id);
      if (c) grid.appendChild(c);
    });
    cards().forEach(c => { c.hidden = removed.includes(c.dataset.widget); });
  }

  function save(){
    const order = cards().filter(c => !c.hidden).map(c => c.dataset.widget);
    return API.put('/api/dashboard', { order, removed, sizes })
      .catch(e => showToast('布局保存失败：' + e.message, 'err'));
  }

  /* ---------- 组件尺寸（跨列数 + 最小高度） ---------- */
  /* 单列宽与间距：把拖拽的像素位移换算成跨列数 */
  function gridGeom(){
    const cs = getComputedStyle(grid);
    const gap = parseFloat(cs.columnGap) || 0;
    const cols = (cs.gridTemplateColumns || '').split(' ').filter(Boolean);
    const colW = cols.length >= 12 && parseFloat(cols[0])
      ? parseFloat(cols[0])
      : (grid.clientWidth - gap * 11) / 12;
    return { gap, colW: colW || 1 };
  }
  function spanFromWidth(w){
    const { gap, colW } = gridGeom();
    return clamp(Math.round((w + gap) / (colW + gap)), COL_MIN, COL_MAX);
  }
  /* 默认跨列数取自卡片原始 col-N 类（类名始终保留，仅被自定义尺寸覆盖） */
  function defaultCol(card){
    return +((card.className.match(/\bcol-(\d+)\b/) || [])[1] || 12);
  }
  function applySize(card){
    const s = sizes[card.dataset.widget] || {};
    card.style.setProperty('--dash-col', String(s.col || defaultCol(card)));
    card.style.setProperty('--dash-h', s.h ? s.h + 'px' : 'auto');
    card.classList.toggle('sized', !!(s.col || s.h) && sizeEnabled());
  }
  function applyAllSizes(){
    cards().forEach(applySize);
  }
  function resetSize(card){
    const id = card.dataset.widget;
    delete sizes[id];
    card.classList.remove('sized');
    card.style.removeProperty('--dash-col');
    card.style.removeProperty('--dash-h');
    save();
    showToast(`已恢复「${WIDGETS[id].title}」默认尺寸`);
  }

  /* ---------- 拖拽调大小 ---------- */
  function showSizeTip(card, col, h){
    let tip = card.querySelector('.dash-size-tip');
    if (!tip){
      tip = document.createElement('div');
      tip.className = 'dash-size-tip num';
      card.appendChild(tip);
    }
    tip.textContent = h ? `${col} 列 · ${Math.round(h)} px` : `${col} 列 · 高度自适应`;
    tip.hidden = false;
  }
  function hideSizeTip(card){
    const tip = card.querySelector('.dash-size-tip');
    if (tip) tip.hidden = true;
  }

  function onResizeDown(e){
    if (!editing || !sizeEnabled()) return;
    const handle = e.target.closest('.dash-resize');
    if (!handle) return;
    e.preventDefault();
    e.stopPropagation();
    const card = handle.closest('[data-widget]');
    if (!card || card.hidden || resizing) return;
    const r = card.getBoundingClientRect();
    const s = sizes[card.dataset.widget] || {};
    resizing = { card, id: card.dataset.widget, x0: e.clientX, y0: e.clientY,
                 w0: r.width, h0: r.height, hStored: s.h || 0,
                 col: s.col || defaultCol(card), h: s.h || null };
    card.classList.add('resizing', 'sized');
    card.draggable = false;
    document.body.classList.add('dash-resizing');
    showSizeTip(card, resizing.col, resizing.h);
    document.addEventListener('mousemove', onResizeMove);
    document.addEventListener('mouseup', onResizeUp);
  }

  function onResizeMove(e){
    if (!resizing) return;
    const { card, x0, y0, w0, h0, hStored } = resizing;
    const col = spanFromWidth(w0 + (e.clientX - x0));
    const dy = e.clientY - y0;
    /* 纵向位移不足 4px 视为只调宽度，高度保持原样（可能是「自适应」） */
    const h = Math.abs(dy) < 4
      ? (hStored || null)
      : clamp(Math.round(((hStored || h0) + dy) / H_STEP) * H_STEP, H_MIN, H_MAX);
    resizing.col = col; resizing.h = h;
    card.style.setProperty('--dash-col', col);
    card.style.setProperty('--dash-h', h ? h + 'px' : 'auto');
    showSizeTip(card, col, h);
  }

  function onResizeUp(){
    if (!resizing) return;
    const { card, id, col, h } = resizing;
    document.removeEventListener('mousemove', onResizeMove);
    document.removeEventListener('mouseup', onResizeUp);
    card.classList.remove('resizing');
    document.body.classList.remove('dash-resizing');
    hideSizeTip(card);
    resizing = null;
    if (id){
      sizes[id] = h ? { col, h } : { col };
      applySize(card);
      save();
    }
  }

  /* 非正常结束（退出编辑 / 组件被收纳）时放弃本次拖拽，不落库 */
  function abortResize(){
    if (!resizing) return;
    const card = resizing.card;
    document.removeEventListener('mousemove', onResizeMove);
    document.removeEventListener('mouseup', onResizeUp);
    card.classList.remove('resizing');
    document.body.classList.remove('dash-resizing');
    hideSizeTip(card);
    resizing = null;
    applySize(card);
  }

  /* ---------- 编辑模式 ---------- */
  function setEditing(on){
    editing = on;
    grid.classList.toggle('editing', on);
    $('#dashEditBtn').innerHTML = on
      ? '<svg class="ic"><use href="#i-check"/></svg>完成'
      : '<svg class="ic"><use href="#i-sliders"/></svg>编辑布局';
    $('#dashAddBtn').hidden = !on;
    cards().forEach(toggleCardTools);
    if (!on){
      if (dragCard){ dragCard.classList.remove('dragging'); dragCard = null; }
      abortResize();
    }
  }

  /* 编辑态为每张卡片注入：拖拽把手 + 收纳按钮 + 右下角调大小手柄 */
  function toggleCardTools(card){
    let bar = card.querySelector('.dash-tools');
    let handle = card.querySelector('.dash-resize');
    if (editing){
      if (!bar){
        bar = document.createElement('div');
        bar.className = 'dash-tools';
        bar.innerHTML = `
          <span class="dash-grip" title="按住拖拽调整位置"><svg class="ic"><use href="#i-grip"/></svg></span>
          <button class="icon-btn-xs" data-dash-remove="${card.dataset.widget}" title="收纳组件"><svg class="ic"><use href="#i-box"/></svg></button>`;
        card.appendChild(bar);
      }
      if (!handle){
        handle = document.createElement('span');
        handle.className = 'dash-resize';
        handle.title = '拖拽调整大小（双击恢复默认）';
        handle.innerHTML = '<svg class="ic"><use href="#i-resize"/></svg>';
        card.appendChild(handle);
      }
    } else {
      if (bar) bar.remove();
      if (handle) handle.remove();
      hideSizeTip(card);
      card.draggable = false;
    }
  }

  /* 收纳：移出仪表盘（可随时从「添加组件」找回） */
  function removeWidget(id){
    if (!WIDGETS[id] || removed.includes(id)) return;
    if (resizing && resizing.id === id) abortResize();
    removed.push(id);
    const c = cardOf(id);
    if (c) c.hidden = true;
    save();
    showToast(`已收纳「${WIDGETS[id].title}」，可随时添加回来`);
  }

  /* ---------- 添加组件弹窗 ---------- */
  function renderAddList(){
    const list = removed.filter(id => WIDGETS[id]);
    $('#addWidgetList').innerHTML = list.length
      ? list.map(id => `
        <button class="widget-add-tile" data-widget-add="${id}">
          <svg class="ic"><use href="#${WIDGETS[id].icon}"/></svg>
          <span>${WIDGETS[id].title}</span>
          <svg class="ic" style="margin-left:auto;color:var(--om-primary)"><use href="#i-plus"/></svg>
        </button>`).join('')
      : '<div style="font-size:12px;color:var(--om-text-3);text-align:center;padding:18px 0">所有组件都在仪表盘上，没有可添加的收纳项</div>';
  }

  function addWidget(id){
    if (!WIDGETS[id]) return;
    removed = removed.filter(x => x !== id);
    const c = cardOf(id);
    if (c){ c.hidden = false; grid.appendChild(c); applySize(c); }
    save();
    renderAddList();
    showToast(`已添加「${WIDGETS[id].title}」`);
  }

  /* ---------- 拖拽排序（虚影预览） ---------- */
  /* 只有按住把手才允许拖动，避免编辑态误触卡片内的输入 */
  function onGripDown(e){
    if (!editing) return;
    const grip = e.target.closest('.dash-grip');
    if (!grip) return;
    const card = grip.closest('[data-widget]');
    if (card) card.draggable = true;
  }

  function onDragStart(e){
    const card = e.target.closest ? e.target.closest('[data-widget]') : null;
    if (!editing || !card || card.hidden || !card.draggable){ return; }
    dragCard = card;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', card.dataset.widget); } catch (_) {}
    /* 占位虚框：继承跨列宽度，高度与原卡片一致 */
    const colCls = (card.className.match(/col-\d+/) || ['col-12'])[0];
    placeholder = document.createElement('div');
    placeholder.className = 'dash-placeholder ' + colCls;
    placeholder.style.height = card.offsetHeight + 'px';
    /* 延后加样式：保证浏览器以原始外观生成跟随鼠标的虚影 */
    setTimeout(() => card.classList.add('dragging'), 0);
  }

  function onDragOver(e){
    if (!dragCard || !placeholder) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    /* 统一按阅读序判定：光标「排在」某张卡片之前（位于卡片垂直中心以上，
       或同行且在卡片水平中心以左）时，占位框插入其前；否则追加到末尾。
       该判定只依赖光标与目标卡片的相对关系：占位框移动引起布局重排后，
       判定结果不变，因此不会来回抖动，宽卡也能稳定拖到第一排 */
    const others = cards().filter(c => c !== dragCard && !c.hidden);
    let ref = null;
    for (const c of others){
      const r = c.getBoundingClientRect();
      const before = e.clientY < r.top + r.height / 2 ||
        (e.clientY <= r.bottom && e.clientX < r.left + r.width / 2);
      if (before){ ref = c; break; }
    }
    if (ref){
      if (placeholder.nextElementSibling !== ref) grid.insertBefore(placeholder, ref);
    } else {
      /* 追加到末尾：仅当占位框后面还有可见卡片时才移动，避免拖尾抖动 */
      const hasAfter = others.some(c =>
        placeholder.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (hasAfter) grid.appendChild(placeholder);
    }
  }

  function onDragEnd(){
    if (!dragCard) return;
    dragCard.classList.remove('dragging');
    dragCard.draggable = false;
    if (placeholder && placeholder.parentNode){
      placeholder.parentNode.insertBefore(dragCard, placeholder);
      placeholder.remove();
    }
    dragCard = null;
    placeholder = null;
    save();
  }

  /* ---------- 事件绑定 ---------- */
  function init(){
    $('#dashEditBtn').addEventListener('click', () => setEditing(!editing));
    $('#dashAddBtn').addEventListener('click', () => {
      renderAddList();
      App.openModal('addWidgetMask');
    });
    $('#addWidgetList').addEventListener('click', e => {
      const btn = e.target.closest('[data-widget-add]');
      if (btn) addWidget(btn.dataset.widgetAdd);
    });

    grid.addEventListener('mousedown', e => { onGripDown(e); onResizeDown(e); });
    /* 未真正拖动时复位 draggable，避免误拖卡片内的文本选区 */
    grid.addEventListener('mouseup', () => {
      if (!editing) return;
      cards().forEach(c => { if (c !== dragCard) c.draggable = false; });
    });
    /* 双击手柄恢复该组件默认尺寸 */
    grid.addEventListener('dblclick', e => {
      const handle = e.target.closest('.dash-resize');
      if (!handle || !editing) return;
      e.preventDefault();
      resetSize(handle.closest('[data-widget]'));
    });
    grid.addEventListener('click', e => {
      const btn = e.target.closest('[data-dash-remove]');
      if (btn && editing){
        e.stopPropagation();
        removeWidget(btn.dataset.dashRemove);
      }
    });
    grid.addEventListener('dragstart', onDragStart);
    grid.addEventListener('dragover', onDragOver);
    grid.addEventListener('drop', e => e.preventDefault());
    grid.addEventListener('dragend', onDragEnd);

    /* 视口跨越阈值时切换自定义尺寸的生效状态（窄屏回落响应式默认） */
    let lastWide = sizeEnabled();
    window.addEventListener('resize', () => {
      if (sizeEnabled() === lastWide) return;
      lastWide = sizeEnabled();
      applyAllSizes();
    });

    App.onEnter(load);
  }

  init();
  return { load };
})();
