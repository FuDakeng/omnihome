/* OmniHome · Mermaid 图表
   本地 vendor（js/vendor/mermaid.min.js），按需加载，离线可用。
   securityLevel=strict：图表里的 HTML 标签会被丢掉，避免笔记内容注入脚本。
   配色走 theme=base，跟日间 / 夜间和品牌色走；画完再把文字对比度和盒子补正。 */

const svgCache = new Map();
let loading = null;
let bootedKey = '';
let seq = 0;
let themeWatch = false;

const GANTT_TAGS = new Set(['done', 'active', 'crit', 'milestone', 'vert']);
const GANTT_DIRECTIVE = /^(title|dateformat|axisformat|includes|excludes|todaymarker|weekday|weekend|tickinterval|inclusiveenddates|topaxis|section|gantt)$/i;
const LIGHT_INK = '#edf0f7';
const DARK_INK = '#171c2b';

export function isMermaidLang(lang){
  return /^mermaid$/i.test(String(lang || '').trim());
}

export function mermaidThemeName(){
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  let hue = '';
  try { hue = getComputedStyle(document.documentElement).getPropertyValue('--om-hue').trim(); }
  catch (_) {}
  return (light ? 'light' : 'dark') + (hue ? ':' + hue : '');
}

function scriptVer(){
  try {
    const cur = document.querySelector('script[src*="boot.js"]');
    if (!cur) return '';
    return new URL(cur.getAttribute('src'), location.href).search || '';
  } catch (_) { return ''; }
}

function loadMermaid(){
  if (window.mermaid && typeof window.mermaid.render === 'function')
    return Promise.resolve(window.mermaid);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('./vendor/mermaid.min.js', import.meta.url).href + scriptVer();
    s.async = true;
    s.onload = () => {
      if (window.mermaid && typeof window.mermaid.render === 'function') resolve(window.mermaid);
      else reject(new Error('Mermaid 未就绪'));
    };
    s.onerror = () => reject(new Error('Mermaid 脚本加载失败'));
    document.head.appendChild(s);
  }).catch(err => { loading = null; throw err; });
  return loading;
}

function cacheSet(key, svg){
  if (svgCache.size > 40) svgCache.delete(svgCache.keys().next().value);
  svgCache.set(key, svg);
}

/* 主题样式都写在 #图表id 下面。去掉 id 之后这些规则全部失效，
   图形就退回写死的填充色。每次插入换一个新 id，避免同一页两张图撞 id。 */
function uniquifySvg(svgText){
  const m = String(svgText).match(/\bid="([^"]+)"/);
  if (!m) return svgText;
  const nid = 'omMmd' + (++seq);
  if (m[1] === nid) return svgText;
  return svgText.split(m[1]).join(nid);
}

function fontStack(){
  try {
    const f = getComputedStyle(document.body).fontFamily;
    if (f) return f;
  } catch (_) {}
  return 'var(--om-font), "PingFang SC", "Noto Sans SC", sans-serif';
}

function hsl(h, s, l){
  const hue = ((h % 360) + 360) % 360;
  return 'hsl(' + hue + ' ' + s + '% ' + l + '%)';
}

