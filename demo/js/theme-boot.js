/* 首屏绘制前确定明暗，避免主题闪烁；未登录时登录页也据此渲染。
   优先级：本机上次的选择 → 系统偏好 → 深色兜底（html 标签上的初始值）。 */
(function () {
  try {
    var m = localStorage.getItem('om_theme_mode') || 'auto';
    document.documentElement.dataset.theme = m === 'auto'
      ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : m;
    document.documentElement.dataset.compact =
      localStorage.getItem('om_layout_compact') === '1' ? 'on' : 'off';
    document.documentElement.dataset.motion =
      localStorage.getItem('om_layout_motion') === '1' ? 'off' : 'on';
    var sidebarCollapsed = localStorage.getItem('om_sidebar_collapsed') === '1';
    document.documentElement.classList.toggle('sidebar-collapsed', sidebarCollapsed);
    var syncSidebar = function () {
      if (!document.body) return;
      document.body.classList.toggle('sidebar-collapsed',
        document.documentElement.classList.contains('sidebar-collapsed'));
    };
    if (document.body) syncSidebar();
    else document.addEventListener('DOMContentLoaded', syncSidebar);
  } catch (e) { /* localStorage 不可用时沿用 html 上的默认深色 */ }
  /* 兜底：脚本异常时也要让启动遮罩消失，不能把用户永久挡在遮罩外 */
  setTimeout(function () {
    var s = document.getElementById('bootSplash');
    if (s) s.classList.add('gone');
  }, 8000);
})();
