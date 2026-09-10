import { mdRender, mdFallback, mdOutline, outlineItemHtml, outlineBodyHtml, mdLineDiff, renderRevDiffHtml, _mdSlug } from './md.js';
import { S } from './state.js';

  S.shareLinkUrl = function(token){
    return location.origin.replace(/\/$/, '') + '/?s=' + encodeURIComponent(token);
  };

  S.pickShareExpireDays = function(exist){
    const exp = Number(exist && exist.expireAt) || 0;
    if (!exp) return 7;
    const left = (exp - Date.now() / 1000) / 86400;
    if (left > 400) return 0;
    let best = 7, dist = Infinity;
    [1, 7, 30].forEach(d => {
      const n = Math.abs(d - left);
      if (n < dist){ dist = n; best = d; }
    });
    return best;
  };

  S.openShareModal = async function(target){
    S.shareTarget = target;
    $('#kbShareTitle').textContent = '分享「' + (target.name || '') + '」';
    const exist = target.kind === 'note' ? S.shareOfNote(target.noteId) : S.shareOfFolder(target.folder);
    $('#kbShareEdit').classList.toggle('on', !!(exist && exist.canEdit));
    $('#kbShareNeedLogin')?.classList.toggle('on', !!(exist && exist.requireLogin));
    const days = String(S.pickShareExpireDays(exist));
    $$('#kbShareExpire .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.days === days));
    $('#kbShareRevoke').hidden = !exist;
    $('#kbShareRevoke').dataset.sid = exist ? exist.id : '';
    if (exist && exist.token){
      $('#kbShareLink').value = S.shareLinkUrl(exist.token);
      $('#kbShareLinkRow').hidden = false;
    } else {
      $('#kbShareLink').value = '';
      $('#kbShareLinkRow').hidden = true;
    }
    App.openModal('kbShareMask');
  };

  S.persistExistingShare = async function(){
    const sid = $('#kbShareRevoke')?.dataset.sid;
    if (!sid || $('#kbShareRevoke')?.hidden) return null;
    const days = parseInt($('#kbShareExpire .seg-btn.active')?.dataset.days || '7', 10);
    const d = await API.put('/api/notes/shares/' + encodeURIComponent(sid), {
      expireDays: days,
      canEdit: $('#kbShareEdit').classList.contains('on'),
      requireLogin: $('#kbShareNeedLogin')?.classList.contains('on'),
    });
    await S.load();
    return d;
  };

  S.createShareLink = async function(){
    if (!S.shareTarget) return;
    const days = parseInt($('#kbShareExpire .seg-btn.active')?.dataset.days || '7', 10);
    const payload = {
      kind: S.shareTarget.kind,
      noteId: S.shareTarget.noteId || '',
      folder: S.shareTarget.folder || '',
      vault: S.currentVault,
      expireDays: days,
      canEdit: $('#kbShareEdit').classList.contains('on'),
      requireLogin: $('#kbShareNeedLogin')?.classList.contains('on'),
    };
    try {
      const sid = $('#kbShareRevoke')?.dataset.sid;
      let token = '';
      if (sid && !$('#kbShareRevoke').hidden){
        const d = await S.persistExistingShare();
        token = (d && d.token) || ($('#kbShareLink').value.match(/[?&]s=([^&]+)/) || [])[1] || '';
        token = token ? decodeURIComponent(token) : '';
        if (!token) token = (d && d.token) || '';
        showToast(payload.canEdit ? '已更新：持有链接可编辑' : '已更新分享设置');
      } else {
        const d = await API.post('/api/notes/shares', payload);
        token = d.token;
        $('#kbShareRevoke').hidden = false;
        $('#kbShareRevoke').dataset.sid = d.id || '';
        showToast('链接已生成');
        await S.load();
      }
      if (token){
        $('#kbShareLink').value = S.shareLinkUrl(token);
        $('#kbShareLinkRow').hidden = false;
      }
    } catch (e) { showToast(e.message, 'err'); }
  };

  S.pollOpenNote = async function(){
    if (!S.currentId || S.dirty) return;
    if (document.body.dataset.view !== 'notes' || document.hidden) return;
    try {
      const d = await API.get('/api/notes/' + S.currentId);
      const ts = d.updated || 0;
      if (ts && S.lastKnownUpdated && ts > S.lastKnownUpdated + 1){
        $('#edSrc').value = d.content || '';
        if (d.title){
          $('#edTitle').value = d.title;
          const meta = S.idx.find(n => n.id === S.currentId);
          if (meta){ meta.title = d.title; meta.updated = ts; }
        }
        S.lastKnownUpdated = ts;
        S.dirty = false;
        if (S.liveEd) S.liveEd.refresh();
        S.renderPreview();
        S.hydrateNow();
        S.renderTree();
        S.renderTabs();
        S.updateCrumb();
        S.updateStat();
        $('#edFootTime').textContent = '已同步远端更新';
      } else if (ts) S.lastKnownUpdated = Math.max(S.lastKnownUpdated, ts);
    } catch (_) {}
  };

  S.shareAuthHeaders = function(extra){
    const h = Object.assign({}, extra || {});
    const t = API.getToken();
    if (t) h.Authorization = 'Bearer ' + t;
    return h;
  };

  S.shareFetch = async function(url, opts){
    const r = await fetch(url, Object.assign({}, opts || {}, {
      headers: S.shareAuthHeaders((opts && opts.headers) || {}),
    }));
    let data = null;
    try { data = await r.json(); } catch (_) {}
    if (r.status === 401){
      const msg = (data && data.detail) || '需要登录后查看此分享';
      const err = new Error(typeof msg === 'string' ? msg : '需要登录后查看此分享');
      err.needLogin = true;
      throw err;
    }
    if (!r.ok){
      const msg = (data && data.detail) || '分享不存在或已过期';
      throw new Error(typeof msg === 'string' ? msg : '分享不存在或已过期');
    }
    return data;
  };

  S.tryOpenShareFromUrl = function(){
    try {
      const s = new URLSearchParams(location.search).get('s');
      if (s) S.openShareOverlay(s);
    } catch (_) {}
  };

  S.destroyShareLive = function(){
    if (S.shareLiveEd){ try { S.shareLiveEd.destroy(); } catch (_) {} S.shareLiveEd = null; }
  };

  S.rewriteShareAssets = function(html){
    html = String(html || '').replace(/src="\/api\/notes\/assets\//g,
      'src="/api/share/' + encodeURIComponent(S.shareView.token) + '/assets/');
    const access = API.getToken();
    if (access)
      html = html.replace(/(\/api\/share\/[^"]+\/assets\/[^"?]+)/g,
        '$1?access=' + encodeURIComponent(access));
    return html;
  };

  S.renderSharePreview = function(){
    const pv = $('#kbSharePreview');
    if (!pv) return;
    let html = mdRender($('#kbShareSrc')?.value || '') || '<p style="color:var(--om-text-3)">空笔记</p>';
    pv.innerHTML = S.rewriteShareAssets(html);
    S.highlightPreviewCode(pv);
  };

  S.renderShareOutline = function(){
    const body = $('#kbShareOutlineBody');
    if (!body) return;
    body.innerHTML = outlineBodyHtml($('#kbShareSrc')?.value || '', 'data-sh-target');
  };

  S.setShareOutline = function(on){
    const p = $('#kbShareOutline');
    if (!p) return;
    if (on){
      S.renderShareOutline();
      p.classList.add('open');
      $('#kbShareOutlineBtn')?.classList.add('on');
    } else {
      p.classList.remove('open');
      $('#kbShareOutlineBtn')?.classList.remove('on');
    }
  };

  S.setShareMode = function(mode){
    S.shareView.mode = mode;
    $$('#kbShareModeSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.shMode === mode));
    const src = $('#kbShareSrc'), pv = $('#kbSharePreview'), body = $('#kbShareEdBody');
    const useLive = S.shareView.canEdit && !!S.shareLiveEd && mode === 'edit';
    if (S.shareLiveEd){ useLive ? S.shareLiveEd.show() : S.shareLiveEd.hide(); }
    if (src){
      src.removeAttribute('hidden');
      src.style.display = (!S.shareView.canEdit || mode === 'preview' || useLive) ? 'none' : '';
    }
    if (pv) pv.style.display = (S.shareView.canEdit && mode === 'edit') ? 'none' : '';
    body?.classList.toggle('single', !S.shareView.canEdit || mode !== 'split');
    if (!useLive) S.renderSharePreview();
    S.renderShareOutline();
  };

  S.attachShareLive = function(){
    S.destroyShareLive();
    const ta = $('#kbShareSrc');
    if (!ta || !window.LiveMD || !S.shareView.canEdit) return;
    S.shareLiveEd = LiveMD.attach(ta, { afterRebuild: S.renderShareOutline });
    S.shareLiveEd.hide();
  };

  S.saveShareNote = async function(){
    if (!S.shareView.canEdit || !S.shareView.nid || !S.shareView.token) return;
    try {
      const content = $('#kbShareSrc').value;
      await S.shareFetch('/api/share/' + encodeURIComponent(S.shareView.token) +
        '/notes/' + encodeURIComponent(S.shareView.nid), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const st = $('#kbShareFootStatus');
      if (st) st.textContent = '已保存 · ' + content.length + ' 字';
    } catch (err) { showToast(err.message || '保存失败', 'err'); }
  };

  S.onShareSrcInput = function(){
    if (!S.shareView.canEdit) return;
    S.renderSharePreview();
    S.renderShareOutline();
    const st = $('#kbShareFootStatus');
    if (st) st.textContent = '编辑中…';
    clearTimeout(S.shareSaveTimer);
    S.shareSaveTimer = setTimeout(S.saveShareNote, 900);
  };

  S.renderShareTree = function(notes, folders, root){
    const rootP = (root || '').replace(/^\/+|\/+$/g, '');
    const allFolders = (folders || []).slice().sort();
    const noteHtml = n =>
      `<button class="note-item" data-share-nid="${App.esc(n.id)}"><svg class="ic ni-icon"><use href="#i-note"/></svg><span class="ni-title">${App.esc(n.title)}</span></button>`;
    const childFolders = prefix => allFolders.filter(f => {
      if (prefix) return f.startsWith(prefix + '/') && !f.slice(prefix.length + 1).includes('/');
      return f && !f.includes('/') && (!rootP || f === rootP);
    });
    const notesIn = prefix => notes.filter(n => (n.folder || '') === prefix);
    const walk = prefix => {
      const here = notesIn(prefix).map(noteHtml).join('');
      const kids = (prefix === rootP ? childFolders(prefix) : childFolders(prefix))
        .filter(f => f !== rootP);
      const inner = kids.map(f => {
        const open = true;
        const body = walk(f);
        const label = f.includes('/') ? f.slice(f.lastIndexOf('/') + 1) : f;
        return `<div class="kb-folder open">
          <div class="kb-folder-row" data-share-fold="${App.esc(f)}">
            <svg class="ic kb-chev"><use href="#i-chev-d"/></svg>
            <svg class="ic kb-folder-ic"><use href="#i-folder"/></svg>
            <span class="kb-folder-name">${App.esc(label)}</span>
          </div>
          <div class="kb-folder-body">${body || '<div class="kb-empty">空</div>'}</div>
        </div>`;
      }).join('') + here;
      return inner;
    };
    if (!rootP){
      const topNotes = notes.filter(n => !(n.folder || '')).map(noteHtml).join('');
      const topFolds = [...new Set(allFolders.map(f => f.split('/')[0]).filter(Boolean))];
      const tree = topFolds.map(f => {
        const body = walk(f);
        return `<div class="kb-folder open">
          <div class="kb-folder-row" data-share-fold="${App.esc(f)}">
            <svg class="ic kb-chev"><use href="#i-chev-d"/></svg>
            <svg class="ic kb-folder-ic"><use href="#i-folder"/></svg>
            <span class="kb-folder-name">${App.esc(f)}</span>
          </div>
          <div class="kb-folder-body">${body || '<div class="kb-empty">空</div>'}</div>
        </div>`;
      }).join('') + topNotes;
      return tree || '<div class="kb-empty">没有可查看的笔记</div>';
    }
    const tree = walk(rootP);
    return tree || '<div class="kb-empty">没有可查看的笔记</div>';
  };

  S.openShareOverlay = async function(token){
    const mask = $('#kbShareViewMask');
    if (!mask) return;
    S.shareView.token = token;
    mask.classList.add('open');
    const list = $('#kbShareViewList');
    const title = $('#kbShareViewTitle');
    const sub = $('#kbShareViewSub');
    const dlNote = $('#kbShareDlNote');
    const dlAll = $('#kbShareDlAll');
    if (dlNote) dlNote.hidden = true;
    if (dlAll) dlAll.hidden = true;
    list.innerHTML = '加载中…';
    $('#kbSharePreview').innerHTML = '';
    try {
      const d = await S.shareFetch('/api/share/' + encodeURIComponent(token));
      title.textContent = d.name || '分享';
      sub.textContent = (d.requireLogin ? '需登录 · ' : '') +
        (d.canEdit ? '可编辑 · ' : '只读 · ') +
        (d.expireAt ? ('有效至 ' + new Date(d.expireAt * 1000).toLocaleString('zh-CN')) : '');
      const notes = d.notes || [];
      const shareQ = API.getToken() ? ('?access=' + encodeURIComponent(API.getToken())) : '';
      if (dlAll){
        dlAll.href = '/api/share/' + encodeURIComponent(token) + '/export' + shareQ;
        dlAll.hidden = notes.length < 2;
      }
      if (d.kind === 'folder')
        list.innerHTML = S.renderShareTree(notes, d.folders || [], d.folder || '');
      else
        list.innerHTML = notes.map(n =>
          `<button class="note-item" data-share-nid="${App.esc(n.id)}"><svg class="ic ni-icon"><use href="#i-note"/></svg><span class="ni-title">${App.esc(n.title)}</span></button>`
        ).join('') || '<div class="kb-empty">没有可查看的笔记</div>';
      const loadOne = async nid => {
        const n = await S.shareFetch('/api/share/' + encodeURIComponent(token) + '/notes/' + encodeURIComponent(nid));
        S.shareView.nid = nid;
        if (dlNote){
          dlNote.href = '/api/share/' + encodeURIComponent(token) + '/notes/' +
            encodeURIComponent(nid) + '/export' + shareQ;
          dlNote.hidden = false;
        }
        S.shareView.canEdit = !!n.canEdit;
        $$('#kbShareViewList .note-item').forEach(b =>
          b.classList.toggle('active', b.dataset.shareNid === nid));
        $('#kbShareSrc').value = n.content || '';
        $('#kbShareEdBar').hidden = !S.shareView.canEdit;
        $('#kbShareFoot').hidden = !S.shareView.canEdit;
        $('#kbShareFootStatus').textContent = S.shareView.canEdit ? ('已保存 · ' + (n.content || '').length + ' 字') : '只读';
        title.textContent = n.title || d.name || '分享';
        if (S.shareView.canEdit) S.attachShareLive();
        else S.destroyShareLive();
        S.setShareMode(S.shareView.canEdit
          ? ((window.isPhone && isPhone()) ? 'edit' : 'split')
          : 'preview');
        if (window.isPhone && isPhone()) document.body.classList.add('share-phone-editor');
        if (d.canEdit && !n.canEdit)
          sub.textContent = '此分享允许编辑，但该笔记为只读或常驻，无法改写';
      };
      list.onclick = e => {
        const fold = e.target.closest('[data-share-fold]');
        if (fold && !e.target.closest('[data-share-nid]')){
          const box = fold.parentElement;
          const body = box && box.querySelector(':scope > .kb-folder-body');
          if (box && body){
            const open = !box.classList.contains('open');
            box.classList.toggle('open', open);
            body.hidden = !open;
          }
          return;
        }
        const b = e.target.closest('[data-share-nid]');
        if (b) loadOne(b.dataset.shareNid);
      };
      if (notes[0] && (!(window.isPhone && isPhone()) || notes.length === 1)) loadOne(notes[0].id);
      App.setShareNeedLogin(false);
      if (!API.getToken()) App.lock(false);
    } catch (e) {
      title.textContent = '无法打开分享';
      sub.textContent = e.message || '';
      list.innerHTML = '';
      if (e.needLogin){
        mask.classList.remove('open');
        App.setShareNeedLogin(true);
        App.lock();
      }
    }
  };

  S.leaveShareOverlay = function(){
    clearTimeout(S.shareSaveTimer);
    if (S.shareView.canEdit) S.saveShareNote();
    S.destroyShareLive();
    S.setShareOutline(false);
    $('#kbShareViewMask')?.classList.remove('open');
    document.body.classList.remove('share-phone-editor');
    const dlNote = $('#kbShareDlNote');
    const dlAll = $('#kbShareDlAll');
    if (dlNote) dlNote.hidden = true;
    if (dlAll) dlAll.hidden = true;
    if (!API.getToken()) App.lock();
  };

  S.tryJoinFromUrl = async function(){
    try {
      const t = new URLSearchParams(location.search).get('join');
      if (!t || !API.getToken()) return;
      const r = await API.post('/api/notes/vaults/join', { token: t });
      try { history.replaceState({}, '', location.pathname + location.hash); } catch (_) {}
      showToast(r.self ? '这是你创建的团队仓库' : ('已加入「' + (r.name || '团队仓库') + '」'));
      await S.load();
      if (r.id) await S.selectVault(r.id);
    } catch (e) { showToast(e.message, 'err'); }
  };

  S.teamInviteUrl = function(token){
    return location.origin.replace(/\/$/, '') + '/?join=' + encodeURIComponent(token);
  };

  S.parseJoinToken = function(raw){
    const s = String(raw || '').trim();
    if (!s) return '';
    try {
      const u = new URL(s, location.origin);
      const j = u.searchParams.get('join');
      if (j) return j.trim();
    } catch (_) {}
    const m = s.match(/[?&]join=([^&#]+)/);
    if (m) {
      try { return decodeURIComponent(m[1]).trim(); } catch (_) { return m[1].trim(); }
    }
    return s;
  };

  S.joinTeamPrompt = async function(){
    const raw = await App.promptModal({
      title: '加入团队笔记仓库',
      sub: '粘贴邀请码，或完整邀请链接（含 ?join=）',
      placeholder: 't_… 或邀请链接',
    });
    if (raw == null) return;
    const token = S.parseJoinToken(raw);
    if (!token){ showToast('请输入邀请码', 'err'); return; }
    try {
      const r = await API.post('/api/notes/vaults/join', { token });
      showToast(r.self ? '这是你创建的团队仓库' : ('已加入「' + (r.name || '团队仓库') + '」'));
      await S.load();
      if (r.id) await S.selectVault(r.id);
    } catch (e) { showToast(e.message, 'err'); }
  };

  S.openTeamModal = async function(vid){
    vid = vid || S.currentVault;
    const v = S.vaultMeta(vid);
    if (v.kind === 'system' || v.kind === 'default'){
      showToast('默认仓库与系统内置仓库不能转为团队仓库', 'err'); return;
    }
    App.openModal('kbTeamMask');
    const body = $('#kbTeamBody');
    const title = $('#kbTeamTitle');
    const sub = $('#kbTeamSub');
    body.innerHTML = '加载中…';
    try {
      if (v.kind === 'user'){
        title.textContent = '转为团队仓库';
        sub.textContent = '转换后会生成邀请码，可通过链接邀请其他万事屋用户加入。仅你可将它转回普通仓库。';
        body.innerHTML = `<p style="font-size:13px;color:var(--om-text-2);line-height:1.6">当前仓库「${App.esc(v.name)}」将变为团队笔记仓库，并立即生成邀请码。成员默认只读，你可以再为他们打开编辑权限。</p>
          <button class="btn btn-primary" type="button" id="kbTeamConvert">转换为团队仓库</button>`;
        $('#kbTeamConvert')?.addEventListener('click', async () => {
          try {
            await API.post('/api/notes/vaults/' + encodeURIComponent(vid) + '/team');
            try { await API.put('/api/notes/vaults/select', { vault: vid }); } catch (_) {}
            S.currentVault = vid;
            try { localStorage.setItem(S.VAULT_KEY, vid); } catch (_) {}
            showToast('已转为团队仓库，邀请码已生成');
            await S.load();
            S.currentVault = vid;
            try { localStorage.setItem(S.VAULT_KEY, vid); } catch (_) {}
            S.renderVaultSwitch();
            S.renderTree();
            await S.openTeamModal(vid);
          } catch (e) { showToast(e.message, 'err'); }
        });
        return;
      }
      const d = await API.get('/api/notes/vaults/' + encodeURIComponent(vid) + '/team');
      title.textContent = d.name || '团队仓库';
      sub.textContent = d.isOwner ? '你是创建人，可管理成员与邀请' : (d.canEdit ? '你是可编辑成员' : '你是只读成员');
      let html = '';
      if (d.isOwner){
        const url = S.teamInviteUrl(d.token || '');
        html += `<div class="set-row-label">邀请码</div>
          <div class="team-invite"><input class="input" id="kbTeamCode" readonly value="${App.esc(d.token || '')}">
          <button class="btn btn-outline btn-sm" type="button" id="kbTeamCopyCode">复制邀请码</button></div>
          <div class="set-row-label" style="margin-top:12px">邀请链接</div>
          <div class="team-invite"><input class="input" id="kbTeamLink" readonly value="${App.esc(url)}">
          <button class="btn btn-outline btn-sm" type="button" id="kbTeamCopy">复制</button>
          <button class="btn btn-ghost btn-sm" type="button" id="kbTeamResetInv">重置</button></div>
          <div class="set-row-sub" style="margin:8px 0 12px">对方可在知识库 ⋯ 菜单选择「加入团队仓库」并填入邀请码。</div>
          <div class="team-member-head"><span>成员</span><span>编辑权限</span><span></span></div>`;
        html += (d.members || []).length
          ? (d.members || []).map(m => `<div class="team-member" data-mu="${App.esc(m.u)}">
              <span class="nm">${App.esc(m.u)}</span>
              <button class="switch${m.canEdit ? ' on' : ''}" type="button" role="switch" data-team-edit="${App.esc(m.u)}" aria-checked="${m.canEdit ? 'true' : 'false'}" title="编辑权限"></button>
              <button class="btn btn-ghost btn-sm" type="button" data-team-kick="${App.esc(m.u)}" style="color:var(--om-danger)">移出</button>
            </div>`).join('')
          : '<div class="kb-empty">还没有成员，把邀请码或链接发给同事即可</div>';
        html += `<div style="margin-top:16px"><button class="btn btn-outline btn-sm" type="button" id="kbTeamRevert" style="color:var(--om-danger)">转回普通仓库</button></div>`;
      } else {
        html += `<p style="font-size:13px;color:var(--om-text-2)">创建人：${App.esc(d.owner || '')}</p>
          <button class="btn btn-outline" type="button" id="kbTeamLeave" style="color:var(--om-danger)">退出此团队仓库</button>`;
      }
      body.innerHTML = html;
      $('#kbTeamCopy')?.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText($('#kbTeamLink').value); showToast('已复制邀请链接'); }
        catch (e) { showToast('复制失败', 'err'); }
      });
      $('#kbTeamCopyCode')?.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText($('#kbTeamCode').value); showToast('已复制邀请码'); }
        catch (e) { showToast('复制失败', 'err'); }
      });
      $('#kbTeamResetInv')?.addEventListener('click', async () => {
        try {
          await API.post('/api/notes/vaults/' + encodeURIComponent(vid) + '/invite');
          showToast('邀请已重置');
          S.openTeamModal(vid);
        } catch (e) { showToast(e.message, 'err'); }
      });
      $('#kbTeamRevert')?.addEventListener('click', async () => {
        if (!await App.confirmModal({ title: '转回普通仓库？', danger: true, okText: '转回',
          sub: '所有成员将失去访问权限。' })) return;
        try {
          await API.del('/api/notes/vaults/' + encodeURIComponent(vid) + '/team');
          showToast('已转回普通仓库');
          App.closeModal('kbTeamMask');
          await S.load();
        } catch (e) { showToast(e.message, 'err'); }
      });
      $('#kbTeamLeave')?.addEventListener('click', async () => {
        try {
          await API.post('/api/notes/vaults/' + encodeURIComponent(vid) + '/leave');
          showToast('已退出');
          App.closeModal('kbTeamMask');
          S.currentVault = S.VAULT_DEFAULT;
          await S.load();
        } catch (e) { showToast(e.message, 'err'); }
      });
      body.onclick = async e => {
        const ed = e.target.closest('[data-team-edit]');
        const kick = e.target.closest('[data-team-kick]');
        try {
          if (ed){
            e.stopPropagation();
            const next = !ed.classList.contains('on');
            await API.put('/api/notes/vaults/' + encodeURIComponent(vid) + '/members/' + encodeURIComponent(ed.dataset.teamEdit), { canEdit: next });
            showToast(next ? '已开启编辑权限' : '已关闭编辑权限');
            S.openTeamModal(vid);
            return;
          }
          if (kick){
            e.stopPropagation();
            if (!await App.confirmModal({ title: '移出成员？', danger: true, okText: '移出',
              sub: '对方将立即失去此仓库访问权限。' })) return;
            await API.del('/api/notes/vaults/' + encodeURIComponent(vid) + '/members/' + encodeURIComponent(kick.dataset.teamKick));
            showToast('已移出');
            S.openTeamModal(vid);
          }
        } catch (err) { showToast(err.message, 'err'); }
      };
    } catch (e) {
      body.innerHTML = '<div class="kb-empty">' + App.esc(e.message || '加载失败') + '</div>';
    }
  };

