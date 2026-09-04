/* ============================================================
   OmniDesk · 设置中心 + 多用户
   外观 / 账号 / 数据 / 关于 四分区实际生效并持久化。
   ============================================================ */
(() => {
  /* ---------- 读取当前界面状态 ---------- */
  function segValue(sel){
    const btn = $(sel + ' .seg-btn.active');
    return btn ? btn.dataset.value ?? btn.textContent.trim() : null;
  }
  function collect(){
    const hue = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--om-hue'), 10) || 243;
    const sat = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--om-sat'), 10) || 72;
    const mode = $('#modeSeg .seg-btn.active');
    return {
      theme: { mode: mode ? mode.dataset.mode : 'dark', hue, sat },
      layout: {
        compact: $('#densitySeg .seg-btn.active')?.dataset.density === 'compact',
        reduceMotion: $('#motionSwitch').classList.contains('on'),
      },
      locale: {
        lang: $('#langSelect').value,
        weekStart: $('#weekSeg .seg-btn.active')?.dataset.week || 'mon',
        tempUnit: $('#tempSeg .seg-btn.active')?.dataset.temp || 'c',
      },
    };
  }

  /* ---------- 应用偏好到控件 ---------- */
  function reflectPrefs(){
    const p = App.prefs;
    if (!p) return;
    $$('#densitySeg .seg-btn').forEach(b =>
      b.classList.toggle('active',
        b.dataset.density === (p.layout.compact ? 'compact' : 'cozy')));
    $('#motionSwitch').classList.toggle('on', !!p.layout.reduceMotion);
    $('#langSelect').value = p.locale.lang || 'zh-CN';
    $$('#weekSeg .seg-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.week === (p.locale.weekStart || 'mon')));
    $$('#tempSeg .seg-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.temp === (p.locale.tempUnit || 'c')));
    /* 色板高亮 */
    $$('.swatch[data-hue]').forEach(sw =>
      sw.classList.toggle('on', String(sw.dataset.hue) === String(p.theme.hue)));
  }

  /* ---------- 自动保存 ----------
     底部保存按钮已移除：外观类设置调整后防抖自动持久化，
     其余分区（账号 / 数据 / AI）各有独立保存按钮。 */
  let saveTimer = null;
  function autoSave(){
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const saved = await API.put('/api/settings', collect());
        App.applyPrefs(saved);
      } catch (e) { showToast('设置保存失败：' + e.message, 'err'); }
    }, 300);
  }
  const appearPanel = $('[data-setpanel="appearance"]');
  if (appearPanel){
    /* demo.js 通用绑定先执行，事件冒泡到面板时控件状态已更新，读到的即新值 */
    appearPanel.addEventListener('click', e => {
      if (e.target.closest('.seg-btn, .swatch, .switch')) autoSave();
    });
    appearPanel.addEventListener('change', autoSave);   // 语言下拉等
    appearPanel.addEventListener('input', autoSave);     // 自定义取色等
  }

  /* ---------- 账号 ---------- */
  $('#accSave').addEventListener('click', async () => {
    const nickname = $('#accNick').value.trim();
    try {
      const d = await API.put(`/api/auth/profile?nickname=${encodeURIComponent(nickname)}`);
      App.applyUser(d.user);
      showToast('个人资料已更新');
    } catch (e) { showToast(e.message, 'err'); }
  });

  /* ---------- 头像：选取 → canvas 压缩 → base64 上传 ---------- */
  $('#accAvatarBtn').addEventListener('click', () => $('#accAvatarFile').click());
  $('#accAvatarFile').addEventListener('change', e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) uploadAvatar(f);
  });
  function uploadAvatar(file){
    const img = new Image();
    img.onload = async () => {
      try {
        /* 居中裁切为正方形并压缩到 256px */
        const size = 256;
        const cv = document.createElement('canvas');
        cv.width = cv.height = size;
        const ctx = cv.getContext('2d');
        const s = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2,
                      s, s, 0, 0, size, size);
        let data = cv.toDataURL('image/jpeg', .85);
        if (data.length > 200 * 1024) data = cv.toDataURL('image/jpeg', .6);
        const d = await API.put('/api/auth/avatar', { data });
        App.applyUser(d.user);
        App.renderAvatar($('#accAvatar'), d.user);
        showToast('头像已更新');
      } catch (err) { showToast(err.message, 'err'); }
    };
    img.onerror = () => showToast('图片文件读取失败', 'err');
    img.src = URL.createObjectURL(file);
  }
  $('#accAvatarRemove').addEventListener('click', async () => {
    try {
      const d = await API.put('/api/auth/avatar', { remove: true });
      App.applyUser(d.user);
      App.renderAvatar($('#accAvatar'), d.user);
      showToast('已恢复默认头像');
    } catch (e) { showToast(e.message, 'err'); }
  });

  /* ---------- 登录记录（设备 / 位置 / 时间，后端真实采集） ---------- */
  function fmtLoginTs(ts){
    const d = new Date(ts * 1000), now = new Date();
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hm}`;
  }
  async function loadLogins(){
    try {
      const d = await API.get('/api/auth/logins');
      const list = d.logins || [];
      $('#loginList').innerHTML = list.length ? list.map((x, i) => `
        <div class="qk-row">
          <span class="qk-name" style="width:auto;max-width:180px">${App.esc(x.device || '未知设备')}</span>
          ${i === 0 ? '<span class="chip success">当前设备</span>' : ''}
          <span class="num" style="margin-left:auto;font-size:11px;color:var(--om-text-3)">${App.esc(x.place || '')} · ${fmtLoginTs(x.ts)}</span>
          ${i > 0 ? `<button class="icon-btn-xs" data-login-del="${x.ts}" title="移除记录"><svg class="ic"><use href="#i-close"/></svg></button>` : ''}
        </div>`).join('')
        : '<div style="font-size:12px;color:var(--om-text-3)">暂无登录记录</div>';
    } catch (e) {}
  }
  $('#loginList').addEventListener('click', async e => {
    const del = e.target.closest('[data-login-del]');
    if (!del) return;
    try {
      await API.del('/api/auth/logins/' + del.dataset.loginDel);
      loadLogins();
    } catch (err) { showToast(err.message, 'err'); }
  });

  $('#pcOpen').addEventListener('click', () => {
    $('#pcOld').value = ''; $('#pcNew').value = ''; $('#pcNew2').value = '';
    App.openModal('passMask');
  });
  $('#pcCancel').addEventListener('click', () => App.closeModal('passMask'));
  $('#pcSave').addEventListener('click', async () => {
    const n1 = $('#pcNew').value, n2 = $('#pcNew2').value;
    if (n1.length < 6) return showToast('新密码至少 6 位', 'err');
    if (n1 !== n2) return showToast('两次输入的新密码不一致', 'err');
    try {
      await API.put('/api/auth/password', { oldPassword: $('#pcOld').value, newPassword: n1 });
      App.closeModal('passMask');
      showToast('登录密码已修改');
    } catch (e) { showToast(e.message, 'err'); }
  });

  /* ---------- 多用户管理（管理员） ---------- */
  /* 注册开关：开启后新用户可在登录页自行注册（仅管理员可见） */
  async function loadRegToggle(){
    const row = $('#regToggleRow');
    if (!App.user || App.user.role !== 'admin'){ row.hidden = true; return; }
    row.hidden = false;
    try {
      const f = await API.get('/api/auth/first');
      $('#regEnabled').classList.toggle('on', !!f.allowRegister);
    } catch (e) {}
  }
  $('#regEnabled').addEventListener('click', async () => {
    /* demo.js 的通用绑定已先切换视觉状态，此处读取新状态提交 */
    const next = $('#regEnabled').classList.contains('on');
    try {
      await API.put('/api/auth/register-config', { allowRegister: next });
      showToast(next ? '已开放新用户注册' : '已关闭新用户注册');
    } catch (e) {
      $('#regEnabled').classList.toggle('on', !next);
      showToast(e.message, 'err');
    }
  });

  /* ---------- 功能设置（对所有用户可见；开关仅管理员能改） ---------- */
  async function loadFeatures(){
    /* 浏览器扩展包可用性（对所有用户可见，方便任何人下载安装） */
    try {
      const ec = await API.get('/api/extension/check');
      /* 按钮始终可点：不可用时点击给出原因，避免置灰让用户误以为功能失效 */
      $('#extDownload').dataset.available = ec.available ? '1' : '';
      $('#extState').textContent = ec.available
        ? 'v' + (ec.version || '?') + ' · ' + App.fmtBytes(ec.size)
        : '部署包中未附带';
    } catch (e) { $('#extState').textContent = '检测失败'; }
    const isAdmin = App.user && App.user.role === 'admin';
    /* 菜单项原本 HTML 上 hidden——对所有登录用户解锁（开关另由 adminOnly 块管控） */
    $('#setFeaturesMenu').hidden = false;
    /* 普通用户看到当前状态 + "请联系管理员"提示；管理员看到真正的开关 */
    document.querySelectorAll('.features-admin-only').forEach(el => { el.hidden = isAdmin; });
    try {
      const c = await API.get('/api/system/monitor-config');
      $('#monitorEnabled').classList.toggle('on', !!c.enabled);
    } catch (e) {}
    await loadObsidianSync();
  }
  $('#monitorEnabled').addEventListener('click', async () => {
    /* demo.js 通用绑定已先切换视觉状态，此处读取新状态提交 */
    const next = $('#monitorEnabled').classList.contains('on');
    try {
      await API.put('/api/system/monitor-config', { enabled: next });
      if (App.user) App.user.monitorEnabled = next;   // 免刷新同步侧边栏 / 仪表盘入口
      document.dispatchEvent(new CustomEvent('monitor-gate'));
      showToast(next ? '系统监控已开启' : '系统监控已关闭');
    } catch (e) {
      $('#monitorEnabled').classList.toggle('on', !next);
      showToast(e.message, 'err');
    }
  });
  $('#extDownload').addEventListener('click', () => {
    if ($('#extDownload').dataset.available !== '1'){
      showToast('当前部署包未附带扩展安装包，请用最新部署包重新部署后再下载', 'err');
      return;
    }
    API.dl('/api/extension.zip');
  });

  async function loadUsers(){
    /* 管理员：全部账号（可增删）；普通用户：自己 + 已绑定账号（可解绑） */
    const isAdmin = App.user && App.user.role === 'admin';
    $('#addUserBtn').hidden = !isAdmin;
    $('#userListChip').textContent = isAdmin
      ? '每个用户独立数据空间' : '已绑定账号可互相切换';
    try {
      const users = await API.get('/api/auth/users');
      $('#userList').innerHTML = users.map(u => `
        <div class="set-row">
          <div style="display:flex;align-items:center;gap:12px">
            <span class="avatar">${App.esc((u.nickname || u.username).slice(0, 2).toUpperCase())}</span>
            <div class="set-row-info"><div class="set-row-label">${App.esc(u.nickname || u.username)}</div>
              <div class="set-row-sub">@${App.esc(u.username)} · 创建于 ${App.esc(u.createdAt)}</div></div>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="chip ${u.role === 'admin' ? 'primary' : 'no-dot'}">${u.role === 'admin' ? '管理员' : '成员'}</span>
            ${u.bound ? `<button class="icon-btn-xs" data-unlink="${App.esc(u.username)}" title="解除绑定"><svg class="ic"><use href="#i-close"/></svg></button>` : ''}
            ${isAdmin && u.username !== App.user.username && u.role !== 'admin'
              ? `<button class="icon-btn-xs" data-user-del="${App.esc(u.username)}" title="删除用户"><svg class="ic"><use href="#i-trash"/></svg></button>` : ''}
          </div>
        </div>`).join('');
    } catch (e) {
      $('#userList').innerHTML = '<div style="font-size:12px;color:var(--om-text-3)">账号列表加载失败</div>';
    }
  }

  $('#addUserBtn').addEventListener('click', () => {
    $('#nuName').value = ''; $('#nuNick').value = ''; $('#nuPass').value = '';
    App.openModal('addUserMask');
  });
  $('#nuCancel').addEventListener('click', () => App.closeModal('addUserMask'));
  $('#nuSave').addEventListener('click', async () => {
    try {
      await API.post('/api/auth/users', {
        username: $('#nuName').value.trim(),
        nickname: $('#nuNick').value.trim(),
        password: $('#nuPass').value,
      });
      App.closeModal('addUserMask');
      showToast('用户已创建');
      loadUsers();
    } catch (e) { showToast(e.message, 'err'); }
  });

  document.addEventListener('click', async e => {
    const del = e.target.closest('[data-user-del]');
    if (del){
      if (!confirm(`删除用户 @${del.dataset.userDel}？其数据空间将被注销（文件保留）。`)) return;
      await API.del('/api/auth/users/' + encodeURIComponent(del.dataset.userDel))
        .catch(err => showToast(err.message, 'err'));
      loadUsers();
      return;
    }
    const un = e.target.closest('[data-unlink]');
    if (!un) return;
    const ok = await App.confirmModal({
      title: `解除与 @${un.dataset.unlink} 的绑定？`,
      sub: '解绑后双方都无法再免密切换，需重新验证密码才能互相切换。',
      okText: '解绑', danger: true,
    });
    if (!ok) return;
    await API.del('/api/auth/link/' + encodeURIComponent(un.dataset.unlink))
      .then(() => { showToast('已解除绑定'); loadUsers(); loadSwitchLinks(); })
      .catch(err => showToast(err.message, 'err'));
  });

  /* ---------- 切换用户（绑定免密 / 手动验证后双向绑定） ---------- */
  function linkAvatarHtml(l){
    if (l.avatar) return `<span class="avatar" style="background-image:url(${l.avatar});background-size:cover;background-position:center"></span>`;
    return `<span class="avatar">${App.esc((l.nickname || l.username).slice(0, 2).toUpperCase())}</span>`;
  }
  async function loadSwitchLinks(){
    try {
      const d = await API.get('/api/auth/links');
      const links = d.links || [];
      $('#switchLinks').innerHTML = links.length ? links.map(l => `
        <button class="m-user" data-switch-link="${App.esc(l.username)}" data-expired="${l.expired ? 1 : 0}"
          title="${l.expired ? '绑定已过期，需重新验证密码' : '已绑定，点击免密切换'}">
          ${linkAvatarHtml(l)}
          <span><div class="user-name">${App.esc(l.nickname)}</div>
          <div class="user-plan">@${App.esc(l.username)} · 最近切换 ${App.esc(l.lastSwitch || '—')}${l.expired ? ' · 已过期' : ''}</div></span>
          <svg class="ic chev"><use href="#i-${l.expired ? 'lock' : 'chev-d'}"/></svg>
        </button>`).join('')
        : '<div style="font-size:12px;color:var(--om-text-3);padding:6px 2px">暂无绑定账号，请先在下方手动输入验证</div>';
    } catch (e) {}
  }
  /* 打开切换弹窗时刷新绑定列表 */
  $$('[data-open-switch]').forEach(el =>
    el.addEventListener('click', () => loadSwitchLinks()));

  async function doSwitch(username, password){
    try {
      const d = await API.post('/api/auth/switch',
                               { username, password: password || '' });
      API.setToken(d.token);
      openSwitch(false);
      showToast('已切换到 ' + (d.user.nickname || d.user.username));
      location.reload();
    } catch (e) { showToast(e.message, 'err'); }
  }
  $('#switchLinks').addEventListener('click', e => {
    const btn = e.target.closest('[data-switch-link]');
    if (!btn) return;
    if (btn.dataset.expired === '1'){
      /* 过期：带出用户名，提示输入密码重新验证（同时刷新绑定） */
      $('#switchUser').value = btn.dataset.switchLink;
      $('#switchPass').value = '';
      $('#switchPass').focus();
      showToast('绑定已过期，请输入该账号密码重新验证', 'err');
      return;
    }
    doSwitch(btn.dataset.switchLink);
  });
  $('#switchConfirm').addEventListener('click', async () => {
    const username = $('#switchUser').value.trim();
    if (!username) return showToast('请输入目标账号的用户名', 'err');
    await doSwitch(username, $('#switchPass').value);
  });

  /* ---------- 数据与存储 ---------- */
  const ENGINE_LABEL = { file: '文件存储', sqlite: 'SQLite', db: '外部数据库' };

  async function loadData(){
    try {
      const s = await API.get('/api/data/stats');
      $('#dataNotes').textContent = s.notes + ' 篇';
      $('#dataBookmarks').textContent = s.bookmarks + ' 个';
      $('#dataVault').textContent = s.vaultItems + ' 条';
      $('#dataBackups').textContent = s.backups + ' 份';
      $('#dataSize').textContent = App.fmtBytes(s.bytes) + ' 已用';
      $('#engineChip').textContent = ENGINE_LABEL[s.engine] || '文件存储';
      /* v0.2.15 增：回收站保留天数回显 */
      const prefs = await API.get('/api/settings').catch(() => ({}));
      const days = (prefs && prefs.trashDays);
      $('#trashDays').value = (days === 0 || days) ? days : 30;
      /* 备份设置回显 */
      const bc = s.backupCfg || {};
      $('#bkAuto').classList.toggle('on', !!bc.auto);
      $$('#bkIntervalSeg .seg-btn').forEach(b =>
        b.classList.toggle('active', String(b.dataset.hours) === String(bc.intervalHours || 24)));
      if (!$('#bkIntervalSeg .seg-btn.active'))
        $('#bkIntervalSeg .seg-btn[data-hours="24"]').classList.add('active');
      $('#bkKeep').value = bc.keep || 10;
      $('#backupList').innerHTML = s.backupList.length
        ? s.backupList.map(b => `
          <div class="qk-row"><span class="qk-name">${App.esc(b.name)}</span>
            <span class="num" style="font-size:11px;color:var(--om-text-3)">${b.time} · ${App.fmtBytes(b.size)}</span>
            <button class="icon-btn-xs js-bk-dl" data-bk="${App.esc(b.name)}" title="下载" style="margin-left:auto"><svg class="ic"><use href="#i-download"/></svg></button>
            <button class="icon-btn-xs js-bk-rs" data-bk="${App.esc(b.name)}" title="恢复到这份备份"><svg class="ic"><use href="#i-refresh"/></svg></button>
          </div>`).join('')
        : '<div style="font-size:12px;color:var(--om-text-3)">暂无备份，点击「立即备份」创建第一份</div>';
    } catch (e) {}
  }

  /* 统计延迟修复：打开设置 / 切到数据面板时实时拉取，无需刷新页面 */
  $$('[data-open-settings]').forEach(el =>
    el.addEventListener('click', () => { loadData(); loadEngine(); }));
  $$('.set-item[data-set="data"]').forEach(el =>
    el.addEventListener('click', () => { loadData(); loadEngine(); }));
  $$('.set-item[data-set="features"]').forEach(el =>
    el.addEventListener('click', () => loadFeatures()));

  $('#backupNow').addEventListener('click', async () => {
    $('#backupNow').disabled = true;
    try {
      const d = await API.post('/api/data/backup');
      showToast('备份完成：' + d.name);
      loadData();
    } catch (e) { showToast(e.message, 'err'); }
    finally { $('#backupNow').disabled = false; }
  });

  /* 回收站保留天数（v0.2.15 增）：0 = 仅手动清空 */
  $('#trashDaysSave')?.addEventListener('click', async () => {
    const raw = parseInt($('#trashDays').value, 10);
    const days = isNaN(raw) ? 30 : Math.max(0, Math.min(3650, raw));
    try {
      await API.put('/api/settings', { trashDays: days });
      showToast(days === 0 ? '已关闭自动清理，仅手动清空' : `回收站保留 ${days} 天`);
    } catch (e) { showToast(e.message, 'err'); }
  });

  /* ---------- Obsidian 插件同步（功能设置） ---------- */
  const _syncPlainByVault = {};

  function fmtLogTs(ts){
    const d = new Date((ts || 0) * 1000);
    if (isNaN(d.getTime())) return '';
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  async function loadObsidianSync(){
    const urlEl = $('#syncBaseUrl');
    if (urlEl) urlEl.value = location.origin.replace(/\/$/, '');
    let on = false;
    try {
      const prefs = await API.get('/api/settings');
      on = !!(prefs && prefs.obsidianSync);
    } catch (e) {}
    $('#obsidianSyncEnabled')?.classList.toggle('on', on);
    const chip = $('#obsidianSyncChip');
    if (chip){
      chip.textContent = on ? '已开启' : '未开启';
      chip.classList.toggle('success', on);
      chip.classList.toggle('no-dot', !on);
    }
    const body = $('#obsidianSyncBody');
    if (body) body.hidden = !on;
    try {
      const pc = await API.get('/api/plugin/check');
      $('#pluginDownload').dataset.available = pc.available ? '1' : '';
      if (pc.available && pc.version){
        const btn = $('#pluginDownload');
        if (btn && !btn.dataset.ver){
          btn.dataset.ver = '1';
          btn.append(' v' + pc.version);
        }
      }
    } catch (e) {}
    if (on) await Promise.all([renderVaultKeys(), renderSyncLog()]);
  }

  async function renderVaultKeys(){
    const box = $('#syncVaultKeys');
    if (!box) return;
    let vaults = [], keys = [];
    try {
      const vd = await API.get('/api/notes/vaults');
      vaults = vd.vaults || [];
    } catch (e) {}
    try {
      const info = await API.get('/api/sync/apikey');
      keys = info.keys || [];
    } catch (e) {}
    const keyOf = id => keys.find(k => k.vault === id);
    box.innerHTML = vaults.map(v => {
      const sys = v.kind === 'system';
      const k = keyOf(v.id);
      const plain = _syncPlainByVault[v.id];
      const shown = plain || (k ? k.masked : '尚未生成');
      return `<div class="sync-vault-row" data-sv="${App.esc(v.id)}">
        <div class="nm">${App.esc(v.name)}${sys ? '<span class="chip no-dot" style="margin-left:6px;font-size:10px">不可同步</span>' : ''}</div>
        <div class="key">${sys ? '—' : App.esc(shown)}</div>
        ${sys ? '' : `<button class="btn btn-outline btn-sm" data-sv-copy="${App.esc(v.id)}">复制</button>
          <button class="btn btn-primary btn-sm" data-sv-gen="${App.esc(v.id)}">${k ? '重置' : '生成令牌'}</button>
          ${k ? `<button class="btn btn-outline btn-sm" style="color:var(--om-danger)" data-sv-rev="${App.esc(v.id)}">吊销</button>` : ''}`}
      </div>`;
    }).join('') || '<div style="font-size:12px;color:var(--om-text-3)">暂无笔记仓库</div>';
  }

  async function renderSyncLog(){
    const box = $('#syncLogBox');
    if (!box) return;
    try {
      const d = await API.get('/api/sync/log?limit=60');
      const logs = d.logs || [];
      if (!logs.length){ box.textContent = '暂无记录'; return; }
      box.innerHTML = logs.map(x =>
        `<div class="lg"><span class="ts">${fmtLogTs(x.ts)}</span><span class="lv ${(x.level||'')==='error'?'err':(x.level||'')==='warn'?'warn':''}">${App.esc(x.vault || x.source || '')}</span><span>${App.esc(x.msg || '')}</span></div>`
      ).join('');
    } catch (e) { box.textContent = '日志加载失败'; }
  }

  $('#obsidianSyncEnabled')?.addEventListener('click', async () => {
    const next = $('#obsidianSyncEnabled').classList.contains('on');
    try {
      await API.put('/api/settings', { obsidianSync: next });
      showToast(next ? '已开启 Obsidian 同步' : '已关闭（已有令牌仍可用，只是隐藏管理入口）');
      await loadObsidianSync();
    } catch (e) {
      $('#obsidianSyncEnabled').classList.toggle('on', !next);
      showToast(e.message, 'err');
    }
  });
  $('#pluginDownload')?.addEventListener('click', () => {
    if ($('#pluginDownload').dataset.available !== '1'){
      showToast('当前部署未包含插件目录', 'err');
      return;
    }
    API.dl('/api/plugin.zip');
  });
  $('#syncBaseUrlCopy')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#syncBaseUrl').value); showToast('服务端地址已复制'); }
    catch (e) { showToast('复制失败，请手动选中复制', 'err'); }
  });
  document.addEventListener('click', async e => {
    const gen = e.target.closest('[data-sv-gen]');
    const copy = e.target.closest('[data-sv-copy]');
    const rev = e.target.closest('[data-sv-rev]');
    if (gen){
      const vid = gen.dataset.svGen;
      if (!await App.confirmModal({
        title: gen.textContent.includes('重置') ? '重置同步令牌？' : '生成同步令牌？',
        danger: true, okText: gen.textContent.includes('重置') ? '重置' : '生成',
        sub: gen.textContent.includes('重置')
          ? '旧令牌将立即失效，Obsidian 插件需填入新令牌才能继续同步该仓库。'
          : '明文仅显示一次，请立刻复制到 Obsidian 插件设置中。',
      })) return;
      try {
        const d = await API.post('/api/sync/apikey', { vault: vid });
        _syncPlainByVault[vid] = d.apiKey || '';
        showToast('已生成，请立即复制（明文仅此一次可见）');
        await renderVaultKeys(); await renderSyncLog();
      } catch (err) { showToast(err.message, 'err'); }
    }
    if (copy){
      const vid = copy.dataset.svCopy;
      const plain = _syncPlainByVault[vid];
      if (!plain){ showToast('明文仅生成时可见，请先生成令牌', 'err'); return; }
      try { await navigator.clipboard.writeText(plain); showToast('令牌已复制'); }
      catch (err) { showToast('复制失败', 'err'); }
    }
    if (rev){
      const vid = rev.dataset.svRev;
      if (!await App.confirmModal({
        title: '吊销同步令牌？', danger: true, okText: '吊销',
        sub: '该仓库的 Obsidian 同步将立即断开，不影响笔记内容。',
      })) return;
      try {
        await API.del('/api/sync/apikey?vault=' + encodeURIComponent(vid));
        delete _syncPlainByVault[vid];
        showToast('已吊销');
        await renderVaultKeys(); await renderSyncLog();
      } catch (err) { showToast(err.message, 'err'); }
    }
  });

  /* 备份设置：自动备份开关 / 周期 / 保留份数 */
  $('#bkCfgSave').addEventListener('click', async () => {
    const hours = parseInt($('#bkIntervalSeg .seg-btn.active')?.dataset.hours || '24', 10);
    try {
      await API.put('/api/data/backup-config', {
        auto: $('#bkAuto').classList.contains('on'),
        intervalHours: hours,
        keep: parseInt($('#bkKeep').value, 10) || 10,
      });
      showToast('备份设置已保存');
      loadData();
    } catch (e) { showToast(e.message, 'err'); }
  });

  document.addEventListener('click', async e => {
    const dl = e.target.closest('.js-bk-dl');
    if (dl) return API.dl('/api/data/backup/' + encodeURIComponent(dl.dataset.bk));
    const rs = e.target.closest('.js-bk-rs');
    if (!rs) return;
    const ok = await App.confirmModal({
      title: '恢复到这份备份？',
      sub: `「${rs.dataset.bk}」将覆盖当前数据（笔记 / 书签 / 日程 / 保险库密文），建议先「立即备份」保存现状。`,
      okText: '恢复', danger: true,
    });
    if (!ok) return;
    try {
      const d = await API.post('/api/data/restore', { name: rs.dataset.bk });
      showToast(`已恢复 ${d.restored} 项数据，页面即将刷新`);
      setTimeout(() => location.reload(), 1200);
    } catch (err) { showToast(err.message, 'err'); }
  });

  $('#exportBtn').addEventListener('click', () => API.dl('/api/data/export'));

  /* ---------- 存储引擎（仅管理员：切换时迁移全部用户数据） ---------- */
  const DB_DRIVER = { mysql: 'mysql+pymysql', postgresql: 'postgresql+psycopg2' };
  const DB_PORT = { mysql: '3306', postgresql: '5432' };

  /* 由表单拼装 SQLAlchemy 连接串；必填项缺失时返回空串。
     密码留空 = 复用已保存配置中的密码（后端校验） */
  function buildDbUrl(){
    const t = $('#dbTypeSeg .seg-btn.active')?.dataset.db || 'mysql';
    const host = $('#dbHost').value.trim();
    const port = $('#dbPort').value.trim() || DB_PORT[t];
    const user = $('#dbUser').value.trim();
    const pass = $('#dbPass').value;
    const name = $('#dbName').value.trim();
    if (!host || !user || !name) return '';
    const auth = encodeURIComponent(user) + (pass ? ':' + encodeURIComponent(pass) : '');
    return `${DB_DRIVER[t]}://${auth}@${host}:${port}/${encodeURIComponent(name)}`;
  }

  async function loadEngine(){
    const card = $('#engineCard');
    if (!App.user || App.user.role !== 'admin'){ card.hidden = true; return; }
    card.hidden = false;
    try {
      const st = await API.get('/api/data/storage');
      $$('#engineSeg .seg-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.engine === st.engine));
      $('#dbCfgForm').hidden = st.engine !== 'db';
      /* 回显已保存的数据库配置（密码不回填，留空提交 = 保持不变） */
      const c = st.dbCfg || {};
      $$('#dbTypeSeg .seg-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.db === (c.dbType || 'mysql')));
      $('#dbHost').value = c.host || '';
      $('#dbPort').value = c.port || DB_PORT[c.dbType || 'mysql'];
      $('#dbUser').value = c.username || '';
      $('#dbPass').value = '';
      $('#dbPass').placeholder = c.hasPassword ? '已配置（留空 = 保持不变）' : '数据库密码';
      $('#dbName').value = c.database || '';
    } catch (e) {}
  }
  $('#engineSeg').addEventListener('click', () => {
    /* demo.js 通用绑定已先切换选中态，此处同步数据库表单可见性 */
    const eng = $('#engineSeg .seg-btn.active')?.dataset.engine;
    $('#dbCfgForm').hidden = eng !== 'db';
  });
  $('#dbTypeSeg').addEventListener('click', () => {
    /* 切换数据库类型：端口为空或仍是另一类型的默认值时自动带出 */
    const t = $('#dbTypeSeg .seg-btn.active')?.dataset.db || 'mysql';
    const port = $('#dbPort');
    const other = t === 'mysql' ? DB_PORT.postgresql : DB_PORT.mysql;
    if (!port.value.trim() || port.value.trim() === other) port.value = DB_PORT[t];
  });
  $('#engineTest').addEventListener('click', async () => {
    const url = buildDbUrl();
    if (!url) return showToast('请填写完整的数据库连接信息（地址 / 用户名 / 库名）', 'err');
    const btn = $('#engineTest');
    btn.disabled = true;
    try {
      await API.post('/api/data/storage-test', { engine: 'db', url });
      showToast('连接成功：数据库可用');
    } catch (e) { showToast('测试失败：' + e.message, 'err'); }
    finally { btn.disabled = false; }
  });
  $('#engineApply').addEventListener('click', async () => {
    const eng = $('#engineSeg .seg-btn.active')?.dataset.engine || 'file';
    let url = '';
    if (eng === 'db'){
      url = buildDbUrl();
      if (!url) return showToast('请填写完整的数据库连接信息（地址 / 用户名 / 库名）', 'err');
    }
    const ok = await App.confirmModal({
      title: `切换到「${ENGINE_LABEL[eng]}」？`,
      sub: '将先测试目标连接，然后把全部用户数据迁移到目标存储。迁移期间请勿关闭服务。',
      okText: '开始迁移',
    });
    if (!ok) return;
    const btn = $('#engineApply');
    btn.disabled = true;
    try {
      const d = await API.post('/api/data/storage', { engine: eng, url });
      showToast(`迁移完成：已切换至${ENGINE_LABEL[d.engine] || d.engine}（${d.moved} 项数据）`);
      loadEngine(); loadData();
    } catch (e) { showToast(e.message, 'err'); }
    finally { btn.disabled = false; }
  });

  /* ---------- 一键清理 macOS 资源垃圾（修复之前版本没过滤导致的乱码笔记） ---------- */
  $('#cleanupJunkBtn').addEventListener('click', async () => {
    if (!await App.confirmModal({ title: '清理 macOS 资源垃圾？',
      sub: '将删除：标题以 ._ 开头的笔记、__MACOSX 文件夹（含嵌套）及其内笔记。普通笔记不受影响。', okText: '清理', danger: false })) return;
    try {
      const d = await API.post('/api/notes/cleanup-junk');
      showToast(`已删除 ${d.deleted_notes || 0} 条笔记、${d.deleted_folders || 0} 个文件夹`);
      loadData();                                          // 刷新本面板统计
      document.dispatchEvent(new CustomEvent('kb-refresh')); // 通知知识库侧栏刷新
    } catch (e) { showToast('清理失败：' + e.message, 'err'); }
  });

  /* ---------- 清空数据（主题弹窗 + 登录密码确认） ---------- */
  $('#wipeBtn').addEventListener('click', () => {
    $('#wipePass').value = '';
    App.openModal('wipeMask');
    setTimeout(() => $('#wipePass').focus(), 80);
  });
  $('#wipeCancel').addEventListener('click', () => App.closeModal('wipeMask'));
  $('#wipeOk').addEventListener('click', async () => {
    const pwd = $('#wipePass').value;
    if (!pwd) return showToast('请输入登录密码', 'err');
    try {
      await API.del('/api/data/wipe', { password: pwd });
      App.closeModal('wipeMask');
      showToast('数据已清空，页面即将刷新');
      setTimeout(() => location.reload(), 1200);
    } catch (e) { showToast(e.message, 'err'); }
  });

  /* ---------- AI 智能 ---------- */
  async function loadAi(){
    try {
      const c = await API.get('/api/ai-config');
      $('#aiEnabled').classList.toggle('on', !!c.enabled);
      $('#aiEndpoint').value = c.endpoint || '';
      $('#aiModel').value = c.model || '';
      $('#aiKey').value = '';
      $('#aiKey').placeholder = c.hasKey ? '已配置（留空保存 = 保持不变）' : 'sk-…';
      const chip = $('#aiStatusChip');
      if (c.enabled){ chip.textContent = '已启用'; chip.className = 'chip success no-dot'; }
      else if (c.endpoint || c.hasKey){ chip.textContent = '已配置未启用'; chip.className = 'chip no-dot'; }
      else { chip.textContent = '未配置'; chip.className = 'chip no-dot'; }
    } catch (e) {}
  }

  $('#aiSave').addEventListener('click', async () => {
    try {
      const saved = await API.put('/api/ai-config', {
        enabled: $('#aiEnabled').classList.contains('on'),
        endpoint: $('#aiEndpoint').value.trim(),
        model: $('#aiModel').value.trim(),
        apiKey: $('#aiKey').value.trim(),   // 空字符串 = 保留已有密钥
      });
      loadAi();
      showToast(saved.enabled ? 'AI 配置已保存并启用' : 'AI 配置已保存');
    } catch (e) { showToast(e.message, 'err'); }
  });

  $('#aiTest').addEventListener('click', async () => {
    const btn = $('#aiTest');
    btn.disabled = true;
    try {
      /* 直接用表单当前值测试（无需先保存），空字段回落已保存配置 */
      await API.post('/api/ai/test', {
        endpoint: $('#aiEndpoint').value.trim(),
        model: $('#aiModel').value.trim(),
        apiKey: $('#aiKey').value.trim(),
      });
      showToast('连接成功：AI 接口可用');
    } catch (e) { showToast('测试失败：' + e.message, 'err'); }
    finally { btn.disabled = false; }
  });

  /* ---------- 关于 ---------- */
  function changelogHtml(list){
    return (list || []).map(v => `
      <div class="cl-ver">
        <div class="cl-head">
          <span class="chip primary no-dot num">v${App.esc(v.version)}</span>
          <span class="num" style="font-size:11px;color:var(--om-text-3)">${App.esc(v.date || '')}</span>
        </div>
        <ul class="cl-items">${(v.items || []).map(i => `<li>${App.esc(i)}</li>`).join('')}</ul>
      </div>`).join('') ||
      '<div style="font-size:12px;color:var(--om-text-3)">暂无更新记录</div>';
  }

  let aboutCache = null;
  async function loadAbout(){
    try {
      const a = await API.get('/api/about');
      aboutCache = a;
      $('#aboutVer').textContent = `v${a.version} · ${a.stage}`;
      $('#aboutBuild').textContent = a.build;
      $('#aboutUp').textContent = a.uptime;
      $('#aboutPy').textContent = 'Python ' + a.python;
      $('#aboutVerChip').textContent = 'v' + a.version;
      $('#aboutChangelog').innerHTML = changelogHtml(a.changelog);
      $('#aboutDevName').textContent = a.developer || 'JeanLaw';
      /* 系统信息：存储引擎从数据统计接口取 */
      API.get('/api/data/stats').then(s => {
        $('#aboutEngine').textContent = ENGINE_LABEL[s.engine] || '文件存储';
      }).catch(() => {});
    } catch (e) {}
  }
  $('#aboutLogBtn').addEventListener('click', () => {
    if (aboutCache) App.showChangelog(aboutCache);
    else loadAbout().then(() => aboutCache && App.showChangelog(aboutCache));
  });
  $('#aboutCheckBtn').addEventListener('click', async () => {
    try {
      const a = await API.get('/api/about');
      aboutCache = a;
      showToast(`当前已是最新版本 v${a.version}`);
    } catch (e) { showToast(e.message, 'err'); }
  });

  /* ---------- 进入时初始化 ---------- */
  App.onEnter(async () => {
    reflectPrefs();
    const u = App.user;
    $('#accNick').value = u.nickname || '';
    $('#accAvatar') && App.renderAvatar($('#accAvatar'), u);
    $('#pwdChangedAt').textContent = u.pwdChangedAt
      ? '上次修改：' + u.pwdChangedAt : '上次修改：—';
    $('#setUserSub').textContent = `外观、账号、数据与关于万事屋的一切 · 当前用户 ${u.nickname || u.username}`;
    loadUsers();
    loadRegToggle();
    loadFeatures();
    loadLogins();
    loadSwitchLinks();
    loadData();
    loadEngine();
    loadAbout();
    loadAi();
  });
})();
