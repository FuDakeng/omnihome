/* ============================================================
   OmniDesk · 日历
   月视图渲染 · 点击日期打开当日计划编辑（与今日计划联动，见 Plan.openDay）。
   未来日期自动填充空模板，未来月份自动新建月度计划文档。
   ============================================================ */
(() => {
  let cursor = new Date();        // 当前展示的月份

  const pad = n => String(n).padStart(2, '0');
  const key = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  function render(){
    const y = cursor.getFullYear(), m = cursor.getMonth();
    $('#calLabel').textContent = `${y} 年 ${m + 1} 月`;
    const first = new Date(y, m, 1);
    const startOffset = (first.getDay() + 6) % 7;      // 周一为一周起始
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const prevDays = new Date(y, m, 0).getDate();
    const todayKey = key(new Date());

    let html = '<span class="cal-dow">一</span><span class="cal-dow">二</span><span class="cal-dow">三</span><span class="cal-dow">四</span><span class="cal-dow">五</span><span class="cal-dow">六</span><span class="cal-dow">日</span>';
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
})();
