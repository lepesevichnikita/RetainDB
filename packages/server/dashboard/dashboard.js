import { element, empty, graphView, vectorView } from './visuals.js';

const number = new Intl.NumberFormat();
const clock = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' });
const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' });
const byId = (id) => document.getElementById(id);
const projectSelect = byId('project');
const content = byId('content');
const feedback = byId('feedback');
const tabs = [...document.querySelectorAll('[data-view]')];
const views = {
  overview: ['Overview', 'Indexed knowledge and embedding coverage for this project.', overview],
  graph: ['Knowledge graph', 'Stored entities and their direct relations.', (data) => graphView(data, state.q)],
  vectors: ['Vector map', 'A view of stored chunk embeddings, one model at a time.', vectors],
  queue: ['Queue', 'Persisted ingestion, repository indexing, source sync, and native capture jobs.', queue],
  logs: ['Logs', 'Recent API requests across RetainDB. This log resets when the server restarts.', logs],
};
let projects;
let state;
let pending;

function describeState(url) {
  const view = url.searchParams.get('view');
  return {
    view: Object.hasOwn(views, view) ? view : 'overview',
    project: url.searchParams.get('project') ?? projects?.[0]?.id ?? '',
    q: url.searchParams.get('q')?.trim().slice(0, 120) ?? '',
    model: url.searchParams.get('model') ?? '',
  };
}

function urlFor({ view, project, q, model }) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ view: view === 'overview' ? '' : view, project, q, model })) {
    if (value) params.set(key, value);
  }
  return `${location.pathname}${params.size ? `?${params}` : ''}`;
}

function change(changes) {
  history.pushState(null, '', urlFor({ ...state, ...changes }));
  return load();
}

function syncControls() {
  const [title, description] = views[state.view];
  byId('view-title').textContent = title;
  byId('view-description').textContent = description;
  projectSelect.closest('.project-control').hidden = state.view === 'logs';
  byId('graph-filter').hidden = state.view !== 'graph' || !projectSelect.value;
  byId('graph-query').value = state.q;
  for (const link of tabs) {
    const view = link.dataset.view;
    link.href = urlFor({ ...state, view });
    if (view === state.view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function setProjects() {
  projectSelect.replaceChildren(...projects.map(({ id, name, slug }) => new Option(name === slug ? name : `${name} (${slug})`, id)));
  if (!projects.some(({ id }) => id === state.project)) projectSelect.prepend(new Option('Select a project', ''));
  projectSelect.value = projects.some(({ id }) => id === state.project) ? state.project : '';
  projectSelect.disabled = projects.length === 0;
}

function status(message, failed = false) {
  feedback.textContent = message;
  feedback.hidden = !message;
  feedback.classList.toggle('error', failed);
}

async function read(view, params, signal) {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value));
  const response = await fetch(`/dashboard/data/${view}?${query}`, { signal, credentials: 'same-origin', redirect: 'manual' });
  if (response.type === 'opaqueredirect' || response.status === 401) throw new Error('Your session expired. Reload the page to sign in again.');
  if (response.status === 403) throw new Error('Your account cannot open this dashboard.');
  if (view === 'vectors' && response.status === 404 && (await response.json()).code === 'EMBEDDING_MODEL_NOT_FOUND') return null;
  if (!response.ok) throw new Error('RetainDB could not load this view. Try Refresh.');
  return response.json();
}

async function loadView(signal) {
  if (!projects && state.view !== 'logs') {
    const data = await read('projects', {}, signal);
    if (signal.aborted) return;
    projects = data.projects;
    state = describeState(new URL(location.href));
  }
  if (projects) setProjects();
  syncControls();
  if (state.view !== 'logs' && !projectSelect.value) return empty(projects.length ? 'Select a project to see its data.' : 'No projects in RetainDB yet.');
  const { view, project, q, model } = state;
  const params = view === 'logs' ? {} : { project, ...(view === 'graph' ? { q } : {}), ...(view === 'vectors' ? { model } : {}) };
  const result = await read(view, params, signal);
  if (!signal.aborted) return views[view][2](result);
}

async function load() {
  pending?.abort();
  const { signal } = pending = new AbortController();
  state = describeState(new URL(location.href));
  syncControls();
  status('Loading…');
  content.setAttribute('aria-busy', 'true');
  content.replaceChildren();
  byId('updated').textContent = '';
  try {
    const rendered = await loadView(signal);
    if (signal.aborted) return;
    content.replaceChildren(rendered);
    byId('updated').textContent = `Updated ${clock.format(new Date())}`;
    status('');
  } catch (error) {
    if (!signal.aborted) status(error.message, true);
  } finally {
    if (!signal.aborted) content.setAttribute('aria-busy', 'false');
  }
}

function table(caption, columns, rows) {
  const result = element('table', undefined, 'table');
  result.append(element('caption', caption));
  const head = result.createTHead().insertRow();
  for (const name of columns) {
    const th = element('th', name);
    th.scope = 'col';
    head.append(th);
  }
  const body = result.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    row.forEach((item, index) => {
      const cell = tr.insertCell();
      cell.dataset.label = columns[index];
      cell.append(item);
    });
  }
  return result;
}

