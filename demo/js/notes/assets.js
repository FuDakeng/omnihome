import { S } from './state.js';

  /* ---------- 附件分区 ---------- */
  S.loadAssets = async function(){
    try { S.assets = (await API.get('/api/notes/assets')).assets || []; }
    catch (e) { S.assets = []; }
  };

  /* 上传成功后刷新附件分区清单 */
  S.refreshAssets = function(){ S.loadAssets().then(S.renderTree); };

  /* 点击附件：把引用插入当前笔记（可在任意 .md 中显示）
     拖动到编辑区：drop 时在光标位置插入 */
  S.insertAssetRef = function(name){
    if (!S.currentId){ showToast('请先打开一篇笔记，再插入附件引用', 'err'); return; }
    const alt = name.replace(/[\[\]()]/g, '');
    const md = '![' + alt + '](/api/notes/assets/' + encodeURIComponent(name) + ')';
    if (S.liveEd && S.liveEd.isShown()){ S.liveEd.insertText('\n' + md + '\n'); showToast('已插入附件引用'); return; }
    const ta = $('#edSrc');
    ta.value = ta.value.replace(/\s+$/, '') + '\n' + md + '\n';
    ta.dispatchEvent(new Event('input'));
    showToast('已插入附件引用');
  };

  /* 导入 Markdown / zip：弹文件选择 → POST → 提示并刷新 */
  S.importMd = function(){
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.zip,.markdown';
    input.style.display = 'none';
    input.onchange = async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      try {
        const r = await fetch('/api/notes/import-md', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + API.getToken() },
          body: fd,
        });
        if (!r.ok) throw new Error((await r.json()).detail || ('HTTP ' + r.status));
        const d = await r.json();
        showToast(`导入完成：${d.imported} 个${d.skipped ? '（跳过 '+d.skipped+' 个非 .md）' : ''}`);
        await S.load();
      } catch (e) { showToast('导入失败：' + e.message, 'err'); }
    };
    document.body.appendChild(input);
    input.click();
  };

  /* 点击附件图片 → 灯箱预览；点击删除按钮 → 删除附件 */
  S.showAssetPreview = function(name){
    const url = '/api/notes/assets/' + encodeURIComponent(name);
    const lb = $('#assetLightbox');
    lb.querySelector('img').src = url;
    lb.dataset.name = name;
    lb.hidden = false;                       // HTML 默认带 hidden 属性，必须先去掉
    lb.classList.add('open');
  };

  S.closeAssetPreview = function(){
    const lb = $('#assetLightbox');
    lb.classList.remove('open');
    lb.hidden = true;                        // 恢复 hidden，关掉 [.asset-lightbox[hidden]] 的 display:none
  };

  S.deleteAsset = async function(name){
    const ok = await App.confirmModal({
      title: '删除附件？',
      sub: `「${name}」删除后，引用该附件的笔记将出现裂图，且无法撤销。`,
      okText: '删除', danger: true,
    });
    if (!ok) return;
    try {
      await API.del('/api/notes/assets/' + encodeURIComponent(name));
      showToast('附件已删除');
      S.refreshAssets();
      S.closeAssetPreview();
    } catch (e) { showToast(e.message, 'err'); }
  };

  S.assetPathOf = function(src){
    const s = String(src || '').split('?')[0];
    return s.startsWith('/api/notes/assets/') ? s : '';
  };

  S.applyCachedSrc = function(img, path){
    const data = S.assetDataCache.get(path);
    if (data){ img.src = data; img.removeAttribute('onerror'); img.style.opacity = ''; return true; }
    return false;
  };

  S.hydrateImages = function(box){
    if (!box) return;
    box.querySelectorAll('img').forEach(img => {
      let s = img.getAttribute('data-asset-src') || img.getAttribute('src') || '';
      const path = S.assetPathOf(s);
      if (!path) return;
      if (S.applyCachedSrc(img, path)) return;
      img.setAttribute('data-asset-src', path);
      if (S.hydrated.has(img)) return;
      S.hydrated.add(img);
      img.style.opacity = '0';
      let p = S.assetPending.get(path);
      if (!p){
        p = fetch(path, { headers: { Authorization: 'Bearer ' + API.getToken() } })
          .then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); })
          .then(b => new Promise((resolve, reject) => {
            const rd = new FileReader();
            rd.onload = () => { S.assetDataCache.set(path, rd.result); resolve(rd.result); };
            rd.onerror = reject;
            rd.readAsDataURL(b);
          }))
          .catch(() => { S.assetPending.delete(path); });
        S.assetPending.set(path, p);
      }
      p.then(data => {
        if (data){
          img.src = data;
          img.removeAttribute('onerror');
          img.style.opacity = '';
        } else if (img.parentNode) {
          img.parentNode.textContent = '📎';
        }
      });
    });
  };

  S.hydrateNow = function(){
    if (S.liveEd && S.liveEd.isShown()) S.hydrateImages(S.liveEd.el);
    const pv = $('#edPreview');
    if (pv && pv.style.display !== 'none') S.hydrateImages(pv);
  };

  S.closeKbMenu = function(){
    document.querySelectorAll('.kb-menu').forEach(m => m.remove());
    S._kbMenuAnchor = null;
    if (S._kbMenuDocClose){
      document.removeEventListener('click', S._kbMenuDocClose);
      S._kbMenuDocClose = null;
    }
  };

  S.kbMenu = function(btn, items){
    const same = S._kbMenuAnchor === btn && document.querySelector('.kb-menu');
    S.closeKbMenu();
    if (same) return;
    const menu = document.createElement('div');
    menu.className = 'kb-menu';
    items.forEach(it => {
      if (!it) return;
      if (it === 'sep' || (it && it[0] === 'sep')){
        const s = document.createElement('div');
        s.className = 'sep';
        menu.appendChild(s);
        return;
      }
      const [label, icon, fn, kind] = it;
      const b = document.createElement('button');
      if (kind === 'danger') b.className = 'danger';
      b.innerHTML = `<svg class="ic"><use href="#${icon}"/></svg>${label}`;
      b.addEventListener('click', (e) => { e.stopPropagation(); S.closeKbMenu(); fn(); });
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    S._kbMenuAnchor = btn;
    const r = btn.getBoundingClientRect();
    let top = r.bottom + 6;
    if (top + menu.offsetHeight > innerHeight - 8) top = r.top - menu.offsetHeight - 6;
    menu.style.left = Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = top + 'px';
    setTimeout(() => {
      S._kbMenuDocClose = (e) => {
        if (btn.contains(e.target) || menu.contains(e.target)) return;
        S.closeKbMenu();
      };
      document.addEventListener('click', S._kbMenuDocClose);
    }, 0);
  };

  S.openKbMenu = function(btn, folder){
    S.kbMenu(btn, [
      ['新建笔记', 'i-note', () => S.create(folder)],
      ['新建文件夹', 'i-folder', () => S.newFolder(folder)],
    ]);
  };

  /* ---------- 拖放删除高亮：目标为树列底部「回收站」条（v0.2.25 替代原全屏横条） ---------- */
  S.highlightTrash = function(on){
    const t = $('#kbTreeFoot'); if (!t) return;
    t.classList.toggle('kb-drop-del', !!on && !!S.dragState);
  };

