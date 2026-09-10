/* ============================================================
   OmniDesk · 密码保险库（零知识 · 端到端加密）
   主密码 → PBKDF2-SHA256 派生 AES-GCM 密钥，全部在浏览器完成；
   服务端只保存密文，永远无法解密。
   ============================================================ */
const Vault = (() => {
  let derivedKey = null;
  let vaultData = { check: null, salt: null, items: {} };
  let failCount = 0;
  let editingId = null;

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
        vaultData.check = await enc({ v: 1 });
        vaultData.items = {};
        await API.put('/api/vault', { check: vaultData.check, salt: vaultData.salt, items: {} });
      } else {
        derivedKey = await deriveKey(master, b64ToBuf(vaultData.salt));
        try { await dec(vaultData.check); }
        catch (e) {
          failCount++;
          derivedKey = null;
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
  async function render(){
    const box = $('#vaultItems');
    const entries = Object.entries(vaultData.items);
    $('#vaultCount').textContent = entries.length + ' 条';
    if (!entries.length){
      box.innerHTML = `<div class="empty" style="padding:36px 0">
        <div class="empty-ic"><svg class="ic"><use href="#i-shield"/></svg></div>
        <div class="empty-title">保险库还是空的</div>
        <div class="empty-sub">点击右上角「新增凭据」保存你的第一条密码</div></div>`;
      return;
    }
    const rows = [];
    for (const [id, item] of entries){
      let data = {};
      try { data = await dec(item.blob); } catch (e) { continue; }
      const strength = score(data.password || '');
      rows.push(`<div class="v-item" data-v-id="${id}">
        <span class="v-fav" style="--fav:${item.meta.hue ?? 243}">${App.esc((data.name || '?').charAt(0).toUpperCase())}</span>
        <div class="v-info"><div class="v-name">${App.esc(data.name)}</div>
          <div class="v-account">${App.esc(data.account || '')}</div></div>
        <span class="strength s${strength}" title="强度 ${strength}/4"><i></i><i></i><i></i><i></i></span>
        <span class="v-pass" data-v-pass>••••••••••••</span>
        <span class="v-date">${App.esc(item.meta.updated || '')}</span>
        <div class="v-actions">
          <button class="icon-btn-xs" data-v-act="show" title="显示"><svg class="ic"><use href="#i-eye"/></svg></button>
          <button class="icon-btn-xs" data-v-act="copy" title="复制"><svg class="ic"><use href="#i-copy"/></svg></button>
          <button class="icon-btn-xs" data-v-act="edit" title="编辑"><svg class="ic"><use href="#i-pen"/></svg></button>
          <button class="icon-btn-xs" data-v-act="del" title="删除"><svg class="ic"><use href="#i-trash"/></svg></button>
        </div></div>`);
    }
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

  /* ---------- 增删改 ---------- */
  function openEditor(id){
    editingId = id;
    $('#viName').value = ''; $('#viAccount').value = ''; $('#viUrl').value = '';
    $('#viPass').value = ''; $('#viNote').value = '';
    if (id && vaultData.items[id]){
      dec(vaultData.items[id].blob).then(d => {
        $('#viName').value = d.name || ''; $('#viAccount').value = d.account || '';
        $('#viUrl').value = d.url || ''; $('#viPass').value = d.password || '';
        $('#viNote').value = d.note || '';
      }).catch(() => {});
    }
    App.openModal('vaultItemMask');
  }

  async function saveItem(){
    const name = $('#viName').value.trim();
    if (!name) return showToast('请填写名称', 'err');
    const payload = {
      name, account: $('#viAccount').value.trim(), url: $('#viUrl').value.trim(),
      password: $('#viPass').value, note: $('#viNote').value.trim(),
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
      const actBtn = e.target.closest('[data-v-act]');
      if (!actBtn) return;
      const row = actBtn.closest('[data-v-id]');
      const id = row.dataset.vId;
      const item = vaultData.items[id];
      let data = {};
      try { data = await dec(item.blob); } catch (err) { return showToast('解密失败', 'err'); }
      const act = actBtn.dataset.vAct;
      if (act === 'show'){
        const el = $('[data-v-pass]', row);
        if (el.textContent === '••••••••••••') el.textContent = data.password || '（空）';
        else el.textContent = '••••••••••••';
      }
      if (act === 'copy'){
        await navigator.clipboard.writeText(data.password || '');
        showToast('密码已复制，30 秒后清除剪贴板提示');
      }
      if (act === 'edit') openEditor(id);
      if (act === 'del'){
        if (!confirm(`删除「${data.name}」？此操作不可恢复。`)) return;
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
