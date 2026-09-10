/* OmniHome · Phone Shell：抽屉、底栏、搜索展开、知识库两级页。 */
const PHONE_MQ = '(max-width: 768px)';

function isPhone(){
  return window.matchMedia(PHONE_MQ).matches;
}

function closePhoneChrome(){
  document.body.classList.remove('nav-open', 'search-open', 'phone-more-open');
  const sheet = document.getElementById('phoneMoreSheet');
  if (sheet) sheet.hidden = true;
}

function syncPhoneMoreMonitor(){
  const src = document.querySelector('.nav-item[data-nav="monitor"]');
  const item = document.getElementById('phoneMoreMonitor');
  if (item) item.hidden = !!(src && src.hidden);
}

function enterKbEditor(push){
  if (!isPhone()) return;
  document.body.classList.remove('kb-phone-list');
  document.body.classList.add('kb-phone-editor');
  if (push && (!history.state || !history.state.kbEditor))
    history.pushState({ kbEditor: true }, '');
}

function exitKbEditor(fromPop){
  document.body.classList.remove('kb-phone-editor');
  if (isPhone() && document.body.dataset.view === 'notes')
    document.body.classList.add('kb-phone-list');
  if (!fromPop && history.state && history.state.kbEditor)
    history.replaceState(null, '', location.pathname + location.search + location.hash);
}

function applyPhoneClass(){
  const on = isPhone();
  document.body.classList.toggle('is-phone', on);
  const btn = document.getElementById('collapseBtn');
  if (btn) btn.setAttribute('title', on ? '打开菜单' : '折叠 / 展开侧边栏');
  if (!on){
    closePhoneChrome();
    document.body.classList.remove('kb-phone-list', 'kb-phone-editor', 'share-phone-editor', 'kb-hide');
  } else if (document.body.dataset.view === 'notes' && !document.body.classList.contains('kb-phone-editor')){
    document.body.classList.add('kb-phone-list');
  }
  syncPhoneMoreMonitor();
}

function setPhoneMoreOpen(open){
  document.body.classList.toggle('phone-more-open', open);
  const sheet = document.getElementById('phoneMoreSheet');
  if (sheet) sheet.hidden = !open;
  if (open) syncPhoneMoreMonitor();
}

function bindPhoneShell(){
  applyPhoneClass();
  const mq = window.matchMedia(PHONE_MQ);
  const onMq = () => applyPhoneClass();
  if (mq.addEventListener) mq.addEventListener('change', onMq);
  else if (mq.addListener) mq.addListener(onMq);

  document.getElementById('navScrim')?.addEventListener('click', closePhoneChrome);

  document.getElementById('searchToggle')?.addEventListener('click', () => {
    document.body.classList.add('search-open');
    document.getElementById('globalSearch')?.focus();
  });
  document.getElementById('searchCancel')?.addEventListener('click', () => {
    document.body.classList.remove('search-open');
    document.getElementById('globalSearch')?.blur();
  });

  document.getElementById('phoneMoreBtn')?.addEventListener('click', e => {
    e.stopPropagation();
    setPhoneMoreOpen(!document.body.classList.contains('phone-more-open'));
  });
  document.getElementById('phoneMoreClose')?.addEventListener('click', () => setPhoneMoreOpen(false));
  document.getElementById('phoneThemeBtn')?.addEventListener('click', () => {
    document.getElementById('themeToggle')?.click();
    setPhoneMoreOpen(false);
  });
  document.getElementById('phoneLogoutBtn')?.addEventListener('click', () => {
    document.getElementById('logoutBtn')?.click();
    setPhoneMoreOpen(false);
  });

  window.addEventListener('popstate', () => {
    if (document.body.classList.contains('kb-phone-editor'))
      exitKbEditor(true);
    if (document.body.classList.contains('share-phone-editor'))
      document.body.classList.remove('share-phone-editor');
  });

  const vv = window.visualViewport;
  if (vv){
    const onVv = () => {
      const kb = window.innerHeight - vv.height > 80;
      document.body.classList.toggle('kb-hide', kb && isPhone());
    };
    vv.addEventListener('resize', onVv);
  }

  document.getElementById('kbPhoneSel')?.addEventListener('click', () => {
    const tree = document.querySelector('.kb-tree');
    const on = !(tree && tree.classList.contains('sel-mode'));
    if (typeof window.__kbSetSelMode === 'function') window.__kbSetSelMode(on);
  });
  document.getElementById('kbPhoneBack')?.addEventListener('click', () => exitKbEditor(false));
  document.getElementById('kbSharePhoneBack')?.addEventListener('click', () => {
    document.body.classList.remove('share-phone-editor');
  });
}

window.isPhone = isPhone;
window.enterKbEditor = enterKbEditor;
window.exitKbEditor = exitKbEditor;
window.closePhoneChrome = closePhoneChrome;
window.syncPhoneMoreMonitor = syncPhoneMoreMonitor;

if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', bindPhoneShell);
else bindPhoneShell();

export { isPhone, enterKbEditor, exitKbEditor, applyPhoneClass, syncPhoneMoreMonitor };
