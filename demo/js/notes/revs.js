import { mdRender, mdFallback, mdOutline, outlineItemHtml, outlineBodyHtml, mdLineDiff, renderRevDiffHtml, _mdSlug } from './md.js';
import { S } from './state.js';

  S.fmtRevTs = function(ts){
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false });
  };

  S.revSourceLabel = function(src){
    return src === 'obsidian' ? '客户端' : '服务端';
  };

  S.openRevModal = async function(id){
    const meta = S.idx.find(n => n.id === id);
    if (!meta) return;
    S._revNoteId = id;
    S._revCanRestore = S.vaultCanEdit() && !meta.readonly && !meta.pinned;
    S._revDiffOn = true;
    S._revCache = null;
    $('#kbRevTitle').textContent = '版本管理 · ' + (meta.title || '未命名笔记');
    $('#kbRevList').innerHTML = '<div class="kb-empty">加载中…</div>';
    $('#kbRevDetail').innerHTML = '<div class="kb-empty">选择一个历史版本查看差异</div>';
    App.openModal('kbRevMask');
    try {
      if (id === S.currentId && S.dirty) await S.save();
      const d = await API.get('/api/notes/' + encodeURIComponent(id) + '/revisions');
      const rows = d.revisions || [];
      if (!rows.length){
        $('#kbRevList').innerHTML = '<div class="kb-empty">还没有历史版本。保存或同步产生变更后会出现在这里。</div>';
        return;
      }
      $('#kbRevList').innerHTML = rows.map(x =>
        '<button class="rev-item" type="button" data-rev="' + x.rev + '">'
        + '<span class="rev-no">v' + x.rev + '</span>'
        + '<span class="chip no-dot">' + S.revSourceLabel(x.source) + '</span>'
        + '<span class="rev-ts">' + S.fmtRevTs(x.ts) + '</span></button>'
      ).join('');
    } catch (e) {
      $('#kbRevList').innerHTML = '<div class="kb-empty">' + App.esc(e.message || '加载失败') + '</div>';
    }
  };

  S.showRevDetail = async function(rev){
    const list = $('#kbRevList');
    list?.querySelectorAll('.rev-item').forEach(b => b.classList.toggle('on', +b.dataset.rev === +rev));
    const box = $('#kbRevDetail');
    box.innerHTML = '<div class="kb-empty">加载中…</div>';
    try {
      const d = await API.get('/api/notes/' + encodeURIComponent(S._revNoteId) + '/revisions/' + encodeURIComponent(rev));
      S._revCache = d;
      S.paintRevDetail();
    } catch (e) {
      box.innerHTML = '<div class="kb-empty">' + App.esc(e.message || '加载失败') + '</div>';
    }
  };

  S.paintRevDetail = function(){
    const d = S._revCache;
    const box = $('#kbRevDetail');
    if (!d || !box) return;
    const body = S._revDiffOn
      ? ('<div class="rev-diff">' + renderRevDiffHtml(d.content || '', d.current || '') + '</div>')
      : ('<div class="rev-full md-preview">' + (mdRender(d.content || '') || '<p style="color:var(--om-text-3)">空笔记</p>') + '</div>');
    box.innerHTML = '<div class="rev-detail-bar">'
      + '<div class="rev-detail-meta">v' + d.rev + ' · ' + S.revSourceLabel(d.source)
      + ' · ' + S.fmtRevTs(d.ts) + '</div>'
      + '<div class="rev-detail-actions">'
      + '<span class="set-row-label" style="margin:0">差异视图</span>'
      + '<button class="switch' + (S._revDiffOn ? ' on' : '') + '" type="button" role="switch" id="kbRevDiffSw" title="差异视图"></button>'
      + (S._revCanRestore ? '<button class="btn btn-primary btn-sm" type="button" id="kbRevRestore">恢复此版本</button>' : '')
      + '</div></div>' + body;
    if (!S._revDiffOn){
      const full = box.querySelector('.rev-full');
      S.highlightPreviewCode(full);
      S.hydrateImages(full);
    }
  };

  S.restoreRev = async function(){
    if (!S._revCache || !S._revCanRestore) return;
    if (!await App.confirmModal({
      title: '恢复此版本？', danger: true, okText: '恢复',
      sub: '当前笔记将被 v' + S._revCache.rev + ' 覆盖。恢复前会把现在的内容存为新的历史版本。',
    })) return;
    try {
      const r = await API.post('/api/notes/' + encodeURIComponent(S._revNoteId)
        + '/revisions/' + encodeURIComponent(S._revCache.rev) + '/restore');
      showToast('已恢复为 v' + S._revCache.rev);
      const meta = S.idx.find(n => n.id === S._revNoteId);
      if (meta) meta.updated = r.updated || Math.floor(Date.now() / 1000);
      if (S.currentId === S._revNoteId){
        S.dirty = false;
        await S.open(S._revNoteId);
      } else S.renderTree();
      await S.openRevModal(S._revNoteId);
    } catch (e) { showToast(e.message, 'err'); }
  };

