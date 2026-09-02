/* ============================================================
   OmniDesk · 登录 / 注册（独立登录页）
   首次启动注册即管理员；此后是否开放注册由管理员在
   设置 → 用户与账号 中控制（开启后新用户可在登录页自行注册）。
   ============================================================ */
const Auth = (() => {
  let mode = 'login'; // login | register
  let canRegister = false;

  function setMode(m){
    mode = m;
    $$('#authModeTabs .seg-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.authMode === m));
    $('#regNickRow').hidden = m !== 'register';
    $('#authSubmit').textContent = m === 'register' ? '创建账号并进入' : '登录';
    $('#authError').textContent = '';
  }

  /* 根据系统状态决定登录页形态：
     无用户 → 强制注册（首个即管理员）；
     有用户且开放注册 → 登录 / 注册双标签；
     有用户且未开放 → 仅登录。 */
  function setup(first = {}){
    canRegister = !first.hasUsers || !!first.allowRegister;
    $('#authModeTabs').hidden = !(first.hasUsers && first.allowRegister);
    if (!first.hasUsers){
      setMode('register');
      $('#authTitle').textContent = '创建管理员账号';
      $('#authSub').textContent = '首个注册账号即管理员，开启你的万事屋';
    } else {
      setMode('login');
      $('#authTitle').textContent = '欢迎回来';
      $('#authSub').textContent = first.allowRegister
        ? '登录后进入你的个人仪表盘'
        : '未开放注册，请使用管理员分配的账号登录';
    }
  }

  function fail(msg){
    $('#authError').textContent = msg;
    $('#authCard').classList.remove('shake');
    void $('#authCard').offsetWidth;
    $('#authCard').classList.add('shake');
  }

  async function submit(){
    const username = $('#authUser').value.trim();
    const password = $('#authPass').value;
    if (!username || !password) return fail('请输入用户名与密码');
    if (mode === 'register' && !canRegister) return fail('当前未开放注册');
    $('#authSubmit').disabled = true;
    try {
      let data;
      if (mode === 'register'){
        data = await API.post('/api/auth/register', {
          username, password, nickname: $('#authNick').value.trim(),
        });
      } else {
        data = await API.post('/api/auth/login', { username, password });
      }
      API.setToken(data.token);
      await App.enter(data.user, false);
    } catch (e) {
      fail(e.message);
    } finally {
      $('#authSubmit').disabled = false;
    }
  }

  function init(){
    $$('#authModeTabs .seg-btn').forEach(b =>
      b.addEventListener('click', () => setMode(b.dataset.authMode)));
    $('#authSubmit').addEventListener('click', submit);
    $('#authScreen').addEventListener('keydown', e => {
      if (e.key === 'Enter') submit();
    });
  }

  return { init, setMode, setup };
})();
Auth.init();

/* 退出登录入口（头像菜单） */
$('#logoutBtn').addEventListener('click', () => App.logout());
