/* ============================================================
   OmniDesk · 今日计划（知识库「每日计划」文件夹 · 按月归档）
   - 系统默认创建「每日计划」文件夹（内置不可删），每月一篇 .md 文档
   - 每天首次进入仪表盘自动在文档最上方生成今日空模板（含名言，未登录不生成）
   - 当月文档被删除后自动重建并写入今日模板
   - 仪表盘组件只编辑「今日」一节；日历点击日期弹出单日计划编辑
   - 导出 Plan.openDay(date) 供日历联动
   ============================================================ */
const Plan = (() => {
  const FOLDER = '每日计划';
  const src = $('#planSrc');
  const daySrc = $('#planDaySrc');
  let timer = null;
  let dayDate = '';
  let cache = { ym: '', id: null, content: '' };   // 当前加载的月份文档

  const pad = n => String(n).padStart(2, '0');
  const dateKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const ymOf = date => date.slice(0, 7);

  /* 原地实时渲染编辑器（隐藏 textarea 仍是数据源） */
  const live = src && window.LiveMD ? LiveMD.attach(src) : null;
  const dayLive = daySrc && window.LiveMD ? LiveMD.attach(daySrc) : null;

  /* ---------- 名言与每日模板 ---------- */
  const QUOTES = [
    '路漫漫其修远兮，吾将上下而求索。——屈原',
    '不积跬步，无以至千里。——荀子',
    '天行健，君子以自强不息。——《周易》',
    '业精于勤，荒于嬉；行成于思，毁于随。——韩愈',
    '宝剑锋从磨砺出，梅花香自苦寒来。——《警世贤文》',
    '世上无难事，只要肯登攀。——毛泽东',
    '千里之行，始于足下。——老子',
    '学而不思则罔，思而不学则殆。——孔子',
    '知之者不如好之者，好之者不如乐之者。——孔子',
    '三人行，必有我师焉。——孔子',
    '逝者如斯夫，不舍昼夜。——孔子',
    '海纳百川，有容乃大。——林则徐',
    '天下兴亡，匹夫有责。——顾炎武',
    '人生自古谁无死，留取丹心照汗青。——文天祥',
    '会当凌绝顶，一览众山小。——杜甫',
    '长风破浪会有时，直挂云帆济沧海。——李白',
    '山重水复疑无路，柳暗花明又一村。——陆游',
    '沉舟侧畔千帆过，病树前头万木春。——刘禹锡',
    '欲穷千里目，更上一层楼。——王之涣',
    '少壮不努力，老大徒伤悲。——《长歌行》',
    '读书破万卷，下笔如有神。——杜甫',
    '纸上得来终觉浅，绝知此事要躬行。——陆游',
    '问渠那得清如许，为有源头活水来。——朱熹',
    '莫等闲，白了少年头，空悲切。——岳飞',
    '盛年不重来，一日难再晨。及时当勉励，岁月不待人。——陶渊明',
    '生活不是等待风暴过去，而是学会在雨中跳舞。——佚名',
    '把简单的事做好就是不简单，把平凡的事做好就是不平凡。——张瑞敏',
    '成功的花，人们只惊慕她现时的明艳！然而当初她的芽儿，浸透了奋斗的泪泉。——冰心',
    '世界上最宽阔的是海洋，比海洋更宽阔的是天空，比天空更宽阔的是人的胸怀。——雨果',
    '人生重要的不是所站的位置，而是所朝的方向。——佚名',
    '日日行，不怕千万里；常常做，不怕千万事。——《格言联璧》',
    '苟日新，日日新，又日新。——《礼记》',
    '凡事预则立，不预则废。——《礼记》',
    '一寸光阴一寸金，寸金难买寸光阴。——《增广贤文》',
    '一年之计在于春，一日之计在于晨。——《增广贤文》',
    '有志者事竟成。——《后汉书》',
  ];
  /* 按日期确定性取名言：同一天内容固定 */
  const quoteOf = date => {
    let h = 0;
    for (const ch of date) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return QUOTES[h % QUOTES.length];
  };
  const templateOf = date => `# ${date}
> ${quoteOf(date)}

## 💰工作
- [ ] 

## 🏠生活
- [ ] 
`;

  /* ---------- 文档分节（按「# YYYY-MM-DD」一级标题拆分） ---------- */
  function parseSections(content){
    const secs = [];
    const re = /^# (\d{4}-\d{2}-\d{2})[ \t]*$/gm;
    let m, prev = null;
    while ((m = re.exec(content)) !== null){
      if (prev) prev.raw = content.slice(prev.start, m.index);
      prev = { date: m[1], start: m.index };
      secs.push(prev);
    }
    if (prev) prev.raw = content.slice(prev.start);
    return secs.map(s => ({
      date: s.date,
      body: (s.raw || '').replace(/\n+---\s*$/, '').replace(/\s+$/, ''),
    }));
  }
  const sectionOf = (content, date) =>
    (parseSections(content).find(s => s.date === date) || {}).body;

  /* 写入 / 替换某天一节，整体按日期倒序（最新在最上），节间以 --- 分隔 */
  function upsertDay(content, date, body){
    const secs = parseSections(content).filter(s => s.date !== date);
    secs.push({ date, body: (body || '').replace(/\s+$/, '') });
    secs.sort((a, b) => b.date.localeCompare(a.date));
    return secs.map(s => s.body).join('\n\n---\n') + '\n';
  }

  /* ---------- 月度文档定位（缺失自动创建） ---------- */
  /* 确保「每日计划」文件夹与指定月份文档存在；文档不存在时以 seedDate 模板新建，
     存在则拉取最新正文。返回缓存 { ym, id, content } */
  async function ensureDoc(ym, seedDate){
    const d = await API.get('/api/notes');
    if (!(d.folders || []).includes(FOLDER))
      await API.post('/api/notes/folders', { name: FOLDER }).catch(() => {});
    const title = `${FOLDER} · ${ym}`;
    let hit = (d.notes || []).find(n => n.title === title);
    if (!hit){
      hit = await API.post('/api/notes', { title, tags: [], folder: FOLDER });
      const seed = templateOf(seedDate || dateKey(new Date()));
      await API.put('/api/notes/' + hit.id, { content: seed });
      cache = { ym, id: hit.id, content: seed };
      return cache;
    }
    const note = await API.get('/api/notes/' + hit.id);
    cache = { ym, id: hit.id, content: note.content || '' };
    return cache;
  }

  /* ---------- 进度统计 ---------- */
  function itemsOf(text){
    return text.split('\n')
      .map(line => line.match(/^(\s*)- \[( |x|X)\]\s*(.*)$/))
      .filter(Boolean)
      .map(m => ({ done: m[2].toLowerCase() === 'x', text: m[3] }));
  }
  function render(){
    const list = itemsOf(src.value);
    const done = list.filter(i => i.done).length;
    $('#planStat').textContent = `${done} / ${list.length}`;
    const pct = list.length ? Math.round(done / list.length * 100) : 0;
    $('#planBar').style.width = pct + '%';
  }

  /* ---------- 仪表盘：今日一节 ---------- */
  /* 每天首次进入：当月文档置顶生成今日空模板（未登录不会执行到这里） */
  async function sync(){
    const today = dateKey(new Date());
    try {
      await ensureDoc(ymOf(today), today);
      if (!sectionOf(cache.content, today)){
        cache.content = upsertDay(cache.content, today, templateOf(today));
        await API.put('/api/notes/' + cache.id, { content: cache.content });
      }
      src.value = sectionOf(cache.content, today) || templateOf(today);
      if (live) live.refresh();
      render();
    } catch (e) { /* 未登录 / 网络异常：保持占位提示 */ }
  }

  async function save(){
    if (!cache.id) return;
    const today = dateKey(new Date());
    const body = src.value.replace(/\s+$/, '');
    let next = upsertDay(cache.content, today, body);
    try {
      await API.put('/api/notes/' + cache.id, { content: next });
      cache.content = next;
    } catch (e) {
      /* 文档可能在知识库里被删除：重建后再保存一次 */
      try {
        await ensureDoc(ymOf(today), today);
        next = upsertDay(cache.content, today, body);
        await API.put('/api/notes/' + cache.id, { content: next });
        cache.content = next;
      } catch (e2) { showToast(e2.message, 'err'); return; }
    }
    $('#planTime').textContent = '已保存 ' + new Date().toTimeString().slice(0, 5);
  }

  /* ---------- 单日计划弹窗（日历联动） ---------- */
  /* 点击任意日期打开当日计划编辑；未来月份自动新建月度文档并填充空模板 */
  async function openDay(date){
    dayDate = date;
    $('#planDayTitle').textContent = date + ' 计划';
    $('#planDaySub').textContent = date === dateKey(new Date())
      ? '今天的计划 · 与仪表盘「今日计划」同步'
      : '按月归档于知识库「每日计划」文件夹';
    App.openModal('planDayMask');
    try {
      await ensureDoc(ymOf(date), date);
      daySrc.value = sectionOf(cache.content, date) || templateOf(date);
      if (dayLive) dayLive.refresh();
    } catch (e) { showToast(e.message, 'err'); }
  }

  async function saveDay(){
    if (!dayDate || !cache.id) return;
    const next = upsertDay(cache.content, dayDate, daySrc.value.replace(/\s+$/, ''));
    try {
      await API.put('/api/notes/' + cache.id, { content: next });
      cache.content = next;
      App.closeModal('planDayMask');
      showToast('计划已保存');
      /* 保存的正是今天：同步仪表盘组件 */
      if (dayDate === dateKey(new Date())){
        src.value = sectionOf(cache.content, dayDate) || '';
        if (live) live.refresh();
        render();
      }
    } catch (e) { showToast(e.message, 'err'); }
  }

  /* ---------- 事件 ---------- */
  if (src){
    src.addEventListener('input', () => {
      render();
      clearTimeout(timer);
      timer = setTimeout(save, 800);
    });
    $('#planDayCancel').addEventListener('click', () => App.closeModal('planDayMask'));
    $('#planDaySave').addEventListener('click', saveDay);
    document.addEventListener('view-change', e => {
      if (e.detail === 'dashboard') sync();
    });
    App.onEnter(sync);
  }

  return { openDay, sync };
})();
/* const 顶层声明不挂 window，显式导出供 calendar.js 的 window.Plan 守卫使用 */
window.Plan = Plan;