/* 品牌色相上转一圈，流程图节点用浅底，饼图 / 思维导图用能压住白字的色块。 */
function themeVars(){
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  let hue = 243;
  try {
    const n = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--om-hue'));
    if (!Number.isNaN(n)) hue = n;
  } catch (_) {}
  const text = light ? DARK_INK : LIGHT_INK;
  const muted = light ? '#5c6579' : '#9aa3b8';
  const surface = light ? '#ffffff' : '#141824';
  const soft = hsl(hue, light ? 62 : 38, light ? 94 : 28);
  const line = light ? hsl(hue, 28, 42) : hsl(hue, 24, 72);
  const border = hsl(hue, light ? 42 : 36, light ? 62 : 64);
  const chip = [0, 28, 168, 198, -32, 128, 88, 212, 148, -64, 248, 108];
  const pie = chip.map(dh => hsl(hue + dh, light ? 58 : 50, light ? 38 : 40));
  const mind = chip.map(dh => hsl(hue + dh, light ? 52 : 42, light ? 90 : 34));
  const mindInk = light ? DARK_INK : LIGHT_INK;
  const noteBkg = light ? '#fff6dc' : '#3a321c';
  const noteText = light ? '#3d3420' : '#f6e7b8';
  const vars = {
    darkMode: !light,
    background: 'transparent',
    fontFamily: fontStack(),
    fontSize: '14px',
    textColor: text,
    titleColor: text,
    primaryTextColor: text,
    secondaryTextColor: text,
    tertiaryTextColor: text,
    nodeTextColor: text,
    primaryColor: soft,
    secondaryColor: light ? hsl(hue, 40, 96) : hsl(hue, 22, 22),
    tertiaryColor: light ? '#eef1f8' : '#232b3e',
    primaryBorderColor: border,
    secondaryBorderColor: border,
    tertiaryBorderColor: border,
    lineColor: muted,
    mainBkg: soft,
    nodeBkg: soft,
    nodeBorder: border,
    clusterBkg: light ? '#f4f6fb' : 'rgba(255,255,255,0.04)',
    clusterBorder: border,
    edgeLabelBackground: surface,
    labelBackground: surface,
    actorBkg: soft,
    actorBorder: border,
    actorTextColor: text,
    actorLineColor: muted,
    signalColor: muted,
    signalTextColor: text,
    labelBoxBkgColor: soft,
    labelBoxBorderColor: border,
    labelTextColor: text,
    loopTextColor: text,
    noteBkgColor: noteBkg,
    noteTextColor: noteText,
    noteBorderColor: light ? '#e4c56a' : '#a88848',
    activationBkgColor: light ? '#e6ebf8' : '#2a334c',
    activationBorderColor: border,
    sequenceNumberColor: light ? '#ffffff' : '#141824',
    sectionBkgColor: light ? '#eef1f8' : '#1c2436',
    altSectionBkgColor: light ? '#e4e9f4' : '#263044',
    sectionBkgColor2: light ? '#eef1f8' : '#1c2436',
    taskBkgColor: hsl(hue, light ? 62 : 52, light ? 48 : 58),
    taskBorderColor: border,
    taskTextColor: '#ffffff',
    taskTextLightColor: '#ffffff',
    taskTextDarkColor: text,
    taskTextOutsideColor: text,
    taskTextClickableColor: border,
    activeTaskBkgColor: hsl(hue, 70, light ? 42 : 60),
    activeTaskBorderColor: border,
    doneTaskBkgColor: light ? '#b7ebc9' : '#1d6b48',
    doneTaskBorderColor: light ? '#1f8a4c' : '#3dbe7a',
    critBkgColor: light ? '#ffd0d8' : '#7a3044',
    critBorderColor: '#f43f5e',
    todayLineColor: border,
    gridColor: light ? '#e4e8f1' : 'rgba(255,255,255,0.1)',
    tickColor: muted,
    branchLabelColor: '#f4f6fb',
    commitLabelColor: text,
    commitLabelBackground: 'transparent',
    tagLabelColor: text,
    tagLabelBackground: soft,
    tagLabelBorder: border,
    pieTitleTextColor: text,
    pieSectionTextColor: '#ffffff',
    pieLegendTextColor: text,
    pieStrokeColor: surface,
    pieOuterStrokeColor: surface,
    quadrant1Fill: light ? 'hsl(158 48% 90%)' : 'hsl(158 32% 24%)',
    quadrant2Fill: light ? 'hsl(38 78% 90%)' : 'hsl(38 36% 24%)',
    quadrant3Fill: light ? 'hsl(350 70% 93%)' : 'hsl(350 28% 24%)',
    quadrant4Fill: light ? hsl(hue, 55, 93) : hsl(hue, 32, 26),
    quadrant1TextFill: text,
    quadrant2TextFill: text,
    quadrant3TextFill: text,
    quadrant4TextFill: text,
    quadrantPointFill: hsl(hue, 72, light ? 46 : 64),
    quadrantPointTextFill: text,
    quadrantXAxisTextFill: muted,
    quadrantYAxisTextFill: muted,
    quadrantTitleFill: text,
    quadrantInternalBorderStrokeFill: light ? '#d5dbe8' : 'rgba(255,255,255,0.14)',
    quadrantExternalBorderStrokeFill: border,
  };
  for (let i = 0; i < 12; i++){
    vars['pie' + (i + 1)] = pie[i];
    vars['cScale' + i] = mind[i];
    vars['cScaleLabel' + i] = mindInk;
    if (i < 8){
      vars['git' + i] = hsl(hue + chip[i], 52, light ? 36 : 42);
      vars['gitBranchLabel' + i] = '#f4f6fb';
    }
  }
  vars.fillType0 = pie[0];
  vars.fillType1 = pie[1];
  vars.fillType2 = pie[2];
  vars.fillType3 = pie[3];
  vars.fillType4 = pie[4];
  vars.fillType5 = pie[5];
  vars.fillType6 = pie[6];
  vars.fillType7 = pie[7];
  /* 夜间主题会把主分支标签回落到黑色，这里显式盖掉。 */
  vars.mainContrastColor = text;
  return vars;
}

