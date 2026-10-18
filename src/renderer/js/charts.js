import { h, clear } from './dom.js';

// Small SVG/HTML chart kit for the Monthly Report. Colors come from CSS tokens
// (--series-1, --series-2, --chart-grid, --chart-axis) so both themes work.

const NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) el.setAttribute(k, String(v));
  for (const c of children.flat()) if (c) el.append(c);
  return el;
}

/** Clean axis range and ticks (1 / 2 / 2.5 / 5 × 10^n steps). */
export function niceScale(min, max, count = 4) {
  if (max <= min) max = min + 1;
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v));
  return { lo, hi, ticks };
}

/** Column with a 4px rounded data end, square at the baseline. */
function columnPath(x, y, w, height, r = 4) {
  const rr = Math.min(r, height, w / 2);
  return `M${x},${y + height}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + height}Z`;
}

function dayTickIndices(n, slot) {
  const step = slot >= 26 ? 1 : slot >= 13 ? 2 : 5;
  const out = [];
  for (let i = 0; i < n; i++) {
    const day = i + 1;
    if (step === 1 || (step === 2 && day % 2 === 1) || (step === 5 && (day === 1 || day % 5 === 0))) out.push(i);
  }
  return out;
}

/**
 * Daily money flow: "spending per day" columns on top and "money left" line
 * below, sharing the day axis (two charts, never two y-scales on one plot).
 * One crosshair and one tooltip cover both; arrow keys move it when focused.
 */
