/* ============================================================
   OmniDesk · 密码保险库（零知识 · 端到端加密）
   主密码 → PBKDF2-SHA256 派生 AES-GCM 密钥，全部在浏览器完成；
   服务端只保存密文，永远无法解密。
   分类名单写在校验密文 check 内，凭据的 cat 写在条目密文内。
   ============================================================ */
const Vault = (() => {
  let derivedKey = null;
  let vaultData = { check: null, salt: null, items: {} };
  let failCount = 0;
  let editingId = null;
  let cats = [];          // 用户分类 [{id, name}]，不含「全部」「未分类」
  let activeCat = 'all';

  /* ---------- Base64 工具 ---------- */
  const bufToB64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const b64ToBuf = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;

  /* ---------- 加密原语 ---------- */
  async function deriveKey(master, saltBuf){
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(master),
      'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBuf, iterations: 310000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function enc(obj){
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv },
      derivedKey, new TextEncoder().encode(JSON.stringify(obj)));
    const out = new Uint8Array(iv.length + ct.byteLength);
    out.set(iv, 0); out.set(new Uint8Array(ct), iv.length);
    return bufToB64(out.buffer);
  }
  async function dec(b64){
    const raw = new Uint8Array(b64ToBuf(b64));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) },
      derivedKey, raw.slice(12));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  /* ---------- 分类 ---------- */
  const ALL = { id: 'all', name: '全部' };
  const NONE = { id: 'none', name: '未分类' };
  function normalizeCats(raw){
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    for (const c of raw){
      const id = String(c?.id || '').trim();
      const name = String(c?.name || '').trim();
      if (!id || !name || id === 'all' || id === 'none' || seen.has(id)) continue;
      seen.add(id);
      out.push({ id: id.slice(0, 16), name: name.slice(0, 24) });
    }
    return out;
  }
  function catTabs(){ return [ALL, ...cats, NONE]; }
  function catName(id){
    if (!id || id === 'none') return NONE.name;
    if (id === 'all') return ALL.name;
    return (cats.find(c => c.id === id) || NONE).name;
  }
  function itemCat(data){
    const id = String(data?.cat || 'none');
    return cats.some(c => c.id === id) ? id : 'none';
  }
  async function writeCheck(){
    vaultData.check = await enc({ v: 1, cats });
  }

  /* ---------- 解锁 ---------- */
  async function unlock(){
    const master = $('#masterPass').value;
    if (!master) return showToast('请输入主密码', 'err');
    try {
      vaultData = await API.get('/api/vault');
      if (!vaultData.salt){
        /* 首次设置：二次确认 */
        if ($('#masterPass2').value !== master){
          $('#masterPass2Wrap').hidden = false;
          return showToast('请再次输入主密码确认', 'err');
        }
        const saltBuf = crypto.getRandomValues(new Uint8Array(16));
        derivedKey = await deriveKey(master, saltBuf);
        vaultData.salt = bufToB64(saltBuf.buffer);
        cats = [];
        activeCat = 'all';
        await writeCheck();
        vaultData.items = {};
        await API.put('/api/vault', { check: vaultData.check, salt: vaultData.salt, items: {} });
      } else {
        derivedKey = await deriveKey(master, b64ToBuf(vaultData.salt));
        try {
          const payload = await dec(vaultData.check);
          cats = normalizeCats(payload && payload.cats);
        }
        catch (e) {
          failCount++;
          derivedKey = null;
          cats = [];
          return showToast(`主密码错误（${failCount}/5）`, 'err');
        }
      }
      $('#vaultWrap').classList.add('unlocked');
      render();
      updateBadge();
      showToast('保险库已解锁');
    } catch (e) {
      showToast(e.message, 'err');
    }
  }

  /* ---------- 渲染 ---------- */
  function renderCats(counts){
    const box = $('#vaultCats');
    if (!box) return;
    const tabs = catTabs().map(c => {
      const builtin = c.id === 'all' || c.id === 'none';
      const n = c.id === 'all' ? (counts.all || 0) : (counts[c.id] || 0);
      const ops = builtin ? '' : `<span class="tab-ops">
          <i data-v-cat-edit="${c.id}" title="重命名分类"><svg class="ic"><use href="#i-pen"/></svg></i>
          <i data-v-cat-del="${c.id}" title="删除分类"><svg class="ic"><use href="#i-close"/></svg></i>
        </span>`;
      return `<button type="button" class="tab ${c.id === activeCat ? 'active' : ''}" data-v-cat="${c.id}">
        ${App.esc(c.name)}<span class="bm-cat-n num">${n}</span>${ops}
      </button>`;
    }).join('');
    box.innerHTML = tabs +
      `<button type="button" class="tab tab-add" data-v-cat-add title="新建分类"><svg class="ic"><use href="#i-plus"/></svg>分类</button>`;
  }

  function previewHtml(data){
    const url = data.url || '';
    const account = data.account || '';
    const password = data.password || '';
    const urlInner = url
      ? (/^https?:\/\//i.test(url)
        ? `<a href="${App.esc(url)}" target="_blank" rel="noopener">${App.esc(url)}</a>`
        : App.esc(url))
      : '<span class="v-empty">未填写</span>';
    const row = (key, label, inner, copyVal) => `<div class="v-kv">
      <span class="v-k">${label}</span>
      <span class="v-v" data-v-field="${key}">${inner}</span>
      <button type="button" class="icon-btn-xs" data-v-copy="${key}" ${copyVal ? '' : 'disabled'} title="复制${label}"><svg class="ic"><use href="#i-copy"/></svg></button>
    </div>`;
    return row('url', '地址', urlInner, url) +
      row('account', '账号', account ? App.esc(account) : '<span class="v-empty">未填写</span>', account) +
      row('password', '密码', password ? `<span class="v-pass-plain">${App.esc(password)}</span>` : '<span class="v-empty">未填写</span>', password);
  }

  async function render(){
    const box = $('#vaultItems');
    const entries = Object.entries(vaultData.items || {});
    const decoded = [];
    const counts = { all: 0, none: 0 };
    cats.forEach(c => { counts[c.id] = 0; });
    for (const [id, item] of entries){
      let data = {};
      try { data = await dec(item.blob); } catch (e) { continue; }
      const cat = itemCat(data);
      counts.all++;
      counts[cat] = (counts[cat] || 0) + 1;
      decoded.push({ id, item, data, cat });
    }
    renderCats(counts);
    const title = $('#vaultTitle');
    if (title) title.textContent = activeCat === 'all' ? '全部凭据' : catName(activeCat);
    const shown = decoded.filter(x => activeCat === 'all' || x.cat === activeCat);
    $('#vaultCount').textContent = shown.length + ' 条';
    if (!decoded.length){
      box.innerHTML = `<div class="empty" style="padding:36px 0">
        <div class="empty-ic"><svg class="ic"><use href="#i-shield"/></svg></div>
        <div class="empty-title">保险库还是空的</div>
        <div class="empty-sub">点击右上角「新增凭据」保存你的第一条密码</div></div>`;
      return;
    }
    if (!shown.length){
      box.innerHTML = `<div class="empty" style="padding:36px 0">
        <div class="empty-ic"><svg class="ic"><use href="#i-folder"/></svg></div>
        <div class="empty-title">「${App.esc(catName(activeCat))}」还没有凭据</div>
        <div class="empty-sub">新增凭据时选择此分类，或把已有凭据改到这里</div></div>`;
      return;
    }
    const rows = shown.map(({ id, item, data, cat }) => {
      const strength = score(data.password || '');
      const catChip = activeCat === 'all'
        ? `<span class="chip no-dot v-cat-chip">${App.esc(catName(cat))}</span>`
        : '';
      return `<div class="v-item" data-v-id="${id}">
        <div class="v-main">
          <span class="v-fav" style="--fav:${item.meta.hue ?? 243}">${App.esc((data.name || '?').charAt(0).toUpperCase())}</span>
          <div class="v-info"><div class="v-name">${App.esc(data.name)} ${catChip}</div>
            <div class="v-account">${App.esc(data.account || '')}</div></div>
          <span class="strength s${strength}" title="强度 ${strength}/4"><i></i><i></i><i></i><i></i></span>
          <span class="v-pass" data-v-pass>••••••••••••</span>
          <span class="v-date">${App.esc(item.meta.updated || '')}</span>
          <div class="v-actions">
            <button class="icon-btn-xs" data-v-act="show" title="预览"><svg class="ic"><use href="#i-eye"/></svg></button>
            <button class="icon-btn-xs" data-v-act="copy" title="复制密码"><svg class="ic"><use href="#i-copy"/></svg></button>
            <button class="icon-btn-xs" data-v-act="edit" title="编辑"><svg class="ic"><use href="#i-pen"/></svg></button>
            <button class="icon-btn-xs" data-v-act="del" title="删除"><svg class="ic"><use href="#i-trash"/></svg></button>
          </div>
        </div>
        <div class="v-preview" hidden></div>
      </div>`;
    });
    box.innerHTML = rows.join('');
  }

  function score(pwd){
    let s = 0;
    if (pwd.length >= 8) s++;
    if (pwd.length >= 12) s++;
    if (/[A-Z]/.test(pwd) && /[a-z]/.test(pwd)) s++;
    if (/[^A-Za-z0-9]/.test(pwd) && /\d/.test(pwd)) s++;
    return Math.max(1, Math.min(4, s));
  }

  function updateBadge(){
    const n = Object.keys(vaultData.items || {}).length;
    $('#vaultBadge').textContent = n || '';
    $('#vaultBadge').style.display = n ? '' : 'none';
  }

  async function persist(){
    await API.put('/api/vault', { check: vaultData.check, salt: vaultData.salt,
                                  items: vaultData.items });
    updateBadge();
  }

  function fillCatSelect(selected){
    const sel = $('#viCat');
    if (!sel) return;
    const cur = cats.some(c => c.id === selected) ? selected : 'none';
    sel.innerHTML = [{ id: 'none', name: '未分类' }, ...cats]
      .map(c => `<option value="${App.esc(c.id)}" ${c.id === cur ? 'selected' : ''}>${App.esc(c.name)}</option>`)
      .join('');
  }

  /* ---------- 增删改 ---------- */
  function openEditor(id){
    editingId = id;
    $('#viName').value = ''; $('#viAccount').value = ''; $('#viUrl').value = '';
    $('#viPass').value = ''; $('#viNote').value = '';
    const fallback = activeCat === 'all' ? 'none' : activeCat;
    fillCatSelect(fallback);
    if (id && vaultData.items[id]){
      dec(vaultData.items[id].blob).then(d => {
        $('#viName').value = d.name || ''; $('#viAccount').value = d.account || '';
        $('#viUrl').value = d.url || ''; $('#viPass').value = d.password || '';
        $('#viNote').value = d.note || '';
        fillCatSelect(itemCat(d));
      }).catch(() => {});
    }
    App.openModal('vaultItemMask');
  }

  async function saveItem(){
    const name = $('#viName').value.trim();
    if (!name) return showToast('请填写名称', 'err');
    const cat = itemCat({ cat: $('#viCat')?.value });
    const payload = {
      name, account: $('#viAccount').value.trim(), url: $('#viUrl').value.trim(),
      password: $('#viPass').value, note: $('#viNote').value.trim(), cat,
    };
    const id = editingId || crypto.randomUUID().slice(0, 8);
    vaultData.items[id] = {
      blob: await enc(payload),
      meta: { name, hue: [...name].reduce((a, c) => a + c.codePointAt(0), 0) % 360,
              updated: new Date().toLocaleDateString('zh-CN') },
    };
    await persist();
    App.closeModal('vaultItemMask');
    render();
    showToast(editingId ? '凭据已更新' : '凭据已加密保存');
  }

  async function addCat(){
    const name = await App.promptModal({
      title: '新建分类',
      sub: '凭据可按分类归组，分类名称同样加密保存在本地',
      placeholder: '分类名称，如：工作、社交',
    });
    if (!name) return;
    const trimmed = name.trim().slice(0, 24);
    if (!trimmed) return;
    if (trimmed === '全部' || trimmed === '未分类') return showToast('请换一个分类名', 'err');
    if (cats.some(c => c.name === trimmed)) return showToast('已有同名分类', 'err');
    const id = crypto.randomUUID().slice(0, 8);
    cats.push({ id, name: trimmed });
    activeCat = id;
    await writeCheck();
    await persist();
    render();
    showToast(`已新建分类「${trimmed}」`);
  }

  async function renameCat(cid){
    const old = catName(cid);
    const name = await App.promptModal({ title: '重命名分类', value: old, placeholder: '新的分类名称' });
    if (!name) return;
    const trimmed = name.trim().slice(0, 24);
    if (!trimmed || trimmed === old) return;
    const hit = cats.find(c => c.id === cid);
    if (!hit) return;
    hit.name = trimmed;
    await writeCheck();
    await persist();
    render();
    showToast('分类已重命名');
  }

  async function delCat(cid){
    const hit = cats.find(c => c.id === cid);
    if (!hit) return;
    const n = Object.keys(vaultData.items || {}).length;
    /* 精确计数要解密，确认文案用「其下凭据将移入未分类」即可 */
    const ok = await App.confirmModal({
      title: `删除分类「${hit.name}」？`,
      sub: n ? '该分类下的凭据会改到「未分类」，凭据本身不会删除。' : '该分类下暂无凭据。',
      okText: '删除', danger: true,
    });
    if (!ok) return;
    for (const [id, item] of Object.entries(vaultData.items || {})){
      let data;
      try { data = await dec(item.blob); } catch (e) { continue; }
      if (itemCat(data) === cid){
        data.cat = 'none';
        vaultData.items[id] = { ...item, blob: await enc(data) };
      }
    }
    cats = cats.filter(c => c.id !== cid);
    if (activeCat === cid) activeCat = 'none';
    await writeCheck();
    await persist();
    render();
    showToast('分类已删除');
  }

  function setPreview(row, data, on){
    const pane = row.querySelector('.v-preview');
    const mask = row.querySelector('[data-v-pass]');
    const btn = row.querySelector('[data-v-act="show"]');
    row.classList.toggle('is-open', on);
    if (!pane) return;
    if (on){
      pane.hidden = false;
      pane.innerHTML = previewHtml(data);
      if (mask) mask.hidden = true;
      if (btn){
        btn.title = '隐藏';
        const use = btn.querySelector('use');
        if (use) use.setAttribute('href', '#i-eye-off');
      }
    } else {
      pane.hidden = true;
      pane.innerHTML = '';
      if (mask) mask.hidden = false;
      if (btn){
        btn.title = '预览';
        const use = btn.querySelector('use');
        if (use) use.setAttribute('href', '#i-eye');
      }
    }
  }

  /* ---------- 事件 ---------- */
  function init(){
    $('#unlockBtn').addEventListener('click', unlock);
    $('#masterPass').addEventListener('keydown', e => { if (e.key === 'Enter') unlock(); });
    $('#vaultNew').addEventListener('click', () => openEditor(null));
    $('#viCancel').addEventListener('click', () => App.closeModal('vaultItemMask'));
    $('#viSave').addEventListener('click', saveItem);
    $('#viGen').addEventListener('click', () => {
      $('#viPass').value = genPass(16);
    });

    document.addEventListener('click', async e => {
      if (e.target.closest('[data-v-cat-add]')){
        e.preventDefault();
        return addCat();
      }
      const editCat = e.target.closest('[data-v-cat-edit]');
      if (editCat){
        e.preventDefault(); e.stopPropagation();
        return renameCat(editCat.getAttribute('data-v-cat-edit'));
      }
      const delBtn = e.target.closest('[data-v-cat-del]');
      if (delBtn){
        e.preventDefault(); e.stopPropagation();
        return delCat(delBtn.getAttribute('data-v-cat-del'));
      }
      const tab = e.target.closest('#vaultCats [data-v-cat]');
      if (tab){
        if (e.target.closest('.tab-ops')) return;
        activeCat = tab.dataset.vCat;
        return render();
      }

      const copyField = e.target.closest('[data-v-copy]');
      if (copyField){
        const row = copyField.closest('[data-v-id]');
        if (!row || !derivedKey) return;
        const item = vaultData.items[row.dataset.vId];
        let data = {};
        try { data = await dec(item.blob); } catch (err) { return showToast('解密失败', 'err'); }
        const key = copyField.dataset.vCopy;
        const map = { url: data.url, account: data.account, password: data.password };
        const label = { url: '地址', account: '账号', password: '密码' }[key] || key;
        await navigator.clipboard.writeText(map[key] || '');
        return showToast(`${label}已复制`);
      }

      const actBtn = e.target.closest('[data-v-act]');
      if (!actBtn) return;
      const row = actBtn.closest('[data-v-id]');
      const id = row.dataset.vId;
      const item = vaultData.items[id];
      let data = {};
      try { data = await dec(item.blob); } catch (err) { return showToast('解密失败', 'err'); }
      const act = actBtn.dataset.vAct;
      if (act === 'show'){
        setPreview(row, data, !row.classList.contains('is-open'));
      }
      if (act === 'copy'){
        await navigator.clipboard.writeText(data.password || '');
        showToast('密码已复制，30 秒后清除剪贴板提示');
      }
      if (act === 'edit') openEditor(id);
      if (act === 'del'){
        const ok = await App.confirmModal({
          title: `删除「${data.name}」？`,
          sub: '此操作不可恢复。',
          okText: '删除', danger: true,
        });
        if (!ok) return;
        delete vaultData.items[id];
        await persist(); render();
        showToast('凭据已删除');
      }
    });
  }

  function genPass(len){
    const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz',
                  '23456789', '!@#$%^&*()-_=+'];
    const all = sets.join('');
    const buf = new Uint32Array(len);
    crypto.getRandomValues(buf);
    let out = sets.map((s, i) => s[buf[i] % s.length]);
    for (let i = out.length; i < len; i++) out.push(all[buf[i % buf.length] % all.length]);
    return out.sort(() => Math.random() - 0.5).join('');
  }

  return { init, genPass, updateBadge };
})();
Vault.init();
App.onEnter(() => {
  $('#vaultWrap').classList.remove('unlocked');
  $('#masterPass').value = '';
  $('#masterPass2').value = '';
  API.get('/api/vault').then(v => {
    /* 已初始化则隐藏确认输入 */
    $('#masterPass2Wrap').hidden = !!v.salt;
    const n = Object.keys(v.items || {}).length;
    $('#vaultBadge').textContent = n || '';
    $('#vaultBadge').style.display = n ? '' : 'none';
    const dash = $('#dashVaultNum');
    if (dash) dash.textContent = n;
  }).catch(() => {});
});

export { Vault };
window.Vault = Vault;
