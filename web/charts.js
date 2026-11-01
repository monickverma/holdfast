// Small SVG charts drawn from the evidence digest. They redraw at the container's real width, so text stays its real size
// on a phone. No data is held here: each chart only draws what it is given.
const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, text) => {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = String(text);
  return node;
};

const tip = () => document.querySelector('#tip');
function showTip(event, lines) {
  const box = tip();
  box.replaceChildren(...lines.map((line, i) => { const row = document.createElement(i ? 'p' : 'strong'); row.textContent = line; return row; }));
  box.hidden = false;
  const rect = event.currentTarget?.getBoundingClientRect?.();
  const x = event.clientX || (rect ? rect.left + rect.width / 2 : 0);
  const y = event.clientY || (rect ? rect.top : 0);
  const { offsetWidth: w, offsetHeight: h } = box;
  box.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, x + 14))}px`;
  box.style.top = `${Math.max(8, y - h - 12)}px`;
}
const hideTip = () => { tip().hidden = true; };
function hover(node, lines) {
  node.setAttribute('tabindex', '0');
  node.setAttribute('aria-label', lines.join('. '));
  node.addEventListener('mousemove', (event) => showTip(event, lines));
  node.addEventListener('focus', (event) => showTip(event, lines));
  node.addEventListener('mouseleave', hideTip);
  node.addEventListener('blur', hideTip);
}

/** Calls draw(width) now and again when the container's width changes. */
function responsive(element, draw) {
  let last = 0;
  const run = () => {
    const width = Math.floor(element.clientWidth);
    if (!width || width === last) return;
    last = width;
    element.replaceChildren(draw(width));
  };
  run();
  new ResizeObserver(run).observe(element);
}

/** A bar with a 4 px rounded data end, square at its baseline. */
const barPath = (x, y, w, h) => {
  const r = Math.min(4, w, h / 2);
  return `M${x},${y}h${Math.max(0, w - r)}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 -${r},${r}h-${Math.max(0, w - r)}z`;
};

const format = (value) => Number(value).toLocaleString('en-US');

/**
 * Horizontal bars, one row a label above its bar, so a long label survives a narrow screen.
 * rows: [{ label, value, tone, tip: [..lines] }]
 */
export function horizontalBars(element, rows, { unit, ariaLabel }) {
  const ROW = 50;
  const BAR = 16;
  const max = Math.max(...rows.map((r) => r.value));
  responsive(element, (width) => {
    const room = 96;
    const scale = (value) => (value / max) * (width - room);
    const root = svg('svg', { viewBox: `0 0 ${width} ${rows.length * ROW}`, width, height: rows.length * ROW, role: 'img', 'aria-label': ariaLabel, class: 'plot' });
    rows.forEach((row, i) => {
      const y = i * ROW;
      root.append(svg('text', { x: 0, y: y + 16, class: 'label' }, row.label));
      const group = svg('g', { class: 'mark' });
      group.append(svg('rect', { x: 0, y: y + 20, width, height: ROW - 22, class: 'hit' }));
      group.append(svg('path', { d: barPath(0, y + 24, Math.max(2, scale(row.value)), BAR), class: `fill-${row.tone ?? 1}` }));
      group.append(svg('text', { x: scale(row.value) + 8, y: y + 37, class: 'value' }, `${format(row.value)}${unit ? ` ${unit}` : ''}`));
      hover(group, row.tip ?? [row.label, format(row.value)]);
      root.append(group);
    });
    return root;
  });
}

/**
 * Pairs of bars, one pair for each measure. series: [{ name, tone }], groups: [{ label, values: [..] , tips: [[..lines]..] }]
 */
export function pairedBars(element, series, groups, { unit, ariaLabel }) {
  const BAR = 16;
  const GAP = 2;
  const GROUP = 24 + series.length * (BAR + GAP) + 18;
  const max = Math.max(...groups.flatMap((g) => g.values));
  responsive(element, (width) => {
    const room = 96;
    const scale = (value) => (value / max) * (width - room);
    const root = svg('svg', { viewBox: `0 0 ${width} ${groups.length * GROUP}`, width, height: groups.length * GROUP, role: 'img', 'aria-label': ariaLabel, class: 'plot' });
    groups.forEach((group, g) => {
      const top = g * GROUP;
      root.append(svg('text', { x: 0, y: top + 16, class: 'label' }, group.label));
      series.forEach((s, i) => {
        const y = top + 24 + i * (BAR + GAP);
        const mark = svg('g', { class: 'mark' });
        mark.append(svg('rect', { x: 0, y, width, height: BAR + GAP, class: 'hit' }));
        mark.append(svg('path', { d: barPath(0, y, Math.max(2, scale(group.values[i])), BAR), class: `fill-${s.tone}` }));
        mark.append(svg('text', { x: scale(group.values[i]) + 8, y: y + 13, class: 'value' }, `${format(group.values[i])} ${unit}`));
        hover(mark, group.tips[i]);
        root.append(mark);
      });
    });
    return root;
  });
}

const niceMax = (value) => {
  const step = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 1.5, 2, 3, 4, 5, 7.5, 10]) if (m * step >= value) return m * step;
  return 10 * step;
};

/** A line with markers on real x positions, a labelled vertical rule, and a crosshair to the nearest point. */
export function lineWithRule(element, points, { xLabel, yLabel, rule, ariaLabel }) {
  const HEIGHT = 300;
  responsive(element, (width) => {
    const left = 52;
    const right = 16;
    const top = 16;
    const bottom = 44;
    const xMax = niceMax(Math.max(...points.map((p) => p.x)));
    const yMax = niceMax(Math.max(...points.map((p) => p.y)));
    const X = (v) => left + (v / xMax) * (width - left - right);
    const Y = (v) => HEIGHT - bottom - (v / yMax) * (HEIGHT - top - bottom);
    const root = svg('svg', { viewBox: `0 0 ${width} ${HEIGHT}`, width, height: HEIGHT, role: 'img', 'aria-label': ariaLabel, class: 'plot' });
    for (let i = 0; i <= 4; i++) {
      const v = (yMax / 4) * i;
      root.append(svg('line', { x1: left, x2: width - right, y1: Y(v), y2: Y(v), class: 'grid' }));
      root.append(svg('text', { x: left - 8, y: Y(v) + 4, class: 'tick', 'text-anchor': 'end' }, `$${format(v)}`));
    }
    const ticks = width < 480 ? 2 : 4;
    for (let i = 0; i <= ticks; i++) {
      const v = (xMax / ticks) * i;
      root.append(svg('text', { x: X(v), y: HEIGHT - bottom + 18, class: 'tick', 'text-anchor': i === ticks ? 'end' : i === 0 ? 'start' : 'middle' }, format(v)));
    }
    root.append(svg('text', { x: width - right, y: HEIGHT - 6, class: 'tick', 'text-anchor': 'end' }, xLabel));
    root.append(svg('text', { x: left, y: 10, class: 'tick' }, yLabel));
    if (rule) {
      root.append(svg('line', { x1: X(rule.x), x2: X(rule.x), y1: top, y2: HEIGHT - bottom, class: 'rule' }));
      root.append(svg('text', { x: X(rule.x) + 6, y: top + 12, class: 'label' }, rule.label));
    }
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.x)},${Y(p.y)}`).join('');
    root.append(svg('path', { d: `${line}L${X(points.at(-1).x)},${Y(0)}L${X(points[0].x)},${Y(0)}z`, class: 'wash-1' }));
    root.append(svg('path', { d: line, class: 'line-1' }));
    const cross = svg('line', { y1: top, y2: HEIGHT - bottom, class: 'cross', visibility: 'hidden' });
    root.append(cross);
    points.forEach((p) => {
      const mark = svg('g', { class: 'mark' });
      mark.append(svg('circle', { cx: X(p.x), cy: Y(p.y), r: 14, class: 'hit' }));
      mark.append(svg('circle', { cx: X(p.x), cy: Y(p.y), r: 5, class: 'dot-1' }));
      hover(mark, p.tip);
      root.append(mark);
    });
    const end = points.at(-1);
    root.append(svg('text', { x: X(end.x) - 10, y: Y(end.y) - 12, class: 'value', 'text-anchor': 'end' }, end.label));
    root.addEventListener('mousemove', (event) => {
      const bounds = root.getBoundingClientRect();
      const px = event.clientX - bounds.left;
      const near = points.reduce((a, b) => (Math.abs(X(a.x) - px) < Math.abs(X(b.x) - px) ? a : b));
      cross.setAttribute('x1', X(near.x));
      cross.setAttribute('x2', X(near.x));
      cross.setAttribute('visibility', 'visible');
      showTip(event, near.tip);
    });
    root.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
    return root;
  });
}

export function legend(element, series) {
  const row = document.createElement('div');
  row.className = 'legend';
  for (const s of series) {
    const item = document.createElement('span');
    const swatch = document.createElement('i');
    swatch.className = `swatch swatch-${s.tone}`;
    item.append(swatch, document.createTextNode(s.name));
    row.append(item);
  }
  element.before(row);
}
