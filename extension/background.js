/* ============================================================
   OmniHome 插件 · 后台（MV3 Service Worker）
   - 右键菜单：唤起当前页面内的保存卡片（选分类 / AI 分析）
   - 同步引擎：书签栏全量镜像万事屋（分类文件夹 + 顺序），
     指纹比对无变化跳过；首次同步需用户确认并自动备份浏览器书签
   - 变动探测：万事屋页面的内容脚本钩子触发即时同步
   - 反向导入：浏览器书签栏一键覆盖导入万事屋（服务端先备份）
   ============================================================ */
import { getAuth, saveAuth, clearAuth, api, getCats, getBookmarks } from './api.js';

const ROOT_TITLE = 'OmniHome 快捷导航';
const K_STATE = 'omni_sync_state';
const K_SETTINGS = 'omni_settings';
const ALARM = 'omni-sync';
const DEFAULT_SETTINGS = { autoSync: true, intervalMin: 30, skipHiddenCats: false };

/* ---------- 状态读写 ---------- */
async function getState(){
  const r = await chrome.storage.local.get(K_STATE);
  return r[K_STATE] || null;
}
async function setState(patch){
  const cur = (await getState()) || {};
  await chrome.storage.local.set({ [K_STATE]: { ...cur, ...patch } });
}
async function getSettings(){
  const r = await chrome.storage.local.get(K_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(r[K_SETTINGS] || {}) };
}
function badge(text, color){
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}
const rid = () => Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-4);
const isHttpUrl = u => /^https?:\/\//i.test(String(u || '').trim());

/* ---------- 右键菜单 ---------- */
async function rebuildMenus(){
  await chrome.contextMenus.removeAll();
  const auth = await getAuth();
  if (!auth){
    chrome.contextMenus.create({
      id: 'omni-login', title: '收进 OmniHome 快捷导航（请先在插件中登录）',
      contexts: ['page'],
    });
    return;
  }
  chrome.contextMenus.create({
    id: 'omni-parent', title: '收进 OmniHome 快捷导航', contexts: ['page'],
  });
  const state = await getState();
  const cats = (state && state.catList) || [];
  for (const c of cats){
    if (c.id === 'all') continue;
    chrome.contextMenus.create({
      id: 'omni-cat-' + c.id, parentId: 'omni-parent',
      title: '存到「' + c.name + '」', contexts: ['page'],
    });
  }
  chrome.contextMenus.create({
    id: 'omni-custom', parentId: 'omni-parent',
    title: '选择分类并保存…', contexts: ['page'],
  });
}

/* 在当前页面内弹出保存卡片（不再新开标签页） */
async function openCardInTab(tab, preselect){
  if (!tab || !tab.url || !isHttpUrl(tab.url)){
    badge('!', '#ef4444');
    setTimeout(() => badge(''), 2500);
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'OMNI_OPEN_CARD', url: tab.url, title: tab.title || '',
      preselect: preselect || '',
    });
  } catch (e) {
    /* 内容脚本尚未注入（刚装扩展 / 特殊页面）：回退为直接保存 */
    try { await quickAdd(tab, preselect || 'none'); } catch (e2) { /* quickAdd 已落状态 */ }
  }
}

async function quickAdd(tab, cat){
  try {
    await api('POST', '/api/bookmarks', {
      name: tab.title || tab.url, url: tab.url, cat,
    });
    badge('✓', '#10b981');
    setTimeout(() => badge(''), 2500);
    setTimeout(() => runAutoCycle().catch(() => {}), 1200);
  } catch (e) {
    badge('!', '#ef4444');
    await setState({ lastError: e.message, lastErrorTs: Date.now() });
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !tab.url || /^(chrome|edge|about):/i.test(tab.url)) return;
  if (info.menuItemId === 'omni-login'){
    chrome.notifications.create({
      type: 'basic', iconUrl: 'icons/icon128.png',
      title: 'OmniHome 快捷导航',
      message: '请先点击浏览器右上角插件图标，填写服务器地址并登录。',
    });
    return;
  }
  if (info.menuItemId === 'omni-custom'){
    openCardInTab(tab, '');
    return;
  }
  const mid = String(info.menuItemId);
  if (mid.startsWith('omni-cat-')) openCardInTab(tab, mid.slice('omni-cat-'.length));
});

/* ---------- 同步引擎（书签栏全量镜像万事屋） ---------- */
function fingerprint(cats, bms, flags){
  const slimC = cats.map(c => [c.id, c.name, !!c.hidden]);
  const slimB = bms.map(b => [b.id, b.name, b.url, b.cat || '', b.order || 0]);
  return JSON.stringify([slimC, slimB, flags]);
}

