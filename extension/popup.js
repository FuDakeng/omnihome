/* ============================================================
   OmniHome 插件 · Popup 逻辑
   - 登录：测试连接 / 登录 双按钮；登录后不再自动同步（BUG 修复）
   - 收藏：快速收藏 + 折叠式选分类保存（含 AI 分析，不新开页面）
   - 同步：首次同步弹窗确认并自动备份浏览器书签；一键反向导入
   - 打开面板时静默比对服务端指纹，有变化即时同步
   ============================================================ */
import { login, saveAuth, testConnection } from './api.js';

const $ = s => document.querySelector(s);
const send = msg => new Promise(res => chrome.runtime.sendMessage(msg, res));

let curCats = [];      // 分类缓存（渲染下拉）
let savedTags = [];    // AI 分析出的标签
let quickCat = '';     // 用户选定的收藏分类；空 = 默认「收藏到万事屋」（服务端落「常用」）
const PRESET_MIN = [5, 15, 30, 60, 360, 1440];   // 同步间隔预设档位（分钟）

function timeAgo(ts){
  if (!ts) return '尚未同步';
  const d = Date.now() - ts;
  if (d < 60 * 1000) return '刚刚同步';
  if (d < 3600 * 1000) return Math.floor(d / 60000) + ' 分钟前同步';
  const t = new Date(ts), p = n => String(n).padStart(2, '0');
  return `${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())} 同步`;
}
function toast(msg, isErr){
  const t = $('#toast');
  t.hidden = false; t.style.display = ''; t.textContent = msg;
  t.classList.toggle('err', !!isErr);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; t.style.display = 'none'; }, 2800);
}

/* 弹窗显隐：同步清内联 style，避免任何 CSS/属性层面失控；
   默认处理器保证弹窗即使异常出现也能被关闭，不会卡死整个面板 */
function openModal(){ const m = $('#modal'); m.hidden = false; m.style.display = ''; }
function closeModal(){ const m = $('#modal'); m.hidden = true; m.style.display = 'none'; }
$('#modalCancel').addEventListener('click', closeModal);
$('#modalOk').addEventListener('click', closeModal);

