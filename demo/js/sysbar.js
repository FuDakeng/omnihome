/* ============================================================
   OmniDesk · 仪表盘系统监控横条（天气横条右侧）
   指标：CPU / 温度 / GPU / 内存 / 存储（已用/总量）/
         硬盘读写（写入与读取并列）/ 网络收发（上传与下载并列）。
   横条上不写文字标题，用图标区分；名称在 tooltip 与 aria-label 里。
   勾选与天气横条一样写入账号偏好；未勾选的不渲染。
   窄宽时从右往左收起，避免换行，也避免盖住右侧布局按钮。
   传感器缺失时显示「—」，不抛错、不显示 NaN。
   ============================================================ */
(() => {
  /* 展示分组。parts 里的 key 仍是账号偏好里的原子字段，服务端白名单不变。 */
  const GROUPS = [
    { key: 'cpu', label: 'CPU 利用率', icon: 'i-cpu', kind: 'pct', parts: ['cpu'] },
    { key: 'cpuTemp', label: 'CPU 温度', icon: 'i-thermo', kind: 'pct', parts: ['cpuTemp'] },
    { key: 'gpu', label: 'GPU 利用率', icon: 'i-gpu', kind: 'pct', parts: ['gpu'] },
    { key: 'mem', label: '内存使用率', icon: 'i-mem', kind: 'pct', parts: ['mem'] },
    { key: 'disk', label: '存储', icon: 'i-hdd', kind: 'cap', parts: ['disk'] },
    { key: 'diskIo', label: '硬盘读写', icon: 'i-diskio', kind: 'pair', parts: [
      { key: 'diskWrite', label: '写入', dir: 'right' },
      { key: 'diskRead', label: '读取', dir: 'left' },
    ]},
    { key: 'net', label: '网络收发', icon: 'i-swap', kind: 'pair', parts: [
      { key: 'netUp', label: '上传', dir: 'up' },
      { key: 'netDown', label: '下载', dir: 'down' },
    ]},
  ];
  const ORDER = ['cpu', 'cpuTemp', 'gpu', 'mem', 'disk', 'diskWrite', 'diskRead', 'netUp', 'netDown'];
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
  const partKeys = g => g.parts.map(p => (typeof p === 'string' ? p : p.key));
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
  /* 容量：与监控页 fmtCap 同一档（≥1 TB 用 TB，否则 GB）。不足 1 GB 再降到 MB / KB / B。
     整数不带多余小数，所以 4 TB 不会写成 4.0 TB。 */
  function trimFixed(v, digits){
    if (digits <= 0) return String(Math.round(v));
    return v.toFixed(digits).replace(/\.0$/, '');
  }
  function fmtCap(bytes){
    const n = finite(bytes);
    if (n == null || n < 0) return null;
    if (n === 0) return '0 GB';
    const tb = n / 1099511627776;
    if (tb >= 1) return trimFixed(tb, 1) + ' TB';
    const gb = n / 1073741824;
    if (gb >= 1) return (gb >= 10 ? trimFixed(gb, 0) : trimFixed(gb, 1)) + ' GB';
    const mb = n / 1048576;
    if (mb >= 1) return (mb >= 10 ? trimFixed(mb, 0) : trimFixed(mb, 1)) + ' MB';
    const kb = n / 1024;
    if (kb >= 1) return (kb >= 10 ? trimFixed(kb, 0) : trimFixed(kb, 1)) + ' KB';
    return Math.round(n) + ' B';
  }
  function diskCap(d){
    if (!d) return null;
    const used = fmtCap(d.diskUsedBytes);
    const total = fmtCap(d.diskTotalBytes);
    if (used == null || total == null) return null;
    return { used, total, text: used + ' / ' + total };
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
      case 'diskWrite': return fmtRate(d.diskWrite);
      case 'diskRead': return fmtRate(d.diskRead);
      case 'netUp': return fmtRate(d.netUp);
      case 'netDown': return fmtRate(d.netDown);
      default: return null;
    }
  }

  function visibleGroups(){
    const sel = new Set(fields());
    return GROUPS.filter(g => partKeys(g).some(k => sel.has(k)));
  }
  function typeIcon(id){
    return `<svg class="ic sys-m-ic" aria-hidden="true"><use href="#${id}"/></svg>`;
  }
  function dirIcon(dir){
    const paths = {
      up: 'M6 10V2M3.2 4.7 6 2l2.8 2.7',
      down: 'M6 2v8M3.2 7.3 6 10l2.8-2.7',
      right: 'M2 6h8M7.3 3.2 10 6 7.3 8.8',
      left: 'M10 6H2M4.7 3.2 2 6l2.7 2.8',
    };
    return `<svg class="sys-m-dir" viewBox="0 0 12 12" aria-hidden="true"><path d="${paths[dir] || paths.up}"/></svg>`;
  }
  function slotHtml(){
    return '<span class="sys-m-slot"><span class="sys-m-track" aria-hidden="true"><span class="sys-m-fill"></span></span><b class="sys-m-v num">—</b></span>';
  }
  function renderGroup(g){
    const icon = typeIcon(g.icon);
    if (g.kind === 'pair'){
      const sides = g.parts.map(p =>
        `<span class="sys-m-side" data-part="${p.key}">${dirIcon(p.dir)}${slotHtml()}</span>`
      ).join('');
      return `<span class="sys-m is-pair" role="group" data-k="${g.key}">${icon}${sides}</span>`;
    }
    if (g.kind === 'cap'){
      return `<span class="sys-m is-cap" role="group" data-k="${g.key}">${icon}<span class="sys-m-cap"><span class="sys-m-track" aria-hidden="true"><span class="sys-m-fill"></span></span><b class="sys-m-v num" data-part="used">—</b><span class="sys-m-slash" aria-hidden="true">/</span><b class="sys-m-v num" data-part="total">—</b></span></span>`;
    }
    return `<span class="sys-m is-pct" role="group" data-k="${g.key}">${icon}${slotHtml()}</span>`;
  }
  function setTip(el, text){
    if (!el) return;
    el.title = text;
    el.setAttribute('aria-label', text);
  }
  function setFill(root, key){
    const fill = root && root.querySelector('.sys-m-fill');
    if (!fill) return;
    const ratio = fillRatio(key, last);
    fill.style.width = (ratio == null ? 0 : ratio) + '%';
  }

  function renderMetrics(){
    const row = $('#sysMetrics');
    if (!row) return;
    const groups = visibleGroups();
    const key = groups.map(g => g.key).join(',');
    if (row.dataset.key !== key){
      row.dataset.key = key;
      row.innerHTML = groups.map(renderGroup).join('')
        + '<span class="sys-more" id="sysMore" hidden>…</span>';
    }
    const bits = [];
    groups.forEach(g => {
      const el = row.querySelector(`.sys-m[data-k="${g.key}"]`);
      if (!el) return;
      if (g.kind === 'pair'){
        const parts = [];
        let any = false;
        g.parts.forEach(p => {
          const side = el.querySelector(`.sys-m-side[data-part="${p.key}"]`);
          if (!side) return;
          const text = valueOf(p.key, last);
          const miss = text == null;
          if (!miss) any = true;
          const shown = miss ? '—' : text;
          const v = side.querySelector('.sys-m-v');
          if (v) v.textContent = shown;
          side.classList.toggle('is-miss', miss);
          setTip(side, p.label + (miss ? ' · 暂无数据' : ' ' + shown));
          setFill(side, p.key);
          parts.push(p.label + ' ' + shown);
        });
        el.classList.toggle('is-miss', !any);
        const summary = g.label + ' · ' + parts.join(' · ');
        setTip(el, summary);
        bits.push(summary);
        return;
      }
      if (g.kind === 'cap'){
        const cap = diskCap(last);
        const miss = cap == null;
        const usedEl = el.querySelector('[data-part="used"]');
        const totalEl = el.querySelector('[data-part="total"]');
        if (usedEl) usedEl.textContent = miss ? '—' : cap.used;
        if (totalEl) totalEl.textContent = miss ? '—' : cap.total;
        el.classList.toggle('is-miss', miss);
        setFill(el, 'disk');
        const summary = g.label + (miss ? ' · 暂无数据' : ' ' + cap.text);
        setTip(el, summary);
        bits.push(summary);
        return;
      }
      const k = partKeys(g)[0];
      const text = valueOf(k, last);
      const miss = text == null;
      el.classList.toggle('is-miss', miss);
      const v = el.querySelector('.sys-m-v');
      if (v) v.textContent = miss ? '—' : text;
      setFill(el, k);
      const summary = g.label + (miss ? ' · 暂无数据' : ' ' + text);
      setTip(el, summary);
      bits.push(summary);
    });
    const strip = $('#sysStrip');
    if (strip) strip.title = bits.join(' · ');
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
    box.innerHTML = GROUPS.map(g => {
      const on = partKeys(g).some(k => sel.has(k));
      return `<label class="tag-opt"><input type="checkbox" value="${g.key}" ${on ? 'checked' : ''}>
      <span>${g.label}</span></label>`;
    }).join('');
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
    const group = GROUPS.find(g => g.key === cb.value);
    const keys = group ? partKeys(group) : [];
    const set = new Set(fields());
    keys.forEach(k => { if (cb.checked) set.add(k); else set.delete(k); });
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
