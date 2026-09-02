/* ============================================================
   OmniHome 插件 · 内容脚本（ISOLATED world）
   1. 转发页面变动信号（content-hook.js postMessage）给后台
   2. 右键菜单唤起的页内保存卡片：改名称 / 选分类 / AI 分析 / 保存，
      全部在当前页面内完成，不再新开标签页
   ============================================================ */

window.addEventListener('message', e => {
  if (e.source === window && e.data && e.data.type === '__OMNI_DATA_CHANGED__'){
    chrome.runtime.sendMessage({ type: 'OMNI_CHANGED' }).catch(() => {});
  }
});

let host = null;
let savedTags = [];

const CARD_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .card { position: fixed; top: 20px; right: 20px; z-index: 2147483647; width: 330px;
    background: #12141f; color: #e8e9f1; border: 1px solid rgba(168,85,247,.35);
    border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.5); overflow: hidden;
    animation: omni-in .18s ease-out; }
  @keyframes omni-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
  .hd { display: flex; align-items: center; gap: 8px; padding: 12px 14px;
    background: linear-gradient(90deg, rgba(168,85,247,.22), rgba(99,102,241,.16)); }
  .logo { width: 22px; height: 22px; border-radius: 6px; display: flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, #a855f7, #6366f1); color: #fff; font-weight: 700; font-size: 12px; }
  .hd b { font-size: 13px; flex: 1; }
  .x { border: 0; background: transparent; color: #8b8fa3; font-size: 16px; cursor: pointer; line-height: 1; padding: 2px 4px; }
  .x:hover { color: #fff; }
  .body { padding: 12px 14px 4px; }
  .row { margin-bottom: 10px; }
  label { display: block; font-size: 11px; color: #8b8fa3; margin-bottom: 4px; }
  input, select { width: 100%; padding: 8px 10px; font-size: 12.5px; color: #e8e9f1;
    background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1);
    border-radius: 8px; outline: none; }
  input:focus, select:focus { border-color: #a855f7; }
  select option { background: #191b28; }
  .tags { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; }
  .tag { font-size: 11px; padding: 2px 8px; border-radius: 20px; color: #c4b5fd;
    background: rgba(168,85,247,.15); border: 1px solid rgba(168,85,247,.3); cursor: pointer; }
  .err { font-size: 11.5px; color: #f87171; margin: 2px 0 8px; line-height: 1.5; }
  .notice { font-size: 12px; color: #fbbf24; background: rgba(251,191,36,.1);
    border: 1px solid rgba(251,191,36,.25); border-radius: 8px; padding: 8px 10px; margin-bottom: 10px; line-height: 1.5; }
  .ft { display: flex; gap: 8px; padding: 10px 14px 14px; }
  button { flex: 1; padding: 9px 0; font-size: 12.5px; border-radius: 9px; cursor: pointer; border: 0; }
  .ghost { background: rgba(255,255,255,.08); color: #e8e9f1; }
  .ghost:hover { background: rgba(255,255,255,.14); }
  .primary { background: linear-gradient(135deg, #a855f7, #6366f1); color: #fff; font-weight: 600; }
  .primary:hover { filter: brightness(1.1); }
  button:disabled { opacity: .55; cursor: default; }
  .done { padding: 26px 14px; text-align: center; }
  .done .ok { width: 42px; height: 42px; margin: 0 auto 10px; border-radius: 50%;
    background: rgba(16,185,129,.15); color: #10b981; font-size: 22px;
    display: flex; align-items: center; justify-content: center; }
  .done p { font-size: 13px; color: #e8e9f1; }
  .done span { font-size: 11.5px; color: #8b8fa3; }
`;

function closeCard(){
  if (host){ host.remove(); host = null; }
}

async function showCard(opts){
  closeCard();
  savedTags = [];
  let logged = false, cats = [];
  try {
    const st = await chrome.runtime.sendMessage({ type: 'CARD_STATE' });
    logged = !!(st && st.logged);
    cats = (st && st.cats) || [];
  } catch (e) { /* 后台不可用按未登录处理 */ }

  host = document.createElement('div');
  host.id = 'omni-ext-host';
  const sr = host.attachShadow({ mode: 'closed' });
  sr.innerHTML = `<style>${CARD_CSS}</style>
    <div class="card">
      <div class="hd">
        <span class="logo">O</span><b>保存到 OmniHome</b>
        <button class="x" title="关闭">×</button>
      </div>
      ${logged ? `
      <div class="body">
        <div class="row"><label>名称</label><input id="name" maxlength="80"></div>
        <div class="row"><label>分类</label><select id="cat"></select></div>
        <div class="row"><label>描述</label><input id="desc" maxlength="60" placeholder="可用 AI 分析自动填写"></div>
        <div class="row"><label>标签</label><input id="tagIn" placeholder="输入后回车添加，可多个" autocomplete="off"></div>
        <div class="tags" id="tags"></div>
        <div class="err" id="err"></div>
      </div>
      <div class="ft">
        <button class="ghost" id="ai">✨ AI 分析</button>
        <button class="primary" id="save">保存书签</button>
      </div>` : `
      <div class="body">
        <div class="notice">尚未登录。请点击浏览器右上角的 OmniHome 插件图标，填写服务器地址并登录后再收藏。</div>
      </div>
      <div class="ft"><button class="ghost" id="only-close">知道了</button></div>`}
    </div>`;
  document.documentElement.appendChild(host);

  sr.querySelector('.x').addEventListener('click', closeCard);
  const onlyClose = sr.getElementById('only-close');
  if (onlyClose){ onlyClose.addEventListener('click', closeCard); return; }

  const name = sr.getElementById('name');
  const sel = sr.getElementById('cat');
  const desc = sr.getElementById('desc');
  const errBox = sr.getElementById('err');
  const aiBtn = sr.getElementById('ai');
  const saveBtn = sr.getElementById('save');

  name.value = opts.title || opts.url || '';
  const usable = cats.filter(c => c.id !== 'all');
  sel.innerHTML = usable.map(c =>
    `<option value="${c.id}">${c.name}</option>`).join('');
  if (usable.find(c => c.id === opts.preselect)) sel.value = opts.preselect;
  /* 默认落「未分类」：用户不选分类时书签也能在万事屋找到 */
  else if (usable.find(c => c.id === 'none')) sel.value = 'none';
  else if (usable.find(c => c.id === 'common')) sel.value = 'common';

  const showErr = m => { errBox.textContent = m || ''; };
  /* 标签输入：回车 / 逗号落一个标签 */
  const tagIn = sr.getElementById('tagIn');
  tagIn.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ','){
      e.preventDefault();
      const v = tagIn.value.trim().replace(/,+$/, '');
      if (v && !savedTags.includes(v)) savedTags.push(v);
      tagIn.value = '';
      renderTags();
    }
  });
  const renderTags = () => {
    sr.getElementById('tags').innerHTML = savedTags.map((t, i) =>
      `<span class="tag" data-i="${i}" title="点击移除">${t} ×</span>`).join('');
    sr.getElementById('tags').querySelectorAll('.tag').forEach(el => {
      el.addEventListener('click', () => {
        savedTags.splice(Number(el.dataset.i), 1);
        renderTags();
      });
    });
  };

  aiBtn.addEventListener('click', async () => {
    showErr('');
    aiBtn.disabled = true; aiBtn.textContent = '分析中…';
    try {
      const r = await chrome.runtime.sendMessage({
        type: 'CARD_AI', name: name.value, url: opts.url, desc: desc.value,
      });
      if (!r || !r.ok) throw new Error((r && r.error) || 'AI 分析失败');
      if (r.catId && usable.find(c => c.id === r.catId)) sel.value = r.catId;
      if (r.desc) desc.value = r.desc;
      savedTags = (r.tags || []).slice(0, 4);
      renderTags();
    } catch (e) {
      showErr(e.message === 'NO_AUTH' ? '会话已失效，请在插件中重新登录' : e.message);
    } finally {
      aiBtn.disabled = false; aiBtn.textContent = '✨ AI 分析';
    }
  });

  saveBtn.addEventListener('click', async () => {
    showErr('');
    saveBtn.disabled = true; saveBtn.textContent = '保存中…';
    try {
      const r = await chrome.runtime.sendMessage({
        type: 'CARD_SAVE', name: name.value.trim() || opts.title || opts.url,
        url: opts.url, cat: sel.value || 'none',
        desc: desc.value.trim(), tags: savedTags,
      });
      if (!r || !r.ok) throw new Error((r && r.error) || '保存失败');
      const catName = (usable.find(c => c.id === r.cat) || {}).name || '未分类';
      sr.querySelector('.card').innerHTML = `
        <div class="hd"><span class="logo">O</span><b>保存到 OmniHome</b></div>
        <div class="done"><div class="ok">✓</div>
          <p>已收藏到「${catName}」分类</p><span>稍后将自动同步到浏览器书签</span></div>`;
      setTimeout(closeCard, 1600);
    } catch (e) {
      showErr(e.message === 'NO_AUTH' ? '会话已失效，请在插件中重新登录' : e.message);
      saveBtn.disabled = false; saveBtn.textContent = '保存书签';
    }
  });

  name.focus();
  document.addEventListener('keydown', escClose);
}
function escClose(e){
  if (e.key === 'Escape'){ closeCard(); document.removeEventListener('keydown', escClose); }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'OMNI_OPEN_CARD'){
    showCard({ url: msg.url || '', title: msg.title || '', preselect: msg.preselect || '' });
    return Promise.resolve({ ok: true });
  }
});
