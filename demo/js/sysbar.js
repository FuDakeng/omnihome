/* ============================================================
   OmniDesk · 仪表盘系统监控横条（天气横条右侧）
   指标：CPU / 温度 / GPU / 内存 / 存储 / 磁盘读写 / 网络上下行。
   勾选与天气横条一样写入账号偏好；未勾选的不渲染。
   窄宽时从右往左收起，避免换行，也避免盖住右侧布局按钮。
   传感器缺失时显示「—」，不抛错、不显示 NaN。
   ============================================================ */
(() => {
  const FIELDS = [
    ['cpu', 'CPU 利用率', 'CPU'],
    ['cpuTemp', 'CPU 温度', '温度'],
    ['gpu', 'GPU 利用率', 'GPU'],
    ['mem', '内存使用率', '内存'],
    ['disk', '存储占用率', '存储'],
    ['diskWrite', '存储写入速度', '写入'],
    ['diskRead', '存储读取速度', '读取'],
    ['netUp', '网络上传速度', '上传'],
    ['netDown', '网络下载速度', '下载'],
  ];
  const ORDER = FIELDS.map(f => f[0]);
  const META = Object.fromEntries(FIELDS.map(([k, full, short]) => [k, { full, short }]));
  const DEFAULT_FIELDS = ORDER.slice();
  const POLL_MS = 2000;
  let timer = null;
  let last = null;
  let fitting = false;

  const prefs = () => (App.prefs && App.prefs.sysbar) || {};
  const fields = () => {
    const raw = prefs().fields;
    if (!Array.isArray(raw)) return DEFAULT_FIELDS.slice();
    const got = new Set(raw);
    return ORDER.filter(k => got.has(k));
  };
  const allowed = () => !!(App.user && App.user.role === 'admin' && App.user.monitorEnabled);
  const onDash = () => (document.body.dataset.view || 'dashboard') === 'dashboard';

  function finite(v){
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function trimNum(n){
    if (n >= 100) return String(Math.round(n));
    const digits = n >= 10 ? 1 : 2;
    return String(Math.round(n * (10 ** digits)) / (10 ** digits));
  }
  function fmtPct(v){
    const n = finite(v);
    if (n == null || n < 0 || n > 100) return null;
    return trimNum(n) + '%';
  }
  function fmtTemp(v){
    const n = finite(v);
    if (n == null || n < -40 || n > 125) return null;
    return Math.round(n) + '℃';
  }
  /* 入参为 MB/s。不足 1 MB/s 用 KB/s，达到 1024 用 GB/s。 */
  function fmtRate(v){
    const n = finite(v);
    if (n == null || n < 0) return null;
    if (n >= 1024) return trimNum(n / 1024) + ' GB/s';
    if (n >= 1) return trimNum(n) + ' MB/s';
    const kb = n * 1024;
    if (kb >= 0.05) return trimNum(kb) + ' KB/s';
    return '0 KB/s';
  }
  /* 只用于轨道填充宽度，不改变展示文案。百分比直接映射，温度按 0–100℃，速率按对数压到 0–100。 */
  function fillRatio(key, d){
    if (!d) return null;
    const gpu = d.gpu || {};
    let n = null;
    if (key === 'cpu') n = finite(d.cpu);
    else if (key === 'mem') n = finite(d.mem);
    else if (key === 'disk') n = finite(d.diskPercent);
    else if (key === 'gpu') n = gpu.available ? finite(gpu.util) : null;
    else if (key === 'cpuTemp') n = finite(d.cpuTemp);
    else if (key === 'diskRead') n = finite(d.diskRead);
    else if (key === 'diskWrite') n = finite(d.diskWrite);
    else if (key === 'netUp') n = finite(d.netUp);
    else if (key === 'netDown') n = finite(d.netDown);
    if (n == null || n < 0) return null;
    if (key === 'cpu' || key === 'mem' || key === 'disk' || key === 'gpu'){
      return n > 100 ? null : n;
    }
    if (key === 'cpuTemp') return Math.max(0, Math.min(100, n));
    if (n === 0) return 0;
    const kb = n * 1024;
    return Math.max(0, Math.min(100, Math.log10(kb + 1) / Math.log10(100 * 1024) * 100));
  }

  function valueOf(key, d){
    if (!d) return null;
    const gpu = d.gpu || {};
    switch (key){
      case 'cpu': return fmtPct(d.cpu);
      case 'cpuTemp': return fmtTemp(d.cpuTemp);
      case 'gpu': return (gpu.available ? fmtPct(gpu.util) : null);
      case 'mem': return fmtPct(d.mem);
      case 'disk': return fmtPct(d.diskPercent);
      case 'diskWrite': return fmtRate(d.diskWrite);
      case 'diskRead': return fmtRate(d.diskRead);
      case 'netUp': return fmtRate(d.netUp);
      case 'netDown': return fmtRate(d.netDown);
      default: return null;
    }
  }

  function renderMetrics(){
    const row = $('#sysMetrics');
    if (!row) return;
    const sel = fields();
    const key = sel.join(',');
    if (row.dataset.key !== key){
      row.dataset.key = key;
      row.innerHTML = sel.map(k => {
        const m = META[k];
        const kind = (k === 'diskWrite' || k === 'diskRead' || k === 'netUp' || k === 'netDown') ? 'is-rate' : 'is-pct';
        return `<span class="sys-m ${kind}" data-k="${k}"><span class="sys-m-k">${m.short}</span><span class="sys-m-slot"><span class="sys-m-track" aria-hidden="true"><span class="sys-m-fill"></span></span><b class="sys-m-v num">—</b></span></span>`;
      }).join('') + '<span class="sys-more" id="sysMore" hidden>…</span>';
    }
    sel.forEach(k => {
      const el = row.querySelector(`.sys-m[data-k="${k}"]`);
      if (!el) return;
      const text = valueOf(k, last);
      const miss = text == null;
      el.classList.toggle('is-miss', miss);
      const v = el.querySelector('.sys-m-v');
      if (v) v.textContent = miss ? '—' : text;
      const fill = el.querySelector('.sys-m-fill');
      if (fill){
        const ratio = fillRatio(k, last);
        fill.style.width = (ratio == null ? 0 : ratio) + '%';
      }
      el.title = META[k].full + (miss ? ' · 暂无数据' : ' ' + text);
    });
    const strip = $('#sysStrip');
    if (strip){
      const bits = sel.map(k => {
        const t = valueOf(k, last);
        return META[k].full + ' ' + (t == null ? '—' : t);
      });
      strip.title = bits.join(' · ');
    }
    fit();
  }

  /* 横条最多用到天气条右侧、布局按钮左侧的剩余宽度，从右往左收起。 */
  function fit(){
    if (fitting) return;
    const row = $('#sysMetrics');
    const strip = $('#sysStrip');
    const slot = document.querySelector('.vh-strips');
    const weather = $('#wxStrip');
    if (!row || !strip || !slot || strip.hidden || slot.clientWidth <= 0) return;
    fitting = true;
    try {
      const gap = parseFloat(getComputedStyle(slot).columnGap) || 0;
      const weatherW = weather ? weather.getBoundingClientRect().width : 0;
      const available = Math.max(40, Math.floor(slot.clientWidth - weatherW - gap));
      /* 外层不超过按钮左侧的剩余宽度；槽位本身已固定，不再按文案改 width */
      const cap = available + 'px';
      if (strip.style.maxWidth !== cap) strip.style.maxWidth = cap;
      if (strip.style.width) strip.style.width = '';
      const items = [...row.querySelectorAll('.sys-m')];
      const more = $('#sysMore');
      items.forEach(el => {
        el.hidden = false;
        el.classList.remove('is-clip');
      });
      if (more) more.hidden = true;
      /* 手机：指标在横条内横向滚动，不换行、不顶到下一行的按钮 */
      if (window.matchMedia('(max-width: 768px)').matches) return;
      const overflow = () => row.scrollWidth > row.clientWidth + 1;
      let guard = items.length + 2;
      while (guard-- && overflow()){
        const vis = items.filter(el => !el.hidden);
        if (vis.length > 1){
          vis[vis.length - 1].hidden = true;
          if (more) more.hidden = false;
          continue;
        }
        if (vis.length === 1){
          vis[0].classList.add('is-clip');
          if (more && !more.hidden && overflow()) more.hidden = true;
        }
        break;
      }
      if (more && !more.hidden){
        more.title = items.filter(el => el.hidden).map(el => el.title).filter(Boolean).join(' · ');
      }
    } finally {
      fitting = false;
    }
  }

  function renderFieldsList(){
    const box = $('#sysFieldsList');
    if (!box) return;
    const sel = new Set(fields());
    box.innerHTML = FIELDS.map(([k, label]) => `
      <label class="tag-opt"><input type="checkbox" value="${k}" ${sel.has(k) ? 'checked' : ''}>
      <span>${label}</span></label>`).join('');
  }

  function setVisible(on){
    const el = $('#sysStrip');
    if (el) el.hidden = !on;
    const head = document.querySelector('.view[data-view="dashboard"] > .view-head');
    if (head) head.classList.toggle('has-sysbar', !!on);
    if (on) requestAnimationFrame(() => requestAnimationFrame(fit));
  }

  function denied(msg){
    return msg.includes('系统监控未开启') || msg.includes('仅管理员');
  }

  async function load(){
    if (!allowed()) { setVisible(false); stop(); return; }
    try {
      const m = await API.get('/api/system/metrics');
      if (!m || typeof m !== 'object') return;
      last = m;
      renderMetrics();
    } catch (e) {
      const msg = (e && e.message) || '';
      if (denied(msg)) { setVisible(false); stop(); return; }
      renderMetrics();
    }
  }

  function stop(){
    clearInterval(timer);
    timer = null;
  }
  function start(){
    stop();
    if (!allowed()) { setVisible(false); return; }
    setVisible(true);
    renderMetrics();
    if (!onDash() || document.hidden) return;
    load();
    timer = setInterval(() => {
      if (!onDash() || document.hidden) return;
      load();
    }, POLL_MS);
  }

  function togglePop(){
    const pop = $('#sysFieldsPop');
    if (!pop) return;
    const open = pop.hidden;
    const wf = $('#wxFieldsPop');
    const wl = $('#wxLocPop');
    if (wf) wf.hidden = true;
    if (wl) wl.hidden = true;
    pop.hidden = !open;
    if (open) renderFieldsList();
  }

  const fieldsBtn = $('#sysFieldsBtn');
  const fieldsPop = $('#sysFieldsPop');
  const fieldsList = $('#sysFieldsList');
  if (fieldsBtn) fieldsBtn.addEventListener('click', e => { e.stopPropagation(); togglePop(); });
  if (fieldsPop) fieldsPop.addEventListener('click', e => e.stopPropagation());
  if (fieldsList) fieldsList.addEventListener('change', e => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    const set = new Set(fields());
    if (cb.checked) set.add(cb.value); else set.delete(cb.value);
    const nextFields = ORDER.filter(k => set.has(k));
    App.prefs.sysbar = Object.assign({}, prefs(), { fields: nextFields });
    API.put('/api/settings', { sysbar: { fields: nextFields } })
      .catch(err => showToast(err.message, 'err'));
    renderMetrics();
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('#sysStrip')){
      const pop = $('#sysFieldsPop');
      if (pop) pop.hidden = true;
    }
  });

  document.addEventListener('view-change', e => {
    if (e.detail === 'dashboard') start();
    else stop();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else if (onDash()) start();
  });
  document.addEventListener('monitor-gate', () => start());
  window.addEventListener('resize', () => fit());

  const addBtn = $('#dashAddBtn');
  const head = document.querySelector('.view[data-view="dashboard"] > .view-head');
  if (addBtn && head){
    const syncEdit = () => {
      head.classList.toggle('is-dash-editing', !addBtn.hidden);
      requestAnimationFrame(fit);
    };
    new MutationObserver(syncEdit).observe(addBtn, { attributes: true, attributeFilter: ['hidden'] });
    syncEdit();
  }
  const strips = document.querySelector('.vh-strips');
  if (window.ResizeObserver && strips){
    new ResizeObserver(() => fit()).observe(strips);
  }
  const actions = document.querySelector('.view[data-view="dashboard"] .vh-actions');
  if (window.ResizeObserver && actions){
    new ResizeObserver(() => fit()).observe(actions);
  }

  App.onEnter(() => start());
})();
