/* ============================================================
   OmniDesk · 实用工具箱
   翻译（MyMemory）· 密码生成 · 时间戳 · 二维码 · 单位换算 ·
   颜色转换 · JSON 格式化 · Base64 编解码。
   ============================================================ */
(() => {
  /* ---------- 翻译 ---------- */
  const LANGS = { '中文': 'zh-CN', 'English': 'en', '日本語': 'ja', '한국어': 'ko' };
  function initTranslate(){
    const src = $('#trSrc'), out = $('#trOut');
    const from = $('#trFrom'), to = $('#trTo');
    const update = () => $('#trCount').textContent = src.value.length + ' / 5000';
    src.addEventListener('input', update);
    $('#trSwap').addEventListener('click', () => {
      const a = from.value; from.value = to.value; to.value = a;
      const outTxt = out.querySelector('span');
      const b = src.value; src.value = outTxt.textContent.trim();
      outTxt.textContent = b;
      update();
    });
    $('#trCopy').addEventListener('click', async () => {
      await navigator.clipboard.writeText(out.querySelector('span').textContent.trim());
      showToast('译文已复制');
    });
    $('#trSpeak').addEventListener('click', () => {
      const u = new SpeechSynthesisUtterance(out.querySelector('span').textContent.trim());
      u.lang = LANGS[to.value] === 'zh-CN' ? 'zh-CN' : 'en-US';
      speechSynthesis.cancel(); speechSynthesis.speak(u);
    });
    $('#trGo').addEventListener('click', async () => {
      const text = src.value.trim();
      if (!text) return showToast('请输入要翻译的内容', 'err');
      const btn = $('#trGo');
      btn.disabled = true;
      btn.dataset.origHtml = btn.innerHTML;
      btn.innerHTML = '<span class="loading-dot"></span>翻译中…';
      try {
        const d = await API.get(`/api/tools/translate?text=${encodeURIComponent(text)}` +
          `&source=${LANGS[from.value]}&target=${LANGS[to.value]}`);
        out.querySelector('span').textContent = d.translation;
      } catch (e) { showToast(e.message, 'err'); }
      finally {
        btn.disabled = false;
        if (btn.dataset.origHtml){ btn.innerHTML = btn.dataset.origHtml; delete btn.dataset.origHtml; }
      }
    });
  }

  /* ---------- 强密码生成 ---------- */
  function initPassGen(){
    const out = $('#pgOut'), lenLabel = $('#pgLenVal'), range = $('#pgLen');
    function gen(){
      const len = parseInt(range.value, 10);
      const use = {
        upper: $('#pgUpper').checked, lower: $('#pgLower').checked,
        digit: $('#pgDigit').checked, symbol: $('#pgSymbol').checked,
      };
      let pool = '';
      if (use.upper) pool += 'ABCDEFGHJKLMNPQRSTUVWXYZ';
      if (use.lower) pool += 'abcdefghijkmnpqrstuvwxyz';
      if (use.digit) pool += '23456789';
      if (use.symbol) pool += '!@#$%^&*()-_=+';
      if (!pool){ showToast('至少选择一种字符类型', 'err'); return ''; }
      const buf = new Uint32Array(len);
      crypto.getRandomValues(buf);
      const pwd = Array.from(buf, n => pool[n % pool.length]).join('');
      out.textContent = pwd;
      $('#pgStrength').className = 'strength s' + score(pwd);
      $('#pgStrengthLbl').textContent = ['—', '弱', '中', '强', '极强'][score(pwd)];
      return pwd;
    }
    function score(pwd){
      let s = 1;
      if (pwd.length >= 12) s++;
      if (/[A-Z]/.test(pwd) && /[a-z]/.test(pwd)) s++;
      if (/[^A-Za-z0-9]/.test(pwd) && /\d/.test(pwd)) s++;
      return Math.min(4, s);
    }
    range.addEventListener('input', () => { lenLabel.textContent = range.value; gen(); });
    $$('.pg-checks input').forEach(cb => cb.addEventListener('change', gen));
    $('#pgGo').addEventListener('click', gen);
    $('#pgRegen').addEventListener('click', gen);
    $('#pgCopy').addEventListener('click', async () => {
      if (!out.textContent) gen();
      await navigator.clipboard.writeText(out.textContent);
      showToast('密码已复制');
    });
    gen();
  }

  /* ---------- 时间戳转换 ---------- */
  function initTimestamp(){
    $('#tsNow').addEventListener('click', () => {
      $('#tsInput').value = Math.floor(Date.now() / 1000);
      convert();
    });
    $('#tsInput').addEventListener('input', convert);
    function convert(){
      const v = $('#tsInput').value.trim();
      if (!v){ $('#tsOut').textContent = '—'; return; }
      let n = Number(v);
      if (isNaN(n)){ $('#tsOut').textContent = '无效数字'; return; }
      if (v.length === 13) n = n / 1000; // 毫秒
      const d = new Date(n * 1000);
      $('#tsOut').textContent = d.toLocaleString('zh-CN', { hour12: false }) +
        `（${d.toISOString()}）`;
    }
    $('#tsDate').addEventListener('change', () => {
      const d = new Date($('#tsDate').value);
      $('#tsDateOut').textContent = isNaN(d) ? '—' : Math.floor(d.getTime() / 1000) + ' 秒';
    });
  }

  /* ---------- 二维码 ---------- */
  function initQr(){
    $('#qrGo').addEventListener('click', () => {
      const text = $('#qrSrc').value.trim();
      if (!text) return showToast('请输入内容');
      const box = $('#qrBox');
      box.innerHTML = '';
      if (window.QRCode){
        new QRCode(box, { text, width: 200, height: 200,
          colorDark: '#1a1a1a', colorLight: '#ffffff' });
        $('#qrDl').hidden = false;
      } else {
        box.innerHTML = '<div style="font-size:12px;color:var(--om-text-3);padding:20px">二维码组件加载失败（需联网加载 CDN）</div>';
        $('#qrDl').hidden = true;
      }
    });
    $('#qrDl').addEventListener('click', () => {
      const img = $('#qrBox').querySelector('img, canvas');
      if (!img) return;
      const a = document.createElement('a');
      a.href = img.src || img.toDataURL('image/png');
      a.download = 'qrcode.png';
      a.click();
    });
  }

  /* ---------- 单位换算（容量 · 速率 · 长度 · 温度） ---------- */
  const UNIT_DEFS = {
    '存储容量': { base: 'B', units: { B: 1, KB: 1024, MB: 1048576, GB: 1099511627776, TB: 1125899906842624 } },
    '数据速率': { base: 'bps', units: { bps: 1, Kbps: 1e3, Mbps: 1e6, Gbps: 1e9, 'MB/s': 8e6 } },
    '长度':     { base: 'm', units: { mm: 1e-3, cm: 1e-2, m: 1, km: 1e3, 英寸: 0.0254, 英尺: 0.3048 } },
    '温度':     { special: 'temp' },
  };
  function initUnit(){
    const cat = $('#unitCat'), from = $('#unitFrom'), to = $('#unitTo');
    const input = $('#unitInput'), out = $('#unitOut');
    function fillSelects(){
      const def = UNIT_DEFS[cat.value];
      const names = def.special ? ['℃', '℉', 'K'] : Object.keys(def.units);
      [from, to].forEach((sel, i) => {
        sel.innerHTML = names.map(n => `<option>${n}</option>`).join('');
        sel.selectedIndex = i === 0 ? 0 : 1;
      });
    }
    function calc(){
      const def = UNIT_DEFS[cat.value];
      const v = parseFloat(input.value);
      if (isNaN(v)){ out.textContent = '—'; return; }
      let r;
      if (def.special === 'temp'){
        let c = from.value === '℃' ? v : from.value === '℉' ? (v - 32) * 5 / 9 : v - 273.15;
        r = to.value === '℃' ? c : to.value === '℉' ? c * 9 / 5 + 32 : c + 273.15;
      } else {
        r = v * def.units[from.value] / def.units[to.value];
      }
      out.textContent = Number(r.toPrecision(10)).toLocaleString('en-US');
    }
    cat.addEventListener('change', () => { fillSelects(); calc(); });
    [input, from, to].forEach(el => el.addEventListener('input', calc));
    $('#unitSwap').addEventListener('click', () => {
      const a = from.value; from.value = to.value; to.value = a; calc();
    });
    fillSelects();
  }

  /* ---------- 颜色转换 ---------- */
  function initColor(){
    const picker = $('#colorPick');
    const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    function update(){
      const hex = picker.value;
      const [r, g, b] = hexToRgb(hex);
      const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255, d = mx - mn;
      let h = 0;
      if (d){
        if (mx === r / 255) h = ((g / 255 - b / 255) / d) % 6;
        else if (mx === g / 255) h = (b / 255 - r / 255) / d + 2;
        else h = (r / 255 - g / 255) / d + 4;
        h = Math.round((h < 0 ? h + 6 : h) * 60);
      }
      const l = (mx + mn) / 2;
      const s = d ? Math.round(d / (1 - Math.abs(2 * l - 1)) * 100) : 0;
      $('#colorHex').textContent = hex.toUpperCase();
      $('#colorRgb').textContent = `rgb(${r}, ${g}, ${b})`;
      $('#colorHsl').textContent = `hsl(${h} ${s}% ${Math.round(l * 100)}%)`;
    }
    picker.addEventListener('input', update);
    $$('.js-color-copy').forEach(btn => btn.addEventListener('click', async () => {
      await navigator.clipboard.writeText($('#' + btn.dataset.colorId).textContent);
      showToast('已复制');
    }));
    update();
  }

  /* ---------- JSON 格式化 ---------- */
  function initJson(){
    $('#jsonFmt').addEventListener('click', () => {
      try { $('#jsonOut').value = JSON.stringify(JSON.parse($('#jsonIn').value), null, 2); }
      catch (e) { $('#jsonOut').value = '解析失败：' + e.message; }
    });
    $('#jsonMin').addEventListener('click', () => {
      try { $('#jsonOut').value = JSON.stringify(JSON.parse($('#jsonIn').value)); }
      catch (e) { $('#jsonOut').value = '解析失败：' + e.message; }
    });
    $('#jsonCopy').addEventListener('click', async () => {
      await navigator.clipboard.writeText($('#jsonOut').value);
      showToast('已复制');
    });
  }

  /* ---------- Base64 ---------- */
  function initBase64(){
    $('#b64Enc').addEventListener('click', () => {
      try { $('#b64Out').value = btoa(unescape(encodeURIComponent($('#b64In').value))); }
      catch (e) { showToast('编码失败', 'err'); }
    });
    $('#b64Dec').addEventListener('click', () => {
      try { $('#b64Out').value = decodeURIComponent(escape(atob($('#b64In').value.trim()))); }
      catch (e) { showToast('解码失败：内容不是合法 Base64', 'err'); }
    });
  }

  /* ---------- 磁贴 → 弹窗映射 ---------- */
  const TOOL_MODAL = { 'tool-ts': 'tsMask', 'tool-qr': 'qrMask', 'tool-unit': 'unitMask',
                       'tool-color': 'colorMask', 'tool-json': 'jsonMask', 'tool-b64': 'b64Mask' };

  function init(){
    initTranslate(); initPassGen(); initTimestamp();
    initQr(); initUnit(); initColor(); initJson(); initBase64();
    document.addEventListener('click', e => {
      const tile = e.target.closest('.tool-tile[id], .js-tool-tile[id]');
      if (!tile || tile.classList.contains('soon')) return;
      const modalId = TOOL_MODAL[tile.id];
      if (modalId) App.openModal(modalId);
      else if (tile.id === 'tool-trans') goView('toolbox');
      else if (tile.id === 'tool-pass') goView('toolbox');
    });
    $$('.modal [data-close]').forEach(b =>
      b.addEventListener('click', () => b.closest('.modal-mask').classList.remove('open')));
  }

  init();
})();
