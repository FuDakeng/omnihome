/* ============================================================
   OmniDesk · 全局搜索
   搜索引擎跳转（Google / Bing / DuckDuckGo / 百度）
   + 站内内容检索（书签 / 笔记 / 计划 / 保险库 / 日程）。
   ============================================================ */
(() => {
  const ENGINES = {
    Google:     q => 'https://www.google.com/search?q=' + encodeURIComponent(q),
    Bing:       q => 'https://www.bing.com/search?q=' + encodeURIComponent(q),
    DuckDuckGo: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
    百度:       q => 'https://www.baidu.com/s?wd=' + encodeURIComponent(q),
  };
  const ORDER = ['Google', 'Bing', 'DuckDuckGo', '百度', '站内检索'];
  let engineIdx = parseInt(localStorage.getItem('om_engine') || '0', 10);
  let debounce = null;
  const TYPE_ICON = { bookmark: 'i-bookmark', note: 'i-pen', plan: 'i-check', vault: 'i-shield', event: 'i-clock' };
  const TYPE_LABEL = { bookmark: '书签', note: '笔记', plan: '计划', vault: '保险库', event: '日程' };

  const input = $('#globalSearch');
  const pop = $('.search-pop');

  function currentEngine(){ return ORDER[engineIdx % ORDER.length]; }

  function renderRecent(){
    const recent = JSON.parse(localStorage.getItem('om_recent') || '[]');
    $('#spRecent').innerHTML = recent.length
      ? recent.slice(0, 5).map(q => `
        <button class="sp-item" data-recent="${App.esc(q)}">
          <svg class="ic"><use href="#i-clock"/></svg>${App.esc(q)}</button>`).join('')
      : '<div style="font-size:12px;color:var(--om-text-3);padding:4px 2px">暂无搜索记录</div>';
    $$('.engine-chip').forEach(c => c.classList.toggle('on', c.textContent === currentEngine()));
  }

  function pushRecent(q){
    let recent = JSON.parse(localStorage.getItem('om_recent') || '[]');
    recent = [q, ...recent.filter(x => x !== q)].slice(0, 10);
    localStorage.setItem('om_recent', JSON.stringify(recent));
  }

  function doSearch(q){
    if (!q.trim()) return;
    pushRecent(q.trim());
    const name = currentEngine();
    if (name === '站内检索'){
      showToast('已在下方展示站内结果');
      return;
    }
    window.open(ENGINES[name](q.trim()), '_blank');
  }

  async function siteSearch(q){
    try {
      const list = await API.get('/api/search/site?q=' + encodeURIComponent(q));
      $('#spResults').innerHTML = list.length
        ? list.map(r => `
          <button class="sp-item" data-go="${r.go}" ${r.id ? `data-nid="${r.id}"` : ''}>
            <svg class="ic"><use href="#${TYPE_ICON[r.type] || 'i-note'}"/></svg>
            ${App.esc(r.title)}<span style="margin-left:auto;font-size:11px;color:var(--om-text-3)">${TYPE_LABEL[r.type] || ''}</span>
          </button>`).join('')
        : '<div style="font-size:12px;color:var(--om-text-3);padding:4px 2px">站内未找到相关内容</div>';
      $('#spResultsWrap').hidden = false;
    } catch (e) { /* 忽略 */ }
  }

  /* ---------- 事件 ---------- */
  input.addEventListener('focus', () => { pop.classList.add('open'); renderRecent(); });
  document.addEventListener('click', e => {
    if (!e.target.closest('.searchbar')) pop.classList.remove('open');
  });

  input.addEventListener('input', e => {
    clearTimeout(debounce);
    const q = e.target.value.trim();
    if (q.length < 1){ $('#spResultsWrap').hidden = true; return; }
    debounce = setTimeout(() => siteSearch(q), 250);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') doSearch(input.value);
    if (e.key === 'Tab'){
      e.preventDefault();
      engineIdx = (engineIdx + (e.shiftKey ? ORDER.length - 1 : 1)) % ORDER.length;
      localStorage.setItem('om_engine', engineIdx);
      renderRecent();
    }
    if (e.key === 'Escape'){ input.blur(); pop.classList.remove('open'); }
  });

  document.addEventListener('click', e => {
    const chip = e.target.closest('.engine-chip');
    if (chip){
      engineIdx = ORDER.indexOf(chip.textContent);
      localStorage.setItem('om_engine', engineIdx);
      renderRecent();
      return;
    }
    const recent = e.target.closest('[data-recent]');
    if (recent){ input.value = recent.dataset.recent; doSearch(recent.dataset.recent); return; }
    const go = e.target.closest('[data-go]');
    if (go){
      pop.classList.remove('open');
      if (typeof goView === 'function') goView(go.dataset.go);
      if (go.dataset.go === 'notes' && go.dataset.nid && window.Notes){
        Notes.open(go.dataset.nid);
      }
    }
  });
})();
