/* OmniHome · Mermaid 图表
   本地 vendor（js/vendor/mermaid.min.js），按需加载，离线可用。
   securityLevel=strict：图表里的 HTML 标签会被丢掉，避免笔记内容注入脚本。 */

const svgCache = new Map();
let loading = null;
let bootedTheme = '';
let seq = 0;
let themeWatch = false;

export function isMermaidLang(lang){
  return /^mermaid$/i.test(String(lang || '').trim());
}

export function mermaidThemeName(){
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'default' : 'dark';
}

function scriptVer(){
  try {
    const cur = document.querySelector('script[src*="boot.js"]');
    if (!cur) return '';
    return new URL(cur.getAttribute('src'), location.href).search || '';
  } catch (_) { return ''; }
}

function loadMermaid(){
  if (window.mermaid && typeof window.mermaid.render === 'function')
    return Promise.resolve(window.mermaid);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('./vendor/mermaid.min.js', import.meta.url).href + scriptVer();
    s.async = true;
    s.onload = () => {
      if (window.mermaid && typeof window.mermaid.render === 'function') resolve(window.mermaid);
      else reject(new Error('Mermaid 未就绪'));
    };
    s.onerror = () => reject(new Error('Mermaid 脚本加载失败'));
    document.head.appendChild(s);
  }).catch(err => { loading = null; throw err; });
  return loading;
}

function cacheSet(key, svg){
  if (svgCache.size > 40) svgCache.delete(svgCache.keys().next().value);
  svgCache.set(key, svg);
}

function boot(mermaid, theme){
  if (bootedTheme === theme) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme,
    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
    logLevel: 'fatal',
    flowchart: { htmlLabels: true, useMaxWidth: true },
    sequence: { useMaxWidth: true },
    gantt: { useMaxWidth: true },
  });
  bootedTheme = theme;
  svgCache.clear();
}

function chartEl(host){
  return host.querySelector('.lm-mermaid-chart') || host;
}
function msgEl(host){
  return host.querySelector('.lm-mermaid-msg');
}

export function hostShowsChart(host){
  if (!host || host.hidden || host.classList.contains('is-folded')) return false;
  const fence = host.closest('.lm-fence-open');
  if (fence) return fence.classList.contains('is-mermaid-chart');
  const pre = host.closest('pre');
  if (pre) return pre.classList.contains('is-mermaid-chart');
  return true;
}

function shortErr(e){
  const m = String((e && (e.str || e.message)) || e || '语法错误').split('\n')[0].trim();
  return m.length > 180 ? m.slice(0, 180) + '…' : m;
}

function cleanup(id, host){
  document.querySelectorAll('[id="' + id + '"], [id="d' + id + '"]').forEach(n => {
    if (host && host.contains(n)) return;
    n.remove();
  });
}

function showMsg(host, text){
  const chart = chartEl(host);
  const msg = msgEl(host);
  if (chart && chart !== host) chart.innerHTML = '';
  if (msg){
    msg.hidden = false;
    msg.textContent = text;
  }
}

let renderChain = Promise.resolve();
function enqueueRender(fn){
  const run = renderChain.then(fn, fn);
  renderChain = run.then(() => {}, () => {});
  return run;
}
function withTimeout(p, ms){
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('渲染超时')), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

export function renderMermaidInto(host, source){
  if (!host) return Promise.resolve();
  const gen = (host._mmdGen = (host._mmdGen || 0) + 1);
  const text = String(source == null ? '' : source).replace(/\s+$/, '');
  watchTheme();
  if (!text.trim()){
    showMsg(host, '空的 Mermaid 图表');
    return Promise.resolve();
  }
  const theme = mermaidThemeName();
  const key = theme + '\n' + text;
  const applySvg = svg => {
    if (host._mmdGen !== gen) return;
    const chart = chartEl(host);
    const msg = msgEl(host);
    if (msg) msg.hidden = true;
    chart.innerHTML = svg;
    host.dataset.mmdSrc = text;
    host.dataset.mmdTheme = theme;
  };
  const cached = svgCache.get(key);
  if (cached){
    applySvg(cached);
    return Promise.resolve();
  }
  return loadMermaid().then(mermaid => enqueueRender(async () => {
    if (host._mmdGen !== gen || !host.isConnected) return;
    boot(mermaid, theme);
    const id = 'omMmd' + (++seq);
    try {
      const out = await withTimeout(mermaid.render(id, text), 8000);
      let svg = out && out.svg ? out.svg : '';
      if (!svg) throw new Error('没有生成图表');
      svg = svg.replace(new RegExp('id="' + id + '"'), '');
      cacheSet(key, svg);
      applySvg(svg);
    } catch (e) {
      if (host._mmdGen !== gen) return;
      showMsg(host, '图表无法渲染：' + shortErr(e));
      delete host.dataset.mmdSrc;
    } finally {
      cleanup(id, host);
    }
  })).catch(e => {
    if (host._mmdGen !== gen) return;
    showMsg(host, '图表无法渲染：' + shortErr(e));
  });
}

const timers = new WeakMap();

export function scheduleMermaid(host, source){
  if (!host) return;
  watchTheme();
  const prev = timers.get(host);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    timers.delete(host);
    if (!host.isConnected || !hostShowsChart(host)) return;
    renderMermaidInto(host, source);
  }, 40);
  timers.set(host, t);
}

function watchTheme(){
  if (themeWatch || typeof MutationObserver !== 'function') return;
  themeWatch = true;
  let last = mermaidThemeName();
  new MutationObserver(() => {
    const t = mermaidThemeName();
    if (t === last) return;
    last = t;
    bootedTheme = '';
    svgCache.clear();
    document.querySelectorAll('.lm-mermaid[data-mmd-src], .md-mermaid[data-mmd-src]').forEach(host => {
      if (!hostShowsChart(host)){
        delete host.dataset.mmdTheme;
        return;
      }
      renderMermaidInto(host, host.dataset.mmdSrc || '');
    });
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}