export function flowChart(host, { days, fmtMoney, fmtCompact, fmtDay, labels }) {
  clear(host);
  host.classList.add('flow-chart');
  host.tabIndex = 0;
  host.setAttribute('aria-label', `${labels.spentTitle}. ${labels.balanceTitle}`);
  const legend = h(
    'span',
    { class: 'chart-legend' },
    h('span', { class: 'legend-item' }, h('span', { class: 'legend-line' }), labels.balance),
    h('span', { class: 'legend-item' }, h('span', { class: 'legend-dot' }), labels.fundIn)
  );
  const topSvg = svg('svg', { class: 'chart-svg', role: 'img', 'aria-label': labels.spentTitle });
  const bottomSvg = svg('svg', { class: 'chart-svg', role: 'img', 'aria-label': labels.balanceTitle });
  const tooltip = h('div', { class: 'chart-tooltip', hidden: true });
  host.append(
    h('div', { class: 'chart-panel-title' }, labels.spentTitle),
    topSvg,
    h('div', { class: 'chart-panel-title' }, labels.balanceTitle, legend),
    bottomSvg,
    tooltip
  );

  const n = days.length;
  const M = { left: 64, right: 24, top: 12, bottom: 26 };
  let geom = null;
  let active = null;
  const parts = { bars: [], cross: [], dot: null };

  function axisLabels(el, H, slot, xc) {
    for (const i of dayTickIndices(n, slot)) {
      el.append(svg('text', { x: xc(i), y: H - 8, class: 'chart-tick', 'text-anchor': 'middle' }, document.createTextNode(String(days[i].day))));
    }
  }

  function gridAndTicks(el, ticks, y, width, bottomIsAxis = false) {
    // Enough significant digits that neighbouring tick labels never read the same.
    const step = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 1;
    const biggest = Math.max(...ticks.map(Math.abs), 1);
    const digits = Math.max(1, Math.min(6, Math.ceil(Math.log10(biggest / step) + 1e-9) + 1));
    ticks.forEach((tick, k) => {
      const axis = tick === 0 || (bottomIsAxis && k === 0);
      el.append(svg('line', { x1: M.left, x2: width - M.right, y1: y(tick), y2: y(tick), class: axis ? 'chart-axis' : 'chart-grid' }));
      el.append(svg('text', { x: M.left - 8, y: y(tick) + 4, class: 'chart-tick', 'text-anchor': 'end' }, document.createTextNode(fmtCompact(tick, digits))));
    });
  }

  function overlay(el, H) {
    const rect = svg('rect', { x: M.left, y: 0, width: geom.plotW, height: H, class: 'chart-hit' });
    rect.addEventListener('pointermove', (e) => show(indexAt(e, el), e));
    rect.addEventListener('pointerleave', () => {
      if (document.activeElement !== host) hide();
    });
    el.append(rect);
  }

  function crosshair(el, top, bottom) {
    const line = svg('line', { y1: top, y2: bottom, class: 'chart-crosshair', visibility: 'hidden' });
    el.append(line);
    parts.cross.push(line);
  }

  function drawTop() {
    const { width, slot, xc } = geom;
    const H = 180;
    const plotH = H - M.top - M.bottom;
    topSvg.setAttribute('viewBox', `0 0 ${width} ${H}`);
    topSvg.setAttribute('height', H);
    clear(topSvg);
    const maxSpent = Math.max(0, ...days.map((d) => d.spent));
    const { hi, ticks } = niceScale(0, maxSpent || 100, 4);
    const y = (v) => M.top + plotH - (v / hi) * plotH;
    gridAndTicks(topSvg, ticks, y, width);
    crosshair(topSvg, M.top, M.top + plotH);
    const w = Math.min(24, Math.max(2, slot * 0.62));
    parts.bars = days.map((d, i) => {
      if (!d.spent) return null;
      const bar = svg('path', { d: columnPath(xc(i) - w / 2, y(d.spent), w, y(0) - y(d.spent)), class: 'chart-bar' });
      topSvg.append(bar);
      return bar;
    });
    axisLabels(topSvg, H, slot, xc);
    overlay(topSvg, H);
  }

  function drawBottom() {
    const { width, slot, xc } = geom;
    const H = 160;
    const plotH = H - M.top - M.bottom;
    bottomSvg.setAttribute('viewBox', `0 0 ${width} ${H}`);
    bottomSvg.setAttribute('height', H);
    clear(bottomSvg);
    const points = days.map((d, i) => (d.balance === null ? null : { i, v: d.balance }));
    const known = points.filter(Boolean);
    const dataMin = known.length ? Math.min(...known.map((p) => p.v)) : 0;
    const dataMax = known.length ? Math.max(...known.map((p) => p.v)) : 0;
    // A line needs no zero baseline: when the balance moves in a narrow band far
    // from zero, fit the axis to the data so the daily changes stay visible.
    const fromZero = dataMin <= 0 || dataMax - dataMin >= dataMax * 0.5;
    const pad = Math.max((dataMax - dataMin) * 0.15, Math.abs(dataMax) * 0.002, 100);
    const { lo, hi, ticks } = fromZero
      ? niceScale(Math.min(0, dataMin), Math.max(0, dataMax) || 100, 4)
      : niceScale(dataMin - pad, dataMax + pad, 4);
    const y = (v) => M.top + plotH - ((v - lo) / (hi - lo)) * plotH;
    geom.yBalance = y;
    gridAndTicks(bottomSvg, ticks, y, width, !fromZero);
    crosshair(bottomSvg, M.top, M.top + plotH);
    if (known.length) {
      const first = known[0];
      const last = known[known.length - 1];
      const line = known.map((p, k) => `${k ? 'L' : 'M'}${xc(p.i)},${y(p.v)}`).join('');
      // The area wash only makes sense down to a zero baseline.
      if (fromZero) bottomSvg.append(svg('path', { d: `M${xc(first.i)},${y(0)}${line.replace(/^M/, 'L')}L${xc(last.i)},${y(0)}Z`, class: 'chart-area' }));
      bottomSvg.append(svg('path', { d: line, class: 'chart-line' }));
      for (const p of known) {
        if (days[p.i].fundIn > 0 || days[p.i].carryOver !== 0) {
          bottomSvg.append(svg('circle', { cx: xc(p.i), cy: y(p.v), r: 4, class: 'chart-marker' }));
        }
      }
      // Direct label at the end of the line only.
      const lx = Math.min(xc(last.i), width - M.right);
      const ly = y(last.v) - 10 < M.top + 8 ? y(last.v) + 18 : y(last.v) - 10;
      bottomSvg.append(svg('text', { x: lx, y: ly, class: 'chart-end-label', 'text-anchor': 'end' }, document.createTextNode(fmtMoney(last.v))));
    }
    parts.dot = svg('circle', { r: 4, class: 'chart-active-dot', visibility: 'hidden' });
    bottomSvg.append(parts.dot);
    axisLabels(bottomSvg, H, slot, xc);
    overlay(bottomSvg, H);
  }

  function draw() {
    const width = Math.max(480, Math.floor(host.clientWidth));
    const plotW = width - M.left - M.right;
    const slot = plotW / n;
    geom = { width, plotW, slot, xc: (i) => M.left + slot * (i + 0.5) };
    parts.cross = [];
    drawTop();
    drawBottom();
    if (active !== null) show(active);
  }

  function indexAt(e, el) {
    const rect = el.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * geom.width;
    return Math.max(0, Math.min(n - 1, Math.floor((x - M.left) / geom.slot)));
  }

  function row(keyClass, value, label) {
    return h('div', { class: 'tt-row' }, h('span', { class: `tt-key ${keyClass}` }), h('strong', { class: 'tt-value' }, value), h('span', { class: 'tt-label' }, label));
  }

  function show(i) {
    active = i;
    const d = days[i];
    const x = geom.xc(i);
    parts.cross.forEach((line) => {
      line.setAttribute('x1', x);
      line.setAttribute('x2', x);
      line.setAttribute('visibility', 'visible');
    });
    parts.bars.forEach((bar, k) => bar && bar.classList.toggle('active', k === i));
    if (d.balance !== null) {
      parts.dot.setAttribute('cx', x);
      parts.dot.setAttribute('cy', geom.yBalance(d.balance));
      parts.dot.setAttribute('visibility', 'visible');
    } else {
      parts.dot.setAttribute('visibility', 'hidden');
    }
    clear(tooltip);
    tooltip.append(
      h('div', { class: 'tt-date' }, fmtDay(d.date)),
      row('tt-key-bar', fmtMoney(d.spent), labels.spentRow(d.purchaseCount)),
      d.carryOver ? row('tt-key-dot', fmtMoney(d.carryOver), labels.carryOver) : null,
      d.fundIn ? row('tt-key-dot', fmtMoney(d.fundIn), labels.fundIn) : null,
      row('tt-key-line', d.balance === null ? '—' : fmtMoney(d.balance), labels.balance)
    );
    tooltip.hidden = false;
    // Position beside the crosshair, flipping left near the right edge.
    const scale = host.clientWidth / geom.width;
    const px = x * scale;
    const tw = tooltip.offsetWidth;
    tooltip.style.left = `${px + 14 + tw > host.clientWidth ? px - 14 - tw : px + 14}px`;
    tooltip.style.top = '28px';
  }

  function hide() {
    active = null;
    tooltip.hidden = true;
    parts.cross.forEach((line) => line.setAttribute('visibility', 'hidden'));
    parts.bars.forEach((bar) => bar && bar.classList.remove('active'));
    if (parts.dot) parts.dot.setAttribute('visibility', 'hidden');
  }

  host.addEventListener('keydown', (e) => {
    const keys = { ArrowLeft: -1, ArrowRight: 1 };
    if (e.key in keys) {
      e.preventDefault();
      show(Math.max(0, Math.min(n - 1, (active ?? -1) + keys[e.key])));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      show(e.key === 'Home' ? 0 : n - 1);
    } else if (e.key === 'Escape') {
      hide();
    }
  });
  host.addEventListener('focus', () => {
    const lastActive = days.reduce((acc, d, i) => (d.spent || d.fundIn ? i : acc), 0);
    show(active ?? lastActive);
  });
  host.addEventListener('blur', hide);

  // Redraw only when the width changes (drawing changes the height itself).
  let frame = 0;
  let drawnWidth = 0;
  const redraw = () => {
    drawnWidth = Math.floor(host.clientWidth);
    draw();
  };
  const resize = new ResizeObserver(() => {
    if (Math.floor(host.clientWidth) === drawnWidth) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(redraw);
  });
  redraw();
  resize.observe(host);

  return {
    destroy() {
      resize.disconnect();
      cancelAnimationFrame(frame);
    },
  };
}

/**
 * Horizontal bars for nominal categories (one hue, values labeled at the tip).
 * rows: [{ label, sub, value, valueText, shareText, child, title }]
 */
export function barList(rows, { max } = {}) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return h(
    'div',
    { class: 'bar-list' },
    rows.map((r) =>
      h(
        'div',
        { class: `bar-row${r.child ? ' bar-row-child' : ''}`, title: r.title || '' },
        h('div', { class: 'bar-label' }, h('span', { class: 'bar-name' }, r.label), r.sub ? h('span', { class: 'bar-sub' }, r.sub) : null),
        h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: { width: `${Math.max(0.5, (r.value / top) * 100)}%` } })),
        h('div', { class: 'bar-value' }, h('span', {}, r.valueText), r.shareText ? h('span', { class: 'bar-share' }, r.shareText) : null)
      )
    )
  );
}
