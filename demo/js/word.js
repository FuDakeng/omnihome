/* ============================================================
   OmniDesk · 每日单词
   随机推荐（不按日期固定），已加入生词本的单词自动跳过。
   收藏写入知识库常驻笔记「生词本」（含中文释义与例句）。
   ============================================================ */
(() => {
  let current = null;
  let wordbook = JSON.parse(localStorage.getItem('om_wordbook') || '[]');
  let wordbookId = null;   // 常驻笔记「生词本」的 id
  let wbWords = new Set(); // 生词本内已有单词（推荐时排除）

  function render(w){
    current = w;
    $('#wordText').textContent = w.word;
    $('#wordPhon').textContent = w.phon;
    $('#wordPos').textContent = w.pos;
    $('#wordSense').innerHTML = `<b>${App.esc(w.pos)}</b> ${App.esc(w.def)}`;
    $('#wordTrans').textContent = w.trans;
    $('#wordExEn').textContent = '“' + w.example + '”';
  }

  async function load(shuffle){
    const btn = $('#wordShuffle');
    try {
      /* 加载态：避免连点重复请求，也让用户看到按钮在响应 */
      if (shuffle && btn){ btn.disabled = true; btn.classList.add('is-loading'); }
      /* 始终随机推荐，并把生词本单词传给后端排除 */
      const excl = [...wbWords].join(',');
      let w = await API.get('/api/dict/word?shuffle=true' +
        (excl ? '&exclude=' + encodeURIComponent(excl) : ''));
      /* 随机撞到当前词时再换一个，保证点击必有变化 */
      if (current && w && w.word === current.word){
        w = await API.get('/api/dict/word?shuffle=true' +
          (excl ? '&exclude=' + encodeURIComponent(excl) : ''));
      }
      render(w);
    } catch (e) {
      /* 不再静默吞掉：手动点击时提示失败原因（如生词本已收满全部单词） */
      if (shuffle) showToast('换词失败：' + e.message, 'err');
    } finally {
      if (shuffle && btn){ btn.disabled = false; btn.classList.remove('is-loading'); }
    }
  }

  $('#wordSpeak').addEventListener('click', () => {
    if (!current) return;
    const u = new SpeechSynthesisUtterance(current.word + '. ' + current.example);
    u.lang = 'en-US'; u.rate = 0.9;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });

  $('#wordShuffle').addEventListener('click', () => load(true));

  /* ---------- 生词本（知识库常驻笔记） ---------- */
  /* 生词条目：含音标 / 词性 / 释义 / 中文翻译与例句 */
  function wordLine(w){
    let line = `- **${w.word}** ${w.phon || ''} ${w.pos || ''} ${w.def || ''}`;
    if (w.trans) line += ` · ${w.trans}`;
    line += ` · 收藏于 ${new Date().toLocaleDateString('zh-CN')}`;
    if (w.example) line += `\n  - 例句：${w.example}`;
    return line + '\n';
  }

  /* 从生词本正文解析已有单词（推荐时排除） */
  function parseWb(content){
    wbWords = new Set([...content.matchAll(/\*\*([^*]+)\*\*/g)]
      .map(m => m[1].trim().toLowerCase()));
  }

  /* 加载生词本正文并同步排除集 */
  async function syncWordbook(){
    try {
      if (!wordbookId && !await ensureWordbook()) return;
      const content = await readWordbook();
      if (content != null) parseWb(content);
    } catch (e) { /* 不影响主流程 */ }
  }

  async function ensureWordbook(){
    const d = await API.get('/api/notes');
    const hit = (d.notes || []).find(n => n.title === '生词本');
    if (!hit) return null;
    wordbookId = hit.id;
    return wordbookId;
  }

  /* 读写生词本：id 失效（知识库里删除重建过）时重新定位后重试一次 */
  async function readWordbook(){
    try {
      const { content } = await API.get('/api/notes/' + wordbookId);
      return content;
    } catch (e) {
      if (!await ensureWordbook()) return null;
      const { content } = await API.get('/api/notes/' + wordbookId);
      return content;
    }
  }

  async function writeWordbook(out){
    try {
      await API.put('/api/notes/' + wordbookId, { content: out, title: '生词本' });
    } catch (e) {
      if (!await ensureWordbook()) return;
      await API.put('/api/notes/' + wordbookId, { content: out, title: '生词本' });
    }
  }

  /* 旧版 localStorage 收藏迁移进常驻笔记（幂等，重复词自动跳过） */
  async function migrate(){
    if (!wordbook.length) return;
    try {
      if (!wordbookId && !await ensureWordbook()) return;
      let out = await readWordbook();
      if (out == null) return;
      let added = 0;
      for (const w of wordbook){
        if (out.includes('**' + w.word + '**')) continue;
        out += wordLine(w);
        added++;
      }
      if (added) await writeWordbook(out);
    } catch (e) { /* 不影响主流程 */ }
  }

  $('#wordStar').addEventListener('click', async () => {
    if (!current) return;
    if (!wordbook.find(w => w.word === current.word)){
      wordbook.push(current);
      localStorage.setItem('om_wordbook', JSON.stringify(wordbook));
    }
    wbWords.add((current.word || '').toLowerCase());   // 后续推荐不再出现
    /* 同步写入知识库「生词本」笔记 */
    try {
      if (!wordbookId) await ensureWordbook();
      if (wordbookId){
        const content = await readWordbook();
        if (content != null && !content.includes('**' + current.word + '**')){
          await writeWordbook(content + wordLine(current));
        }
      }
    } catch (e) { /* localStorage 已兜底 */ }
    showToast(`已加入生词本（共 ${wordbook.length} 个），不再推荐该单词`);
  });

  /* 顶栏日期芯片 */
  const chip = $('#wordDateChip');
  if (chip){
    const d = new Date();
    chip.textContent = `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  }

  App.onEnter(async () => {
    migrate();
    await syncWordbook();   // 先拿到生词本排除集，再推单词
    load(false);
  });
})();
