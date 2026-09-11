/* OmniHome · Phone Shell：抽屉侧栏、搜索展开、知识库两级页。 */
const PHONE_MQ = '(max-width: 768px)';

function isPhone(){
  return window.matchMedia(PHONE_MQ).matches;
}

function closePhoneChrome(){
  document.body.classList.remove('nav-open', 'search-open');
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
    document.body.classList.remove('kb-phone-list', 'kb-phone-editor', 'share-phone-editor');
  } else if (document.body.dataset.view === 'notes' && !document.body.classList.contains('kb-phone-editor')){
    document.body.classList.add('kb-phone-list');
  }
}

function bindPhoneShell(){
  applyPhoneClass();
  const mq = window.matchMedia(PHONE_MQ);
  const onMq = () => applyPhoneClass();
  if (mq.addEventListener) mq.addEventListener('change', onMq);
  else if (mq.addListener) mq.addListener(onMq);

  document.getElementById('navScrim')?.addEventListener('click', closePhoneChrome);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closePhoneChrome();
  });

  document.getElementById('searchToggle')?.addEventListener('click', () => {
    document.body.classList.add('search-open');
    document.getElementById('globalSearch')?.focus();
  });
  document.getElementById('searchCancel')?.addEventListener('click', () => {
    document.body.classList.remove('search-open');
    document.getElementById('globalSearch')?.blur();
  });

  window.addEventListener('popstate', () => {
    if (document.body.classList.contains('kb-phone-editor'))
      exitKbEditor(true);
    if (document.body.classList.contains('share-phone-editor'))
      document.body.classList.remove('share-phone-editor');
  });

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

if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', bindPhoneShell);
else bindPhoneShell();

export { isPhone, enterKbEditor, exitKbEditor, applyPhoneClass };
