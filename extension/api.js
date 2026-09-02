/* ============================================================
   OmniHome 插件 · 服务端 API 封装（MV3 ES Module）
   - 凭证存 chrome.storage.local：{ server, username, password, token }
   - 401 自动用保存的密码重登一次；仍失败则标记未登录
   ============================================================ */

const KEY = 'omni_auth';

export async function getAuth(){
  const r = await chrome.storage.local.get(KEY);
  return r[KEY] || null;
}

export async function saveAuth(auth){
  await chrome.storage.local.set({ [KEY]: auth });
}

export async function clearAuth(){
  await chrome.storage.local.remove(KEY);
}

export function normServer(u){
  let s = String(u || '').trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s;
}

export async function login(server, username, password){
  server = normServer(server);
  if (!server) throw new Error('请填写服务器地址');
  const res = await fetch(server + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).catch(() => { throw new Error('无法连接服务器，请检查地址与网络'); });
  if (res.status === 401) throw new Error('用户名或密码错误');
  if (!res.ok) throw new Error('登录失败（HTTP ' + res.status + '）');
  const d = await res.json();
  if (!d.token) throw new Error('服务器响应异常（无 token）');
  return { server, username, password, token: d.token, user: d.user || {} };
}

/* 仅验证地址可达且是 OmniHome 服务（不需要账号） */
export async function testConnection(server){
  server = normServer(server);
  if (!server) throw new Error('请填写服务器地址');
  const res = await fetch(server + '/api/about')
    .catch(() => { throw new Error('无法连接服务器，请检查地址与网络'); });
  if (!res.ok) throw new Error('服务器响应异常（HTTP ' + res.status + '）');
  const d = await res.json().catch(() => null);
  if (!d || !d.name) throw new Error('响应异常：该地址不是 OmniHome 服务');
  return d;
}

/* 带鉴权的请求；401 时自动重登一次 */
export async function api(method, path, body, _retried){
  const auth = await getAuth();
  if (!auth || !auth.token) throw new Error('NO_AUTH');
  const headers = { 'Authorization': 'Bearer ' + auth.token };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(auth.server + path, {
      method, headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error('无法连接服务器，请检查地址与网络');
  }
  if (res.status === 401 && !_retried && auth.username && auth.password){
    try {
      const fresh = await login(auth.server, auth.username, auth.password);
      await saveAuth(fresh);
      return api(method, path, body, true);
    } catch (e) {
      throw new Error('会话已失效，请重新登录');
    }
  }
  if (!res.ok){
    let msg = 'HTTP ' + res.status;
    try { msg = (await res.json()).detail || msg; } catch (e) { /* 非 JSON 错误体 */ }
    throw new Error(msg);
  }
  return res.json();
}

export const getBookmarks = () => api('GET', '/api/bookmarks');
export const getCats = () => api('GET', '/api/bookmark-cats');
export const addBookmark = bm => api('POST', '/api/bookmarks', bm);
export const replaceBookmarks = bms => api('PUT', '/api/bookmarks', bms);
export const replaceCats = cats => api('PUT', '/api/bookmark-cats', cats);
export const analyzeBookmark = body => api('POST', '/api/ai/analyze-bookmark', body);
