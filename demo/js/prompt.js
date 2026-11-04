/* ============================================================
   OmniHome · 实用工具箱 · 提示词增强
   本地规则增强 + 可选 AI 润色 / 测试运行 + 历史与收藏（localStorage）。
   提示词正文一律用 textContent 写入，不渲染 HTML。
   ============================================================ */
(() => {
  const MAX_INPUT = 2000;
  const MAX_HISTORY = 20;
  const MAX_FAVS = 30;
  const LS_HISTORY = 'om_pe_history';
  const LS_FAVS = 'om_pe_favs';

  const SCENE_LABELS = {
    auto: '自动识别', general: '通用', coding: '代码生成',
    writing: '文案创作', data: '数据分析', academic: '学术研究',
    translation: '翻译润色',
  };

  const TEMPLATES = {
    zh: {
      coding: '请帮我实现以下功能：\n- 输入：\n- 期望输出：\n要求：考虑性能优化，添加单元测试，并处理必要的错误情况。',
      writing: '请为以下主题写一段文案：\n- 主题：\n- 目标读者：\n- 发布平台：\n要求：吸引眼球，符合 SEO 规范，并给出 3 个标题候选。',
      data: '请分析以下数据并给出结论：\n- 数据：\n- 分析目标：\n要求：提供可视化建议，解释数据趋势，并给出可执行的下一步。',
      academic: '请围绕以下主题完成学术写作：\n- 主题：\n- 研究范围：\n要求：引用权威来源，逻辑严密，并按规范列出参考文献。',
    },
    en: {
      coding: 'Please implement the following:\n- Input:\n- Expected output:\nRequirements: consider performance, add unit tests, and handle necessary error cases.',
      writing: 'Write copy for the following topic:\n- Topic:\n- Target audience:\n- Publishing platform:\nRequirements: make it engaging, follow SEO best practices, and provide 3 headline options.',
      data: 'Analyze the following data and give conclusions:\n- Data:\n- Analysis goal:\nRequirements: suggest visualizations, explain trends, and recommend actionable next steps.',
      academic: 'Write an academic piece on the following topic:\n- Topic:\n- Research scope:\nRequirements: cite authoritative sources, keep the logic rigorous, and list references in a standard format.',
    },
  };

  let history = [];
  let favs = [];
  let last = null;
  let busy = false;
  let libMode = null;
  let ai = { loaded: false, loading: false, ready: false };

  const $id = id => document.getElementById(id);
  const isEN = () => !!(window.Locale && Locale.lang() === 'en');

  function node(tag, cls, text){
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function icon(name){
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ic');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  }

  function iconBtn(name, title){
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-btn-xs';
    b.title = title;
    b.append(icon(name));
    return b;
  }

  function readStore(key){
    try {
      const v = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }

  function writeStore(key, value){
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  function uid(){
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function keyOf(entry){
    return (entry && entry.text || '') + '\u0000' + (entry && entry.prompt || '');
  }

  function oneLine(text){
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function sceneLabel(scene){
    return SCENE_LABELS[scene] || SCENE_LABELS.general;
  }

  function formatDate(ts){
    const d = new Date(ts || Date.now());
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(isEN() ? 'en-US' : 'zh-CN',
      { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  /* ---------- DOM ---------- */
  const root = document.querySelector('[data-tool="prompt"]');
  if (!root) return;

  const input = $id('peInput');
  const out = $id('peOut');
  const count = $id('peCount');
  const modeChip = $id('peMode');
  const missingEl = $id('peMissing');
  const enhanceBtn = $id('peEnhance');
  const clearBtn = $id('peClear');
  const copyBtn = $id('peCopy');
  const favBtn = $id('peFav');
  const testBtn = $id('peTest');
  const testHint = $id('peTestHint');
  const testWrap = $id('peTestWrap');
  const testOut = $id('peTestOut');
  const testClose = $id('peTestClose');
  const aiSwitch = $id('peAI');
  const aiHint = $id('peAIHint');
  const aiSetup = $id('peAISetup');
  const historyBtn = $id('peHistoryBtn');
  const favsBtn = $id('peFavBtn');
  const historyCount = $id('peHistoryCount');
  const favCount = $id('peFavCount');
  const lib = $id('peLib');
  const libTitle = $id('peLibTitle');
  const libHint = $id('peLibHint');
  const libList = $id('peLibList');
  const libClear = $id('peLibClear');
  const sceneSel = $id('peScene');
  const roleSel = $id('peRole');
  const roleWrap = $id('peRoleCustomWrap');
  const roleCustom = $id('peRoleCustom');

  if (!input || !out || !enhanceBtn) return;

  history = readStore(LS_HISTORY);
  favs = readStore(LS_FAVS);

  /* ---------- 结果与状态 ---------- */
  function showEmpty(){
    out.replaceChildren(node('span', 'pe-empty', '增强结果会显示在这里'));
    modeChip.hidden = true;
    missingEl.hidden = true;
    missingEl.replaceChildren();
    last = null;
    setFavState(false);
  }

  function renderResult(d){
    out.textContent = d.prompt || '';
    out.scrollTop = 0;
    modeChip.hidden = !d.prompt;
    modeChip.textContent = d.mode === 'ai' ? 'AI 润色' : '本地模板';

    missingEl.replaceChildren();
    const missing = Array.isArray(d.missing) ? d.missing.filter(Boolean) : [];
    if (missing.length){
      missingEl.hidden = false;
      missingEl.append(node('b', null, '可补充：'));
      missing.forEach((m, i) => {
        if (i) missingEl.append(document.createTextNode('、'));
        missingEl.append(node('span', null, m));
      });
    } else {
      missingEl.hidden = true;
    }
  }

  function setFavState(on){
    favBtn.classList.toggle('on', !!on);
    favBtn.title = on ? '取消收藏' : '收藏';
  }

  function updateCounts(){
    historyCount.textContent = String(history.length);
    favCount.textContent = String(favs.length);
  }

  function updateInputState(){
    const n = input.value.length;
    count.textContent = n + ' / ' + MAX_INPUT;
    count.classList.toggle('over', n > MAX_INPUT);
    enhanceBtn.disabled = busy || !input.value.trim() || n > MAX_INPUT;
  }

  function setBusy(on){
    busy = on;
    if (on){
      enhanceBtn.dataset.origHtml = enhanceBtn.innerHTML;
      enhanceBtn.replaceChildren(
        node('span', 'loading-dot'),
        document.createTextNode('正在增强…')
      );
    } else if (enhanceBtn.dataset.origHtml){
      enhanceBtn.innerHTML = enhanceBtn.dataset.origHtml;
      delete enhanceBtn.dataset.origHtml;
    }
    updateInputState();
  }

  function readParams(){
    return {
      text: input.value.trim(),
      scene: sceneSel.value || 'auto',
      role: roleSel.value || 'auto',
      customRole: roleCustom.value.trim(),
      tone: $id('peTone').value || 'professional',
      format: $id('peFormat').value || 'auto',
      language: $id('peLang').value || 'auto',
      detail: $id('peDetail').value || 'standard',
      audience: $id('peAudience').value.trim(),
      constraints: $id('peConstraints').value.trim(),
      examples: $id('peExamples').value.trim(),
      useAI: aiSwitch.classList.contains('on'),
    };
  }

  function applyParams(p){
    if (!p) return;
    sceneSel.value = p.scene || 'auto';
    roleSel.value = p.role || 'auto';
    roleCustom.value = p.customRole || '';
    $id('peTone').value = p.tone || 'professional';
    $id('peFormat').value = p.format || 'auto';
    $id('peLang').value = p.language || 'auto';
    $id('peDetail').value = p.detail || 'standard';
    $id('peAudience').value = p.audience || '';
    $id('peConstraints').value = p.constraints || '';
    $id('peExamples').value = p.examples || '';
    roleWrap.hidden = roleSel.value !== 'custom';
    updateInputState();
  }

  function entryFrom(d, params){
    return {
      id: uid(),
      ts: Date.now(),
      text: params.text,
      params: {
        text: params.text,
        scene: params.scene, role: params.role, customRole: params.customRole,
        tone: params.tone, format: params.format, language: params.language,
        detail: params.detail, audience: params.audience,
        constraints: params.constraints, examples: params.examples,
      },
      prompt: d.prompt || '',
      mode: d.mode || 'local',
      scene: d.scene || params.scene,
      language: d.language || params.language,
      missing: Array.isArray(d.missing) ? d.missing : [],
      warnings: Array.isArray(d.warnings) ? d.warnings : [],
    };
  }

  function loadEntry(entry){
    if (!entry) return;
    input.value = entry.text || '';
    applyParams(entry.params || {});
    last = entry;
    renderResult(entry);
    setFavState(favs.some(x => keyOf(x) === keyOf(entry)));
    testWrap.hidden = true;
    updateInputState();
    closeLibrary();
  }

  /* ---------- 历史 / 收藏 ---------- */
  function pushHistory(entry){
    if (!entry || !entry.prompt) return;
    history = [entry, ...history.filter(x => keyOf(x) !== keyOf(entry))].slice(0, MAX_HISTORY);
    writeStore(LS_HISTORY, history);
    updateCounts();
    if (libMode === 'history') renderLibrary();
  }

  function toggleFavEntry(entry){
    if (!entry || !entry.prompt){
      showToast('请先增强提示词', 'err');
      return;
    }
    const k = keyOf(entry);
    const idx = favs.findIndex(x => keyOf(x) === k);
    if (idx >= 0){
      favs.splice(idx, 1);
      showToast('已取消收藏');
    } else {
      favs = [{ ...entry, id: uid(), ts: Date.now() }, ...favs].slice(0, MAX_FAVS);
      writeStore(LS_FAVS, favs);
      showToast('已收藏');
    }
    writeStore(LS_FAVS, favs);
    updateCounts();
    setFavState(last ? favs.some(x => keyOf(x) === keyOf(last)) : false);
    if (libMode) renderLibrary();
  }

  function renderLibrary(){
    if (!libMode) return;
    const items = libMode === 'favs' ? favs : history;
    libTitle.textContent = libMode === 'favs' ? '收藏' : '历史记录';
    libClear.hidden = libMode !== 'history';
    libList.replaceChildren();

    if (!items.length){
      libList.append(node('div', 'pe-lib-empty',
        libMode === 'favs' ? '暂无收藏' : '暂无历史记录'));
      return;
    }

    items.forEach(entry => {
      const row = node('div', 'pe-lib-item');
      row.tabIndex = 0;
      const main = node('div', 'pe-lib-main');
      main.append(node('div', 'pe-lib-title', oneLine(entry.text).slice(0, 80) || '（无标题）'));
      main.append(node('div', 'pe-lib-sub',
        [formatDate(entry.ts), sceneLabel(entry.scene)].filter(Boolean).join(' · ')));
      row.append(main);

      const actions = node('div', 'pe-lib-actions');
      if (libMode === 'favs'){
        const remove = iconBtn('i-trash', '取消收藏');
        remove.addEventListener('click', ev => {
          ev.stopPropagation();
          toggleFavEntry(entry);
        });
        actions.append(remove);
      } else {
        const star = iconBtn('i-star', '收藏');
        const on = favs.some(x => keyOf(x) === keyOf(entry));
        if (on) star.classList.add('on');
        star.addEventListener('click', ev => {
          ev.stopPropagation();
          toggleFavEntry(entry);
        });
        actions.append(star);
      }
      row.append(actions);

      row.addEventListener('click', () => loadEntry(entry));
      row.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' || ev.key === ' '){
          ev.preventDefault();
          loadEntry(entry);
        }
      });
      libList.append(row);
    });
  }

  function closeLibrary(){
    libMode = null;
    lib.hidden = true;
    historyBtn.classList.remove('active');
    favsBtn.classList.remove('active');
  }

  function toggleLibrary(mode){
    if (libMode === mode){
      closeLibrary();
      return;
    }
    libMode = mode;
    lib.hidden = false;
    historyBtn.classList.toggle('active', mode === 'history');
    favsBtn.classList.toggle('active', mode === 'favs');
    renderLibrary();
  }

  historyBtn.addEventListener('click', () => toggleLibrary('history'));
  favsBtn.addEventListener('click', () => toggleLibrary('favs'));

  libClear.addEventListener('click', async () => {
    const ok = await App.confirmModal({
      title: '清空历史记录？',
      sub: '清空后无法恢复，收藏的内容不受影响。',
      okText: '清空',
      danger: true,
    });
    if (!ok) return;
    history = [];
    writeStore(LS_HISTORY, history);
    updateCounts();
    renderLibrary();
    showToast('历史记录已清空');
  });

  /* ---------- 场景模板 ---------- */
  function applyTemplate(key){
    const bag = isEN() ? TEMPLATES.en : TEMPLATES.zh;
    const tpl = bag[key];
    if (!tpl) return;
    const doApply = () => {
      input.value = tpl;
      sceneSel.value = key;
      updateInputState();
      input.focus();
      try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
    };
    const current = input.value.trim();
    if (current && current !== tpl.trim()){
      App.confirmModal({
        title: '替换当前内容？',
        sub: '应用场景模板会覆盖你已输入的文字。',
        okText: '替换',
      }).then(ok => { if (ok) doApply(); });
    } else {
      doApply();
    }
  }

  document.querySelectorAll('#peTemplates .pe-tpl').forEach(btn => {
    btn.addEventListener('click', () => applyTemplate(btn.dataset.template));
  });

  /* ---------- 角色自定义 ---------- */
  roleSel.addEventListener('change', () => {
    roleWrap.hidden = roleSel.value !== 'custom';
    if (!roleWrap.hidden) roleCustom.focus();
  });

  /* ---------- 增强 ---------- */
  async function enhance(){
    if (busy) return;
    const params = readParams();
    if (!params.text){
      showToast('请输入要增强的内容', 'err');
      input.focus();
      return;
    }
    if (params.text.length > MAX_INPUT){
      showToast('最多 2000 字，请精简后再试', 'err');
      return;
    }
    setBusy(true);
    try {
      const d = await API.post('/api/tools/prompt/enhance', params);
      const entry = entryFrom(d, params);
      last = entry;
      renderResult(entry);
      pushHistory(entry);
      setFavState(favs.some(x => keyOf(x) === keyOf(entry)));
      testWrap.hidden = true;
      if (d.aiError) showToast(d.aiError, 'err');
    } catch (e) {
      showToast(e.message || '增强失败，请重试', 'err');
    } finally {
      setBusy(false);
    }
  }

  enhanceBtn.addEventListener('click', enhance);
  input.addEventListener('input', updateInputState);
  input.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter'){
      e.preventDefault();
      enhance();
    }
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    out.replaceChildren();
    showEmpty();
    testWrap.hidden = true;
    updateInputState();
    input.focus();
    showToast('已清空');
  });

  /* ---------- 复制 ---------- */
  async function copyText(text){
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (_) { return false; }
    }
  }

  copyBtn.addEventListener('click', async () => {
    const text = last && last.prompt ? last.prompt : out.textContent;
    if (!text || !text.trim()) return showToast('还没有可复制的内容', 'err');
    const ok = await copyText(text);
    showToast(ok ? '已复制' : '复制失败，请手动选择', ok ? 'ok' : 'err');
  });

  favBtn.addEventListener('click', () => toggleFavEntry(last));

  /* ---------- AI 配置 / 润色 / 测试运行 ---------- */
  function applyAIState(){
    if (!ai.ready){
      aiSwitch.classList.remove('on');
      aiSwitch.setAttribute('aria-checked', 'false');
      aiSwitch.disabled = true;
      aiHint.textContent = '未配置 AI 接口，当前使用本地模板';
      aiSetup.hidden = false;
      testBtn.disabled = true;
      testHint.textContent = '配置 AI 后可测试';
    } else {
      aiSwitch.disabled = false;
      aiHint.textContent = '内容将发送到你配置的 AI 接口';
      aiSetup.hidden = true;
      testBtn.disabled = false;
      testHint.textContent = '发送到你的 AI 接口';
      aiSwitch.setAttribute('aria-checked',
        aiSwitch.classList.contains('on') ? 'true' : 'false');
    }
  }

  async function refreshAI(){
    if (ai.loading) return;
    ai.loading = true;
    try {
      const c = await API.get('/api/ai-config');
      ai.ready = !!(c && c.enabled && c.hasKey && c.endpoint && c.model);
      ai.loaded = true;
    } catch (e) {
      ai.ready = false;
      ai.loaded = true;
    } finally {
      ai.loading = false;
      applyAIState();
    }
  }

  aiSwitch.addEventListener('click', () => {
    if (!ai.ready){
      showToast('AI 未启用，请先在设置 → AI 智能中配置', 'err');
      aiSwitch.classList.remove('on');
      return;
    }
    aiSwitch.setAttribute('aria-checked',
      aiSwitch.classList.contains('on') ? 'true' : 'false');
  });

  aiSetup.addEventListener('click', () => {
    if (typeof openSettings === 'function') openSettings(true);
    const tab = document.querySelector('.set-item[data-set="ai"]');
    if (tab) tab.click();
  });

  testBtn.addEventListener('click', async () => {
    if (!last || !last.prompt) {
      showToast('请先增强提示词', 'err');
      return;
    }
    if (!ai.ready){
      showToast('AI 未启用，请先在设置 → AI 智能中配置', 'err');
      return;
    }
    testWrap.hidden = false;
    testBtn.disabled = true;
    testOut.replaceChildren(
      node('span', 'loading-dot'),
      document.createTextNode('正在测试运行…')
    );
    try {
      const d = await API.post('/api/tools/prompt/test', { prompt: last.prompt });
      testOut.textContent = d.reply || '（AI 没有返回内容）';
    } catch (e) {
      testOut.textContent = '';
      showToast(e.message || '测试运行失败', 'err');
    } finally {
      testBtn.disabled = false;
    }
  });

  testClose.addEventListener('click', () => { testWrap.hidden = true; });

  updateCounts();
  updateInputState();
  applyAIState();
  document.addEventListener('om-ai-config-changed', refreshAI);
  if (window.App && App.onEnter) App.onEnter(() => refreshAI());
  else if (API.getToken && API.getToken()) refreshAI();
})();
