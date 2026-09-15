import { S } from './state.js';

S.bindShare = function () {
    /* 新建笔记：所有 + 号按钮都通过 kbMenu 弹出选择，不再常驻顶栏。
       原来 #noteNew / #folderNew 已从 HTML 移除，相应绑定也清掉。 */
    App.onEnter(() => { S.load(); S.tryOpenShareFromUrl(); S.tryJoinFromUrl(); });
    App.onReady(() => { if (!API.getToken()) S.tryOpenShareFromUrl(); });
    setInterval(S.pollOpenNote, 4000);
    $('#kbShareCreate')?.addEventListener('click', S.createShareLink);
    $('#kbShareCopy')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($('#kbShareLink').value); showToast('链接已复制'); }
      catch (e) { showToast('复制失败', 'err'); }
    });
    $('#kbShareClose')?.addEventListener('click', () => App.closeModal('kbShareMask'));
    $('#kbShareRevoke')?.addEventListener('click', async () => {
      const sid = $('#kbShareRevoke').dataset.sid;
      if (!sid) return;
      try {
        await API.del('/api/notes/shares/' + encodeURIComponent(sid));
        showToast('已取消分享');
        App.closeModal('kbShareMask');
        await S.load();
      } catch (e) { showToast(e.message, 'err'); }
    });
    $('#kbShareExpire')?.addEventListener('click', e => {
      const b = e.target.closest('.seg-btn');
      if (!b) return;
      $$('#kbShareExpire .seg-btn').forEach(x => x.classList.toggle('active', x === b));
      S.persistExistingShare().catch(err => showToast(err.message, 'err'));
    });
    $('#kbShareEdit')?.addEventListener('click', () => {
      S.persistExistingShare().catch(err => showToast(err.message, 'err'));
    });
    $('#kbShareNeedLogin')?.addEventListener('click', () => {
      S.persistExistingShare().catch(err => showToast(err.message, 'err'));
    });
    $('#kbShareViewClose')?.addEventListener('click', S.leaveShareOverlay);
    $('#kbTeamClose')?.addEventListener('click', () => App.closeModal('kbTeamMask'));
    $('#kbObsidianClose')?.addEventListener('click', () => App.closeModal('kbObsidianMask'));
    $('#kbObsidianMask')?.addEventListener('click', e => {
      if (e.target === $('#kbObsidianMask')) App.closeModal('kbObsidianMask');
    });
    $('#kbObsidianSwitchHit')?.addEventListener('click', e => {
      if (!$('#kbObsidianEnabled')?.disabled && !$('#kbObsidianSwitchHit')?.classList.contains('locked')) return;
      e.preventDefault();
      e.stopPropagation();
      showToast($('#kbObsidianBlockText')?.textContent || '此仓库不可开启 Obsidian 同步', 'err');
    });
    $('#kbObsidianEnabled')?.addEventListener('click', async () => {
      if ($('#kbObsidianEnabled').disabled) return;
      const block = S.vaultSyncBlock();
      if (block){
        $('#kbObsidianEnabled').classList.remove('on');
        showToast(block, 'err');
        return;
      }
      const lock = S.vaultSyncSwitchLocked();
      if (lock){
        $('#kbObsidianEnabled').classList.toggle('on');
        showToast(lock, 'err');
        return;
      }
      const next = $('#kbObsidianEnabled').classList.contains('on');
      try {
        await API.put('/api/sync/enabled', { vault: S.currentVault, enabled: next });
        showToast(next ? '已开启当前仓库的 Obsidian 同步' : '已关闭：令牌仍保留但同步不可用，重新开启后可继续使用');
        await S.loadObsidianModal();
      } catch (e) {
        $('#kbObsidianEnabled').classList.toggle('on', !next);
        showToast(e.message, 'err');
      }
    });
    $('#kbObsidianPluginDl')?.addEventListener('click', () => {
      if ($('#kbObsidianPluginDl').dataset.available !== '1'){
        showToast('当前部署未包含插件目录', 'err');
        return;
      }
      API.dl('/api/plugin.zip');
    });
    $('#kbObsidianUrlCopy')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($('#kbObsidianUrl').value); showToast('服务端地址已复制'); }
      catch (e) { showToast('复制失败，请手动选中复制', 'err'); }
    });
    $('#kbObsidianVaultKey')?.addEventListener('click', async e => {
      const gen = e.target.closest('[data-obs-gen]');
      const bundle = e.target.closest('[data-obs-bundle]');
      const rev = e.target.closest('[data-obs-rev]');
      if (!gen && !bundle && !rev) return;
      const block = S.vaultSyncBlock();
      if (block){ showToast(block, 'err'); return; }
      const vid = S.currentVault;
      if (gen){
        const isNew = gen.dataset.obsNew === '1';
        if (!await App.confirmModal({
          title: isNew ? '生成同步令牌？' : '重置同步令牌？',
          warning: true, okText: isNew ? '生成' : '重置',
          sub: isNew
            ? '请保管好同步令牌，向他人提供可能导致数据泄漏！'
            : '旧令牌将立即失效。请保管好同步令牌，向他人提供可能导致数据泄漏！',
        })) return;
        try {
          const d = await API.post('/api/sync/apikey?vault=' + encodeURIComponent(vid), { vault: vid });
          if (d.vault && d.vault !== vid){
            showToast('签发仓库与当前仓库不一致，请刷新后重试', 'err');
            return;
          }
          S._obsidianPlain = d.apiKey || '';
          S._obsidianPlainVault = vid;
          await S.renderObsidianVaultKey();
          await S.renderObsidianLog();
          await S.copyObsidianBundle();
        } catch (err) { showToast(err.message, 'err'); }
      }
      if (bundle) await S.copyObsidianBundle();
      if (rev){
        if (!await App.confirmModal({
          title: '吊销同步令牌？', danger: true, okText: '吊销',
          sub: '当前仓库的 Obsidian 同步将立即断开，不影响笔记内容。',
        })) return;
        try {
          await API.del('/api/sync/apikey?vault=' + encodeURIComponent(vid));
          if (S._obsidianPlainVault === vid){ S._obsidianPlain = ''; S._obsidianPlainVault = ''; }
          showToast('已吊销');
          await S.renderObsidianVaultKey();
          await S.renderObsidianLog();
        } catch (err) { showToast(err.message, 'err'); }
      }
    });
    $('#kbShareOutlineBtn')?.addEventListener('click', () =>
      S.setShareOutline(!$('#kbShareOutline')?.classList.contains('open')));
    $('#kbShareOutlineClose')?.addEventListener('click', () => S.setShareOutline(false));
    $('#kbShareOutlineBody')?.addEventListener('click', e => {
      const it = e.target.closest('[data-sh-target]');
      if (!it) return;
      S.jumpToHeading(it.dataset.shTarget, it.dataset.line, S.shareLiveEd, $('#kbSharePreview'));
    });
    $$('#kbShareModeSeg .seg-btn').forEach(b =>
      b.addEventListener('click', () => S.setShareMode(b.dataset.shMode)));
    $('#kbShareSrc')?.addEventListener('input', S.onShareSrcInput);
    $('#kbShareEdBar')?.addEventListener('mousedown', e => {
      if (e.target.closest && e.target.closest('button, .seg-btn, [data-sh-act]')) e.preventDefault();
    });
    $('#kbShareEdBar')?.addEventListener('click', e => {
      const btn = e.target.closest('[data-sh-act]');
      if (!btn || !S.shareView.canEdit) return;
      const act = btn.dataset.shAct;
      const ta = $('#kbShareSrc');
      const liveOn = () => S.shareLiveEd && S.shareLiveEd.isShown();
      const srcInsert = text => {
        ta.focus();
        document.execCommand('insertText', false, text);
        ta.dispatchEvent(new Event('input'));
      };
      const wrapSel = (pre, suf, ph) => {
        if (liveOn()){ S.shareLiveEd.wrapSelection(pre, suf, ph || ''); return; }
        const s = ta.selectionStart, e2 = ta.selectionEnd;
        const sel = ta.value.slice(s, e2);
        const mid = sel || ph || '';
        ta.focus();
        document.execCommand('insertText', false, pre + mid + suf);
        ta.dispatchEvent(new Event('input'));
      };
      const linePrefix = prefix => {
        if (liveOn()){ S.shareLiveEd.lineInsert(prefix); return; }
        const s = ta.selectionStart;
        const lineStart = ta.value.lastIndexOf('\n', s - 1) + 1;
        ta.setSelectionRange(lineStart, lineStart);
        srcInsert(prefix);
      };
      if (act === 'bold') wrapSel('**', '**', '粗体');
      else if (act === 'italic') wrapSel('*', '*', '斜体');
      else if (act === 'strike') wrapSel('~~', '~~', '删除线');
      else if (act === 'inline-code') wrapSel('`', '`', 'code');
      else if (act === 'h1') linePrefix('# ');
      else if (act === 'h2') linePrefix('## ');
      else if (act === 'h3') linePrefix('### ');
      else if (act === 'ul') linePrefix('- ');
      else if (act === 'ol') linePrefix('1. ');
      else if (act === 'task') linePrefix('- [ ] ');
      else if (act === 'quote') linePrefix('> ');
      else if (act === 'code') wrapSel('\n```\n', '\n```\n', 'code');
      else if (act === 'link') wrapSel('[', '](https://)', '链接文字');
    });

    /* 顶部 "..." 溢出菜单：导入 / 导出（设计图把显眼按钮收纳收起） */
    $('#notesOverflowBtn')?.addEventListener('click', e => {
      e.stopPropagation();
      S.kbMenu($('#notesOverflowBtn'), [
      ['新建笔记仓库', 'i-folder', () => S.createVault()],
      ['加入团队仓库…', 'i-users', () => S.joinTeamPrompt()],
      ['重命名当前仓库', 'i-pen', () => S.renameVault()],
      ...(S.canDeleteVault(S.vaultMeta(S.currentVault)) ? [['删除当前仓库', 'i-trash', () => S.deleteCurrentVault(), 'danger']] : []),
      ...((S.vaultMeta(S.currentVault).kind === 'user' || S.vaultMeta(S.currentVault).kind === 'team')
        ? [['管理团队…', 'i-users', () => S.openTeamModal()]] : []),
      'sep',
      ['Obsidian 同步…', 'i-swap', () => S.openObsidianModal()],
      ...(S.vaultCanEdit() ? [['导入 Markdown / zip', 'i-download', () => S.importMd()]] : []),
      ['导出全部笔记', 'i-upload', () => API.dl('/api/notes/all')],
    ]);
    });
    $('#kbVaultBtn')?.addEventListener('click', e => {
      e.stopPropagation();
      const items = S.vaults.map(v => [
        (v.id === S.currentVault ? '✓ ' : '') + v.name + S.vaultKindTag(v),
        S.vaultIcon(v),
        () => S.selectVault(v.id),
      ]);
      items.push('sep');
      items.push(['新建仓库…', 'i-plus', () => S.createVault()]);
      S.kbMenu($('#kbVaultBtn'), items);
    });
    /* 回收站入口：v0.2.26 整个底部条都是点击热区（按钮只是视觉），点击弹层。
       拖放到回收站后浏览器可能再派发 click，用时间戳跳过，避免误开弹层 */
    $('#kbTreeFoot')?.addEventListener('click', () => {
      if (Date.now() - (S._trashDropAt || 0) < 500) return;
      S.openTrashModal();
    });
    $('#kbTrashClose')?.addEventListener('click', () => App.closeModal('kbTrashMask'));
    $('#kbTrashPurgeAll')?.addEventListener('click', S.purgeAllTrash);
    $('#kbTrashMask')?.addEventListener('click', e => { if (e.target === $('#kbTrashMask')) App.closeModal('kbTrashMask'); });
    /* 笔记详情弹层 */
    $('#kbInfoClose')?.addEventListener('click', () => App.closeModal('kbInfoMask'));
    $('#kbInfoMask')?.addEventListener('click', e => { if (e.target === $('#kbInfoMask')) App.closeModal('kbInfoMask'); });
    $('#kbRevClose')?.addEventListener('click', () => App.closeModal('kbRevMask'));
    $('#kbRevMask')?.addEventListener('click', e => {
      if (e.target === $('#kbRevMask')){ App.closeModal('kbRevMask'); return; }
      const item = e.target.closest('#kbRevList [data-rev]');
      if (item){ S.showRevDetail(item.dataset.rev); return; }
      if (e.target.closest('#kbRevDiffSw')){ S._revDiffOn = !S._revDiffOn; S.paintRevDetail(); return; }
      if (e.target.closest('#kbRevRestore')) S.restoreRev();
    });
    /* 编辑区顶栏由全局 .topbar 承载（#globalSearch 等 demo.js 已绑）；
       此处不再绑定 kbBack / kbEditorSearch / kbAvatar / kbDate */
    /* 单篇导出/删除已随 0.2.18 顶栏移除，入口收进笔记悬浮 ⋯ 菜单（openNoteMenu） */

    };