/* 拉取服务端数据；非法地址（空 / 非 http）的书签跳过并计数，
   避免单条坏数据抛 "Invalid URL" 中断整个同步 */
async function fetchServer(){
  const [catsRaw, bmsRaw] = await Promise.all([getCats(), getBookmarks()]);
  /* 服务端异常返回非数组时兜底为空，避免后续 map/for 抛出难懂的错误 */
  const cats = Array.isArray(catsRaw) ? catsRaw : [];
  const bms = Array.isArray(bmsRaw) ? bmsRaw : [];
  const valid = [], skipped = [];
  for (const b of bms){
    if (isHttpUrl(b.url)) valid.push(b);
    else skipped.push(b.name || '(未命名)');
  }
  return { cats, bms: valid, skipped };
}

function buildPlan(cats, bms, settings){
  const list = Array.isArray(cats) ? cats : [];
  const catIds = new Set(list.map(c => c.id));
  const groups = new Map();
  const ordered = [...bms].sort((a, b) => (a.order || 0) - (b.order || 0));
  for (const b of ordered){
    const cid = catIds.has(b.cat) ? b.cat : 'none';
    if (!groups.has(cid)) groups.set(cid, []);
    groups.get(cid).push(b);
  }
  const plan = [];
  for (const c of list){
    if (c.id === 'all') continue;
    if (settings.skipHiddenCats && c.hidden) continue;   // 选项：不同步隐藏分类
    if (c.id === 'none' && !groups.has('none')) continue; // 未分类为空不建夹
    plan.push({ ...c, bms: groups.get(c.id) || [] });
  }
  return plan;
}

/* 清空书签栏全部内容，按万事屋的分类与顺序原样重建 */
async function mirrorBar(plan){
  const tree = await chrome.bookmarks.getTree();
  const treeRoot = tree && tree[0];
  /* 部分内核 / 极端状态下根节点可能缺 children，统一兜底并给出可读报错 */
  if (!treeRoot || !Array.isArray(treeRoot.children)){
    throw new Error('无法读取浏览器书签结构，请重试或检查浏览器书签权限');
  }
  const bar = treeRoot.children.find(n => !n.url);
  if (!bar) throw new Error('找不到浏览器书签栏');
  for (const child of bar.children || []){
    await chrome.bookmarks.removeTree(child.id);
  }
  let created = 0;
  for (const g of plan){
    const title = g.id === 'none' ? '未分类' : g.name;
    const folder = await chrome.bookmarks.create({ parentId: bar.id, title });
    let i = 0;
    for (const bm of g.bms){
      await chrome.bookmarks.create({
        parentId: folder.id, title: bm.name || bm.url, url: bm.url, index: i++,
      });
      created++;
    }
  }
  return created;
}

/* 已确认后的实际同步 */
async function syncAll(reason){
  const auth = await getAuth();
  if (!auth) throw new Error('NO_AUTH');
  const settings = await getSettings();
  const { cats, bms, skipped } = await fetchServer();
  const fp = fingerprint(cats, bms, !!settings.skipHiddenCats);
  const prev = await getState();
  if (reason === 'auto' && prev && prev.fingerprint === fp){
    await setState({ lastSync: Date.now(), lastResult: '无变化', lastError: '' });
    return { changed: false, total: bms.length };
  }
  const plan = buildPlan(cats, bms, settings);
  await mirrorBar(plan);
  await setState({
    lastSync: Date.now(), fingerprint: fp, total: bms.length,
    catCount: plan.length, skippedCount: skipped.length,
    catList: cats.filter(c => c.id !== 'all'),
    firstConfirmed: true, lastResult: '已同步', lastError: '',
  });
  badge('');
  await rebuildMenus();
  return { changed: true, total: bms.length, skippedCount: skipped.length };
}

/* 自动轮询 / 变动触发统一入口：首次确认前只刷新缓存不动书签 */
async function runAutoCycle(){
  const prev = await getState();
  if (!prev || !prev.firstConfirmed){
    try {
      const { cats } = await fetchServer();
      await setState({ catList: cats.filter(c => c.id !== 'all') });
      await rebuildMenus();
    } catch (e) { /* 下个周期重试 */ }
    return { changed: false, needConfirm: true };
  }
  return syncAll('auto');
}