function stats(items) {
  const list = element('dl', undefined, 'stats');
  for (const [label, value] of items) {
    const item = element('div');
    item.append(element('dt', label), element('dd', number.format(value), 'number'));
    list.append(item);
  }
  return list;
}

function coverage(embedded, chunks) {
  const section = element('div', undefined, 'coverage');
  const label = `${number.format(embedded)} of ${number.format(chunks)} searchable chunks have an embedding`;
  section.append(element('h2', 'Embedding coverage'), element('p', label, 'muted'));
  if (chunks) {
    const meter = element('meter');
    meter.max = chunks;
    meter.value = embedded;
    meter.setAttribute('aria-label', label);
    section.append(meter);
  }
  return section;
}

function overview({ documents, chunks, sources, embedded, memories, entities, models }) {
  const group = document.createDocumentFragment();
  group.append(stats([['Indexed documents', documents], ['Searchable chunks', chunks], ['Indexed sources', sources], ['Memories', memories], ['Entities', entities]]), coverage(embedded, chunks));
  if (models.length) group.append(table('Chunk embeddings by recorded model', ['Model', 'Vectors'], models.map(({ model, count }) => [model ?? 'Unlabelled', number.format(count)])));
  return group;
}

function missingModel() {
  const group = element('div', undefined, 'coverage');
  const reset = element('button', 'Show available models');
  reset.type = 'button';
  reset.addEventListener('click', () => change({ model: '' }).then(() => (byId('vector-model') ?? byId('refresh')).focus()));
  group.append(element('p', 'The selected embedding model is no longer available in this project.'), reset);
  return group;
}

function vectors(data) {
  if (data === null) return missingModel();
  if (!data.models.length) return vectorView(data);
  const group = document.createDocumentFragment();
  const controls = element('div', undefined, 'model-control');
  const select = element('select');
  select.id = 'vector-model';
  select.append(...data.models.map(({ model, count }) => new Option(`${model} (${number.format(count)})`, model, false, model === data.model)));
  const label = element('label', 'Embedding model');
  label.htmlFor = select.id;
  select.addEventListener('change', () => change({ model: select.value }).then(() => byId('vector-model')?.focus()));
  controls.append(label, select);
  group.append(controls, vectorView(data));
  return group;
}

function timestamp(value) {
  if (!value) return 'Unknown';
  const time = element('time', date.format(new Date(value)));
  time.dateTime = value;
  return time;
}

function badge(text, tone = 'neutral') {
  const tag = element('span', text, 'badge');
  tag.dataset.tone = tone;
  return tag;
}

function jobTone(value) {
  if (/FAILED|ERROR/i.test(value)) return 'error';
  if (/PROCESSING|RUNNING|OPEN|SEALED/i.test(value)) return 'active';
  return 'neutral';
}

function queueRow({ id, kind, status, createdAt, processed, total, unit }) {
  const job = element('div', kind);
  job.append(element('span', id, 'queue-id'));
  const progress = total ? `${number.format(processed)} / ${number.format(total)} ${unit}` : 'Not reported';
  return [job, badge(status, jobTone(status)), progress, timestamp(createdAt)];
}

function queue({ totals, jobs }) {
  if (!jobs.length) return empty('No jobs for this project.');
  const group = document.createDocumentFragment();
  const summary = element('ul', undefined, 'summary');
  summary.setAttribute('aria-label', 'All jobs by state');
  for (const { kind, status, count } of totals) {
    const item = element('li');
    item.append(badge(`${kind}: ${status} ${number.format(count)}`, jobTone(status)));
    summary.append(item);
  }
  group.append(summary, table(`Showing ${jobs.length} jobs, active first`, ['Job', 'State', 'Progress', 'Created'], jobs.map(queueRow)));
  return group;
}

function logs({ rows, limit }) {
  if (!rows.length) return empty('No API requests recorded since startup.');
  const entries = rows.map(({ at, method, route, status, durationMs }) => [
    timestamp(at), method, route, badge(String(status), status >= 400 ? 'error' : 'neutral'), `${number.format(durationMs)} ms`,
  ]);
  return table(`Latest API requests · up to ${limit}`, ['Time', 'Method', 'Route', 'Status', 'Duration'], entries);
}

for (const tab of tabs) tab.addEventListener('click', (event) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  void change({ view: tab.dataset.view });
});
projectSelect.addEventListener('change', () => change({ project: projectSelect.value, q: '', model: '' }));
byId('graph-filter').addEventListener('submit', (event) => {
  event.preventDefault();
  void change({ q: byId('graph-query').value.trim() });
});
byId('refresh').addEventListener('click', () => {
  projects = undefined;
  void load();
});
window.addEventListener('popstate', load);
void load();
