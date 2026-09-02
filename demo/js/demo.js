/* ============================================================
   OmniDesk · 演示脚本
   仅用于 UI 状态切换演示（视图 / 主题 / 弹层），
   不包含任何真实业务功能（无请求、无存储）。
   ============================================================ */

const $  = (s, c = document) => c.querySelector(s);
const $$ = (s, c = document) => [...c.querySelectorAll(s)];
const root = document.documentElement;

/* ---------- 视图切换 ---------- */
function goView(name){
  $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === name));
  $$('.nav-item[data-nav]').forEach(b => b.classList.toggle('active', b.dataset.nav === name));
  const nav = $(`.nav-item[data-nav="${name}"]`);
  if (nav) $('#crumbTitle').textContent = nav.dataset.title;
  document.body.dataset.view = name;        // CSS 用此区分视图，给全局顶栏/.kb-layout 套样式
  /* 知识库视图激活时：让全局 collapseBtn 视觉/语义上变成"折叠 kb-tree"。
     其它视图则继续折叠全局侧栏（系统监控等）。 */
  $('#collapseBtn')?.classList.toggle('kb-mode', name === 'notes');
  $('#collapseBtn')?.setAttribute(
    'title',
    name === 'notes' ? '折叠 / 展开左侧目录树' : '折叠 / 展开侧边栏');
  /* 进入知识库视图时还原 kb-tree（除非用户曾折叠） */
  if (name === 'notes' && !$('.kb-layout')?.classList.contains('kb-collapsed-persisted')){
    $('.kb-layout')?.classList.remove('kb-collapsed');
  }
  $('#userMenu').classList.remove('open');
  window.scrollTo({ top: 0 });
  document.dispatchEvent(new CustomEvent('view-change', { detail: name }));
}
$$('[data-nav]').forEach(el => el.addEventListener('click', () => goView(el.dataset.nav)));

/* ---------- 折叠按钮：按当前视图切换折叠对象 ---------- */
$('#collapseBtn').addEventListener('click', () => {
  if (document.body.dataset.view === 'notes'){
    const layout = $('.kb-layout');
    if (!layout) return;
    const collapsed = layout.classList.toggle('kb-collapsed');
    if (collapsed) layout.classList.add('kb-collapsed-persisted');
    else layout.classList.remove('kb-collapsed-persisted');
    try { localStorage.setItem('omni.kb.tree.collapsed', collapsed ? '1' : '0'); } catch (_) {}
  } else {
    document.body.classList.toggle('sidebar-collapsed');
  }
});
/* 进入知识库视图时还原折叠偏好 */
try {
  if (localStorage.getItem('omni.kb.tree.collapsed') === '1'){
    document.addEventListener('DOMContentLoaded', () => $('.kb-layout')?.classList.add('kb-collapsed', 'kb-collapsed-persisted'));
  }
} catch (_) {}

/* ---------- 明暗模式 ---------- */
/* persist=false 用于初始化：只同步界面状态，不覆盖已保存的偏好
   （否则会把「跟随系统」解析出的具体值写回去，auto 就丢了） */