/* ---------- 渲染 ---------- */
async function render(){
  const r = await send({ type: 'GET_STATE' });
  if (!r) return;
  const { auth, state, settings } = r;
  const logged = !!(auth && auth.token);
  $('#loginPanel').hidden = logged;
  $('#mainPanel').hidden = !logged;
  $('#headDot').classList.toggle('on', logged);
  $('#footVer').textContent = 'v' + chrome.runtime.getManifest().version;

  if (!logged){
    $('#headSub').textContent = '未连接 · 请先登录';
    if (auth && auth.server) $('#inServer').value = auth.server;
    if (auth && auth.username) $('#inUser').value = auth.username;
    return;
  }

  $('#headSub').textContent = auth.server.replace(/^https?:\/\//, '');
  $('#uName').textContent = (auth.user && (auth.user.nickname || auth.user.username)) || auth.username;
  $('#uAvatar').textContent = String($('#uName').textContent).slice(0, 1).toUpperCase();
  $('#uServer').textContent = auth.server;

  curCats = (state && state.catList) || [];
  fillCatSelect();
  updateQuickLabel();

  /* 同步状态 */
  const chip = $('#syncChip'), err = $('#syncErr');
  if (state && state.lastError){
    chip.textContent = '异常'; chip.className = 'chip err';
    err.hidden = false; err.textContent = state.lastError;
  } else if (!state || !state.firstConfirmed){
    chip.textContent = '待首次同步'; chip.className = 'chip warn';
    err.hidden = true;
  } else if (state.lastSync){
    chip.textContent = '正常'; chip.className = 'chip ok';
    err.hidden = true;
  } else {
    chip.textContent = '待同步'; chip.className = 'chip';
    err.hidden = true;
  }
  $('#syncInfo').textContent = state && state.lastSync
    ? `${timeAgo(state.lastSync)} · ${state.total ?? 0} 个书签 / ${state.catCount ?? 0} 个分类`
      + (state.skippedCount ? `（${state.skippedCount} 个无效地址已跳过）` : '')
    : '尚未同步';
  $('#syncHint').textContent = (!state || !state.firstConfirmed)
    ? '首次同步将清空书签栏现有内容并替换为万事屋书签，执行前会自动下载一份当前书签备份。'
    : '书签栏内容以万事屋为准：万事屋中的分类与书签会原样镜像到书签栏。';

  /* 设置回显：预设档位直接选中；非标值落「自定义」并展示输入框 */
  $('#swAuto').classList.toggle('on', !!settings.autoSync);
  $('#rowInterval').style.opacity = settings.autoSync ? '' : '.4';
  const iv = settings.intervalMin || 30;
  const selIv = $('#selInterval'), inIv = $('#inInterval');
  if (PRESET_MIN.includes(iv)){
    selIv.value = String(iv);
    inIv.hidden = true; inIv.style.display = 'none';
  } else {
    selIv.value = 'custom';
    inIv.value = iv; inIv.hidden = false; inIv.style.display = '';
  }
  $('#swSkipHidden').classList.toggle('on', !!settings.skipHiddenCats);
}

function fillCatSelect(){
  const usable = curCats.filter(c => c.id !== 'all');
  $('#svCat').innerHTML = usable.map(c =>
    `<option value="${c.id}">${c.name}</option>`).join('');
  /* 默认落在「未分类」：用户不选分类时书签也能在万事屋找到 */
  if (usable.find(c => c.id === 'none')) $('#svCat').value = 'none';
  else if (usable.find(c => c.id === 'common')) $('#svCat').value = 'common';
}

/* 收藏按钮文案：默认「收藏到万事屋」；用户选了分类后动态显示对应分类 */
function updateQuickLabel(){
  const name = quickCat ? ((curCats.find(c => c.id === quickCat) || {}).name || '') : '';
  $('#btnQuickAdd').textContent = name ? `⭐ 收藏到「${name}」` : '⭐ 收藏到万事屋';
}
$('#svCat').addEventListener('change', () => {
  quickCat = $('#svCat').value || '';
  updateQuickLabel();
});

async function currentTab(){
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/* ---------- 登录：测试连接 / 登录 两个按钮 ---------- */
$('#btnTest').addEventListener('click', async () => {
  const btn = $('#btnTest'), spin = $('#testSpin'), err = $('#loginErr');
  err.hidden = true; btn.disabled = true; spin.hidden = false;
  try {
    const info = await testConnection($('#inServer').value);
    toast(`连接成功 · ${info.name} v${info.version}`);
  } catch (e) {
    err.hidden = false; err.textContent = e.message;
  } finally {
    btn.disabled = false; spin.hidden = true;
  }
});

$('#btnLogin').addEventListener('click', async () => {
  const err = $('#loginErr'), spin = $('#loginSpin'), btn = $('#btnLogin');
  err.hidden = true; spin.hidden = false; btn.disabled = true;
  try {
    const auth = await login($('#inServer').value, $('#inUser').value.trim(), $('#inPass').value);
    await saveAuth(auth);
    await send({ type: 'LOGIN_DONE' });   // 后台立即应答，不自动同步
    toast('登录成功');
    await render();
    /* 登录成功即拉一次最新分类（供右键菜单 / 下拉使用），并提示首次同步 */
    const chk = await send({ type: 'CHECK_CHANGES' });
    if (chk && chk.needConfirm) $('#syncHint').style.color = '#fbbf24';
  } catch (e) {
    err.hidden = false; err.textContent = e.message;
  } finally {
    spin.hidden = true; btn.disabled = false;
  }
});
$('#inPass').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('#btnLogin').click();
});

/* ---------- 退出 ---------- */
$('#btnLogout').addEventListener('click', async () => {
  await send({ type: 'LOGOUT' });
  $('#inPass').value = '';
  render();
});

/* ---------- 收藏当前页 ---------- */
$('#btnQuickAdd').addEventListener('click', async () => {
  const tab = await currentTab();
  if (!tab || !/^https?:/i.test(tab.url || '')){
    toast('当前页面不是普通网页，无法收藏', true);
    return;
  }
  const r = await send({
    type: 'CARD_SAVE', name: tab.title || tab.url, url: tab.url, cat: quickCat || 'none',
  });
  if (r && r.ok){
    const name = (curCats.find(c => c.id === r.cat) || {}).name || '未分类';
    toast(`已收藏到「${name}」分类`);
  } else {
    toast((r && r.error) === 'NO_AUTH' ? '会话已失效，请重新登录' : (r && r.error) || '收藏失败', true);
  }
});

