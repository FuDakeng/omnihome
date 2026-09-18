/* ============================================================
   OmniDesk · 密码保险库（零知识 · 端到端加密）
   主密码 → PBKDF2-SHA256 派生 AES-GCM 密钥，全部在浏览器完成。
   排版对齐快捷导航：左分类、右卡片；分类/凭据均可多选、拖拽排序、
   拖到分类归类、拖到底部条快速删除。同一网站可保存多条账号。
   分类名单写在校验密文 check 内，凭据字段写在条目密文内。
   ============================================================ */
const Vault = (() => {
  let derivedKey = null;
  let vaultData = { check: null, salt: null, items: {} };
  let failCount = 0;
  let editingId = null;
  let cats = [];          // [{id, name}]，含内置「全部」「未分类」
  let activeCat = 'all';
  let sortMode = 'manual';
  let cache = [];         // 解锁后明文缓存 {id, item, data, cat}
  let sel = new Set();    // 多选凭据
  let catSel = new Set(); // 多选分类（不含全部）
  let dragEl = null;
  let dragKind = '';      // 'card' | 'cat'
  let dragIds = [];
  let droppedCat = false;
  let droppedBar = false;
  const HINT_CARD = '拖到左侧分类可归类，拖到此条可删除';
  const HINT_CAT = '松手到此横条可删除分类（凭据改到未分类）';
  const HINT_DRAG = '松手到此横条可快速删除';

  const ALL = { id: 'all', name: '全部' };
  const NONE = { id: 'none', name: '未分类' };

  /* ---------- Base64 / 加密 ---------- */
  const bufToB64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const b64ToBuf = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;

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

  /* ---------- 分类 / 站点 ---------- */
  function normalizeCats(raw){
    const seen = new Set();
    const out = [];
    if (Array.isArray(raw)){
      for (const c of raw){
        const id = String(c?.id || '').trim();
        const name = String(c?.name || '').trim();
        if (!id || !name || seen.has(id)) continue;
        seen.add(id);
        out.push({ id: id.slice(0, 16), name: name.slice(0, 24) });
      }
    }
    if (!out.find(c => c.id === 'all')) out.unshift({ ...ALL });
    if (!out.find(c => c.id === 'none')) out.push({ ...NONE });
    return out;
  }
  function catName(id){
    if (!id || id === 'none') return NONE.name;
    if (id === 'all') return ALL.name;
    return (cats.find(c => c.id === id) || NONE).name;
  }
  function itemCat(data){
    const id = String(data?.cat || 'none');
    if (id === 'all') return 'none';
    return cats.some(c => c.id === id && c.id !== 'all') ? id : 'none';
  }
  function hostOf(url){
    if (!url) return '';
    try { return new URL(/^https?:\/\//.test(url) ? url : 'https://' + url).host; }
    catch (e) { return ''; }
  }
  function sameSiteN(host){
    if (!host) return 1;
    return cache.filter(x => hostOf(x.data.url) === host).length;
  }
  async function writeCheck(){
    vaultData.check = await enc({ v: 1, cats, sort: sortMode });
  }

  /* ---------- 解锁 ---------- */
  async function unlock(){
    const master = $('#masterPass').value;
    if (!master) return showToast('请输入主密码', 'err');
    try {
      vaultData = await API.get('/api/vault');
      if (!vaultData.salt){
        if ($('#masterPass2').value !== master){
          $('#masterPass2Wrap').hidden = false;
          return showToast('请再次输入主密码确认', 'err');
        }
        const saltBuf = crypto.getRandomValues(new Uint8Array(16));
        derivedKey = await deriveKey(master, saltBuf);
        vaultData.salt = bufToB64(saltBuf.buffer);
        cats = normalizeCats([]);
        activeCat = 'all';
        sortMode = 'manual';
        await writeCheck();
        vaultData.items = {};
        await API.put('/api/vault', { check: vaultData.check, salt: vaultData.salt, items: {} });
      } else {
        derivedKey = await deriveKey(master, b64ToBuf(vaultData.salt));
        try {
          const payload = await dec(vaultData.check);
          cats = normalizeCats(payload && payload.cats);
          sortMode = ['manual', 'added', 'updated', 'name'].includes(payload?.sort)
            ? payload.sort : 'manual';
        } catch (e) {
          failCount++;
          derivedKey = null;
          cats = normalizeCats([]);
          return showToast(`主密码错误（${failCount}/5）`, 'err');
        }
      }
      await refreshCache();
      $('#vaultWrap').classList.add('unlocked');
      $('#vaultSort').value = sortMode;
      render();
      updateBadge();
      showToast('保险库已解锁');
    } catch (e) {
      showToast(e.message, 'err');
    }
  }

  async function refreshCache(){
    const entries = Object.entries(vaultData.items || {});
    const out = [];
    let i = 0;
    for (const [id, item] of entries){
      let data = {};
      try { data = await dec(item.blob); } catch (e) { continue; }
      const cat = itemCat(data);
      const added = Number(data.added) || 0;
      const updated = Number(data.updated) || added;
      const order = Number.isFinite(Number(data.order)) ? Number(data.order) : i;
      out.push({
        id, item,
        data: { ...data, cat, added, updated, order },
        cat,
      });
      i++;
    }
    cache = out;
  }

  /* ---------- 列表 ---------- */
  function viewingCats(){
    const picked = [...catSel].filter(id => id !== 'all' && cats.some(c => c.id === id));
    if (picked.length) return picked;
    return [activeCat || 'all'];
  }
  function listed(){
    const view = viewingCats();
    const showAll = view.length === 1 && view[0] === 'all';
    let rows = showAll ? [...cache] : cache.filter(x => view.includes(x.cat));
    if (sortMode === 'added'){
      rows.sort((a, b) => (b.data.added || 0) - (a.data.added || 0));
    } else if (sortMode === 'updated'){
      rows.sort((a, b) => (b.data.updated || 0) - (a.data.updated || 0));
    } else if (sortMode === 'name'){
      rows.sort((a, b) => (a.data.name || '').localeCompare(b.data.name || '', 'zh'));
    } else {
      rows.sort((a, b) => (a.data.order ?? 0) - (b.data.order ?? 0));
    }
    return rows;
  }
  function fmtTime(ts){
    if (!ts) return '';
    try { return new Date(ts).toLocaleDateString('zh-CN'); }
    catch (e) { return ''; }
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

  function cardHtml(row){
    const { id, item, data, cat } = row;
    const strength = score(data.password || '');
    const host = hostOf(data.url);
    const nSite = sameSiteN(host);
    const siteChip = nSite > 1
      ? `<span class="chip no-dot v-site-chip" title="同一网站可保存多个账号">${nSite} 个账号</span>`
      : '';
    const hue = item.meta?.hue ?? 243;
    const letter = App.esc((data.name || host || '?').charAt(0).toUpperCase());
    const sub = [host || data.url || '', data.account || ''].filter(Boolean).join(' · ');
    return `<div class="bm-tile bm-card v-card${sel.has(id) ? ' sel' : ''}" data-v-id="${id}" draggable="true">
      <span class="bm-check" data-v-sel="${id}" title="选择 / 多选"><svg class="ic"><use href="#i-check"/></svg></span>
      <div class="bmc-top">
        <span class="v-fav" style="--fav:${hue}">${letter}</span>
        <div class="bmc-info">
          <div class="bm-name">${App.esc(data.name || '未命名')} ${siteChip}</div>
          <div class="bm-url">${App.esc(sub || '未填写地址与账号')}</div>
        </div>
        <span class="strength s${strength}" title="强度 ${strength}/4"><i></i><i></i><i></i><i></i></span>
      </div>
      <div class="v-preview" hidden></div>
      <div class="bmc-foot">
        <span class="chip no-dot bm-cat-chip">${App.esc(catName(cat))}</span>
        <span class="v-date">${App.esc(fmtTime(data.updated || data.added))}</span>
        <button type="button" class="icon-btn-xs v-eye" data-v-act="show" title="预览"><svg class="ic"><use href="#i-eye"/></svg></button>
      </div>
      <span class="bm-x" data-v-act="del" title="删除"><svg class="ic"><use href="#i-close"/></svg></span>
      <span class="bm-e" data-v-act="edit" title="编辑"><svg class="ic"><use href="#i-pen"/></svg></span>
    </div>`;
  }

  function renderCats(){
    const box = $('#vaultCats');
    if (!box) return;
    const view = new Set(viewingCats());
    box.innerHTML = cats.map(c => {
      const builtin = c.id === 'all' || c.id === 'none';
      const n = c.id === 'all' ? cache.length : cache.filter(x => x.cat === c.id).length;
      const on = view.has(c.id) || (view.has('all') && c.id === 'all');
      const picked = catSel.has(c.id);
      const ops = `<span class="tab-ops">
          ${builtin ? '' : `<i data-v-cat-edit="${c.id}" title="重命名分类"><svg class="ic"><use href="#i-pen"/></svg></i>
          <i data-v-cat-del="${c.id}" title="删除分类"><svg class="ic"><use href="#i-close"/></svg></i>`}
        </span>`;
      return `<button type="button" class="tab ${on ? 'active' : ''} ${picked ? 'sel' : ''}" data-v-cat="${c.id}" draggable="true"
        title="${builtin ? '内置分类 · 拖拽可调整位置' : '拖拽调整顺序；勾选可多选'}">
        <span class="bm-check v-cat-check" data-v-cat-sel="${c.id}" title="多选分类"><svg class="ic"><use href="#i-check"/></svg></span>
        ${App.esc(c.name)}
        <span class="bm-cat-n num">${n}</span>${ops}
      </button>`;
    }).join('') +
      `<button type="button" class="tab tab-add" data-v-cat-add title="新建分类"><svg class="ic"><use href="#i-plus"/></svg>分类</button>`;
  }

  function render(){
    if (!$('#vaultWrap')?.classList.contains('unlocked')) return;
    renderCats();
    const view = viewingCats();
    const multi = catSel.size > 0;
    const title = $('#vaultTitle');
    if (title){
      title.textContent = multi
        ? `已选 ${catSel.size} 个分类`
        : (view[0] === 'all' ? '全部凭据' : catName(view[0]));
    }
    const rows = listed();
    $('#vaultCount').textContent = rows.length + ' 条';
    const box = $('#vaultItems');
    if (!cache.length){
      box.innerHTML = `<div class="empty" style="grid-column:1/-1;background:var(--om-surface);border:1px dashed var(--om-border-strong);border-radius:var(--om-radius-lg)">
        <div class="empty-ic"><svg class="ic"><use href="#i-shield"/></svg></div>
        <div class="empty-title">保险库还是空的</div>
        <div class="empty-sub">点击右上角「新增凭据」。同一网站可以添加多个账号。</div></div>`;
    } else if (!rows.length){
      box.innerHTML = `<div class="empty" style="grid-column:1/-1;background:var(--om-surface);border:1px dashed var(--om-border-strong);border-radius:var(--om-radius-lg)">
        <div class="empty-ic"><svg class="ic"><use href="#i-folder"/></svg></div>
        <div class="empty-title">此分类暂无凭据</div>
        <div class="empty-sub">新增凭据时选择此分类，或把卡片拖到左侧分类</div></div>`;
    } else {
      box.innerHTML = rows.map(cardHtml).join('');
    }
    syncSelUi();
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

  async function persistRow(row){
    const data = { ...row.data, cat: row.cat };
    vaultData.items[row.id] = {
      blob: await enc(data),
      meta: {
        name: data.name,
        hue: row.item?.meta?.hue ?? [...(data.name || '')].reduce((a, c) => a + c.codePointAt(0), 0) % 360,
        updated: fmtTime(data.updated) || new Date().toLocaleDateString('zh-CN'),
      },
    };
    row.item = vaultData.items[row.id];
  }

  /* ---------- 多选 ---------- */
  function batchBar(){ return $('#vaultBatch'); }
  function syncSelUi(){
    $$('#vaultItems .v-card[data-v-id]').forEach(t =>
      t.classList.toggle('sel', sel.has(t.dataset.vId)));
    $$('#vaultCats .tab[data-v-cat]').forEach(t =>
      t.classList.toggle('sel', catSel.has(t.dataset.vCat)));
    const bar = batchBar();
    if (!bar) return;
    const nCat = catSel.size;
    const nCard = sel.size;
    if (nCat && !nCard){
      bar.hidden = false;
      $('#vaultBatchN').textContent = `已选 ${nCat} 个分类`;
      $('#vaultBatchHint').textContent = HINT_CAT;
    } else if (nCard){
      bar.hidden = false;
      $('#vaultBatchN').textContent = `已选 ${nCard} 个`;
      $('#vaultBatchHint').textContent = HINT_CARD;
    } else {
      bar.hidden = true;
    }
  }
  function toggleSel(id){
    if (sel.has(id)) sel.delete(id); else sel.add(id);
    catSel.clear();
    syncSelUi();
  }
  function toggleCatSel(cid){
    if (cid === 'all'){
      catSel.clear();
      activeCat = 'all';
      render();
      return;
    }
    if (catSel.has(cid)) catSel.delete(cid); else catSel.add(cid);
    sel.clear();
    if (!catSel.size) activeCat = cid;
    render();
  }
  function clearSel(){
    sel.clear();
    catSel.clear();
    syncSelUi();
    renderCats();
  }
  function batchDragMode(on, n, kind){
    const bar = batchBar();
    if (!bar) return;
    bar.classList.toggle('drag-mode', on);
    bar.classList.remove('drop-del');
    if (on){
      bar.hidden = false;
      $('#vaultBatchN').textContent = `拖拽 ${n} 个`;
      $('#vaultBatchHint').textContent = HINT_DRAG;
    } else {
      $('#vaultBatchHint').textContent = kind === 'cat' ? HINT_CAT : HINT_CARD;
      syncSelUi();
    }
  }

  /* ---------- 增删改 ---------- */
  function fillCatSelect(selected){
    const el = $('#viCat');
    if (!el) return;
    const cur = cats.some(c => c.id === selected && c.id !== 'all') ? selected : 'none';
    el.innerHTML = cats.filter(c => c.id !== 'all')
      .map(c => `<option value="${App.esc(c.id)}" ${c.id === cur ? 'selected' : ''}>${App.esc(c.name)}</option>`)
      .join('');
  }

  function openEditor(id){
    editingId = id;
    $('#viName').value = ''; $('#viAccount').value = ''; $('#viUrl').value = '';
    $('#viPass').value = ''; $('#viNote').value = '';
    const fallback = (viewingCats()[0] === 'all' ? 'none' : viewingCats()[0]);
    fillCatSelect(fallback);
    if (id){
      const row = cache.find(x => x.id === id);
      if (row){
        const d = row.data;
        $('#viName').value = d.name || ''; $('#viAccount').value = d.account || '';
        $('#viUrl').value = d.url || ''; $('#viPass').value = d.password || '';
        $('#viNote').value = d.note || '';
        fillCatSelect(itemCat(d));
      }
    }
    App.openModal('vaultItemMask');
  }

  async function saveItem(){
    const name = $('#viName').value.trim();
    if (!name) return showToast('请填写名称', 'err');
    const cat = itemCat({ cat: $('#viCat')?.value });
    const now = Date.now();
    const prev = editingId ? cache.find(x => x.id === editingId) : null;
    const payload = {
      name,
      account: $('#viAccount').value.trim(),
      url: $('#viUrl').value.trim(),
      password: $('#viPass').value,
      note: $('#viNote').value.trim(),
      cat,
      added: prev?.data.added || now,
      updated: now,
      order: prev?.data.order ?? (cache.reduce((m, x) => Math.max(m, x.data.order || 0), 0) + 1),
    };
    const id = editingId || crypto.randomUUID().slice(0, 8);
    const hue = [...name].reduce((a, c) => a + c.codePointAt(0), 0) % 360;
    vaultData.items[id] = {
      blob: await enc(payload),
      meta: { name, hue, updated: new Date(now).toLocaleDateString('zh-CN') },
    };
    await persist();
    await refreshCache();
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
    const noneAt = cats.findIndex(c => c.id === 'none');
    const rec = { id, name: trimmed };
    if (noneAt >= 0) cats.splice(noneAt, 0, rec);
    else cats.push(rec);
    activeCat = id;
    catSel.clear();
    await writeCheck();
    await persist();
    render();
    showToast(`已新建分类「${trimmed}」`);
  }

  async function renameCat(cid){
    if (cid === 'all' || cid === 'none') return;
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

  async function deleteCats(ids, { confirm = true } = {}){
    const targets = ids.filter(id => id && id !== 'all' && id !== 'none');
    if (!targets.length) return showToast('内置分类不能删除', 'err');
    if (confirm){
      const ok = await App.confirmModal({
        title: targets.length > 1 ? `删除 ${targets.length} 个分类？` : `删除分类「${catName(targets[0])}」？`,
        sub: '其下凭据会改到「未分类」，凭据本身不会删除。',
        okText: '删除', danger: true,
      });
      if (!ok) return;
    }
    const drop = new Set(targets);
    for (const row of cache){
      if (drop.has(row.cat)){
        row.cat = 'none';
        row.data.cat = 'none';
        row.data.updated = Date.now();
        await persistRow(row);
      }
    }
    cats = cats.filter(c => !drop.has(c.id));
    cats = normalizeCats(cats);
    if (drop.has(activeCat)) activeCat = 'none';
    targets.forEach(id => catSel.delete(id));
    await writeCheck();
    await persist();
    await refreshCache();
    render();
    showToast(targets.length > 1 ? `已删除 ${targets.length} 个分类` : '分类已删除');
  }

  async function deleteCards(ids, { confirm = true } = {}){
    if (!ids.length) return;
    if (confirm){
      const ok = await App.confirmModal({
        title: ids.length > 1 ? `删除 ${ids.length} 条凭据？` : '删除凭据？',
        sub: '此操作不可恢复。',
        okText: '删除', danger: true,
      });
      if (!ok) return;
    }
    ids.forEach(id => {
      delete vaultData.items[id];
      sel.delete(id);
    });
    await persist();
    await refreshCache();
    render();
    showToast(ids.length > 1 ? `已删除 ${ids.length} 条凭据` : '凭据已删除');
  }

  async function dropSelToCat(cid){
    if (!cid || cid === 'all') return;
    const ids = [...dragIds];
    const rows = cache.filter(x => ids.includes(x.id));
    if (!rows.length) return;
    const now = Date.now();
    for (const row of rows){
      row.cat = cid;
      row.data.cat = cid;
      row.data.updated = now;
      await persistRow(row);
    }
    sel.clear();
    await persist();
    await refreshCache();
    render();
    showToast(`已将 ${rows.length} 条移入「${catName(cid)}」`);
  }

  async function persistCardOrder(){
    if (sortMode !== 'manual') return;
    const ids = $$('#vaultItems .v-card[data-v-id]').map(el => el.dataset.vId);
    if (!ids.length) return;
    const shown = new Set(ids);
    const rest = cache.filter(x => !shown.has(x.id)).sort((a, b) => (a.data.order ?? 0) - (b.data.order ?? 0));
    const ordered = [...ids.map(id => cache.find(x => x.id === id)).filter(Boolean), ...rest];
    let i = 0;
    for (const row of ordered){
      if ((row.data.order ?? -1) !== i){
        row.data.order = i;
        await persistRow(row);
      }
      i++;
    }
    await persist();
    await refreshCache();
  }

  async function persistCatOrder(){
    const order = $$('#vaultCats .tab[data-v-cat]').map(t => t.dataset.vCat);
    const next = order.map(id => cats.find(c => c.id === id)).filter(Boolean);
    if (next.length !== cats.length) return;
    cats = next;
    await writeCheck();
    await persist();
    renderDashSafe();
  }
  function renderDashSafe(){ /* 保险库不驱动仪表盘分类 */ }

  function setPreview(card, data, on){
    const pane = card.querySelector('.v-preview');
    const btn = card.querySelector('[data-v-act="show"]');
    card.classList.toggle('is-open', on);
    if (!pane) return;
    if (on){
      pane.hidden = false;
      pane.innerHTML = previewHtml(data);
      if (btn){
        btn.title = '隐藏';
        const use = btn.querySelector('use');
        if (use) use.setAttribute('href', '#i-eye-off');
      }
    } else {
      pane.hidden = true;
      pane.innerHTML = '';
      if (btn){
        btn.title = '预览';
        const use = btn.querySelector('use');
        if (use) use.setAttribute('href', '#i-eye');
      }
    }
  }

  function eventHit(e, selector){
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    for (const n of path){
      if (n && n.nodeType === 1 && n.matches && n.matches(selector)) return n;
    }
    return e.target && e.target.closest ? e.target.closest(selector) : null;
  }

  /* ---------- 事件 ---------- */
  function init(){
    $('#unlockBtn').addEventListener('click', unlock);
    $('#masterPass').addEventListener('keydown', e => { if (e.key === 'Enter') unlock(); });
    $('#vaultNew').addEventListener('click', () => {
      if (!$('#vaultWrap').classList.contains('unlocked')) return showToast('请先解锁保险库', 'err');
      openEditor(null);
    });
    $('#viCancel').addEventListener('click', () => App.closeModal('vaultItemMask'));
    $('#viSave').addEventListener('click', saveItem);
    $('#viGen').addEventListener('click', () => { $('#viPass').value = genPass(16); });
    $('#vaultSort').addEventListener('change', async () => {
      sortMode = $('#vaultSort').value;
      await writeCheck();
      await persist();
      render();
    });
    $('#vaultBatchClear').addEventListener('click', clearSel);
    $('#vaultBatchDel').addEventListener('click', async () => {
      if (catSel.size && !sel.size) return deleteCats([...catSel]);
      return deleteCards([...sel]);
    });

    const catsBox = $('#vaultCats');
    const itemsBox = $('#vaultItems');
    const batch = $('#vaultBatch');

    document.addEventListener('click', async e => {
      if (!eventHit(e, '#vaultView')) return;
      if (eventHit(e, '[data-v-cat-add]')){
        e.preventDefault();
        return addCat();
      }
      const catSelBtn = eventHit(e, '[data-v-cat-sel]');
      if (catSelBtn){
        e.preventDefault(); e.stopPropagation();
        return toggleCatSel(catSelBtn.getAttribute('data-v-cat-sel'));
      }
      const editCat = eventHit(e, '[data-v-cat-edit]');
      if (editCat){
        e.preventDefault(); e.stopPropagation();
        return renameCat(editCat.getAttribute('data-v-cat-edit'));
      }
      const delCatBtn = eventHit(e, '[data-v-cat-del]');
      if (delCatBtn){
        e.preventDefault(); e.stopPropagation();
        return deleteCats([delCatBtn.getAttribute('data-v-cat-del')]);
      }
      const tab = eventHit(e, '#vaultCats [data-v-cat]');
      if (tab){
        if (eventHit(e, '.tab-ops') || eventHit(e, '.v-cat-check')) return;
        if (e.metaKey || e.ctrlKey){
          toggleCatSel(tab.dataset.vCat);
          return;
        }
        activeCat = tab.dataset.vCat;
        catSel.clear();
        return render();
      }

      const copyField = eventHit(e, '[data-v-copy]');
      if (copyField){
        const card = copyField.closest('[data-v-id]');
        const row = cache.find(x => x.id === card?.dataset.vId);
        if (!row) return;
        const key = copyField.dataset.vCopy;
        const map = { url: row.data.url, account: row.data.account, password: row.data.password };
        const label = { url: '地址', account: '账号', password: '密码' }[key] || key;
        await navigator.clipboard.writeText(map[key] || '');
        return showToast(`${label}已复制`);
      }

      const selBtn = eventHit(e, '[data-v-sel]');
      if (selBtn){
        e.stopPropagation();
        toggleSel(selBtn.dataset.vSel);
        return;
      }

      const actBtn = eventHit(e, '[data-v-act]');
      if (actBtn){
        const card = actBtn.closest('[data-v-id]');
        const id = card?.dataset.vId;
        const row = cache.find(x => x.id === id);
        if (!row) return;
        const act = actBtn.dataset.vAct;
        if (act === 'show'){
          e.stopPropagation();
          setPreview(card, row.data, !card.classList.contains('is-open'));
          return;
        }
        if (act === 'edit'){
          e.stopPropagation();
          return openEditor(id);
        }
        if (act === 'del'){
          e.stopPropagation();
          return deleteCards([id]);
        }
      }

      const card = eventHit(e, '#vaultItems .v-card[data-v-id]');
      if (card){
        toggleSel(card.dataset.vId);
      }
    });

    /* 分类拖拽排序 */
    catsBox.addEventListener('dragstart', e => {
      const tab = e.target.closest?.('.tab[data-v-cat]');
      if (!tab) return;
      dragKind = 'cat';
      dragEl = tab;
      dragIds = catSel.has(tab.dataset.vCat) && catSel.size
        ? [...catSel]
        : [tab.dataset.vCat];
      batchDragMode(true, dragIds.length, 'cat');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', tab.dataset.vCat); } catch (_) {}
    });
    catsBox.addEventListener('dragover', e => {
      if (dragKind === 'cat' && dragEl){
        const tab = e.target.closest?.('.tab[data-v-cat]');
        if (!tab || tab === dragEl) return;
        e.preventDefault();
        const r = tab.getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) tab.before(dragEl);
        else tab.after(dragEl);
        return;
      }
      if (dragKind !== 'card' || !dragEl) return;
      const tab = e.target.closest?.('.tab[data-v-cat]');
      if (!tab || tab.dataset.vCat === 'all') return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      $$('.tab', catsBox).forEach(t => t.classList.toggle('drop-over', t === tab));
    });
    catsBox.addEventListener('drop', e => {
      if (dragKind !== 'card' || !dragEl) return;
      const tab = e.target.closest?.('.tab[data-v-cat]');
      if (!tab || tab.dataset.vCat === 'all') return;
      e.preventDefault();
      $$('.tab.drop-over', catsBox).forEach(t => t.classList.remove('drop-over'));
      droppedCat = true;
      dropSelToCat(tab.dataset.vCat);
    });
    catsBox.addEventListener('dragend', () => {
      if (dragKind !== 'cat') return;
      const skip = droppedBar;
      dragEl = null;
      dragKind = '';
      dragIds = [];
      droppedBar = false;
      batchDragMode(false, 0, 'cat');
      if (!skip) persistCatOrder();
    });

    /* 卡片拖拽排序 / 归类 */
    document.addEventListener('dragstart', e => {
      const tile = e.target.closest?.('#vaultItems .v-card[data-v-id]');
      if (!tile) return;
      dragKind = 'card';
      dragEl = tile;
      dragIds = sel.has(tile.dataset.vId) ? [...sel] : [tile.dataset.vId];
      if (dragIds.length > 1){
        const ghost = document.createElement('div');
        ghost.className = 'bm-drag-ghost';
        const name = (tile.querySelector('.bm-name') || {}).textContent || '';
        ghost.innerHTML = `<div class="bm-dg-tile"><span class="bm-dg-name">${App.esc(name)}</span></div>` +
          `<span class="bm-dg-n num">${dragIds.length}</span>`;
        ghost.style.left = '-9999px'; ghost.style.top = '-9999px';
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 40, 24);
        setTimeout(() => ghost.remove(), 300);
      }
      batchDragMode(true, dragIds.length, 'card');
      tile.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', tile.dataset.vId); } catch (_) {}
    });
    document.addEventListener('dragend', () => {
      $$('#vaultCats .tab.drop-over').forEach(t => t.classList.remove('drop-over'));
      if (dragKind !== 'card') return;
      const skip = droppedCat || droppedBar;
      if (dragEl) dragEl.classList.remove('dragging');
      dragEl = null;
      dragKind = '';
      dragIds = [];
      droppedCat = false;
      droppedBar = false;
      batchDragMode(false, 0, 'card');
      if (!skip) persistCardOrder();
    });
    itemsBox.addEventListener('dragover', e => {
      if (dragKind !== 'card' || !dragEl || sortMode !== 'manual') return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const others = $$('.v-card[data-v-id]:not(.dragging)', itemsBox);
      let ref = null;
      for (const el of others){
        const r = el.getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2 ||
            (e.clientY <= r.bottom && e.clientX < r.left + r.width / 2)){
          ref = el; break;
        }
      }
      if (ref){
        if (ref.previousElementSibling !== dragEl) itemsBox.insertBefore(dragEl, ref);
      } else if (itemsBox.lastElementChild !== dragEl){
        itemsBox.appendChild(dragEl);
      }
    });
    itemsBox.addEventListener('drop', e => e.preventDefault());

    batch.addEventListener('dragover', e => {
      if (!dragEl || !dragIds.length) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      batch.classList.add('drop-del');
    });
    batch.addEventListener('dragleave', () => batch.classList.remove('drop-del'));
    batch.addEventListener('drop', async e => {
      if (!dragEl || !dragIds.length) return;
      e.preventDefault();
      batch.classList.remove('drop-del');
      droppedBar = true;
      const ids = [...dragIds];
      if (dragKind === 'cat') await deleteCats(ids, { confirm: false });
      else await deleteCards(ids, { confirm: false });
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

  function lockUi(){
    derivedKey = null;
    cache = [];
    sel.clear();
    catSel.clear();
    $('#vaultWrap').classList.remove('unlocked');
    $('#masterPass').value = '';
    $('#masterPass2').value = '';
    const bar = batchBar();
    if (bar) bar.hidden = true;
  }

  return { init, genPass, updateBadge, lockUi };
})();
Vault.init();
App.onEnter(() => {
  Vault.lockUi();
  API.get('/api/vault').then(v => {
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