function setMode(mode, persist = true){
  const resolved = mode === 'auto'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : mode;
  root.dataset.theme = resolved;
  if (persist){
    /* 记住选择：下次打开时 <head> 的内联脚本据此渲染首屏（含未登录的登录页） */
    try { localStorage.setItem('om_theme_mode', mode); } catch (e) {}
  }
  $$('[data-ic]').forEach(ic => ic.style.display = ic.dataset.ic === resolved ? 'none' : '');
  $$('#modeSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
}
$('#themeToggle').addEventListener('click', () =>
  setMode(root.dataset.theme === 'dark' ? 'light' : 'dark'));
$$('#modeSeg .seg-btn').forEach(b =>
  b.addEventListener('click', () => setMode(b.dataset.mode)));

/* 跟随系统：系统深浅切换即时生效，用户不必刷新页面 */
if (window.matchMedia){
  const mq = matchMedia('(prefers-color-scheme: light)');
  const onSysChange = () => {
    let mode = 'auto';
    try { mode = localStorage.getItem('om_theme_mode') || 'auto'; } catch (e) {}
    if (mode === 'auto') setMode('auto', false);
  };
  if (mq.addEventListener) mq.addEventListener('change', onSysChange);
  else if (mq.addListener) mq.addListener(onSysChange);
}

/* 初始值沿用 <head> 内联脚本的解算结果，避免二次跳变 */
(function initTheme(){
  let mode = 'dark';
  try { mode = localStorage.getItem('om_theme_mode') || 'auto'; } catch (e) {}
  setMode(mode, false);
})();

/* ---------- 品牌主色（自定义主题核心演示） ---------- */
function setAccent(hue, sat = '72%'){
  root.style.setProperty('--om-hue', hue);
  root.style.setProperty('--om-sat', sat);
}
$$('.swatch[data-hue]').forEach(sw => sw.addEventListener('click', () => {
  $$('.swatch').forEach(s => s.classList.remove('on'));
  sw.classList.add('on');
  setAccent(sw.dataset.hue);
}));

/* 自定义取色：HEX → HSL，只回写色相与饱和度 */
function hexToHsl(hex){
  const r = parseInt(hex.slice(1, 3), 16) / 255,
        g = parseInt(hex.slice(3, 5), 16) / 255,
        b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d){
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = Math.round(h * 60);
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return [h, Math.round(s * 100)];
}
$('#customColor').addEventListener('input', e => {
  const [h, s] = hexToHsl(e.target.value);
  $$('.swatch').forEach(x => x.classList.remove('on'));
  $('.swatch.custom').classList.add('on');
  setAccent(h, Math.max(s, 35) + '%');
});

/* ---------- 设置中心弹窗 ---------- */
function openSettings(open){
  $('#settingsMask').classList.toggle('open', open);
}
$$('[data-open-settings]').forEach(el => el.addEventListener('click', () => {
  $('#userMenu').classList.remove('open');
  openSettings(true);
}));
$('#settingsClose').addEventListener('click', () => openSettings(false));
$('#settingsMask').addEventListener('click', e => {
  if (e.target === e.currentTarget) openSettings(false);
});

/* ---------- 用户菜单 / 切换用户 ---------- */
$('#avatarBtn').addEventListener('click', e => {
  e.stopPropagation();
  $('#userMenu').classList.toggle('open');
});
document.addEventListener('click', e => {
  if (!e.target.closest('.menu-wrap')) $('#userMenu').classList.remove('open');
});

function openSwitch(open){
  $('#switchMask').classList.toggle('open', open);
  $('#userMenu').classList.remove('open');
}
$$('[data-open-switch]').forEach(el => el.addEventListener('click', () => openSwitch(true)));
$('#switchCancel').addEventListener('click', () => openSwitch(false));
$('#switchMask').addEventListener('click', e => {
  if (e.target === e.currentTarget) openSwitch(false);
});

/* ---------- Tabs：悬浮/点击即切换（突出“快”，无需点击） ---------- */
$$('[data-hover-tabs]').forEach(group => {
  /* 面板查询限定在所在卡片/视图内，避免跨视图重名分类互相干扰 */
  const scope = group.closest('.card') || group.closest('.view') || document;
  const tabs = $$('.tab', group);
  const panels = $$('[data-qpanel]', scope);
  const activate = tab => {
    tabs.forEach(t => t.classList.toggle('active', t === tab));
    panels.forEach(p => p.hidden = p.dataset.qpanel !== tab.dataset.cat);
  };
  tabs.forEach(tab => {
    tab.addEventListener('mouseenter', () => activate(tab));
    tab.addEventListener('click', () => activate(tab));
  });
});

/* ---------- 设置中心：分区切换 ---------- */
$$('.set-item').forEach(btn => btn.addEventListener('click', () => {
  $$('.set-item').forEach(b => b.classList.toggle('active', b === btn));
  $$('[data-setpanel]').forEach(p => p.hidden = p.dataset.setpanel !== btn.dataset.set);
}));

/* ---------- 开关 / 分段控件（视觉状态） ---------- */
$$('.switch').forEach(sw => sw.addEventListener('click', () => sw.classList.toggle('on')));
$$('.seg').forEach(group => {
  if (group.id === 'modeSeg') return;
  $$('.seg-btn', group).forEach(btn => btn.addEventListener('click', () => {
    $$('.seg-btn', group).forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }));
});

/* ---------- Toast ---------- */
let toastTimer;
function showToast(msg, type = 'ok'){
  $('#toastMsg').textContent = msg;
  const t = $('#toast');
  /* 成功显示“勾”，错误显示“叉”并转红 */
  t.classList.toggle('err', type === 'err');
  t.querySelector('.ic use').setAttribute('href', type === 'err' ? '#i-close' : '#i-check');
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------- 全局脚本错误可见化 ----------
   init() 里一个绑定抛错会让后续所有事件绑定失效，表现成"所有按钮都没反应"。
   把未捕获错误弹成 toast（同一消息只提示一次），用户能直接看到原因而不是默默失灵。 */
const _omErrSeen = new Set();
window.addEventListener('error', e => {
  const msg = (e && e.message) || '未知脚本错误';
  if (_omErrSeen.has(msg)) return;               // 同一错误只弹一次，防刷屏
  _omErrSeen.add(msg);
  try { showToast('脚本错误：' + msg, 'err'); } catch (_) {}
});
window.addEventListener('unhandledrejection', e => {
  const msg = (e && e.reason && (e.reason.message || String(e.reason))) || '未处理的 Promise 异常';
  if (_omErrSeen.has(msg)) return;
  _omErrSeen.add(msg);
  try { showToast('异步错误：' + msg, 'err'); } catch (_) {}
});

/* ---------- 快捷键 ⌘K / Ctrl+K 聚焦全局搜索；Esc 关闭弹窗 ---------- */
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'){
    e.preventDefault();
    $('#globalSearch').focus();
  }
  if (e.key === 'Escape') openSettings(false);
});

/* ---------- 顶栏实时时钟（精确到秒；按天气定位城市时区，未定位用本机时区） ---------- */
function tickClock(){
  const el = $('#crumbDate');
  if (!el) return;
  const w = (window.App && App.prefs && App.prefs.weather) || {};
  /* 定位城市时区优先；未保存时退回本机时区（统一换算成目标时区的“墙上时间”） */
  const off = typeof w.tzOffset === 'number'
    ? w.tzOffset : -new Date().getTimezoneOffset() * 60;
  const d = new Date(Date.now() + off * 1000);
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getUTCDay()];
  const p = n => String(n).padStart(2, '0');
  el.textContent = `${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日 · 星期${week} · ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  /* 悬浮提示时区归属，区分本机时间与定位城市时间 */
  el.title = w.city
    ? `${w.city}${w.district ? ' ' + w.district : ''} 当地时间` +
      (w.tzName ? ` · ${w.tzName}` : '')
    : '本机时间';
}
tickClock();
setInterval(tickClock, 1000);
