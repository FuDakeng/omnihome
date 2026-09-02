/* ============================================================
   OmniHome 插件 · 页面变动探测（MAIN world）
   注入所有 http/https 页面，钩住页面自身的 fetch：
   当前站点是 OmniHome 服务且书签 / 分类发生写操作时，
   通过 postMessage 通知 ISOLATED 内容脚本转发后台触发同步。
   对页面本身零副作用：仅旁路观察响应，不改动请求。
   ============================================================ */
(function(){
  try {
    const origFetch = window.fetch;
    if (!origFetch || origFetch.__omniHooked) return;
    const WRITE = /^(POST|PUT|DELETE)$/i;
    const PATH = /\/api\/(bookmarks|bookmark-cats)([/?#]|$)/;
    window.fetch = async function(...args){
      const res = await origFetch.apply(this, args);
      try {
        const req = args[0];
        const method = String(
          (args[1] && args[1].method) || (req && req.method) || 'GET');
        const url = typeof req === 'string' ? req : (req && req.url) || '';
        if (WRITE.test(method) && PATH.test(url) && res.ok){
          window.postMessage({ type: '__OMNI_DATA_CHANGED__' }, '*');
        }
      } catch (e) { /* 绝不影响页面自身 */ }
      return res;
    };
    Object.defineProperty(window.fetch, '__omniHooked', { value: true });
  } catch (e) { /* 注入失败静默 */ }
})();
