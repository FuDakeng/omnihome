/* ============================================================
   OmniDesk · 日历
   月视图渲染 · 点击日期打开当日计划编辑（与今日计划联动，见 Plan.openDay）。
   未来日期自动填充空模板，未来月份自动新建月度计划文档。
   ============================================================ */
(() => {
  let cursor = new Date();        // 当前展示的月份

  const pad = n => String(n).padStart(2, '0');
  const key = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  const DOW_SUN = ['日', '一', '二', '三', '四', '五', '六'];
  const DOW_MON = ['一', '二', '三', '四', '五', '六', '日'];
  const DOW_SUN_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DOW_MON_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const MONTH_EN = ['January', 'February', 'March', 'April', 'May', 'June',
                    'July', 'August', 'September', 'October', 'November', 'December'];

  function render(){
    const y = cursor.getFullYear(), m = cursor.getMonth();
    const sun = window.Locale && Locale.weekStart() === 'sun';
    const en = window.Locale && Locale.lang() === 'en';
    $('#calLabel').textContent = en ? `${MONTH_EN[m]} ${y}` : `${y} 年 ${m + 1} 月`;
    const first = new Date(y, m, 1);
    const startOffset = sun ? first.getDay() : (first.getDay() + 6) % 7;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const prevDays = new Date(y, m, 0).getDate();
    const todayKey = key(new Date());
    const heads = en ? (sun ? DOW_SUN_EN : DOW_MON_EN) : (sun ? DOW_SUN : DOW_MON);

    let html = heads.map(d => `<span class="cal-dow">${d}</span>`).join('');
    const cells = [];
    for (let i = startOffset - 1; i >= 0; i--) cells.push({ d: prevDays - i, other: true });
    for (let d = 1; d <= daysInMonth; d++) cells.push({ d, other: false, date: key(new Date(y, m, d)) });
    let n = 1;
    while (cells.length % 7 !== 0) cells.push({ d: n++, other: true });
    html += cells.map(c => {
      const cls = ['cal-day', 'num'];
      if (c.other) cls.push('other');
      if (c.date === todayKey) cls.push('today');
      return `<span class="${cls.join(' ')}" ${c.date ? `data-cal-date="${c.date}" title="查看 / 编辑当日计划"` : ''}>${c.d}</span>`;
    }).join('');
    $('#calGrid').innerHTML = html;
  }

  $('#calPrev').addEventListener('click', () => { cursor = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1); render(); });
  $('#calNext').addEventListener('click', () => { cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1); render(); });

  /* 点击日期 → 打开对应日期的计划编辑弹窗 */
  $('#calGrid').addEventListener('click', e => {
    const cell = e.target.closest('[data-cal-date]');
    if (!cell || !window.Plan) return;
    Plan.openDay(cell.dataset.calDate);
  });

  App.onEnter(render);
  document.addEventListener('om-locale', render);
})();
