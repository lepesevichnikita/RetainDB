const WIDTH = 820;
const HEIGHT = 480;
const INSET = 48;
const NS = 'http://www.w3.org/2000/svg';

export function element(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}

function svg(tag, attributes, text) {
  const el = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
  if (text !== undefined) el.textContent = text;
  return el;
}

export function empty(message) {
  return element('p', message, 'empty');
}

function neighboursById(edges, nodes) {
  const labels = new Map(nodes.map(({ id, label }) => [id, label]));
  const neighbours = new Map(nodes.map(({ id }) => [id, []]));
  for (const { fromEntityId: from, toEntityId: to, relationType } of edges) {
    neighbours.get(from)?.push(`${relationType} → ${labels.get(to)}`);
    if (from !== to) neighbours.get(to)?.push(`${labels.get(from)} → ${relationType}`);
  }
  return neighbours;
}

function graphPositions(nodes, neighbours) {
  const ranked = [...nodes].sort((a, b) => neighbours.get(b.id).length - neighbours.get(a.id).length);
  const center = { x: WIDTH / 2, y: HEIGHT / 2 };
  return new Map(ranked.map(({ id }, index) => {
    const angle = index * Math.PI * (3 - Math.sqrt(5));
    const radius = Math.sqrt(index / Math.max(1, ranked.length - 1));
    return [id, { x: center.x + (center.x - INSET) * radius * Math.cos(angle), y: center.y + (center.y - INSET) * radius * Math.sin(angle) }];
  }));
}

function pathBetween(from, to) {
  if (from === to) return `M ${from.x} ${from.y} c 26 -28 -26 -28 0 0`;
  return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
}

function edgesLayer(edges, positions) {
  const layer = svg('g', {});
  for (const { fromEntityId: from, toEntityId: to } of edges) {
    if (!positions.has(from) || !positions.has(to)) continue;
    layer.append(svg('path', { class: 'edge', d: pathBetween(positions.get(from), positions.get(to)), 'data-from': from, 'data-to': to }));
  }
  return layer;
}

function marksLayer(items, positions, labelled) {
  const layer = svg('g', {});
  for (const [i, { id, label }] of items.entries()) {
    const { x, y } = positions.get(id);
    const mark = svg('g', { class: 'mark', 'data-id': id, transform: `translate(${x} ${y})` });
    mark.append(svg('title', {}, label), svg('circle', { class: 'point', r: labelled ? 7 : 6 }));
    if (labelled && i < 10) mark.append(svg('text', { class: 'label', x: 11, y: 4 }, label.length > 18 ? `${label.slice(0, 17)}…` : label));
    layer.append(mark);
  }
  return layer;
}

function detailsFor(item, details) {
  if (!item) return [element('p', 'Select an item to inspect it.')];
  const summary = details(item);
  const list = element('ul');
  list.append(...summary.map((line) => element('li', line)));
  return [element('strong', item.label), list];
}

function selectItem({ selection, list, marks, background, items, details }, id) {
  const selected = items.find((item) => item.id === id);
  selection.replaceChildren(...detailsFor(selected, details));
  for (const button of list.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.id === id));
  for (const mark of marks.children) mark.classList.toggle('is-selected', mark.dataset.id === id);
  for (const edge of background.querySelectorAll('.edge')) edge.classList.toggle('is-selected', edge.dataset.from === id || edge.dataset.to === id);
}

function itemList(items) {
  const list = element('ul', undefined, 'item-list');
  for (const { id, label } of items) {
    const row = element('li');
    const button = element('button', label);
    button.type = 'button';
    button.dataset.id = id;
    button.setAttribute('aria-pressed', 'false');
    row.append(button);
    list.append(row);
  }
  return list;
}

function inspector(title, list, selection) {
  const panel = element('aside', undefined, 'inspector');
  panel.append(element('h2', title), selection, list);
  return panel;
}

function visual({ items, positions, background, caption, title, details, labelled = false }) {
  const wrap = element('div', undefined, 'visual');
  const figure = element('figure', undefined, 'plot');
  const drawing = svg('svg', { viewBox: `0 0 ${WIDTH} ${HEIGHT}`, 'aria-hidden': 'true' });
  const marks = marksLayer(items, positions, labelled);
  const list = itemList(items);
  const selection = element('div', undefined, 'selection');
  selection.setAttribute('role', 'status');
  selection.setAttribute('aria-label', 'Selected item');
  const parts = { selection, list, marks, background, items, details };
  selectItem(parts);
  drawing.append(background, marks);
  figure.append(drawing, element('figcaption', caption));
  wrap.append(figure, inspector(title, list, selection));
  wrap.addEventListener('click', (event) => {
    const id = event.target.closest('[data-id]')?.dataset.id;
    if (id) selectItem(parts, id);
  });
  wrap.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') selectItem(parts);
  });
  return wrap;
}

export function graphView({ nodes, edges }, query) {
  if (nodes.length === 0) return empty(query ? 'No entities match that name.' : 'No visible entities in this project.');
  const neighbours = neighboursById(edges, nodes);
  const positions = graphPositions(nodes, neighbours);
  return visual({ items: nodes, positions, background: edgesLayer(edges, positions), labelled: true,
    title: 'Inspect entities', caption: `${nodes.length} entities · ${edges.length} relations shown. Search to focus on another neighbourhood.`,
    details: ({ id, type }) => [type ?? 'Unclassified', ...(neighbours.get(id).length ? neighbours.get(id) : ['No displayed relations'])],
  });
}

function axisGrid() {
  const grid = svg('g', {});
  for (const [x1, y1, x2, y2] of [[INSET, INSET, INSET, HEIGHT - INSET], [INSET, HEIGHT - INSET, WIDTH - INSET, HEIGHT - INSET], [WIDTH / 2, INSET, WIDTH / 2, HEIGHT - INSET], [INSET, HEIGHT / 2, WIDTH - INSET, HEIGHT / 2]]) {
    grid.append(svg('line', { x1, y1, x2, y2, class: 'gridline' }));
  }
  grid.append(svg('text', { x: WIDTH / 2, y: HEIGHT - 15, class: 'axis', 'text-anchor': 'middle' }, 'cosine similarity to A'),
    svg('text', { x: INSET, y: 26, class: 'axis' }, 'cosine similarity to B'));
  return grid;
}

export function vectorView({ anchors, points, model, limit }) {
  if (!model) return empty('No labelled embeddings in this project.');
  if (!points.length) return empty('No non-zero vectors for this model.');
  const halfX = (WIDTH - 2 * INSET) / 2;
  const halfY = (HEIGHT - 2 * INSET) / 2;
  const position = ({ x, y }) => ({ x: WIDTH / 2 + x * halfX, y: HEIGHT / 2 - y * halfY });
  const chunks = points.map((point) => ({ ...point, label: `${point.label} · chunk ${point.chunkIndex + 1}` }));
  return visual({ items: chunks, positions: new Map(points.map((point) => [point.id, position(point)])), background: axisGrid(),
    title: 'Inspect chunks', caption: `${points.length} plotted · up to ${limit} recent vectors. A: ${anchors[0]}. B: ${anchors[1]}. Distances on this map are not full-vector distances.`,
    details: ({ type, x, y }) => [type ?? 'Chunk', `Similarity to A: ${x.toFixed(3)}`, `Similarity to B: ${y.toFixed(3)}`],
  });
}
