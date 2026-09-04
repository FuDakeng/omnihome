/* ============================================================
   OmniDesk · API 封装层
   统一请求：Bearer Token、JSON、错误提示。
   ============================================================ */
const API = (() => {
  const TOKEN_KEY = 'om_token';
  let token = localStorage.getItem(TOKEN_KEY) || '';

  function setToken(t){
    token = t || '';
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  }

  async function request(method, url, body){
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(url, { method, headers,
        body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch (e) {
      throw new Error('无法连接万事屋服务');
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (res.status === 401){
      const msg = (data && data.detail) || '未登录或会话已过期';
      const textMsg = typeof msg === 'string' ? msg : JSON.stringify(msg);
      /* 登录/注册/切换账号的 401 是凭证错误，不能清会话、也不能改口风 */
      if (!/^\/api\/auth\/(login|register|switch|session|first)\b/.test(url)){
        App.onUnauthorized();
        throw new Error('未登录或会话已过期');
      }
      throw new Error(textMsg);
    }
    if (!res.ok){
      const msg = (data && data.detail) || ('请求失败 ' + res.status);
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    return data;
  }

  /* FormData 上传（图片等附件）：不设 Content-Type，由浏览器自带边界 */
  async function upload(url, fd){
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: fd });
    } catch (e) {
      throw new Error('无法连接万事屋服务');
    }
    if (res.status === 401){
      App.onUnauthorized();
      throw new Error('未登录或会话已过期');
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok){
      const msg = (data && data.detail) || ('请求失败 ' + res.status);
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    return data;
  }

  return {
    setToken,
    getToken: () => token,
    get:  (url)        => request('GET', url),
    post: (url, body)  => request('POST', url, body),
    put:  (url, body)  => request('PUT', url, body),
    del:  (url, body)  => request('DELETE', url, body),
    upload,
    /* 带鉴权的下载链接（备份 / 导出） */
    dl: (url) => {
      const a = document.createElement('a');
      a.href = url; a.download = '';
      /* token 以查询参数附加，后端同时支持 */
      a.href += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
      document.body.appendChild(a); a.click(); a.remove();
    },
  };
})();
