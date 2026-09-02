/* ============================================================
   OmniDesk · 天气横条（顶栏 · Open-Meteo + 浏览器定位）
   信息区：图标 / 城市（精确到区县）/ 气温 / 可选附加项，点开看详情；
   操作区：显示内容选择、位置设置（定位或手动搜索城市）、手动刷新。
   保存城市后顶栏时钟自动按该地时区显示（tzOffset 由天气接口带回）。
   ============================================================ */
(() => {
  const DOW = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  /* 横条附加项：键 → 标题（与 prefs.weather.fields 对应） */
  const FIELDS = [
    ['cond', '天气'], ['temp', '最高最低温 / 体感'], ['humidity', '湿度'],
    ['rain', '降雨概率'], ['aqi', '空气指数'], ['uv', '紫外线指数'],
  ];
  const DEFAULT_FIELDS = ['cond', 'temp', 'humidity'];
  let timer = null;
  let last = null;        // 最近一次天气数据（详情弹窗用）
  let searchTimer = null;

  const prefs = () => (App.prefs && App.prefs.weather) || {};
  const fields = () => prefs().fields || DEFAULT_FIELDS;
  const locText = () => {
    const w = prefs();
    if (!w.city) return '';
    return w.city + (w.district ? ' · ' + w.district : '');
  };

  function windText(deg){
    const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
    return dirs[Math.round(deg / 45) % 8] + '风';
  }

  /* 附加项文本：缺数据时返回空串不展示 */
  function extraOf(key, d){
    const t0 = (d.days || [])[0] || {};
    switch (key){
      case 'cond':    return d.cond || '';
      case 'temp':    return t0.max != null ? `↑${t0.max}°/↓${t0.min}° 体感${d.feels}°` : `体感${d.feels}°`;
      case 'humidity':return d.humidity != null ? `湿度${d.humidity}%` : '';
      case 'rain':    return d.rainProb != null ? `雨${d.rainProb}%` : '';
      case 'aqi':     return d.aqi != null ? `空气${d.aqi}` : '';
      case 'uv':      return d.uv != null ? `UV${Math.round(d.uv)}` : '';
      default: return '';
    }
  }

  function renderStrip(){
    const w = prefs();
    $('#wxSCity').textContent = locText() || (w.lat ? '自定义位置' : '定位中');
    if (!last) return;
    $('#wxSTemp').textContent = last.temp + '°';
    $('#wxSIc use').setAttribute('href', '#i-' + last.icon);
    $('#wxSExtra').textContent =
      fields().map(k => extraOf(k, last)).filter(Boolean).join(' · ');
    $('#wxStripInfo').title =
      `${locText() || '当前位置'} · ${last.cond} ${last.temp}° · 更新于 ${last.updated} · 点击查看详情`;
  }

  /* 时区变化时持久化（顶栏时钟读取），值未变则跳过请求 */
  function syncTz(d){
    const w = prefs();
    if (typeof d.tzOffset === 'number' && d.tzOffset !== w.tzOffset){
      App.prefs.weather = Object.assign({}, w, { tzOffset: d.tzOffset, tzName: d.tzName || '' });
      API.put('/api/settings', { weather: App.prefs.weather }).catch(() => {});
    }
  }

  async function load(){
    const w = prefs();
    const lat = w.lat ?? 30.2741, lon = w.lon ?? 120.1552;
    try {
      const d = await API.get(`/api/weather?lat=${lat}&lon=${lon}`);
      last = d;
      syncTz(d);
      renderStrip();
    } catch (e) {
      $('#wxSCity').textContent = locText() || '天气不可用';
      $('#wxSTemp').textContent = '--°';
    }
  }

  /* ---------- 详情弹窗 ---------- */
  function metaItem(icon, val, label){
    return `<div class="wx-meta-item"><svg class="ic"><use href="#${icon}"/></svg><b class="num">${val}</b><span>${label}</span></div>`;
  }
  function openDetail(){
    if (!last){ load(); return; }
    const d = last;
    $('#wxDTitle').textContent = '天气详情 · ' + (locText() || '当前位置');
    $('#wxDSub').textContent =
      `${d.cond} · 更新于 ${d.updated}${prefs().tzName ? ' · 时区 ' + prefs().tzName : ''}`;
    $('#wxDIc use').setAttribute('href', '#i-' + d.icon);
    $('#wxDTemp').innerHTML = d.temp + '<sup>°C</sup>';
    $('#wxDCond').textContent = `体感 ${d.feels}°C · ${windText(d.windDeg)} ${d.windSpeed} km/h`;
    $('#wxDMeta').innerHTML = [
      metaItem('#i-droplet', d.humidity != null ? d.humidity + '%' : '--', '湿度'),
      metaItem('#i-cloud-rain', d.rainProb != null ? d.rainProb + '%' : '--', '降雨概率'),
      metaItem('#i-activity', d.aqi != null ? d.aqi : '--', '空气指数'),
      metaItem('#i-sun', d.uv != null ? Math.round(d.uv) : '--', '紫外线'),
    ].join('');
    $('#wxDDays').innerHTML = (d.days || []).map((day, i) => `
      <div class="wx-day${i === 0 ? ' today' : ''}" title="${day.date} · ${day.cond}">
        <span class="wx-d-name">${i === 0 ? '今天' : DOW[new Date(day.date).getDay()]}</span>
        <svg class="ic"><use href="#i-${day.icon}"/></svg>
        <span class="wx-d-t num"><b>${day.max}°</b><span>${day.min}°</span></span>
        ${day.rain != null ? `<span class="wx-d-rain num" title="降雨概率"><svg class="ic"><use href="#i-droplet"/></svg>${day.rain}%</span>` : '<span class="wx-d-rain"></span>'}
      </div>`).join('');
    App.openModal('wxDetailMask');
  }

  /* ---------- 显示内容选择 ---------- */
  function renderFieldsList(){
    const sel = new Set(fields());
    $('#wxFieldsList').innerHTML = FIELDS.map(([k, label]) => `
      <label class="tag-opt"><input type="checkbox" value="${k}" ${sel.has(k) ? 'checked' : ''}>
      <span>${label}</span></label>`).join('');
  }

  /* ---------- 位置保存（城市 + 区县 + 坐标 + 显示字段合并） ---------- */
  async function saveCity(hit, silent){
    try {
      const next = Object.assign({}, prefs(), {
        city: hit.city, district: hit.district || '', lat: hit.lat, lon: hit.lon,
      });
      await API.put('/api/settings', { weather: next });
      App.prefs.weather = next;
      renderStrip();
      if (!silent) showToast(`已切换到 ${locText()}`);
      load();
    } catch (e) { showToast(e.message, 'err'); }
  }

  /* 浏览器定位 → 反向解析到区县。注：geolocation 仅 HTTPS / localhost 可用，
     局域网 HTTP 下浏览器拒绝授权，此时引导手动搜索 */
  function locate(){
    const btn = $('#wxLocateBtn');
    if (!navigator.geolocation){
      showToast('当前环境不支持定位，请手动搜索城市', 'err');
      $('#wxCitySearch').focus();
      return;
    }
    btn.disabled = true;
    btn.innerHTML = '<svg class="ic" style="animation:omSpin .8s linear infinite"><use href="#i-refresh"/></svg>定位中…';
    navigator.geolocation.getCurrentPosition(async pos => {
      const lat = +pos.coords.latitude.toFixed(4);
      const lon = +pos.coords.longitude.toFixed(4);
      try {
        const list = await API.get(`/api/weather/geocode?lat=${lat}&lon=${lon}`);
        const hit = list && list[0];
        /* 反向解析失败时仍按坐标保存（天气按坐标精确查询） */
        await saveCity(hit ? { city: hit.city, district: hit.district, lat, lon }
                           : { city: '当前位置', lat, lon });
        showToast(hit && hit.district ? `已定位到 ${hit.city} ${hit.district}`
                                       : '已按定位更新位置');
      } catch (e) { showToast('定位解析失败，请手动搜索城市', 'err'); }
      finally { resetLocateBtn(); }
    }, () => {
      resetLocateBtn();
      showToast('定位失败或未获授权，请手动搜索城市', 'err');
      $('#wxCitySearch').focus();
    }, { timeout: 8000, maximumAge: 10 * 60 * 1000 });
  }
  function resetLocateBtn(){
    const btn = $('#wxLocateBtn');
    btn.disabled = false;
    btn.innerHTML = '<svg class="ic"><use href="#i-pin"/></svg>定位当前位置（精确到区县）';
  }

  /* 手动搜索城市（500ms 防抖），结果点选即切换 */
  async function searchCity(q){
    const box = $('#wxCityResults');
    if (!q){ box.innerHTML = ''; return; }
    try {
      const list = await API.get('/api/weather/geocode?city=' + encodeURIComponent(q));
      box.innerHTML = list.length
        ? list.map((x, i) => `
          <button class="sp-item" data-city-hit="${i}">
            <svg class="ic"><use href="#i-pin"/></svg>
            ${App.esc(x.city)}${x.district ? ' · ' + App.esc(x.district) : ''}
            ${x.region ? '<span class="text-faint" style="margin-left:auto;font-size:11px">' + App.esc(x.region) + '</span>' : ''}
          </button>`).join('')
        : '<div class="drop-empty">未找到匹配的城市</div>';
      box._hits = list;
    } catch (e) { box.innerHTML = `<div class="drop-empty">${App.esc(e.message)}</div>`; }
  }

  /* ---------- 弹层开关（互斥） ---------- */
  function togglePop(id){
    const pop = $('#' + id);
    const open = pop.hidden;
    $('#wxFieldsPop').hidden = true;
    $('#wxLocPop').hidden = true;
    pop.hidden = !open;
    if (open && id === 'wxFieldsPop') renderFieldsList();
  }
  document.addEventListener('click', e => {
    if (!e.target.closest('#wxStrip')){
      $('#wxFieldsPop').hidden = true;
      $('#wxLocPop').hidden = true;
    }
  });

  /* ---------- 事件 ---------- */
  $('#wxStripInfo').addEventListener('click', openDetail);
  $('#wxDClose').addEventListener('click', () => App.closeModal('wxDetailMask'));
  $('#wxSRefresh').addEventListener('click', e => {
    const ic = e.currentTarget.querySelector('.ic');
    ic.style.animation = 'omSpin .8s linear';
    setTimeout(() => ic.style.animation = '', 820);
    load();
  });
  $('#wxSFieldsBtn').addEventListener('click', e => { e.stopPropagation(); togglePop('wxFieldsPop'); });
  $('#wxSLocBtn').addEventListener('click', e => { e.stopPropagation(); togglePop('wxLocPop'); });

  $('#wxFieldsList').addEventListener('change', e => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    const set = new Set(fields());
    if (cb.checked) set.add(cb.value); else set.delete(cb.value);
    App.prefs.weather = Object.assign({}, prefs(), { fields: [...set] });
    API.put('/api/settings', { weather: App.prefs.weather })
      .catch(err => showToast(err.message, 'err'));
    renderStrip();
  });

  $('#wxLocateBtn').addEventListener('click', e => { e.stopPropagation(); locate(); });
  $('#wxLocPop').addEventListener('click', e => e.stopPropagation());
  $('#wxFieldsPop').addEventListener('click', e => e.stopPropagation());
  $('#wxCitySearch').addEventListener('input', e => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchTimer = setTimeout(() => searchCity(q), 500);
  });
  $('#wxCityResults').addEventListener('click', e => {
    const btn = e.target.closest('[data-city-hit]');
    if (!btn) return;
    const hit = ($('#wxCityResults')._hits || [])[+btn.dataset.cityHit];
    if (hit) saveCity(hit);
  });

  App.onEnter(() => {
    renderStrip();
    load();
    /* 无已保存城市时首次自动定位；已有城市不重复定位 */
    if (!prefs().city) locate();
    clearInterval(timer);
    timer = setInterval(load, 10 * 60 * 1000); // 10 分钟自动刷新
  });
})();