/* ---------- 浏览器书签备份（Netscape HTML，浏览器可直接导入） ---------- */
const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function exportBookmarksHtml(){
  const tree = await chrome.bookmarks.getTree();
  const root = tree && tree[0];
  if (!root || !Array.isArray(root.children)){
    throw new Error('无法读取浏览器书签结构，备份失败');
  }
  const lines = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>', '<H1>Bookmarks</H1>', '<DL><p>'];
  const walk = (nodes, depth) => {
    const pad = '    '.repeat(depth);
    for (const n of nodes){
      if (n.url){
        lines.push(pad + '<DT><A HREF="' + escHtml(n.url) + '">' + escHtml(n.title || n.url) + '</A>');
      } else {
        lines.push(pad + '<DT><H3>' + escHtml(n.title || '') + '</H3>');
        lines.push(pad + '<DL><p>');
        walk(n.children || [], depth + 1);
        lines.push(pad + '</DL><p>');
      }
    }
  };
  walk(root.children || [], 1);
  lines.push('</DL><p>');
  return lines.join('\n');
}

async function backupAndDownload(){
  const html = await exportBookmarksHtml();
  const now = new Date(), p = n => String(n).padStart(2, '0');
  const name = `omnihome-bookmarks-backup-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.html`;
  /* MV3 Service Worker 里没有 URL.createObjectURL（Blob URL 仅限页面环境），
     改用 data: URL 交给下载接口，效果等同 */
  const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
  await chrome.downloads.download({ url, filename: name, saveAs: false });
}

/* ---------- 反向导入：浏览器书签栏 → 万事屋（先清空服务端再写入） ---------- */
async function importBrowserToServer(){
  const auth = await getAuth();
  if (!auth) throw new Error('NO_AUTH');
  /* 服务端先备份一份当前数据，可回滚 */
  await api('POST', '/api/data/backup', {}).catch(() => {});
  const tree = await chrome.bookmarks.getTree();
  const treeRoot = tree && tree[0];
  if (!treeRoot || !Array.isArray(treeRoot.children)){
    throw new Error('无法读取浏览器书签结构，导入失败');
  }
  const bar = treeRoot.children.find(n => !n.url);
  if (!bar) throw new Error('找不到浏览器书签栏');
  /* 「其他书签」若有内容一并纳入 */
  const other = treeRoot.children.find(
    n => !n.url && n.id !== bar.id && (n.children || []).length);
  const cats = [{ id: 'all', name: '全部' }, { id: 'common', name: '常用' }];
  const bms = [];
  let order = 0;
  const pushBm = (n, cat) => {
    if (!isHttpUrl(n.url)) return;
    bms.push({ id: rid(), name: n.title || n.url, url: n.url, cat,
               hue: Math.floor(Math.random() * 360), order: order++,
               icon: '', desc: '', tags: [] });
  };
  const walkFolder = (nodes, cat) => {
    for (const m of nodes){
      if (m.url) pushBm(m, cat);
      else walkFolder(m.children || [], cat);
    }
  };
  const sources = other ? [bar, other] : [bar];
  for (const src of sources){
    for (const n of src.children || []){
      if (n.url){ pushBm(n, 'common'); continue; }
      if (n.title === ROOT_TITLE) continue;   // 托管文件夹不回灌自身
      const cid = rid();
      cats.push({ id: cid, name: n.title || '导入文件夹' });
      walkFolder(n.children || [], cid);
    }
  }
  cats.push({ id: 'none', name: '未分类' });
  await api('PUT', '/api/bookmark-cats', cats);
  await api('PUT', '/api/bookmarks', bms);
  await setState({ fingerprint: '', lastError: '' });   // 强制下次同步重建
  return { catCount: cats.length - 2, bmCount: bms.length };
}

/* ---------- 定时任务 ---------- */
async function setupAlarm(){
  const s = await getSettings();
  await chrome.alarms.clear(ALARM);
  if (s.autoSync){
    chrome.alarms.create(ALARM, { periodInMinutes: Math.max(1, s.intervalMin) });
  }
}
chrome.alarms.onAlarm.addListener(async a => {
  if (a.name !== ALARM) return;
  try { await runAutoCycle(); }
  catch (e) {
    badge('!', '#ef4444');
    await setState({ lastError: e.message, lastErrorTs: Date.now() });
  }
});

/* 万事屋页面内增删书签 / 分类后的即时探测（2 秒防抖） */
let changeTimer = null;
function onServerChanged(){
  clearTimeout(changeTimer);
  changeTimer = setTimeout(async () => {
    try { await runAutoCycle(); } catch (e) { /* 静默，等下次轮询 */ }
  }, 2000);
}