function boot(mermaid, key){
  if (bootedKey === key) return;
  const text = document.documentElement.getAttribute('data-theme') === 'light' ? DARK_INK : LIGHT_INK;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: themeVars(),
    fontFamily: fontStack(),
    fontSize: 14,
    logLevel: 'fatal',
    htmlLabels: true,
    flowchart: {
      htmlLabels: true,
      useMaxWidth: true,
      padding: 16,
      nodeSpacing: 42,
      rankSpacing: 48,
      diagramPadding: 8,
      wrappingWidth: 240,
      curve: 'basis',
    },
    sequence: {
      useMaxWidth: true,
      actorMargin: 60,
      messageMargin: 38,
      boxMargin: 10,
      boxTextMargin: 8,
      noteMargin: 12,
      mirrorActors: true,
    },
    gantt: {
      useMaxWidth: true,
      barHeight: 26,
      barGap: 8,
      topPadding: 50,
      leftPadding: 132,
      fontSize: 13,
      sectionFontSize: 13,
    },
    themeCSS: 'text.actor{fill:' + text + ' !important;}',
  });
  bootedKey = key;
  svgCache.clear();
}

function diagramKind(src){
  const line = String(src || '').split('\n').map(l => l.trim()).find(l => l && !l.startsWith('%%'));
  return line ? line.split(/\s+/)[0].toLowerCase() : '';
}