/* 折叠式：选择分类并保存（不新开页面，含 AI 分析） */
$('#saveToggle').addEventListener('click', async () => {
  const more = $('#saveMore');
  more.hidden = !more.hidden;
  more.style.display = more.hidden ? 'none' : '';
  $('#saveToggle').textContent = more.hidden ? '选择分类 ▾' : '收起 ▴';
  if (!more.hidden){
    const tab = await currentTab();
    $('#svName').value = (tab && tab.title) || '';
    $('#svDesc').value = '';
    $('#svTagInput').value = '';
    savedTags = [];
    renderTags();
  }
});

/* 标签输入：回车 / 逗号落一个标签，可连续添加 */
function addTagFromInput(){
  const v = $('#svTagInput').value.trim().replace(/,+$/, '');
  if (v && !savedTags.includes(v)) savedTags.push(v);
  $('#svTagInput').value = '';
  renderTags();
}
$('#svTagInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ','){ e.preventDefault(); addTagFromInput(); }
});

function renderTags(){
  $('#svTags').innerHTML = savedTags.map((t, i) =>
    `<span class="tag" data-i="${i}" title="点击移除">${t} ×</span>`).join('');
  $('#svTags').querySelectorAll('.tag').forEach(el => {
    el.addEventListener('click', () => {
      savedTags.splice(Number(el.dataset.i), 1);
      renderTags();
    });
  });
}

$('#btnAi').addEventListener('click', async () => {
  const tab = await currentTab();
  const btn = $('#btnAi'), spin = $('#aiSpin');
  btn.disabled = true; spin.hidden = false;
  try {
    const r = await send({
      type: 'CARD_AI', name: $('#svName').value || (tab && tab.title) || '',
      url: tab && tab.url, desc: $('#svDesc').value,
    });
    if (!r || !r.ok) throw new Error((r && r.error) || 'AI 分析失败');
    if (r.catId && curCats.find(c => c.id === r.catId)) $('#svCat').value = r.catId;
    if (r.desc) $('#svDesc').value = r.desc;
    savedTags = (r.tags || []).slice(0, 4);
    renderTags();
    toast('AI 分析完成');
  } catch (e) {
    toast(e.message === 'NO_AUTH' ? '会话已失效，请重新登录' : e.message, true);
  } finally {
    btn.disabled = false; spin.hidden = true;
  }
});

$('#btnSavePick').addEventListener('click', async () => {
  const tab = await currentTab();
  if (!tab || !/^https?:/i.test(tab.url || '')){
    toast('当前页面不是普通网页，无法收藏', true);
    return;
  }
  const r = await send({
    type: 'CARD_SAVE',
    name: $('#svName').value.trim() || tab.title || tab.url,
    url: tab.url, cat: $('#svCat').value || 'none',
    desc: $('#svDesc').value.trim(), tags: savedTags,
  });
  if (r && r.ok){
    const name = (curCats.find(c => c.id === r.cat) || {}).name || '未分类';
    toast(`已收藏到「${name}」分类`);
  } else {
    toast((r && r.error) === 'NO_AUTH' ? '会话已失效，请重新登录' : (r && r.error) || '收藏失败', true);
  }
});

/* ---------- 同步 ---------- */
function showConfirm(title, sub, okText, onOk){
  $('#modalTitle').textContent = title;
  $('#modalSub').textContent = sub;
  $('#modalOkText').textContent = okText;
  openModal();
  $('#modalOk').onclick = async () => {
    $('#modalOk').disabled = true; $('#modalSpin').hidden = false;
    try { await onOk(); } catch (e) {
      toast((e && e.message) || '操作失败', true);
    } finally {
      $('#modalOk').disabled = false; $('#modalSpin').hidden = true;
      closeModal();
    }
  };
  $('#modalCancel').onclick = () => { closeModal(); };
}