/* ---------- 消息 ---------- */
chrome.runtime.onMessage.addListener((msg, sender, send) => {
  (async () => {
    switch (msg.type){
      case 'GET_STATE': {
        send({ auth: await getAuth(), state: await getState(), settings: await getSettings() });
        return;
      }
      case 'LOGIN_DONE': {
        /* 立即应答：不再登录即同步；首次同步由用户在弹窗确认后执行 */
        await setState({ lastError: '', fingerprint: '', firstConfirmed: false });
        try {
          const { cats } = await fetchServer();
          await setState({ catList: cats.filter(c => c.id !== 'all') });
        } catch (e) { /* 菜单稍后随轮询刷新 */ }
        await rebuildMenus();
        await setupAlarm();
        send({ ok: true });
        return;
      }
      case 'LOGOUT': {
        await clearAuth();
        await setState({ firstConfirmed: false, fingerprint: '', lastError: '' });
        await rebuildMenus();
        send({ ok: true });
        return;
      }
      case 'SYNC_NOW': {
        const prev = await getState();
        if (!prev || !prev.firstConfirmed){ send({ ok: true, needConfirm: true }); return; }
        try {
          const r = await syncAll('manual');
          send({ ok: true, ...r });
        } catch (e) {
          await setState({ lastError: e.message, lastErrorTs: Date.now() });
          send({ ok: false, error: e.message });
        }
        return;
      }
      case 'CONFIRM_SYNC': {
        try {
          await backupAndDownload();            // 先自动备份浏览器书签
          await setState({ firstConfirmed: true });
          const r = await syncAll('manual');
          send({ ok: true, ...r });
        } catch (e) {
          await setState({ lastError: e.message, lastErrorTs: Date.now() });
          send({ ok: false, error: e.message });
        }
        return;
      }
      case 'CHECK_CHANGES': {
        try {
          const settings = await getSettings();
          const { cats, bms } = await fetchServer();
          const fp = fingerprint(cats, bms, !!settings.skipHiddenCats);
          const prev = await getState();
          await setState({ catList: cats.filter(c => c.id !== 'all'), lastCheck: Date.now() });
          await rebuildMenus();
          if (prev && prev.fingerprint === fp){ send({ ok: true, changed: false }); return; }
          if (!prev || !prev.firstConfirmed){ send({ ok: true, changed: true, needConfirm: true }); return; }
          const r = await syncAll('auto');
          send({ ok: true, ...r });
        } catch (e) { send({ ok: false, error: e.message }); }
        return;
      }
      case 'IMPORT_TO_SERVER': {
        try {
          const r = await importBrowserToServer();
          send({ ok: true, ...r });
        } catch (e) { send({ ok: false, error: e.message }); }
        return;
      }
      case 'SAVE_SETTINGS': {
        await chrome.storage.local.set({ [K_SETTINGS]: msg.settings });
        await setupAlarm();
        send({ ok: true });
        return;
      }
      case 'BOOKMARK_ADDED': {
        setTimeout(() => runAutoCycle().catch(() => {}), 1200);
        send({ ok: true });
        return;
      }
      case 'OMNI_CHANGED': {
        onServerChanged();
        send({ ok: true });
        return;
      }
      /* ---------- 页内保存卡片（内容脚本） ---------- */
      case 'CARD_STATE': {
        const auth = await getAuth();
        const st = await getState();
        send({ logged: !!(auth && auth.token), cats: (st && st.catList) || [] });
        return;
      }
      case 'CARD_SAVE': {
        try {
          if (!isHttpUrl(msg.url)) throw new Error('当前页面地址不是普通网页，无法收藏');
          const bm = await api('POST', '/api/bookmarks', {
            name: msg.name || msg.url, url: msg.url, cat: msg.cat || 'none',
            desc: msg.desc || '', tags: msg.tags || [],
          });
          setTimeout(() => runAutoCycle().catch(() => {}), 1200);
          send({ ok: true, cat: bm.cat });
        } catch (e) { send({ ok: false, error: e.message }); }
        return;
      }
      case 'CARD_AI': {
        try {
          const st = await getState();
          const cats = ((st && st.catList) || [])
            .filter(c => c.id !== 'none' && c.id !== 'all');
          const r = await api('POST', '/api/ai/analyze-bookmark', {
            name: msg.name || '', url: msg.url || '', desc: msg.desc || '',
            cats: cats.map(c => ({ id: c.id, name: c.name })),
          });
          send({ ok: true, ...r });
        } catch (e) { send({ ok: false, error: e.message }); }
        return;
      }
      default: send({ ok: false, error: 'unknown message' });
    }
  })().catch(e => send({ ok: false, error: e.message }));
  return true;   // 异步 sendResponse
});

/* ---------- 生命周期 ---------- */
chrome.runtime.onInstalled.addListener(async () => {
  await rebuildMenus();
  await setupAlarm();
});
chrome.runtime.onStartup.addListener(async () => {
  await setupAlarm();
  try { await runAutoCycle(); } catch (e) { /* 下次轮询重试 */ }
});