function quoteLabel(raw){
  const t = String(raw || '').trim();
  if (!t) return t;
  if (t.startsWith('"') && t.endsWith('"')) return t;
  if (/^[A-Za-z0-9 !"#$%&'*+,\-.`?\\_/:;]+$/.test(t)) return t;
  return '"' + t.replace(/"/g, "'") + '"';
}

/* 象限图词法只认 ASCII。中文轴名、象限名要加引号，否则整图解析失败。 */
function prepareQuadrant(src){
  return src.split('\n').map(line => {
    const axis = line.match(/^(\s*)(x-axis|y-axis)\s+(.*)$/i);
    if (axis){
      const bits = axis[3].split(/\s*--+>\s*/);
      if (bits.length >= 2)
        return axis[1] + axis[2] + ' ' + quoteLabel(bits[0]) + ' --> ' + quoteLabel(bits.slice(1).join(' --> '));
    }
    const quad = line.match(/^(\s*)(quadrant-[1-4])\s+(.*)$/i);
    if (quad) return quad[1] + quad[2] + ' ' + quoteLabel(quad[3]);
    const point = line.match(/^(\s*)(.+?)(\s*:\s*\[.*)$/);
    if (point && !/^(title|x-axis|y-axis|quadrant-[1-4]|classdef)\b/i.test(point[2].trim()))
      return point[1] + quoteLabel(point[2]) + point[3];
    return line;
  }).join('\n');
}

function asciiId(s){
  return /^[\w-]+$/.test(s);
}

/* 甘特图的 after / until 只匹配 ASCII 任务 id。
   「系统设计 :a2, after 需求评审, 7d」会被当成日期然后抛 Invalid date。
   给没有 id 的任务补一个 ASCII id，再把中文任务名换成这个 id。 */
function prepareGantt(src){
  const lines = src.split('\n');
  const tasks = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('%%')) return;
    const m = line.match(/^(\s*)(.*?)\s*:\s*(.*)$/);
    if (!m) return;
    const name = m[2].trim();
    if (!name || GANTT_DIRECTIVE.test(name)) return;
    const parts = m[3].split(',').map(s => s.trim()).filter(s => s.length);
    const tags = [];
    while (parts.length && GANTT_TAGS.has(parts[0].toLowerCase())) tags.push(parts.shift());
    tasks.push({ index, indent: m[1], name, tags, parts });
  });
  const used = new Set();
  tasks.forEach(t => {
    if (t.parts.length >= 3 && asciiId(t.parts[0])) used.add(t.parts[0]);
  });
  let n = 0;
  const alloc = () => {
    let id;
    do { id = 'omgt' + (++n); } while (used.has(id));
    used.add(id);
    return id;
  };
  const nameToId = new Map();
  tasks.forEach(t => {
    let id = t.parts.length >= 3 && asciiId(t.parts[0]) ? t.parts[0] : '';
    if (!id) id = alloc();
    t.id = id;
    if (!nameToId.has(t.name)) nameToId.set(t.name, id);
  });
  tasks.forEach(t => { nameToId.set(t.id, t.id); });
  const rewriteDep = field => {
    const m = String(field).match(/^(after|until)\s+(.+)$/i);
    if (!m) return field;
    let rest = m[2].trim();
    if (nameToId.has(rest)) return m[1] + ' ' + nameToId.get(rest);
    const names = [...nameToId.keys()].filter(k => k && !asciiId(k)).sort((a, b) => b.length - a.length);
    names.forEach(name => {
      if (rest.includes(name)) rest = rest.split(name).join(nameToId.get(name));
    });
    rest = rest.split(/\s+/).map(tok => nameToId.get(tok) || tok).join(' ');
    return m[1] + ' ' + rest;
  };
  tasks.forEach((t, ord) => {
    t.parts = t.parts.map(rewriteDep);
    if (t.parts.length >= 3){
      if (!asciiId(t.parts[0])) t.parts[0] = t.id;
    } else if (t.parts.length === 2){
      t.parts.unshift(t.id);
    } else if (t.parts.length === 1){
      const prev = ord > 0 ? tasks[ord - 1].id : '';
      if (prev) t.parts = [t.id, 'after ' + prev, t.parts[0]];
    }
    lines[t.index] = t.indent + t.name + ' :' + [...t.tags, ...t.parts].join(', ');
  });
  return lines.join('\n');
}

export function prepareDiagram(src){
  const text = String(src || '').replace(/\r\n/g, '\n');
  const kind = diagramKind(text);
  if (kind === 'gantt') return prepareGantt(text);
  if (kind === 'quadrantchart') return prepareQuadrant(text);
  return text;
}

function chartEl(host){
  return host.querySelector('.lm-mermaid-chart') || host;
}
function msgEl(host){
  return host.querySelector('.lm-mermaid-msg');
}

export function hostShowsChart(host){
  if (!host || host.hidden || host.classList.contains('is-folded')) return false;
  const fence = host.closest('.lm-fence-open');
  if (fence) return fence.classList.contains('is-mermaid-chart');
  const pre = host.closest('pre');
  if (pre) return pre.classList.contains('is-mermaid-chart');
  return true;
}

function shortErr(e){
  const m = String((e && (e.str || e.message)) || e || '语法错误').split('\n')[0].trim();
  return m.length > 180 ? m.slice(0, 180) + '…' : m;
}

function cleanup(id, host){
  document.querySelectorAll('[id="' + id + '"], [id="d' + id + '"]').forEach(n => {
    if (host && host.contains(n)) return;
    n.remove();
  });
}

function showMsg(host, text){
  const chart = chartEl(host);
  const msg = msgEl(host);
  if (chart && chart !== host) chart.innerHTML = '';
  if (msg){
    msg.hidden = false;
    msg.textContent = text;
  }
}

let renderChain = Promise.resolve();
function enqueueRender(fn){
  const run = renderChain.then(fn, fn);
  renderChain = run.then(() => {}, () => {});
  return run;
}
function withTimeout(p, ms){
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('渲染超时')), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

function transparent(c){
  if (!c || c === 'none' || c === 'transparent') return true;
  const m = String(c).match(/[\d.]+/g);
  return !!(m && m.length >= 4 && Number(m[3]) === 0);
}
function luminance(c){
  const raw = String(c || '').trim();
  let rgb = null;
  if (raw.startsWith('#')){
    let h = raw.slice(1);
    if (h.length === 3) h = h.split('').map(ch => ch + ch).join('');
    if (h.length >= 6) rgb = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  } else {
    const m = raw.match(/[\d.]+/g);
    if (m && m.length >= 3) rgb = m.slice(0, 3).map(Number);
  }
  if (!rgb || rgb.some(n => Number.isNaN(n))) return 0;
  const lin = rgb.map(n => {
    let v = n > 1 ? n / 255 : n;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrast(a, b){
  const L1 = luminance(a), L2 = luminance(b);
  const hi = Math.max(L1, L2), lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}
function pickInk(bg){
  return contrast(LIGHT_INK, bg) >= contrast(DARK_INK, bg) ? LIGHT_INK : DARK_INK;
}
function inkOf(el){
  const cs = getComputedStyle(el);
  const tag = el.tagName.toLowerCase();
  if (tag === 'text' || tag === 'tspan')
    return cs.fill && cs.fill !== 'none' ? cs.fill : cs.color;
  return cs.color;
}
function boxOf(el){
  try { return el.getBoundingClientRect(); }
  catch (_) { return null; }
}

function chipFill(el){
  const r = boxOf(el);
  if (!r || r.width < 1) return null;
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  let best = null;
  let bestArea = Infinity;
  let g = el.parentElement;
  while (g && g.tagName && g.tagName.toLowerCase() !== 'svg'){
    for (const s of g.children){
      const tag = s.tagName && s.tagName.toLowerCase();
      if (tag !== 'rect' && tag !== 'polygon' && tag !== 'circle' && tag !== 'ellipse' && tag !== 'path') continue;
      const sr = boxOf(s);
      if (!sr || sr.width < 8 || sr.height < 8) continue;
      if (cx < sr.left - 1 || cx > sr.right + 1 || cy < sr.top - 1 || cy > sr.bottom + 1) continue;
      const fill = shapeFill(s);
      if (!fill) continue;
      const area = sr.width * sr.height;
      if (area < 520) continue;
      if (area < bestArea){ best = fill; bestArea = area; }
    }
    g = g.parentElement;
  }
  return best;
}
function shapeFill(el){
  const tag = (el.tagName || '').toLowerCase();
  if (tag !== 'rect' && tag !== 'circle' && tag !== 'ellipse' && tag !== 'polygon' && tag !== 'path') return null;
  const attr = (el.getAttribute('fill') || '').trim();
  if (attr === 'none') return null;
  const r = boxOf(el);
  if (!r || r.width < 12 || r.height < 12) return null;
  if (tag === 'path'){
    const cls = ((el.getAttribute('class') || '') + ' ' + ((el.parentElement && el.parentElement.getAttribute('class')) || ''));
    if (!/section|node|mindmap|cluster|label|slice|pie/.test(cls)) return null;
  }
  const fill = getComputedStyle(el).fill;
  if (!fill || fill === 'none' || transparent(fill)) return null;
  return fill;
}
function hostBackground(host){
  let n = host;
  while (n && n !== document.documentElement){
    const bg = getComputedStyle(n).backgroundColor;
    if (!transparent(bg)) return bg;
    n = n.parentElement;
  }
  return null;
}
function backdrop(el, host){
  const r = boxOf(el);
  if (!r || r.width < 0.5 || r.height < 0.5) return hostBackground(host);
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  if (x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight){
    const stack = document.elementsFromPoint(x, y) || [];
    for (const n of stack){
      if (n === el || el.contains(n)) continue;
      const tag = (n.tagName || '').toLowerCase();
      if (tag === 'text' || tag === 'tspan' || tag === 'span' || tag === 'div' || tag === 'p' || tag === 'foreignobject' || tag === 'g' || tag === 'svg' || tag === 'line' || tag === 'polyline') continue;
      const fill = shapeFill(n);
      if (fill){
        const br = boxOf(n);
        if (br && br.width * br.height >= 520) return fill;
      }
      const bg = getComputedStyle(n).backgroundColor;
      if (!transparent(bg)) return bg;
    }
  }
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  let p = el.parentElement;
  while (p && p !== host && p !== document.body){
    let top = null;
    for (const s of p.children){
      const sr = boxOf(s);
      if (!sr || sr.width < 10 || sr.height < 10) continue;
      if (cx < sr.left - 1 || cx > sr.right + 1 || cy < sr.top - 1 || cy > sr.bottom + 1) continue;
      const fill = shapeFill(s);
      if (!fill) continue;
      top = fill;
    }
    if (top) return top;
    p = p.parentElement;
  }
  return hostBackground(host);
}

function paintInk(el, ink){
  const tag = el.tagName.toLowerCase();
  if (tag === 'text' || tag === 'tspan'){
    el.style.setProperty('fill', ink, 'important');
    el.querySelectorAll('tspan').forEach(t => t.style.setProperty('fill', ink, 'important'));
  } else {
    el.style.setProperty('color', ink, 'important');
  }
}

function numAttr(el, name){
  const n = parseFloat(el.getAttribute(name));
  return Number.isFinite(n) ? n : 0;
}

/* 文字比 foreignObject 宽或高时，盒子和背后的图形一起撑开，避免裁切。 */
function relaxLabels(svg){
  svg.querySelectorAll('foreignObject').forEach(fo => {
    const label = fo.querySelector('.nodeLabel, .edgeLabel, span');
    if (!label) return;
    fo.querySelectorAll('div, span').forEach(n => { n.style.overflow = 'visible'; });
    label.style.lineHeight = '1.4';
    const sw = Math.ceil(label.scrollWidth);
    const sh = Math.ceil(label.scrollHeight);
    const w = numAttr(fo, 'width');
    const h = numAttr(fo, 'height');
    if (w < 1 || h < 1) return;
    const nw = Math.max(w, sw + 6);
    const nh = Math.max(h, sh + 4);
    if (nw - w < 0.5 && nh - h < 0.5) return;
    fo.setAttribute('x', String(numAttr(fo, 'x') - (nw - w) / 2));
    fo.setAttribute('y', String(numAttr(fo, 'y') - (nh - h) / 2));
    fo.setAttribute('width', String(nw));
    fo.setAttribute('height', String(nh));
    fo.setAttribute('overflow', 'visible');
  });
  svg.querySelectorAll('.nodeLabel, .edgeLabel, text').forEach(el => {
    const lr = boxOf(el);
    if (!lr || lr.width < 1 || lr.height < 1) return;
    const shape = hostShape(el);
    if (!shape) return;
    const sr = boxOf(shape);
    if (!sr || sr.width < 8 || sr.height < 8) return;
    const cx = lr.left + lr.width / 2;
    const cy = lr.top + lr.height / 2;
    if (cx < sr.left || cx > sr.right || cy < sr.top || cy > sr.bottom) return;
    const pad = 5;
    const needL = Math.min(24, Math.max(0, sr.left + pad - lr.left));
    const needR = Math.min(24, Math.max(0, lr.right - (sr.right - pad)));
    const needT = Math.min(18, Math.max(0, sr.top + pad - lr.top));
    const needB = Math.min(18, Math.max(0, lr.bottom - (sr.bottom - pad)));
    if (needL + needR + needT + needB < 1) return;
    growShape(shape, sr, needL, needR, needT, needB);
  });
}

function hostShape(el){
  let p = el.parentElement;
  while (p && p.tagName && p.tagName.toLowerCase() !== 'svg'){
    for (const s of p.children){
      const tag = s.tagName && s.tagName.toLowerCase();
      if (tag === 'rect' || tag === 'polygon' || tag === 'circle' || tag === 'ellipse') return s;
    }
    p = p.parentElement;
  }
  return null;
}

function growShape(shape, sr, needL, needR, needT, needB){
  const tag = shape.tagName.toLowerCase();
  if (tag === 'rect'){
    const w = numAttr(shape, 'width');
    const h = numAttr(shape, 'height');
    if (w < 1 || h < 1 || sr.width < 1 || sr.height < 1) return;
    const sx = w / sr.width;
    const sy = h / sr.height;
    shape.setAttribute('x', String(numAttr(shape, 'x') - needL * sx));
    shape.setAttribute('y', String(numAttr(shape, 'y') - needT * sy));
    shape.setAttribute('width', String(w + (needL + needR) * sx));
    shape.setAttribute('height', String(h + (needT + needB) * sy));
    return;
  }
  const grow = Math.max(
    sr.width > 1 ? (sr.width / 2 + Math.max(needL, needR)) / (sr.width / 2) : 1,
    sr.height > 1 ? (sr.height / 2 + Math.max(needT, needB)) / (sr.height / 2) : 1
  );
  if (grow <= 1.01) return;
  const factor = Math.min(grow, 1.45);
  if (tag === 'circle' || tag === 'ellipse'){
    const rx = numAttr(shape, tag === 'circle' ? 'r' : 'rx') || sr.width / 2;
    const ry = numAttr(shape, tag === 'circle' ? 'r' : 'ry') || sr.height / 2;
    if (tag === 'circle') shape.setAttribute('r', String(rx * factor));
    else {
      shape.setAttribute('rx', String(rx * factor));
      shape.setAttribute('ry', String(ry * factor));
    }
    return;
  }
  if (tag !== 'polygon') return;
  const raw = (shape.getAttribute('points') || '').trim();
  if (!raw) return;
  let pts;
  if (raw.includes(','))
    pts = raw.split(/\s+/).map(p => p.split(',').map(Number)).filter(p => p.length >= 2 && p.every(n => !Number.isNaN(n)));
  else {
    const nums = raw.split(/[\s,]+/).map(Number);
    pts = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  }
  if (pts.length < 3) return;
  let cx = 0, cy = 0;
  pts.forEach(p => { cx += p[0]; cy += p[1]; });
  cx /= pts.length; cy /= pts.length;
  shape.setAttribute('points', pts.map(p => (cx + (p[0] - cx) * factor) + ',' + (cy + (p[1] - cy) * factor)).join(' '));
}

function expandViewBox(svg){
  const vb = svg.viewBox && svg.viewBox.baseVal;
  if (!vb || vb.width < 1 || vb.height < 1) return;
  const svgRect = boxOf(svg);
  let x1 = vb.x, y1 = vb.y, x2 = vb.x + vb.width, y2 = vb.y + vb.height;
  if (svgRect && svgRect.width > 1 && svgRect.height > 1){
    const sx = vb.width / svgRect.width;
    const sy = vb.height / svgRect.height;
    const cap = 140;
    svg.querySelectorAll('text, tspan, .nodeLabel, .edgeLabel, rect, circle, ellipse, polygon, path').forEach(el => {
      const r = boxOf(el);
      if (!r || (r.width < 0.5 && r.height < 0.5)) return;
      const ux1 = vb.x + (r.left - svgRect.left) * sx;
      const uy1 = vb.y + (r.top - svgRect.top) * sy;
      const ux2 = vb.x + (r.right - svgRect.left) * sx;
      const uy2 = vb.y + (r.bottom - svgRect.top) * sy;
      if (!isFinite(ux1 + uy1 + ux2 + uy2)) return;
      x1 = Math.max(vb.x - cap, Math.min(x1, ux1));
      y1 = Math.max(vb.y - cap, Math.min(y1, uy1));
      x2 = Math.min(vb.x + vb.width + cap, Math.max(x2, ux2));
      y2 = Math.min(vb.y + vb.height + cap, Math.max(y2, uy2));
    });
  } else {
    try {
      const b = svg.getBBox();
      x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y);
      x2 = Math.max(x2, b.x + b.width); y2 = Math.max(y2, b.y + b.height);
    } catch (_) { return; }
  }
  const pad = 16;
  svg.setAttribute('viewBox', (x1 - pad) + ' ' + (y1 - pad) + ' ' + (x2 - x1 + pad * 2) + ' ' + (y2 - y1 + pad * 2));
  if ((svg.getAttribute('height') || '') === '100%') svg.removeAttribute('height');
}

function polishChart(host){
  const svg = host.querySelector('svg');
  if (!svg) return;
  const sx = window.scrollX, sy = window.scrollY;
  const hr = boxOf(host);
  const visible = hr && hr.top < window.innerHeight && hr.bottom > 80;
  if (!visible){
    try { host.scrollIntoView({ block: 'center', inline: 'nearest' }); }
    catch (_) {}
  }
  relaxLabels(svg);
  svg.querySelectorAll('.nodeLabel, .edgeLabel, text').forEach(el => {
    const text = (el.textContent || '').trim();
    if (!text) return;
    if (el.tagName.toLowerCase() === 'text' && el.querySelector('.nodeLabel, .edgeLabel')) return;
    if (el.closest && el.closest('.branchLabel, .edgeLabel, .task')) return;
    if (el.classList && [...el.classList].some(c => String(c).includes('taskText'))) return;
    if (el.classList && (el.classList.contains('edgeLabel') || el.classList.contains('messageText') || el.classList.contains('loopText') || el.classList.contains('labelText') || el.classList.contains('commit-label') || el.classList.contains('actor') || el.classList.contains('legend'))) return;
    const bg = chipFill(el) || backdrop(el, host);
    if (!bg) return;
    const fg = inkOf(el);
    if (!fg || transparent(fg)) return;
    if (contrast(fg, bg) >= 3.1) return;
    paintInk(el, pickInk(bg));
  });
  expandViewBox(svg);
  const vb = svg.viewBox && svg.viewBox.baseVal;
  if (vb && vb.width > 1 && vb.height > 1){
    const w = Math.ceil(vb.width);
    const h = Math.ceil(vb.height);
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    svg.style.width = w + 'px';
    svg.style.maxWidth = 'none';
    svg.style.height = h + 'px';
  }
  if (!visible) window.scrollTo(sx, sy);
}

export function renderMermaidInto(host, source){
  if (!host) return Promise.resolve();
  const gen = (host._mmdGen = (host._mmdGen || 0) + 1);
  const text = String(source == null ? '' : source).replace(/\s+$/, '');
  watchTheme();
  if (!text.trim()){
    showMsg(host, '空的 Mermaid 图表');
    return Promise.resolve();
  }
  const theme = mermaidThemeName();
  const key = theme + '\n' + text;
  const applySvg = (svg, polish) => {
    if (host._mmdGen !== gen) return;
    const chart = chartEl(host);
    const msg = msgEl(host);
    if (msg) msg.hidden = true;
    svg = uniquifySvg(svg);
    chart.innerHTML = svg;
    if (polish){
      try { polishChart(chart); }
      catch (_) {}
      svg = chart.innerHTML;
      cacheSet(key, svg);
    }
    host.dataset.mmdSrc = text;
    host.dataset.mmdTheme = theme;
  };
  const cached = svgCache.get(key);
  if (cached){
    applySvg(cached, false);
    return Promise.resolve();
  }
  const diagram = prepareDiagram(text);
  return loadMermaid().then(mermaid => enqueueRender(async () => {
    if (host._mmdGen !== gen || !host.isConnected) return;
    boot(mermaid, theme);
    const id = 'omMmd' + (++seq);
    try {
      const out = await withTimeout(mermaid.render(id, diagram), 8000);
      let svg = out && out.svg ? out.svg : '';
      if (!svg) throw new Error('没有生成图表');
      applySvg(svg, true);
    } catch (e) {
      if (host._mmdGen !== gen) return;
      showMsg(host, '图表无法渲染：' + shortErr(e));
      delete host.dataset.mmdSrc;
    } finally {
      cleanup(id, host);
    }
  })).catch(e => {
    if (host._mmdGen !== gen) return;
    showMsg(host, '图表无法渲染：' + shortErr(e));
  });
}

const timers = new WeakMap();

export function scheduleMermaid(host, source){
  if (!host) return;
  watchTheme();
  const prev = timers.get(host);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    timers.delete(host);
    if (!host.isConnected || !hostShowsChart(host)) return;
    renderMermaidInto(host, source);
  }, 40);
  timers.set(host, t);
}

function watchTheme(){
  if (themeWatch || typeof MutationObserver !== 'function') return;
  themeWatch = true;
  let last = mermaidThemeName();
  new MutationObserver(() => {
    const t = mermaidThemeName();
    if (t === last) return;
    last = t;
    bootedKey = '';
    svgCache.clear();
    document.querySelectorAll('.lm-mermaid[data-mmd-src], .md-mermaid[data-mmd-src]').forEach(host => {
      if (!hostShowsChart(host)){
        delete host.dataset.mmdTheme;
        return;
      }
      renderMermaidInto(host, host.dataset.mmdSrc || '');
    });
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
}