$('#btnSync').addEventListener('click', async () => {
  const btn = $('#btnSync'), spin = $('#syncSpin');
  btn.disabled = true; spin.hidden = false;
  const r = await send({ type: 'SYNC_NOW' });
  spin.hidden = true; btn.disabled = false;
  if (r && r.needConfirm){
    showConfirm(
      '将万事屋书签同步到浏览器？',
      '这会清空浏览器书签栏中的全部书签与文件夹，替换为万事屋中的分类与书签（含顺序）。点击确定后，会先自动下载一份当前浏览器书签的备份文件，再执行同步。',
      '备份并同步',
      async () => {
        const c = await send({ type: 'CONFIRM_SYNC' });
        if (c && c.ok) toast(`同步完成：${c.total ?? 0} 个书签` + (c.skippedCount ? `（${c.skippedCount} 个无效地址已跳过）` : ''));
        else toast((c && c.error) || '同步失败', true);
        render();
      });
    return;
  }
  if (r && !r.ok) toast(r.error === 'NO_AUTH' ? '会话已失效，请重新登录' : r.error, true);
  else toast(r && !r.changed ? '已是最新，无需更新' : '同步完成');
  render();
});

$('#btnImport').addEventListener('click', async () => {
  showConfirm(
    '将浏览器书签导入万事屋？',
    '这会清空万事屋中现有的全部书签与自定义分类，替换为浏览器书签栏的内容（文件夹将转为分类）。服务端会先自动备份一份当前数据，可在「数据与存储」中恢复。',
    '清空并导入',
    async () => {
      const btn = $('#btnImport'), spin = $('#importSpin');
      btn.disabled = true; spin.hidden = false;
      const r = await send({ type: 'IMPORT_TO_SERVER' });
      spin.hidden = true; btn.disabled = false;
      if (r && r.ok){
        toast(`导入完成：${r.bmCount} 个书签 / ${r.catCount} 个分类`);
        send({ type: 'CHECK_CHANGES' });   // 导入后立即镜像回书签栏
      } else {
        toast((r && r.error) === 'NO_AUTH' ? '会话已失效，请重新登录' : (r && r.error) || '导入失败', true);
      }
      render();
    });
});

/* ---------- 设置 ---------- */
/* 读取自定义同步间隔（分钟）：非法 / 越界时回落到 30 */
function readIntervalMin(){
  const v = Math.round(Number($('#inInterval').value));
  if (!Number.isFinite(v) || v < 1) return 30;
  return Math.min(v, 43200);   // 上限 30 天，避免输入失控
}
async function saveSettings(){
  const settings = {
    autoSync: $('#swAuto').classList.contains('on'),
    intervalMin: $('#selInterval').value === 'custom'
      ? readIntervalMin() : (Number($('#selInterval').value) || 30),
    skipHiddenCats: $('#swSkipHidden').classList.contains('on'),
  };
  if ($('#selInterval').value === 'custom') $('#inInterval').value = settings.intervalMin;
  await send({ type: 'SAVE_SETTINGS', settings });
}
$('#swAuto').addEventListener('click', async () => {
  $('#swAuto').classList.toggle('on');
  $('#rowInterval').style.opacity = $('#swAuto').classList.contains('on') ? '' : '.4';
  await saveSettings();
});
/* 预设档位即选即存；选「自定义」时展开分钟输入框，等用户录入后再保存 */
$('#selInterval').addEventListener('change', async () => {
  const custom = $('#selInterval').value === 'custom';
  const inn = $('#inInterval');
  inn.hidden = !custom; inn.style.display = custom ? '' : 'none';
  if (custom){ inn.value = readIntervalMin(); inn.focus(); return; }
  await saveSettings();
});
$('#inInterval').addEventListener('change', saveSettings);
$('#swSkipHidden').addEventListener('click', async () => {
  $('#swSkipHidden').classList.toggle('on');
  await saveSettings();
  send({ type: 'CHECK_CHANGES' });   // 开关变化后重新比对
});

/* ---------- 快捷入口 ---------- */
$('#btnOpenSite').addEventListener('click', async () => {
  const r = await send({ type: 'GET_STATE' });
  if (r && r.auth && r.auth.server) chrome.tabs.create({ url: r.auth.server });
});

/* 打开面板：先兜底强制关闭弹窗/提示，再静默比对服务端，万事屋有变动即时同步 */
(async () => {
  closeModal();
  const t = $('#toast'); t.hidden = true; t.style.display = 'none';
  await render();
  const r = await send({ type: 'GET_STATE' });
  if (r && r.auth && r.auth.token) send({ type: 'CHECK_CHANGES' });
})();
