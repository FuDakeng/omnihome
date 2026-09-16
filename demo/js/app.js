/* ============================================================
   OmniDesk · 核心状态
   当前用户、偏好（主题/主色/密度）、门控、通用工具。
   ============================================================ */
const App = (() => {
  let user = null;
  let prefs = null;
  const listeners = [];
  const readyListeners = [];
  let shareNeedLogin = false;
  let inboxTimer = 0;

  /* ---------- 偏好 → 页面 ---------- */
  function applyPrefs(p){
    prefs = p || prefs;
    if (!prefs) return;
    if (typeof setMode === 'function' && prefs.theme && prefs.theme.mode){
      setMode(prefs.theme.mode);
    }
    if (typeof setAccent === 'function' && prefs.theme){
      setAccent(prefs.theme.hue, (prefs.theme.sat || 72) + '%');
    }
    const layout = prefs.layout || {};
    const compact = !!layout.compact;
    const reduceMotion = !!layout.reduceMotion;
    document.documentElement.dataset.compact = compact ? 'on' : 'off';
    document.documentElement.dataset.motion = reduceMotion ? 'off' : 'on';
    try {
      localStorage.setItem('om_layout_compact', compact ? '1' : '0');
      localStorage.setItem('om_layout_motion', reduceMotion ? '1' : '0');
    } catch (e) { /* 隐私模式等无法写入时跳过，登录后仍由服务端偏好生效 */ }
  }

  /* 头像渲染：有自定义头像时用图片填充，否则回首字母 */
  function renderAvatar(av, u){
    const initial = (u.nickname || u.username || '?').trim().slice(0, 2).toUpperCase();
    if (u.avatar){
      av.textContent = '';
      av.style.backgroundImage = `url(${u.avatar})`;
      av.style.backgroundSize = 'cover';
      av.style.backgroundPosition = 'center';
    } else {
      av.textContent = initial;
      av.style.backgroundImage = '';
      av.style.backgroundSize = '';
      av.style.backgroundPosition = '';
    }
  }

  function applyUser(u){
    user = u;
    if (!u) return;
    $$('.avatar').forEach(av => {
      /* 只替换带用户信息语义的头像，弹窗中的示例头像由各自模块管理 */
      if (av.closest('.m-user, .set-row, .lock-panel')) return;
      renderAvatar(av, u);
    });
    $$('.user-chip .user-name, .menu-head .user-name').forEach(el =>
      el.textContent = u.nickname || u.username);
    const planLabel = u.role === 'admin' ? '管理员' : '成员';
    const sub = $('.user-chip .user-plan');
    if (sub) sub.textContent = planLabel + ' · 在线';
    const mail = $('.menu-head .user-plan');
    if (mail) mail.textContent = planLabel + ' · @' + u.username;
  }

  /* ---------- 登录门控（独立登录页：未登录时隐藏主界面，不再模糊展示） ---------- */
  function lock(showAuth){
    /* 需登录分享已判定要出登录页时，boot 末尾的 lock(false) 不得再把登录藏掉（Safari 上尤其容易白屏） */
    if (shareNeedLogin && showAuth === false) showAuth = true;
    if (showAuth !== false) $('#authScreen').classList.add('open');
    else $('#authScreen').classList.remove('open');
    $('.app').hidden = true;
  }
  function unlock(){
    shareNeedLogin = false;
    $('#authScreen').classList.remove('open');
    $('.app').hidden = false;
  }
  function setShareNeedLogin(v){
    shareNeedLogin = !!v;
    if (shareNeedLogin){
      const sub = $('#authSub');
      if (sub) sub.textContent = '此分享需要登录后查看';
    }
  }
  function fireReady(){
    readyListeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
  }

  function shareTokenFromUrl(){
    try { return new URLSearchParams(location.search).get('s') || ''; }
    catch (_) { return ''; }
  }

  function onUnauthorized(){
    API.setToken(null);
    user = null;
    lock();
  }

  /* 登录态解析完毕后撤掉启动遮罩（首屏不再闪现登录页） */
  function finishBoot(){
    const s = $('#bootSplash');
    if (s) s.classList.add('gone');
  }

  async function boot(){
    const hasToken = !!API.getToken();
    /* 两个接口互不依赖，并行发起：少一次串行往返，遮罩停留时间减半 */
    const [first, sess] = await Promise.all([
      API.get('/api/auth/first').catch(() => null),
      hasToken ? API.get('/api/auth/session').catch(() => null)
               : Promise.resolve(null),
    ]);

    if (sess && sess.user){
      await enter(sess.user, false);
      finishBoot();
      return;
    }

    if (hasToken) API.setToken(null);      // 会话已失效，清掉残留 token
    if (first){
      Auth.setup(first);   // 根据 hasUsers / allowRegister 决定登录页形态
    } else {
      /* 后端不可达：明说原因，别让用户对着登录页干等 */
      const sub = $('#authSub');
      if (sub) sub.textContent = '无法连接万事屋服务，请检查服务是否已启动';
    }
    /* 无需登录的分享链：先不盖登录页（登录页 z-index 高于分享层）。
       需登录分享会在打开失败时再 lock()。 */
    lock(!shareTokenFromUrl());
    finishBoot();
    fireReady();
  }

  async function enter(u, reload){
    applyUser(u);
    prefs = await API.get('/api/settings').catch(() => null);
    applyPrefs(prefs);
    unlock();
    listeners.forEach(fn => { try { fn(u); } catch (e) { console.error(e); } });
    refreshInbox();
    if (!inboxTimer) inboxTimer = setInterval(refreshInbox, 20000);
    checkVersionUpdate();
    if (reload) location.reload();
  }

  /* ---------- 版本更新推送：首次进入新版本时弹窗展示更新日志 ---------- */
  const SEEN_KEY = 'om_seen_version';
  async function checkVersionUpdate(){
    try {
      const a = await API.get('/api/about');
      const seen = localStorage.getItem(SEEN_KEY);
      if (a.version && a.version !== seen){
        localStorage.setItem(SEEN_KEY, a.version);
        showChangelog(a);
      }
    } catch (e) { /* 后端不可达时跳过 */ }
  }

  function showChangelog(a){
    $('#changelogSub').textContent = `v${a.version} · ${a.stage}`;
    $('#changelogBody').innerHTML = (a.changelog || []).map(v => `
      <div class="cl-ver">
        <div class="cl-head">
          <span class="chip primary no-dot num">v${esc(v.version)}</span>
          <span class="num" style="font-size:11px;color:var(--om-text-3)">${esc(v.date || '')}</span>
        </div>
        <ul class="cl-items">${(v.items || []).map(i => `<li>${esc(i)}</li>`).join('')}</ul>
      </div>`).join('') ||
      '<div style="font-size:12px;color:var(--om-text-3)">暂无更新记录</div>';
    openModal('changelogMask');
  }

  async function logout(){
    await API.post('/api/auth/logout').catch(() => {});
    API.setToken(null);
    location.reload();
  }

  /* ---------- 通用工具 ---------- */
  function openModal(id){ $('#' + id).classList.add('open'); }
  function closeModal(id){ $('#' + id).classList.remove('open'); }

  /* ---------- 统一输入 / 确认弹窗（替代 prompt / confirm，样式与业务弹窗一致） ---------- */
  let promptResolver = null;
  let confirmResolver = null;

  function promptModal(opts = {}){
    return new Promise(resolve => {
      $('#promptTitle').textContent = opts.title || '请输入';
      $('#promptSub').textContent = opts.sub || '';
      $('#promptSub').hidden = !opts.sub;
      const input = $('#promptValue');
      input.placeholder = opts.placeholder || '';
      input.value = opts.value || '';
      promptResolver = resolve;
      openModal('promptMask');
      setTimeout(() => { input.focus(); input.select(); }, 60);
    });
  }

  function finishPrompt(v){
    if (!promptResolver) return;
    const r = promptResolver;
    promptResolver = null;
    closeModal('promptMask');
    r(v);
  }

  function confirmModal(opts = {}){
    return new Promise(resolve => {
      $('#confirmTitle').textContent = opts.title || '请确认';
      $('#confirmTitle').classList.toggle('warn', !!opts.warning);
      $('#confirmSub').textContent = opts.sub || '';
      $('#confirmSub').hidden = !opts.sub;
      $('#confirmSub').classList.toggle('warn', !!opts.warning);
      $('#confirmBox')?.classList.toggle('modal-warn', !!opts.warning);
      const ok = $('#confirmOk');
      ok.innerHTML = `<svg class="ic"><use href="#i-check"/></svg>${opts.okText || '确定'}`;
      ok.classList.toggle('danger', !!opts.danger && !opts.warning);
      ok.classList.toggle('warning', !!opts.warning);
      confirmResolver = resolve;
      openModal('confirmMask');
    });
  }

  function finishConfirm(v){
    if (!confirmResolver) return;
    const r = confirmResolver;
    confirmResolver = null;
    closeModal('confirmMask');
    r(v);
  }

  function esc(s){
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function fmtBytes(n){
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  async function refreshInbox(){
    if (!API.getToken()) return;
    try {
      const d = await API.get('/api/inbox');
      const items = d.items || [];
      const n = d.unread || 0;
      const dot = $('#inboxDot');
      if (dot) dot.hidden = !n;
      const list = $('#inboxList');
      if (!list) return;
      if (!items.length){ list.innerHTML = '<div class="kb-empty" style="padding:18px">暂无通知</div>'; return; }
      list.innerHTML = items.map(x => {
        const need = x.type === 'sync-approval' && !x.action;
        return `<div class="inbox-item${x.read ? '' : ' unread'}" data-iid="${esc(x.id)}">
          <div class="t">${esc(x.title || '通知')}</div>
          <div class="b">${esc(x.body || '')}</div>
          ${need ? '<div class="ops"><button class="btn btn-primary btn-sm" data-in-act="approve">同意</button><button class="btn btn-ghost btn-sm" data-in-act="deny">拒绝</button></div>' : ''}
        </div>`;
      }).join('');
    } catch (_) {}
  }

  return {
    get user(){ return user; },
    get prefs(){ return prefs; },
        applyPrefs, applyUser, renderAvatar,
    boot, enter, lock, unlock, onUnauthorized, logout,
    shareTokenFromUrl, setShareNeedLogin,
    onEnter: fn => listeners.push(fn),
    onReady: fn => readyListeners.push(fn),
    openModal, closeModal, esc, fmtBytes,
    promptModal, confirmModal, showChangelog, refreshInbox,
    _finishPrompt: finishPrompt, _finishConfirm: finishConfirm,
  };
})();

/* 统一弹窗内部事件（输入弹窗的确定 / 取消 / 回车，确认弹窗按钮） */
(() => {
  $('#promptOk').addEventListener('click', () => {
    const v = $('#promptValue').value.trim();
    App._finishPrompt(v || null);
  });
  $('#promptCancel').addEventListener('click', () => App._finishPrompt(null));
  $('#promptValue').addEventListener('keydown', e => {
    if (e.key === 'Enter'){
      e.preventDefault();
      const v = e.target.value.trim();
      App._finishPrompt(v || null);
    }
    if (e.key === 'Escape') App._finishPrompt(null);
  });
  $('#confirmOk').addEventListener('click', () => App._finishConfirm(true));
  $('#confirmCancel').addEventListener('click', () => App._finishConfirm(false));
  $('#changelogOk').addEventListener('click', () => App.closeModal('changelogMask'));
  $('#bellBtn')?.addEventListener('click', e => {
    e.stopPropagation();
    const p = $('#inboxPanel');
    if (!p) return;
    p.hidden = !p.hidden;
    if (!p.hidden) App.refreshInbox();
  });
  $('#inboxList')?.addEventListener('click', async e => {
    const act = e.target.closest('[data-in-act]');
    const item = e.target.closest('[data-iid]');
    if (!item) return;
    const iid = item.dataset.iid;
    try {
      if (act){
        await API.put('/api/inbox/' + encodeURIComponent(iid), { action: act.dataset.inAct, read: true });
      } else {
        await API.put('/api/inbox/' + encodeURIComponent(iid), { read: true });
      }
      App.refreshInbox();
    } catch (err) { showToast(err.message, 'err'); }
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('#inboxPanel') && !e.target.closest('#bellBtn')){
      const p = $('#inboxPanel');
      if (p) p.hidden = true;
    }
  });
})();

/* 全局弹窗关闭：点遮罩 / Esc */
document.addEventListener('click', e => {
  const mask = e.target.closest('.modal-mask');
  if (mask && e.target === mask && mask.id !== 'authScreen'){
    mask.classList.remove('open');
    /* 统一弹窗需要兑现 Promise */
    if (mask.id === 'promptMask') App._finishPrompt(null);
    if (mask.id === 'confirmMask') App._finishConfirm(false);
    if (mask.id === 'kbShareViewMask' && !API.getToken()) App.lock();
  }
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if ($('#confirmMask').classList.contains('open')) App._finishConfirm(false);
});

export { App };
window.App = App;
