/* ============================================================
   OmniDesk · 系统监控（管理员专属 · 功能设置中开启）
   - 系统监控区：主机 CPU / GPU / 内存 / 网络 / 硬盘 曲线，3 秒轮询
   - Docker 监控区：容器筛选栏（多选 + 搜索）、合计指标卡、
     容器曲线（内存 / CPU / 上传 / 下载，默认占用最高前 5）、
     容器内存占比饼图（前 8 独立扇区 + 其他合并，悬浮高亮）、容器表格
   - 曲线图带图例、坐标轴刻度，鼠标悬浮显示数据点具体数值
   ============================================================ */
(() => {
  const RING = 163.4; // 2πr, r=26
  const MAX_POINTS = 120;
  const POLL_MS = 3000;      // 主机指标轮询
  const CT_POLL_MS = 5000;   // 容器指标轮询（后端已并行采集）
  let statTimer = null, metricTimer = null, ctTimer = null;
  let allowed = false;       // 管理员 && 功能开关开启
  let curView = 'dashboard';
  let lastStats = null;      // 最近一次主机摘要（容器卡换算占主机比例用）

  const STATUS = {
    running: ['运行中', 'success'], exited: ['已停止', 'danger'],
    paused: ['已暂停', 'warning'], restarting: ['重启中', 'warning'],
    created: ['已创建', ''], dead: ['异常', 'danger'],
  };

  const cssVar = n =>
    getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  /* ---------- 功能门控：仅管理员且开关开启时可见 ---------- */
  function applyGate(){
    allowed = !!(App.user && App.user.role === 'admin' && App.user.monitorEnabled);
    const nav = $('.nav-item[data-nav="monitor"]');
    if (nav) nav.hidden = !allowed;
    const widget = $('[data-widget="monitor"]');
    if (widget) widget.style.display = allowed ? '' : 'none';
    return allowed;
  }

  /* ---------- 摘要数据（仪表盘仪表 + 监控视图四卡） ---------- */
  function setGauge(circle, pct){
    const v = Math.max(0, Math.min(100, pct));
    circle.setAttribute('stroke-dasharray', `${(v / 100 * RING).toFixed(1)} ${RING}`);
    circle.classList.remove('ok', 'warn');
    if (v < 70) circle.classList.add('ok');
    else if (v < 90) circle.classList.add('warn');
  }
  function barCls(v){ return v < 70 ? 'ok' : v < 90 ? 'warn' : ''; }

  function renderHwCard(s){
    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text || '—';
    };
    set('monHwHost', s.host);
    set('monHwCpu', s.cpuName
      ? s.cpuName + (s.cpuCount ? ' · ' + s.cpuCount + ' 线程' : '')
      : (s.cpuCount ? s.cpuCount + ' 线程' : '—'));
    set('monHwGpu', s.gpuName || '未检测到');
    set('monHwOs', s.osName || s.platform);
    set('monHwMem', (s.memTotalGB != null)
      ? `${s.memUsedGB} / ${s.memTotalGB} GB（${s.mem}%）` : '—');
    const up = document.getElementById('monHwUp');
    if (up){
      up.textContent = s.uptime || '—';
      up.title = s.bootTime ? '开机于 ' + s.bootTime : '';
    }
  }

  async function loadStats(){
    if (!allowed) return;
    try {
      const s = await API.get('/api/system/stats');
      lastStats = s;
      /* 仪表盘摘要 */
      setGauge($('#dashCpuGauge'), s.cpu);
      $('#dashCpuNum').textContent = s.cpu + '%';
      $('#dashCpuLbl').textContent = `CPU · ${s.temp !== null && s.temp !== undefined ? s.temp + '°C' : s.cpuCount + ' 核'}`;
      setGauge($('#dashMemGauge'), s.mem);
      $('#dashMemNum').textContent = s.mem + '%';
      $('#dashMemLbl').textContent = `内存 · ${s.memUsedGB}/${s.memTotalGB} GB`;
      const diskPct = (s.disk == null || s.disk === '') ? null : s.disk;
      const scopeHint = s.storageScope === 'host' ? '全部硬盘合计' : '当前环境存储';
      setGauge($('#dashDiskGauge'), diskPct == null ? 0 : diskPct);
      $('#dashDiskNum').textContent = diskPct == null ? '—' : diskPct + '%';
      $('#dashDiskLbl').textContent = `存储 · ${s.diskUsedTB}/${s.diskTotalTB} TB`;
      $('#dashNet').textContent = `↓ ${s.netDownMbps} · ↑ ${s.netUpMbps} MB/s`;
      /* 监控视图四卡。存储总览用宿主全部真实卷合计，不再拿单块盘冒充根分区。 */
      $('#monCpuVal').innerHTML = s.cpu + '<small>%</small>';
      $('#monCpuSub').innerHTML = `<svg class="ic" style="width:11px;height:11px"><use href="#i-thermo"/></svg>` +
        (s.temp !== null && s.temp !== undefined
          ? `核心温度 ${s.temp}°C · ${s.cpuCount} 逻辑核心`
          : `温度 — · ${s.cpuCount} 逻辑核心`);
      $('#monMemVal').innerHTML = s.mem + '<small>%</small>';
      $('#monMemLbl').textContent = `内存 ${s.memUsedGB} / ${s.memTotalGB} GB`;
      $('#monDiskVal').innerHTML = diskPct == null ? '—' : diskPct + '<small>%</small>';
      $('#monDiskLbl').textContent = `存储 ${s.diskUsedTB} / ${s.diskTotalTB} TB`;
      const diskTempTxt = s.diskTemp !== null && s.diskTemp !== undefined
        ? `硬盘温度 ${s.diskTemp}°C（NVMe）` : '硬盘温度 —';
      $('#monDiskSub').textContent = `${diskTempTxt} · ${scopeHint}`;
      renderHwCard(s);
      /* 网络：以前显示的是累计字节、还把"实时上传"标成"累计下载"。
         现在是真速率 + 文案对应：主值 = 下载速率，副值 = 上传速率 */
      $('#monNetVal').innerHTML = (s.netDownMbps || 0).toFixed(1) + '<small>MB/s</small>';
      $('#monNetSub').innerHTML =
        `<span class="up">↑ ${(s.netUpMbps || 0).toFixed(1)} MB/s</span> · 当前上传速率`;
      /* 资源占用条 */
      [[s.cpu, $('#barCpu')], [s.mem, $('#barMem')], [diskPct, $('#barDisk')]].forEach(([v, box]) => {
        if (!box) return;
        const known = v != null && v !== '';
        const n = known ? v : 0;
        const fill = $('.bar-fill', box);
        fill.style.width = n + '%';
        fill.className = 'bar-fill ' + (known ? barCls(n) : '');
        $('.num', box.parentElement).textContent = known ? n + '%' : '—';
      });
      $('#monHost').textContent = `${s.host} · ${s.platform} · 开机于 ${s.bootTime}`;
    } catch (e) { /* 保持占位 */ }
  }

  /* ---------- 通用曲线引擎（坐标轴 / 网格 / 悬浮十字线） ---------- */
  const PAD_L = 46, PAD_R = 14, PAD_T = 12, PAD_B = 24;
  function niceMax(v){
    if (!(v > 0)) return 0;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }
  const fmtVal = (v, unit) => v == null ? '—'
    : (unit === '%' || unit === '°C' ? Math.round(v) : (Math.round(v * 100) / 100)) + ' ' + unit;
  const fmtClock = ts => {
    const d = new Date(ts), p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  /* o: { canvas, wrap, tip, samples, series, hover }
     series: [{ label, color, unit, get(sample), fmt?(v) }] */
  function drawLine(o){
    const { canvas, wrap, tip, samples, series } = o;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth, H = wrap.clientHeight || 230;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (samples.length < 2) return;

    const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
    const t0 = samples[0].ts, t1 = samples[samples.length - 1].ts;
    const x = ts => PAD_L + (ts - t0) / Math.max(t1 - t0, 1) * plotW;

    /* Y 轴：可见系列最大值取整刻度 */
    let maxV = 0;
    series.forEach(s => samples.forEach(p => {
      const v = s.get(p);
      if (v != null && v > maxV) maxV = v;
    }));
    const top = niceMax(maxV * 1.2) || niceMax(maxV) || 1;
    const y = v => PAD_T + (1 - v / top) * plotH;

    const gridC = cssVar('--om-border'), textC = cssVar('--om-text-3');
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++){
      const v = top * i / 4, yy = y(v);
      ctx.strokeStyle = gridC; ctx.lineWidth = 1;
      ctx.setLineDash(i === 0 ? [] : [3, 5]);
      ctx.beginPath(); ctx.moveTo(PAD_L, yy); ctx.lineTo(W - PAD_R, yy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = textC;
      ctx.fillText(String(Math.round(v * 100) / 100), PAD_L - 8, yy);
    }
    ctx.textBaseline = 'top';
    [[t0, 'left', PAD_L], [(t0 + t1) / 2, 'center', PAD_L + plotW / 2], [t1, 'right', W - PAD_R]]
      .forEach(([ts, align, xx]) => {
        ctx.textAlign = align; ctx.fillStyle = textC;
        ctx.fillText(fmtClock(ts), xx, H - PAD_B + 8);
      });

    /* 曲线（无数据的点断开） */
    series.forEach(s => {
      ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.lineJoin = 'round';
      ctx.beginPath();
      let pen = false;
      samples.forEach(p => {
        const v = s.get(p);
        if (v == null){ pen = false; return; }
        const px = x(p.ts), py = y(Math.min(v, top));
        if (pen) ctx.lineTo(px, py); else { ctx.moveTo(px, py); pen = true; }
      });
      ctx.stroke();
    });

    /* 悬浮十字线 + 数据点 + 提示框 */
    if (o.hover != null && samples[o.hover]){
      const p = samples[o.hover], hx = x(p.ts);
      ctx.strokeStyle = textC; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(hx, PAD_T); ctx.lineTo(hx, H - PAD_B); ctx.stroke();
      ctx.setLineDash([]);
      series.forEach(s => {
        const v = s.get(p);
        if (v == null) return;
        ctx.fillStyle = s.color;
        ctx.beginPath(); ctx.arc(hx, y(Math.min(v, top)), 3.5, 0, Math.PI * 2); ctx.fill();
      });
      tip.innerHTML = `<div class="res-tip-t num">${fmtClock(p.ts)}</div>` +
        series.map(s => {
          const v = s.get(p);
          const txt = v == null ? '—' : (s.fmt ? s.fmt(v) : fmtVal(v, s.unit));
          return `<div class="res-tip-r"><i style="background:${s.color}"></i>${App.esc(s.label)}
            <b class="num">${txt}</b></div>`;
        }).join('');
      tip.hidden = false;
      const tw = tip.offsetWidth || 140;
      tip.style.left = (hx + 14 + tw > W ? Math.max(hx - tw - 14, 4) : hx + 14) + 'px';
      tip.style.top = PAD_T + 'px';
    } else {
      tip.hidden = true;
    }
  }

  /* 悬浮：按 X 坐标吸附最近采样点 */
  function bindHover(canvas, wrap, getLen, setHover){
    const onPoint = e => {
      const len = getLen();
      if (len < 2) return;
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX != null ? e.clientX : (e.touches && e.touches[0].clientX)) - rect.left;
      const plotW = wrap.clientWidth - PAD_L - PAD_R;
      const idx = Math.round((x - PAD_L) / Math.max(plotW, 1) * (len - 1));
      setHover(Math.max(0, Math.min(len - 1, idx)));
    };
    canvas.addEventListener('mousemove', onPoint);
    canvas.addEventListener('pointermove', onPoint);
    canvas.addEventListener('mouseleave', () => setHover(null));
    canvas.addEventListener('pointerleave', () => setHover(null));
  }

  /* ---------- 系统监控区：主机资源曲线 ---------- */
  /* 系列定义：k 唯一键、colorVar 主题色变量、get 从采样点取值（null = 断开） */
  const TAB_DEFS = {
    cpu: { empty: '暂无 CPU 数据', series: [
      { k: 'cpu', label: '利用率', colorVar: '--om-primary', unit: '%', get: s => s.cpu },
      { k: 'cpuTemp', label: '温度', colorVar: '--om-warning', unit: '°C', get: s => s.cpuTemp },
    ]},
    gpu: { empty: '未检测到可监控的 GPU（NVIDIA / Intel / AMD）', series: [
      { k: 'gpuUtil', label: '利用率', colorVar: '--om-success', unit: '%', get: s => s.gpuUtil },
      { k: 'gpuTemp', label: '温度', colorVar: '--om-danger', unit: '°C', get: s => s.gpuTemp },
    ]},
    mem: { empty: '暂无内存数据', series: [
      { k: 'mem', label: '利用率', colorVar: '--om-info', unit: '%', get: s => s.mem },
    ]},
    net: { empty: '暂无网络数据', series: [
      { k: 'netDown', label: '下载', colorVar: '--om-primary', unit: 'MB/s', get: s => s.netDown },
      { k: 'netUp', label: '上传', colorVar: '--om-info', unit: 'MB/s', get: s => s.netUp },
    ]},
    disk: { empty: '暂无硬盘 IO 数据', series: [
      { k: 'read', label: '读取', colorVar: '--om-success', unit: 'MB/s',
        get: s => (s.disks.find(d => d.name === resState.disk) || {}).read ?? null },
      { k: 'write', label: '写入', colorVar: '--om-warning', unit: 'MB/s',
        get: s => (s.disks.find(d => d.name === resState.disk) || {}).write ?? null },
      { k: 'diskTemp', label: '温度', colorVar: '--om-danger', unit: '°C', get: s => s.diskTemp },
    ]},
  };

  const resState = { tab: 'cpu', disk: '', on: {}, hover: null };
  const samples = [];
  Object.keys(TAB_DEFS).forEach(t => {
    resState.on[t] = new Set(TAB_DEFS[t].series.map(s => s.k));
  });

  async function pollMetrics(){
    if (!allowed) return;
    try {
      const m = await API.get('/api/system/metrics');
      samples.push({
        ts: Date.now(), cpu: m.cpu, cpuTemp: m.cpuTemp, mem: m.mem,
        netDown: m.netDown, netUp: m.netUp, diskTemp: m.diskTemp,
        gpuUtil: m.gpu && m.gpu.available ? m.gpu.util : null,
        gpuTemp: m.gpu && m.gpu.available ? m.gpu.temp : null,
        gpuName: m.gpu && m.gpu.available ? (m.gpu.name || '') : '',
        gpuSource: m.gpu && m.gpu.available ? (m.gpu.source || '') : '',
        disks: m.disks || [],
      });
      if (samples.length > MAX_POINTS) samples.shift();
      syncDiskSelect(m.disks || []);
      if (curView === 'monitor') drawResChart();
    } catch (e) { /* 轮询失败静默，下个周期重试 */ }
  }

  /* 多硬盘：填充选择器并记住选中盘 */
  function syncDiskSelect(disks){
    const sel = $('#resDiskSel');
    if (!disks.length){ sel.hidden = true; return; }
    if (!resState.disk || !disks.some(d => d.name === resState.disk)) resState.disk = disks[0].name;
    const names = disks.map(d => d.name);
    if (sel.dataset.joined !== names.join(',')){
      sel.dataset.joined = names.join(',');
      sel.innerHTML = names.map(n => `<option value="${App.esc(n)}">${App.esc(n)}</option>`).join('');
    }
    sel.value = resState.disk;
    sel.hidden = names.length < 2 || resState.tab !== 'disk';
  }
  $('#resDiskSel').addEventListener('change', e => {
    resState.disk = e.target.value;
    drawResChart();
  });

  /* 图例（可勾选显隐的系列列表） */
  function renderResChips(){
    const def = TAB_DEFS[resState.tab];
    $('#resSeries').innerHTML = def.series.map(s => `
      <label class="res-ser-item ${resState.on[resState.tab].has(s.k) ? 'on' : ''}" data-ser="${s.k}">
        <i style="background:var(${s.colorVar})"></i>${s.label}
      </label>`).join('') +
      `<span class="res-ser-hint">采样间隔 3 秒 · 近 ${Math.round(MAX_POINTS * POLL_MS / 60000)} 分钟</span>`;
  }
  $('#resSeries').addEventListener('click', e => {
    const chip = e.target.closest('[data-ser]');
    if (!chip) return;
    const k = chip.dataset.ser;
    if (resState.on[resState.tab].has(k)) resState.on[resState.tab].delete(k);
    else resState.on[resState.tab].add(k);
    renderResChips();
    drawResChart();
  });

  $('#resTabs').addEventListener('click', e => {
    const btn = e.target.closest('[data-res]');
    if (!btn || btn.dataset.res === resState.tab) return;
    resState.tab = btn.dataset.res;
    resState.hover = null;
    $$('#resTabs .res-tab').forEach(b => b.classList.toggle('active', b === btn));
    $('#resDiskSel').hidden = resState.tab !== 'disk' || $('#resDiskSel').dataset.joined?.split(',').length < 2;
    renderResChips();
    drawResChart();
  });

  function showResEmpty(text){
    const empty = $('#resEmpty');
    empty.hidden = false; empty.textContent = text;
    $('#resTip').hidden = true;
  }
  function drawResChart(){
    const def = TAB_DEFS[resState.tab];
    const series = def.series
      .filter(s => resState.on[resState.tab].has(s.k))
      .map(s => ({ label: s.label, color: cssVar(s.colorVar), unit: s.unit, get: s.get }));
    if (samples.length < 2){
      showResEmpty(samples.length ? '数据采集中…' : def.empty); return;
    }
    if (resState.tab === 'gpu' && samples.every(s => s.gpuUtil == null)){
      showResEmpty(def.empty); return;
    }
    $('#resEmpty').hidden = true;
    drawLine({ canvas: $('#resChart'), wrap: $('#resChartWrap'), tip: $('#resTip'),
               samples, series, hover: resState.hover });
  }
  bindHover($('#resChart'), $('#resChartWrap'), () => samples.length,
    i => { resState.hover = i; drawResChart(); });

  /* ---------- Docker 监控区 ---------- */
  let ctAll = [];
  let ctSel = null;          // null = 全部容器；Set = 明确勾选的 id
  let ctQuery = '';
  const ctSort = { key: 'name', dir: 1 };
  const ctHist = [];         // [{ ts, items: { id: {name, cpu, memMB, up, down} } }]
  let ctTabK = 'mem';
  let ctHover = null;
  const ctColorIdx = new Map();
  let ctColorNext = 0;
  const PALETTE_VARS = ['--om-primary', '--om-info', '--om-success', '--om-warning', '--om-danger'];
  const PALETTE_HEX = ['#a855f7', '#ec4899', '#14b8a6', '#f97316'];
  const ctColorOf = id => {
    if (!ctColorIdx.has(id)) ctColorIdx.set(id, ctColorNext++);
    const i = ctColorIdx.get(id);
    return i < PALETTE_VARS.length ? cssVar(PALETTE_VARS[i])
      : PALETTE_HEX[(i - PALETTE_VARS.length) % PALETTE_HEX.length];
  };

  /* 容器曲线四类指标：取值 / 排序 / 悬浮提示格式 */
  const CT_METRICS = {
    mem:  { label: '内存', field: 'memMB', get: c => c.memMB, fmt: v => Math.round(v) + ' MB' },
    cpu:  { label: 'CPU', field: 'cpu', get: c => c.cpu, fmt: v => Math.round(v) + '%' },
    up:   { label: '上传', field: 'up', get: c => c.netUpKBps, fmt: v => fmtKBps(v) || '0 KB/s' },
    down: { label: '下载', field: 'down', get: c => c.netDownKBps, fmt: v => fmtKBps(v) || '0 KB/s' },
  };

  function fmtKBps(v){
    if (!v) return null;
    return v >= 1024 ? (v / 1024).toFixed(1) + ' MB/s' : v.toFixed(1) + ' KB/s';
  }
  function fmtMemSum(mb){
    return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : Math.round(mb) + ' MB';
  }

  /* 筛选栏生效后的容器集合：多选 ∩ 搜索词 */
  function ctEffective(){
    return ctAll.filter(c =>
      (ctSel === null || ctSel.has(c.id)) &&
      (!ctQuery || (c.name + ' ' + c.image).toLowerCase().includes(ctQuery)));
  }
  function ctSortVal(c, key){
    switch (key){
      case 'name': return (c.name || '').toLowerCase();
      case 'status': return c.status;
      case 'cpu': return c.cpu;
      case 'memMB': return c.memMB;
      case 'net': return (c.netDownKBps || 0) + (c.netUpKBps || 0);
      case 'upSecs': return c.upSecs || 0;
      default: return 0;
    }
  }

  async function loadContainers(){
    if (!allowed) return;
    try {
      const d = await API.get('/api/system/containers');
      if (!d.available){
        ctAll = [];
        $('#containerRows').innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--om-text-3);padding:28px">
          ${App.esc(d.hint || 'Docker 不可用')}</td></tr>`;
        $('#qkContainers').innerHTML = '';
        $('#monRunning').textContent = 'Docker 未连接';
        $('#dashContainerChip').textContent = '';
        renderCtCards(); renderCtFilter(); drawCtChart(); renderCtPie();
        return;
      }
      ctAll = d.containers;
      pushCtHist();
      const running = ctAll.filter(c => c.status === 'running');
      $('#monRunning').textContent = running.length + ' 运行中';
      $('#dashContainerChip').textContent = running.length + ' 容器运行中';
      renderCtFilter();
      renderCtCards();
      renderCtTable();
      drawCtChart();
      renderCtPie();
      /* 仪表盘容器速览（前 4 个运行中容器） */
      $('#qkContainers').innerHTML = running.slice(0, 4).map(c => `
        <div class="qk-row"><span class="qk-name">${App.esc(c.name)}</span>
          <span class="chip success">运行中</span>
          <div class="mini-bar" style="margin-left:auto"><div class="bar">
            <div class="bar-fill ${barCls(c.cpu)}" style="width:${Math.min(c.cpu, 100)}%"></div></div></div>
          <span class="num text-faint" style="width:34px;text-align:right">${c.cpu}%</span>
        </div>`).join('') ||
        '<div style="font-size:12px;color:var(--om-text-3)">暂无运行中的容器</div>';
    } catch (e) { /* 保持占位 */ }
  }

  /* 容器曲线历史：仅运行中容器入库，已停止容器曲线自然断开 */
  function pushCtHist(){
    const items = {};
    ctAll.forEach(c => {
      if (c.status !== 'running') return;
      items[c.id] = { name: c.name, cpu: c.cpu, memMB: c.memMB,
                      up: c.netUpKBps, down: c.netDownKBps };
    });
    ctHist.push({ ts: Date.now(), items });
    if (ctHist.length > MAX_POINTS) ctHist.shift();
  }

  /* ---------- 筛选栏：容器多选下拉 + 搜索 ---------- */
  function renderCtFilter(){
    /* 下拉列表（保留当前勾选状态） */
    $('#ctFilterList').innerHTML = ctAll.length ? ctAll.map(c => `
      <label class="ct-f-item">
        <input type="checkbox" data-cid="${c.id}" ${ctSel === null || ctSel.has(c.id) ? 'checked' : ''}>
        <span class="ct-f-dot ${c.status === 'running' ? 'run' : ''}"></span>
        <span class="ct-f-name">${App.esc(c.name)}<i>${App.esc(c.image)}</i></span>
      </label>`).join('')
      : '<div style="font-size:12px;color:var(--om-text-3);padding:8px">暂无容器</div>';
    /* 计数角标与结果提示 */
    const count = $('#ctFilterCount');
    count.hidden = ctSel === null;
    count.textContent = ctSel ? ctSel.size : '';
    const eff = ctEffective();
    $('#ctFilterHint').textContent = !ctAll.length ? 'Docker 未连接'
      : (ctSel === null && !ctQuery) ? '显示全部容器'
      : `筛选后 ${eff.length} / ${ctAll.length} 个容器`;
  }

  $('#ctFilterBtn').addEventListener('click', () => {
    const panel = $('#ctFilterPanel');
    panel.hidden = !panel.hidden;
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('#ctFilterPanel') && !e.target.closest('#ctFilterBtn'))
      $('#ctFilterPanel').hidden = true;
  });
  $('#ctSelAll').addEventListener('click', () => { ctSel = null; renderCtFilter(); renderDockerView(); });
  $('#ctSelNone').addEventListener('click', () => { ctSel = new Set(); renderCtFilter(); renderDockerView(); });
  $('#ctFilterList').addEventListener('change', () => {
    const checked = $$('#ctFilterList input:checked').map(i => i.dataset.cid);
    ctSel = checked.length === ctAll.length ? null : new Set(checked);
    renderCtFilter();
    renderDockerView();
  });
  $('#ctSearch').addEventListener('input', e => {
    ctQuery = e.target.value.trim().toLowerCase();
    renderCtFilter();
    renderDockerView();
  });

  /* ---------- 合计指标卡（跟随筛选） ---------- */
  function renderCtCards(){
    const eff = ctEffective();
    const n = eff.length;
    const sumCpu = eff.reduce((a, c) => a + (c.cpu || 0), 0);
    const sumMem = eff.reduce((a, c) => a + (c.memMB || 0), 0);
    const sumUp = eff.reduce((a, c) => a + (c.netUpKBps || 0), 0);
    const sumDown = eff.reduce((a, c) => a + (c.netDownKBps || 0), 0);
    $('#dcCpuVal').innerHTML = n ? sumCpu + '<small>%</small>' : '--<small>%</small>';
    $('#dcCpuSub').textContent = n ? `${n} 个容器合计` : '无匹配容器';
    $('#dcMemVal').textContent = n ? fmtMemSum(sumMem) : '--';
    const hostGB = lastStats && lastStats.memTotalGB;
    $('#dcMemSub').textContent = n
      ? `${n} 个容器合计` + (hostGB ? ` · 占主机 ${(sumMem / 1024 / hostGB * 100).toFixed(1)}%` : '')
      : '无匹配容器';
    $('#dcUpVal').textContent = n ? (fmtKBps(sumUp) || '0 KB/s') : '--';
    $('#dcUpSub').textContent = n ? `${n} 个容器实时合计` : '无匹配容器';
    $('#dcDownVal').textContent = n ? (fmtKBps(sumDown) || '0 KB/s') : '--';
    $('#dcDownSub').textContent = n ? `${n} 个容器实时合计` : '无匹配容器';
  }

  /* ---------- 容器表格（跟随筛选，表头排序） ---------- */
  function renderCtTable(){
    const list = ctEffective().sort((a, b) => {
      const va = ctSortVal(a, ctSort.key), vb = ctSortVal(b, ctSort.key);
      return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * ctSort.dir;
    });
    $$('.ct-tbl thead th[data-sort]').forEach(th => {
      th.dataset.dir = th.dataset.sort === ctSort.key ? (ctSort.dir > 0 ? 'asc' : 'desc') : '';
    });
    if (!list.length){
      $('#containerRows').innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--om-text-3);padding:28px">
        ${ctQuery || ctSel !== null ? '没有符合筛选条件的容器' : '暂无容器'}</td></tr>`;
      return;
    }
    $('#containerRows').innerHTML = list.map(c => {
      const [label, cls] = STATUS[c.status] || [c.status, ''];
      const dn = fmtKBps(c.netDownKBps), up = fmtKBps(c.netUpKBps);
      return `<tr>
        <td><div class="cell-name"><svg class="ic"><use href="#i-box"/></svg>${App.esc(c.name)}
          <div class="cell-sub">${App.esc(c.image)}</div></div></td>
        <td><span class="chip ${cls}">${label}</span></td>
        <td><span class="cell-sub num">${c.cpu}%</span>
          <div class="mini-bar"><div class="bar"><div class="bar-fill ${barCls(c.cpu)}" style="width:${Math.min(c.cpu, 100)}%"></div></div></div></td>
        <td class="num">${c.memMB ? c.memMB + ' MB' + (c.memPct ? ` <span class="text-faint">(${c.memPct}%)</span>` : '') : '—'}</td>
        <td class="num text-muted">${dn || up ? `↓ ${dn || '0 KB/s'} · ↑ ${up || '0 KB/s'}` : '—'}</td>
        <td class="num text-muted">${App.esc(c.started)}</td>
        <td><div class="row-actions">
          ${c.status === 'running'
            ? `<button class="ct-row-btn" data-c-act="restart" data-cid="${c.id}" title="重启该容器"><svg class="ic"><use href="#i-refresh"/></svg>重启</button>
               <button class="ct-row-btn danger" data-c-act="stop" data-cid="${c.id}" title="停止该容器"><svg class="ic"><use href="#i-close"/></svg>停止</button>`
            : `<button class="ct-row-btn primary" data-c-act="start" data-cid="${c.id}" title="启动该容器"><svg class="ic"><use href="#i-zap"/></svg>启动</button>`}
        </div></td>
      </tr>`;
    }).join('');
  }
  $('.ct-tbl thead').addEventListener('click', e => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const key = th.dataset.sort;
    if (ctSort.key === key) ctSort.dir *= -1;
    else { ctSort.key = key; ctSort.dir = key === 'name' ? 1 : -1; }
    renderCtTable();
  });

  /* ---------- 容器内存占比饼图（跟随筛选） ---------- */
  const CT_PIE_MAX = 8;        // 最多独立扇区，其余归入「其他」
  const CT_PIE_R = 54;         // 圆环半径（viewBox 140×140）
  const CT_PIE_C = 2 * Math.PI * CT_PIE_R;
  let ctPieData = [];          // [{ id, name, mb, color }]
  let ctPieHover = null;       // 当前悬浮的扇区序号：轮询重绘后用于恢复高亮

  function setPieCenter(main, sub){
    $('#ctPieTotal').textContent = main;
    $('#ctPieTLabel').textContent = sub;
  }
  function pieTotal(){
    return ctPieData.reduce((a, d) => a + d.mb, 0);
  }
  /* 悬浮：高亮对应扇区，圆心改为显示该容器明细；离开还原合计 */
  function pieHover(i){
    ctPieHover = i;
    $$('#ctPieSegs .ct-pie-seg').forEach((el, k) => {
      el.classList.toggle('hot', i !== null && k === i);
      el.classList.toggle('dim', i !== null && k !== i);
    });
    $$('#ctPieLegend .ct-pie-item').forEach((el, k) =>
      el.classList.toggle('hot', i !== null && k === i));
    if (i === null || !ctPieData[i]){
      setPieCenter(fmtMemSum(pieTotal()), '合计占用');
      return;
    }
    const d = ctPieData[i], total = pieTotal();
    setPieCenter(fmtMemSum(d.mb),
      `${d.name} · ${total ? (d.mb / total * 100).toFixed(1) : 0}%`);
  }
  /* 移到卡片空白处（非扇区 / 非图例）时同样复位，避免高亮残留 */
  $('#ctPieCard').addEventListener('mouseover', e => {
    const t = e.target.closest('[data-pie]');
    pieHover(t ? +t.dataset.pie : null);
  });
  $('#ctPieCard').addEventListener('mouseleave', () => pieHover(null));

  function renderCtPie(){
    const segs = $('#ctPieSegs'), legend = $('#ctPieLegend');
    const list = ctEffective().filter(c => c.memMB > 0)
      .sort((a, b) => b.memMB - a.memMB);
    if (!list.length){
      ctPieData = [];
      ctPieHover = null;
      segs.innerHTML = '';
      legend.innerHTML = '<div class="ct-pie-empty">暂无内存占用数据</div>';
      $('#ctPieHint').textContent = '—';
      setPieCenter('--', '暂无数据');
      return;
    }
    const total = list.reduce((a, c) => a + c.memMB, 0);
    const data = list.slice(0, CT_PIE_MAX).map(c => ({
      id: c.id, name: c.name, mb: c.memMB, color: ctColorOf(c.id),
    }));
    const rest = list.slice(CT_PIE_MAX);
    if (rest.length){
      data.push({ id: '__rest__', name: `其他 ${rest.length} 个容器`,
                  mb: rest.reduce((a, c) => a + c.memMB, 0),
                  color: cssVar('--om-text-3') });
    }
    ctPieData = data;

    let acc = 0;
    segs.innerHTML = data.map((d, i) => {
      const frac = d.mb / total;
      const dash = (frac * CT_PIE_C).toFixed(2);
      /* 描边色走内联 style：主题色是 hsl(var(...)) 形式，CSS 解析器比属性解析更稳 */
      const seg = `<circle class="ct-pie-seg" data-pie="${i}" cx="70" cy="70" r="${CT_PIE_R}" style="stroke:${d.color}" stroke-dasharray="${dash} ${(CT_PIE_C - frac * CT_PIE_C).toFixed(2)}" stroke-dashoffset="${(-acc * CT_PIE_C).toFixed(2)}"></circle>`;
      acc += frac;
      return seg;
    }).join('');

    legend.innerHTML = data.map((d, i) => `
      <div class="ct-pie-item" data-pie="${i}">
        <i style="background:${d.color}"></i>
        <span class="nm" title="${App.esc(d.name)}">${App.esc(d.name)}</span>
        <span class="vl num">${(d.mb / total * 100).toFixed(1)}% · ${fmtMemSum(d.mb)}</span>
      </div>`).join('');

    $('#ctPieHint').textContent = `${list.length} 个 · ${fmtMemSum(total)}`;
    /* 重绘会重建扇区与图例节点，需恢复此前的悬浮高亮，否则每 5 秒被冲掉一次 */
    if (ctPieHover != null) pieHover(ctPieHover);
    else setPieCenter(fmtMemSum(total), '合计占用');
  }

  /* ---------- 容器曲线（默认占用最高前 5，跟随筛选） ---------- */
  function ctTop5(){
    const m = CT_METRICS[ctTabK];
    return ctEffective().filter(c => c.status === 'running')
      .sort((a, b) => (m.get(b) || 0) - (m.get(a) || 0))
      .slice(0, 5);
  }
  function showCtEmpty(text){
    const empty = $('#ctEmpty');
    empty.hidden = false; empty.textContent = text;
    $('#ctTip').hidden = true;
  }
  function drawCtChart(){
    const m = CT_METRICS[ctTabK];
    const top = ctAll.length ? ctTop5() : [];
    if (!ctAll.length){ showCtEmpty('Docker 未连接'); $('#ctSeries').innerHTML = ''; return; }
    if (!top.length){
      showCtEmpty(ctEffective().length ? '筛选范围内暂无运行中的容器' : '没有符合筛选条件的容器');
      $('#ctSeries').innerHTML = '';
      return;
    }
    if (ctHist.length < 2){ showCtEmpty('数据采集中…'); return; }
    $('#ctEmpty').hidden = true;
    const series = top.map(c => ({
      label: c.name, color: ctColorOf(c.id), unit: '',
      get: s => { const it = s.items[c.id]; return it ? it[m.field] : null; },
      fmt: m.fmt,
    }));
    $('#ctSeries').innerHTML = series.map(s => `
      <span class="res-ser-item on" style="cursor:default"><i style="background:${s.color}"></i>${App.esc(s.label)}</span>`).join('') +
      `<span class="res-ser-hint">${m.label}占用最高前 ${top.length} · 采样间隔 5 秒</span>`;
    drawLine({ canvas: $('#ctChart'), wrap: $('#ctChartWrap'), tip: $('#ctTip'),
               samples: ctHist, series, hover: ctHover });
  }
  bindHover($('#ctChart'), $('#ctChartWrap'), () => ctHist.length,
    i => { ctHover = i; drawCtChart(); });

  $('#ctTabs').addEventListener('click', e => {
    const btn = e.target.closest('[data-ctab]');
    if (!btn || btn.dataset.ctab === ctTabK) return;
    ctTabK = btn.dataset.ctab;
    ctHover = null;
    $$('#ctTabs .res-tab').forEach(b => b.classList.toggle('active', b === btn));
    drawCtChart();
  });

  /* 筛选变化后联动卡片 / 表格 / 曲线 */
  function renderDockerView(){
    renderCtCards();
    renderCtTable();
    drawCtChart();
    renderCtPie();
  }

  /* 容器操作 */
  document.addEventListener('click', async e => {
    const btn = e.target.closest('[data-c-act]');
    if (!btn) return;
    try {
      await API.post(`/api/system/containers/${btn.dataset.cid}/${btn.dataset.cAct}`);
      showToast('指令已发送：' + btn.title);
      setTimeout(loadContainers, 1500);
    } catch (err) { showToast(err.message, 'err'); }
  });

  $('#monRefresh').addEventListener('click', () => {
    loadStats(); loadContainers(); pollMetrics();
  });

  document.addEventListener('view-change', e => {
    curView = e.detail;
    if (curView === 'monitor' && allowed){ drawResChart(); drawCtChart(); }
  });
  window.addEventListener('resize', () => {
    if (curView === 'monitor' && allowed){ drawResChart(); drawCtChart(); }
  });

  function stopTimers(){
    clearInterval(statTimer); clearInterval(metricTimer); clearInterval(ctTimer);
    statTimer = metricTimer = ctTimer = null;
  }

  /* 门控通过后启动全部采集（登录时 / 功能开关切换时均会走到） */
  function startAll(){
    stopTimers();
    renderResChips();
    loadStats(); loadContainers(); pollMetrics();
    statTimer = setInterval(loadStats, 30 * 1000);
    metricTimer = setInterval(pollMetrics, POLL_MS);
    ctTimer = setInterval(loadContainers, CT_POLL_MS);
  }

  /* 功能设置里切换监控开关后免刷新同步入口可见性 */
  document.addEventListener('monitor-gate', () => {
    if (applyGate()){
      startAll();
      if (curView === 'monitor'){ drawResChart(); drawCtChart(); }
    } else {
      stopTimers();
      if (curView === 'monitor') goView('dashboard');   // 正停留在监控页时回仪表盘
    }
  });

  App.onEnter(() => {
    stopTimers();
    if (!applyGate()) return;   // 非管理员 / 未开启：隐藏入口，不请求任何监控接口
    startAll();
  });
})();
