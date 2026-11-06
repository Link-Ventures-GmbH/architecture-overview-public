// Link Labs · Architecture Overview, browser side.
// One SSE stream feeds three things: the map (graph), the live state (git) and the activity feed.

import { createAgentsView } from './agents.js';
import { createEvalsView } from './evals.js';
import { createUsageView } from './usage.js';

const $ = (id) => document.getElementById(id);
const HUES = ['#6FE3FF', '#A08CFF', '#5CF0B4', '#FFC24B', '#FF7B93', '#4DA3FF', '#C6F36B', '#E08CFF', '#7FF5E8', '#FF9F6B'];
const HEAT_TAU = 15 * 60e3; // heat halves roughly every 10 minutes
const FOCUS_WINDOW = 30 * 60e3;
const SPARK_BUCKETS = 12;
const SPARK_SPAN = 60 * 60e3;
const SVGNS = 'http://www.w3.org/2000/svg';

const S = {
  graph: null,
  git: { enabled: false, commits: [], live: [], changed: [] },
  activity: [],
  seen: new Set(),
  tiles: new Map(),
  selected: null,
  hover: null,
  pinned: null,
  replay: null,
  skew: 0,
  scale: 1,
  view: (() => { try { return localStorage.getItem('ao-view') || 'layers'; } catch { return 'layers'; } })(),
  owner: new Map(),
  mapping: null,
};

const map = $('map');
const inner = $('map-inner');
const bandsEl = $('bands');
const edgesSvg = $('edges');
const edgeLayer = $('edge-layer');
const sparkLayer = $('spark-layer');

const now = () => Date.now() - S.skew;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
function ago(t) {
  const s = Math.max(0, Math.round((now() - t) / 1000));
  if (s < 10) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}
const base = (p) => p.split('/').pop();
const dir = (p) => p.split('/').slice(0, -1).join('/') || '.';
const V = () => {
  if (!S.graph) return { groups: [], nodes: [], edges: [] };
  // Runtime keeps the logic layout but draws only the calls that really happened.
  if (S.view === 'runtime') return { ...S.graph.views.logic, edges: S.rt?.edges || [] };
  return S.graph.views[S.view] || S.graph.views.layers;
};
const nodeById = (id) => V().nodes.find((m) => m.id === id);
const nodeOf = (path) => (path ? S.owner.get(path) || null : null);
const modOf = (a) => nodeOf(a.file);
const uniq = (xs) => [...new Set(xs.filter(Boolean))];
const commitNodes = (c) => uniq((c?.files || (c?.touched || []).map((t) => t.path)).map(nodeOf));
const label = (id) => nodeById(id)?.label || id;
const areaName = (a) => (a === '.' ? 'root' : a);
const groupName = (id) => V().groups.find((l) => l.id === id)?.label || id;
const areaOrder = () => (S.view !== 'layers' ? V().groups.map((g) => g.id) : uniq(V().nodes.map((n) => n.area)).sort());
const hueOf = (area) => HUES[Math.max(0, areaOrder().indexOf(area)) % HUES.length];

const ICONS = {
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/></svg>',
  add: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  delete: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
  commit: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M2 12h6M16 12h6"/></svg>',
};

function symChip(s) {
  const kind = s.kind || 'function';
  const label = { function: 'fn', method: 'fn', class: 'class', struct: 'struct', interface: 'iface', type: 'type', enum: 'enum', const: 'const', impl: 'impl', module: 'mod' }[kind] || kind;
  const call = kind === 'function' || kind === 'method' ? '()' : '';
  return `<span class="sym k-${esc(kind)}" title="${esc(kind)} ${esc(s.name)}"><i>${label}</i>${esc(s.name)}${call}</span>`;
}

// ---------- connection ----------

// ---------- projects ----------

const projectFromHash = () => { const m = location.hash.match(/(?:^#|&)p=([^&]+)/); return m ? decodeURIComponent(m[1]) : null; };
const projectQuery = () => (S.project ? `?project=${encodeURIComponent(S.project)}` : '');

/** Switches the whole tool to another project; every view reloads from its snapshot. */
function openProject(root) {
  S.project = root;
  const hash = root ? `#p=${encodeURIComponent(root)}` : '';
  if (location.hash !== hash) history.replaceState(null, '', hash || location.pathname);
  S.seen.clear();
  S.selected = null;
  S.pinned = null;
  $('detail').hidden = true;
  closeProjects();
  agentsView.setProject(root);
  connect();
}

function connect() {
  S.es?.close();
  const es = new EventSource(`/events${projectQuery()}`);
  S.es = es;
  const live = $('live');
  live.dataset.state = 'connecting';
  $('live-text').textContent = 'connecting';
  es.addEventListener('snapshot', (e) => {
    const d = JSON.parse(e.data);
    if (d.project) {
      S.project = d.project.root;
      S.workspace = d.project.workspace;
      agentsView.setProject(S.project);
      rememberProject(S.project);
    }
    S.skew = Date.now() - d.now;
    S.mapping = d.mapping || null;
    S.git = d.git;
    S.activity = d.activity;
    rtInit(d.otel);
    setGraph(d.graph);
    evalsView.setSnapshot(d.evals);
    setEvalsTab(!!d.evals?.enabled);
    usageView.setSnapshot(d.usage);
    setUsageTab(!!d.usage?.enabled);
    // a product tile in the control room opens its project straight in the usage view
    if (S.pendingView) { const v = S.pendingView; S.pendingView = null; if (v !== 'usage' || d.usage?.enabled) setView(v); }
    if (S.view === 'agents') agentsView.show();
    if (S.view === 'evals') evalsView.show();
    if (S.view === 'usage') usageView.show();
    renderHeader();
    renderFeed();
    renderTimeline();
    renderNow();
    live.dataset.state = 'live';
    $('live-text').textContent = 'live';
  });
  es.addEventListener('graph', (e) => { setGraph(JSON.parse(e.data)); renderHeader(); });
  es.addEventListener('git', (e) => {
    S.git = JSON.parse(e.data);
    renderHeader();
    renderTimeline();
    applyState();
    renderNow();
    if (S.selected) renderDetail(S.selected);
  });
  es.addEventListener('activity', (e) => onActivity(JSON.parse(e.data)));
  es.addEventListener('spans', (e) => onSpans(JSON.parse(e.data)));
  for (const ev of ['agent-sessions', 'agent-spawn', 'agent-tool', 'agent-hit', 'agent-end', 'agent-msg']) {
    es.addEventListener(ev, (e) => agentsView.on(ev, JSON.parse(e.data)));
  }
  es.addEventListener('evals-live', (e) => evalsView.onLive(JSON.parse(e.data)));
  es.addEventListener('evals-flow', (e) => evalsView.onFlows(JSON.parse(e.data)));
  es.addEventListener('evals-config', (e) => setEvalsTab(JSON.parse(e.data).enabled));
  es.addEventListener('usage-config', (e) => setUsageTab(JSON.parse(e.data).enabled));
  es.addEventListener('usage-status', (e) => usageView.onStatus(JSON.parse(e.data)));
  es.addEventListener('usage-snapshot', (e) => usageView.setSnapshot(JSON.parse(e.data)));
  es.addEventListener('usage-users', (e) => usageView.onUsers(JSON.parse(e.data)));
  es.addEventListener('usage-ev', (e) => usageView.onEvents(JSON.parse(e.data)));
  es.addEventListener('usage-web', (e) => usageView.onWeb(JSON.parse(e.data)));
  es.addEventListener('mapping', (e) => {
    const prev = S.mapping;
    S.mapping = JSON.parse(e.data);
    renderViewSwitch();
    if (prev?.running && !S.mapping.running && !S.mapping.error) toast('New logic map is in');
  });
  es.onerror = () => { live.dataset.state = 'offline'; $('live-text').textContent = 'reconnecting'; };
}

const RECENT_KEY = 'ao-recent-projects';
function rememberProject(root) {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((r) => r !== root);
    localStorage.setItem(RECENT_KEY, JSON.stringify([root, ...list].slice(0, 6)));
  } catch { /* storage blocked */ }
}

let projectsTimer = null;
let projectsAll = false;

async function loadProjects() {
  const res = await fetch(`/api/projects?days=14${projectsAll ? '&all=1' : ''}`);
  if (!res.ok) return;
  const d = await res.json();
  $('pj-where').textContent = d.workspace;
  const grid = $('pj-grid');
  const now = Date.now();
  grid.innerHTML = '';
  d.projects.forEach((p, i) => {
    const live = p.activeChats || p.agentsWorking || p.telemetry || now - p.lastActivity < 15 * 60e3;
    const max = Math.max(1, ...p.perDay);
    const card = document.createElement('button');
    card.className = 'pj-card' + (live ? ' is-hot' : '') + (p.root === S.project ? ' current' : '');
    card.style.setProperty('--i', i);
    const parent = p.name.includes('/') ? p.name.split('/').slice(0, -1).join('/') + '/' : '';
    card.innerHTML = `<div class="pj-top"><span class="pj-parent">${esc(parent)}</span><span class="pj-ago">${p.lastActivity ? ago(p.lastActivity) : 'quiet'}</span></div>`
      + `<div class="pj-name">${esc(p.folder)}</div>`
      + `<div class="pj-branch">${p.branch ? `⑂ ${esc(p.branch)}` : 'not a git branch'}${p.subject ? ` · ${esc(p.subject)}` : ''}</div>`
      + `<svg class="pj-spark" viewBox="0 0 ${p.perDay.length * 10} 28" preserveAspectRatio="none">${p.perDay.map((v, j) => `<rect x="${j * 10 + 1}" y="${28 - (v ? 4 + (v / max) * 24 : 2)}" width="8" height="${v ? 4 + (v / max) * 24 : 2}" rx="1"${v ? ' class="on"' : ''}/>`).join('')}</svg>`
      + '<div class="pj-badges">'
      + (p.activeChats ? `<span class="b-live">● ${p.activeChats} ${p.activeChats === 1 ? 'chat' : 'chats'} active</span>` : p.chats ? `<span>${p.chats} ${p.chats === 1 ? 'chat' : 'chats'}</span>` : '')
      + (p.agentsWorking ? `<span class="b-agents">⑂ ${p.agentsWorking} agents working</span>` : '')
      + (p.dirty ? `<span>${p.dirty} open ${p.dirty === 1 ? 'file' : 'files'}</span>` : '')
      + (p.telemetry ? '<span class="b-otel">〜 telemetry</span>' : '')
      + (p.commits ? `<span>${p.commits} commits</span>` : '')
      + '</div>';
    card.addEventListener('click', () => openProject(p.root));
    grid.appendChild(card);
  });
  $('pj-count').textContent = `${d.projects.length} ${projectsAll ? 'projects' : 'touched in 14 days'}`;
}

// ---------- control room: every product, its health and the day in numbers ----------

const PJMODE_KEY = 'ao-pjmode';
let pjMode = (() => { try { return localStorage.getItem(PJMODE_KEY) || 'products'; } catch { return 'products'; } })();
const pct = (x) => (x == null ? '–' : x >= 0.9995 ? '100 %' : `${(x * 100).toFixed(1).replace('.', ',')} %`);
const clock = (t) => new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

function envRow(e) {
  const strip = `<svg class="ct-strip" viewBox="0 0 ${e.strip.length * 6} 18" preserveAspectRatio="none">${[...e.strip].map((c, i) => `<rect x="${i * 6}" y="0" width="5" height="18" class="${c === '-' ? '' : c}"/>`).join('')}</svg>`;
  const meta = e.state === 'down' ? `${e.status || 'no answer'} · ${clock(e.at)}`
    : e.state === 'up' ? `${pct(e.uptime)} · ${e.cold && e.ms > 2500 ? 'cold start' : fmtMs(e.ms)}` : 'not checked yet';
  return `<div class="ct-env ${e.state}" title="${esc(e.url)} · every ${Math.round(e.every / 60) || 1} min${e.cold ? ', wakes on demand' : ''}">`
    + `<span class="ct-env-name"><i></i>${esc(e.name)}</span>${strip}<span class="ct-env-meta">${meta}</span></div>`;
}

function kpis(u) {
  const k = (n, label, cls = '') => `<div class="ct-kpi ${cls}"><b>${n == null ? '–' : fmtNum(n)}</b><small>${label}</small></div>`;
  return '<div class="ct-kpis">'
    + k(u.active, 'active today') + k(u.calls, 'calls 24 h') + k(u.accounts, 'accounts')
    + k(u.strangersActive, 'strangers today', u.strangersActive ? 'warn' : '') + k(u.fresh, 'new in 7 days')
    + (u.visitors != null ? k(u.visitors, 'visitors without account') : k(u.errors, 'errors 24 h', u.errors ? 'bad' : ''))
    + '</div>';
}

function productCard(p, i) {
  const repo = p.repos.find((r) => r.root);
  const down = p.environments.some((e) => e.state === 'down');
  const feedErr = p.environments.find((e) => e.feed?.error)?.feed.error;
  const card = document.createElement('div');
  card.className = 'ct-card' + (down ? ' is-down' : '') + (repo ? ' can-open' : '');
  card.style.setProperty('--i', i);
  let usage = '';
  if (p.usage) usage = p.usage.status === 'live' ? kpis(p.usage) : `<div class="ct-note">Usage feed ${esc(p.usage.status)}…</div>`;
  else if (feedErr) usage = `<div class="ct-note bad">Usage feed: ${esc(feedErr)}</div>`;
  else if (p.group !== 'Websites') usage = '<div class="ct-note">Usage not connected yet.</div>';
  card.innerHTML = `<div class="ct-top"><span class="ct-name">${esc(p.name)}</span>${repo ? `<span class="ct-repo">${esc(repo.name)}</span>` : ''}</div>`
    + `<div class="ct-envs">${p.environments.map(envRow).join('') || '<div class="ct-note">No environment with a URL.</div>'}</div>`
    + usage + (p.error ? `<div class="ct-note bad">${esc(p.error)}</div>` : '');
  if (repo) {
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Open ${p.name}`);
    const go = () => { S.pendingView = p.usage ? 'usage' : null; openProject(repo.root); };
    card.addEventListener('click', go);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  }
  return card;
}

async function loadControl() {
  const res = await fetch('/api/control');
  if (!res.ok || pjMode !== 'products') return;
  const d = await res.json();
  const board = $('ct-board');
  board.innerHTML = '';
  if (!d.configured) {
    board.innerHTML = '<p class="ct-empty">No product registry yet. Point <code>"products"</code> in <code>~/.linklabs/architecture-overview/control.json</code> at a folder with a <code>products/</code> directory (one JSON file per product).</p>';
    $('pj-count').textContent = 'no products';
    $('pj-where').textContent = '';
    return;
  }
  const isDown = (p) => p.environments.some((e) => e.state === 'down');
  const groups = [...new Set(d.products.map((p) => p.group))];
  let i = 0;
  for (const g of groups) {
    const list = d.products.filter((p) => p.group === g).sort((a, b) => isDown(b) - isDown(a) || !!b.usage - !!a.usage);
    const sec = document.createElement('section');
    sec.className = 'ct-group';
    sec.innerHTML = `<span class="eyebrow">${esc(g)} · ${list.length}</span>`;
    const grid = document.createElement('div');
    grid.className = 'ct-grid';
    for (const p of list) grid.appendChild(productCard(p, i++));
    sec.appendChild(grid);
    board.appendChild(sec);
  }
  const down = d.products.filter(isDown).length;
  $('pj-count').textContent = `${d.products.length} products · ${down ? `${down} down` : 'all up'}`;
  $('pj-where').textContent = d.dir;
}

function renderPjMode() {
  const products = pjMode === 'products';
  for (const b of document.querySelectorAll('[data-pjmode]')) b.setAttribute('aria-pressed', String(b.dataset.pjmode === pjMode));
  $('pj-days').hidden = products;
  $('pj-grid').hidden = products;
  $('ct-board').hidden = !products;
  $('pj-eyebrow').textContent = products ? 'Control room' : 'Projects';
  $('pj-title').textContent = products ? 'How is everything running?' : 'Where is the action?';
}

function refreshOverview() { (pjMode === 'products' ? loadControl : loadProjects)().catch(() => {}); }

function openProjects() {
  $('projects').hidden = false;
  document.body.classList.add('projects-open');
  renderPjMode();
  refreshOverview();
  clearInterval(projectsTimer);
  projectsTimer = setInterval(refreshOverview, 8000);
}

function closeProjects() {
  $('projects').hidden = true;
  document.body.classList.remove('projects-open');
  clearInterval(projectsTimer);
}

// ---------- graph ----------

function buildOwner() {
  S.owner = new Map();
  S.ownerVersion = (S.ownerVersion || 0) + 1;
  for (const n of V().nodes) for (const f of n.files) S.owner.set(f, n.id);
}

const SOURCE_TEXT = {
  heuristic: 'Logic guessed from file names',
  claude: 'Logic map by Claude',
  agent: 'Logic map by your coding agent',
  config: 'Logic map from .archoverview.json',
  saved: 'Saved logic map',
};

function renderViewSwitch() {
  for (const b of document.querySelectorAll('.switch [data-view]')) {
    b.setAttribute('aria-selected', String(b.dataset.view === S.view));
  }
  const sw = document.querySelector('.switch');
  sw.dataset.active = S.view;
  sw.style.setProperty('--idx', sw.querySelector(`[data-view="${S.view}"]`)?.dataset.idx ?? 0);
  $('st-modules-label').textContent = S.view === 'layers' ? 'Modules' : 'Parts';
  document.body.dataset.view = S.view;
  $('rt-bar').hidden = S.view !== 'runtime';
  renderRuntimeChrome();
  const bar = $('map-bar');
  bar.hidden = S.view !== 'logic';
  const src = S.graph?.views.logic.source || 'heuristic';
  const m = S.mapping || {};
  $('map-source').textContent = m.running ? 'Claude is reading the code…' : m.error ? `Claude: ${m.error}` : SOURCE_TEXT[src] || src;
  bar.classList.toggle('busy', !!m.running);
  bar.classList.toggle('failed', !!m.error && !m.running);
  const btn = $('btn-map-claude');
  btn.disabled = !!m.running;
  btn.textContent = m.running ? 'Mapping…' : src === 'heuristic' ? 'Map with Claude' : 'Remap with Claude';
}

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, 4200);
}

function setView(view) {
  if (!S.graph || view === S.view) return;
  const was = S.view;
  S.view = view;
  try { localStorage.setItem('ao-view', view); } catch { /* private window */ }
  if (was === 'agents' && view !== 'agents') agentsView.hide();
  if (was === 'evals' && view !== 'evals') evalsView.hide();
  if (was === 'usage' && view !== 'usage') usageView.hide();
  if (view === 'agents') { renderViewSwitch(); agentsView.show(); return; }
  if (view === 'evals') { renderViewSwitch(); evalsView.show(); return; }
  if (view === 'usage') { renderViewSwitch(); usageView.show(); return; }
  S.seen.clear();
  S.selected = null;
  $('detail').hidden = true;
  buildOwner();
  renderViewSwitch();
  renderBands();
  renderHeader();
  renderFeed();
  renderNow();
}

function setGraph(g) {
  S.graph = g;
  buildOwner();
  renderViewSwitch();
  $('empty').hidden = g.stats.files > 0;
  renderBands();
  if (S.selected && !nodeById(S.selected)) closeDetail();
  else if (S.selected) renderDetail(S.selected);
}

function renderBands() {
  if (S.view === 'agents' || S.view === 'evals' || S.view === 'usage') return;
  const view = V();
  const logic = S.view !== 'layers';
  const first = S.seen.size === 0;
  bandsEl.innerHTML = '';
  S.tiles.clear();
  map.dataset.view = logic ? 'logic' : 'layers';
  map.dataset.runtime = String(S.view === 'runtime');
  view.groups.forEach((group, bi) => {
    const mods = view.nodes.filter((m) => m.group === group.id);
    if (!mods.length) return;
    const band = document.createElement('section');
    band.className = 'band' + (mods.length > (logic ? 7 : 12) ? ' crowded' : '');
    band.dataset.group = group.id;
    band.style.setProperty('--i', first ? bi : 0);
    if (!first) band.classList.add('seen');
    else band.addEventListener('animationend', (ev) => { if (ev.target === band) band.classList.add('seen'); });
    if (logic) band.style.setProperty('--hue', hueOf(group.id));
    band.innerHTML = `<div class="band-label"><span class="band-num">${String(bi + 1).padStart(2, '0')}</span><span class="band-name">${esc(group.label)}</span>`
      + (logic && group.description ? `<span class="band-desc">${esc(group.description)}</span>` : '')
      + '</div><div class="band-body"></div>';
    const body = band.querySelector('.band-body');
    // Layers group tiles by area inside a band; in the logic view the band itself is the area.
    const byArea = new Map();
    for (const m of mods) {
      const key = logic ? group.id : m.area;
      if (!byArea.has(key)) byArea.set(key, []);
      byArea.get(key).push(m);
    }
    let ti = 0;
    for (const [area, list] of byArea) {
      const a = document.createElement('div');
      a.className = 'area';
      a.style.setProperty('--hue', hueOf(area));
      const showLabel = !logic && (list.length > 1 || list[0].label !== areaName(area));
      a.innerHTML = `${showLabel ? `<div class="area-label"><span class="area-dot"></span>${esc(areaName(area))}</div>` : ''}<div class="area-tiles"></div>`;
      const tilesEl = a.querySelector('.area-tiles');
      // The section's own files come first, as its hub.
      list.sort((x, y) => (y.own ? 1 : 0) - (x.own ? 1 : 0));
      for (const m of list) {
        const t = document.createElement('button');
        const hasChildren = logic && list.length > 1;
        t.className = 'tile' + (S.seen.has(m.id) ? ' seen' : '') + (logic && m.own && hasChildren ? ' hub' : '');
        t.dataset.id = m.id;
        t.style.setProperty('--band-i', first ? bi : 0);
        t.style.setProperty('--i', ti++);
        const name = logic && m.own && hasChildren ? 'Common' : m.label;
        t.innerHTML = `<span class="tile-flag"></span><span class="tile-name"><span class="area-dot"></span>${esc(name)}</span>`
          + `<span class="tile-meta"><span>${m.files.length} ${m.files.length === 1 ? 'file' : 'files'}</span><span>${fmtNum(m.lines)} lines</span></span>`
          + `<svg class="tile-spark" viewBox="0 0 120 16" preserveAspectRatio="none"></svg>`;
        t.addEventListener('animationend', (ev) => { if (ev.animationName === 'tile-in') t.classList.add('seen'); });
        t.addEventListener('mouseenter', () => setHover(m.id, t));
        t.addEventListener('mouseleave', () => setHover(null));
        t.addEventListener('click', () => selectModule(m.id));
        tilesEl.appendChild(t);
        S.tiles.set(m.id, t);
      }
      body.appendChild(a);
    }
    bandsEl.appendChild(band);
  });
  for (const m of view.nodes) S.seen.add(m.id);
  applyState();
  requestAnimationFrame(() => { fit(); drawEdges(first); });
}

/** Scale the map so it fills the screen: largest zoom whose height still fits. */
function fit() {
  const bar = [$('map-bar'), $('rt-bar')].find((b) => !b.hidden);
  const offset = bar ? bar.offsetHeight + 20 : 0;
  inner.style.marginTop = `${offset}px`;
  const availW = map.clientWidth;
  const availH = map.clientHeight - offset;
  const heightAt = (z) => {
    inner.style.width = `${availW / z}px`;
    return inner.offsetHeight * z;
  };
  let lo = 0.45;
  let hi = 1.9;
  for (let i = 0; i < 9; i++) {
    const mid = (lo + hi) / 2;
    if (heightAt(mid) <= availH) lo = mid; else hi = mid;
  }
  heightAt(lo);
  inner.style.transform = `scale(${lo})`;
  S.scale = lo;
}

function posOf(el) {
  let x = 0;
  let y = 0;
  let n = el;
  while (n && n !== inner) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

function edgePath(a, b, ax, bx) {
  if (b.y > a.y + a.h / 2) {
    const sy = a.y + a.h; const ey = b.y - 3; const dy = Math.max(30, (ey - sy) * 0.5);
    return `M${ax},${sy} C${ax},${sy + dy} ${bx},${ey - dy} ${bx},${ey}`;
  }
  if (b.y + b.h < a.y + a.h / 2) {
    const sy = a.y; const ey = b.y + b.h + 3; const dy = Math.max(30, (sy - ey) * 0.5);
    return `M${ax},${sy} C${ax},${sy - dy} ${bx},${ey + dy} ${bx},${ey}`;
  }
  const top = Math.min(a.y, b.y);
  const lift = 26 + Math.abs(ax - bx) * 0.12;
  return `M${ax},${a.y} C${ax},${top - lift} ${bx},${top - lift} ${bx},${b.y - 3}`;
}

/** Which side of a tile an edge leaves or enters: 'top' or 'bottom'. */
function sides(a, b) {
  if (b.y > a.y + a.h / 2) return ['bottom', 'top'];
  if (b.y + b.h < a.y + a.h / 2) return ['top', 'bottom'];
  return ['top', 'top'];
}

function drawEdges(animate = false) {
  edgesSvg.setAttribute('width', inner.offsetWidth);
  edgesSvg.setAttribute('height', inner.offsetHeight);
  edgeLayer.innerHTML = '';
  const edges = [...V().edges].sort((a, b) => b.weight - a.weight).slice(0, 180);
  const pos = new Map([...S.tiles].map(([id, t]) => [id, posOf(t)]));
  const list = edges.filter((e) => pos.has(e.from) && pos.has(e.to));
  // Spread the anchors of each tile side, ordered by where the other end sits.
  const ports = new Map();
  const addPort = (id, side, e, otherX) => {
    const k = `${id}|${side}`;
    if (!ports.has(k)) ports.set(k, []);
    ports.get(k).push({ e, otherX });
  };
  for (const e of list) {
    const a = pos.get(e.from); const b = pos.get(e.to);
    const [sa, sb] = sides(a, b);
    e._sa = sa; e._sb = sb;
    addPort(e.from, sa, e, b.x + b.w / 2);
    addPort(e.to, sb, e, a.x + a.w / 2);
  }
  const anchor = new Map();
  for (const [k, arr] of ports) {
    const [id] = k.split('|');
    const p = pos.get(id);
    arr.sort((x, y) => x.otherX - y.otherX);
    arr.forEach((it, i) => {
      const x = arr.length === 1 ? p.x + p.w / 2 : p.x + p.w * (0.18 + 0.64 * (i / (arr.length - 1)));
      anchor.set(`${k}|${it.e.from}>${it.e.to}`, x);
    });
  }
  for (const e of list) {
    const a = pos.get(e.from); const b = pos.get(e.to);
    const key = `${e.from}>${e.to}`;
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', edgePath(a, b, anchor.get(`${e.from}|${e._sa}|${key}`), anchor.get(`${e.to}|${e._sb}|${key}`)));
    p.setAttribute('class', S.view === 'runtime' ? 'edge flow' : 'edge');
    p.dataset.from = e.from;
    p.dataset.to = e.to;
    p.style.setProperty('--w', (1 + Math.log2(e.weight) * 0.55).toFixed(2));
    edgeLayer.appendChild(p);
    if (animate) {
      const len = p.getTotalLength();
      p.style.setProperty('--len', len);
      p.style.setProperty('--d', `${700 + Math.random() * 900}ms`);
      p.classList.add('drawn');
      setTimeout(() => p.classList.remove('drawn'), 3000);
    }
  }
  if (S.hover) setHover(S.hover);
}

// ---------- live state ----------

function moduleHeat() {
  const t = now();
  const heat = new Map();
  const spark = new Map();
  for (const a of S.activity) {
    const mods = a.kind === 'commit' ? [] : [modOf(a)];
    for (const m of mods) {
      if (!m) continue;
      const age = t - a.t;
      if (age < 4 * HEAT_TAU) heat.set(m, (heat.get(m) || 0) + Math.exp(-age / HEAT_TAU));
      if (age < SPARK_SPAN) {
        const b = SPARK_BUCKETS - 1 - Math.floor(age / (SPARK_SPAN / SPARK_BUCKETS));
        if (!spark.has(m)) spark.set(m, new Array(SPARK_BUCKETS).fill(0));
        spark.get(m)[b]++;
      }
    }
  }
  for (const [m, v] of heat) heat.set(m, 1 - Math.exp(-v * 0.8));
  return { heat, spark };
}

function focusModule() {
  const t = now();
  const fresh = S.activity.find((a) => a.kind !== 'commit' && modOf(a) && !a.seeded && t - a.t < FOCUS_WINDOW);
  if (fresh) return modOf(fresh);
  const any = S.activity.find((a) => a.kind !== 'commit' && modOf(a));
  return any ? modOf(any) : null;
}

function applyState() {
  if (!S.graph) return;
  if (S.view === 'runtime') { applyRuntimeState(); return; }
  const live = new Set((S.git.live || []).map((l) => nodeOf(l.path)));
  const committed = new Set(commitNodes(S.git.commits?.[0]));
  const { heat, spark } = moduleHeat();
  const focus = focusModule();
  for (const [id, t] of S.tiles) {
    t.style.setProperty('--heat', (Math.max(heat.get(id) || 0, live.has(id) ? 0.16 : 0)).toFixed(3));
    t.classList.toggle('is-live', live.has(id));
    t.classList.toggle('committed', committed.has(id));
    t.classList.toggle('focus', id === focus);
    t.classList.toggle('selected', id === S.selected);
    const counts = spark.get(id) || [];
    const svg = t.querySelector('.tile-spark');
    let html = '';
    for (let i = 0; i < SPARK_BUCKETS; i++) {
      const c = counts[i] || 0;
      const h = c ? Math.min(16, 4 + c * 3) : 2;
      html += `<rect x="${i * 10}" y="${16 - h}" width="7" height="${h}" rx="1"${c ? ' class="on"' : ''}/>`;
    }
    svg.innerHTML = html;
  }
  for (const band of bandsEl.children) {
    band.classList.toggle('hot', !!focus && !!band.querySelector(`.tile[data-id="${CSS.escape(focus)}"]`));
  }
}

// ---------- hover / focus ----------

function setHover(id, tileEl) {
  S.hover = id;
  const tip = $('tip');
  if (!id) {
    map.classList.remove('focusing');
    edgesSvg.classList.remove('focusing');
    for (const p of edgeLayer.children) p.classList.remove('hot', 'in');
    for (const t of S.tiles.values()) t.classList.remove('near', 'center');
    tip.hidden = true;
    if (S.pinned) highlightModules(commitNodes(S.pinned));
    return;
  }
  const near = new Set([id]);
  let outN = 0;
  let inN = 0;
  for (const p of edgeLayer.children) {
    const out = p.dataset.from === id;
    const inc = p.dataset.to === id;
    p.classList.toggle('hot', out);
    p.classList.toggle('in', inc);
    if (out) { near.add(p.dataset.to); outN++; }
    if (inc) { near.add(p.dataset.from); inN++; }
  }
  for (const [mid, t] of S.tiles) {
    t.classList.toggle('near', near.has(mid));
    t.classList.toggle('center', mid === id);
  }
  map.classList.add('focusing');
  edgesSvg.classList.add('focusing');
  const m = nodeById(id);
  if (tileEl && m) {
    const liveFiles = (S.git.live || []).filter((l) => nodeOf(l.path) === id);
    tip.innerHTML = `<b>${esc(S.view === 'logic' ? m.label : m.path === '.' ? m.label : m.path)}</b>`
      + (m.description ? `<div class="t-sub">${esc(m.description)}</div>` : '')
      + `<div class="t-sub">${esc(groupName(m.group))} · ${m.files.length} files · uses ${outN} · used by ${inN}</div>`
      + (liveFiles.length ? `<div class="t-sub">${liveFiles.length} uncommitted ${liveFiles.length === 1 ? 'file' : 'files'}</div>` : '');
    tip.hidden = false;
    const r = tileEl.getBoundingClientRect();
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(window.innerWidth - tw - 12, Math.max(12, r.left + r.width / 2 - tw / 2))}px`;
    tip.style.top = `${r.top - tip.offsetHeight - 10 < 8 ? r.bottom + 10 : r.top - tip.offsetHeight - 10}px`;
  }
}

function highlightModules(ids) {
  const set = new Set(ids);
  if (!set.size) { setHover(null); return; }
  map.classList.add('focusing');
  for (const [mid, t] of S.tiles) { t.classList.toggle('near', set.has(mid)); t.classList.toggle('center', false); }
}

// ---------- activity ----------

function onActivity(a) {
  S.activity.unshift(a);
  if (S.activity.length > 200) S.activity.length = 200;
  prependFeed(a, true);
  renderNow(true);
  applyState();
  if (a.kind === 'commit') {
    flash(a);
    pulseModules(commitNodes(a), 'replay', 2400);
  } else if (modOf(a)) {
    pulse(modOf(a));
    impact(modOf(a));
  }
}

function pulse(id, error = false) {
  const t = S.tiles.get(id);
  if (!t) return;
  const r = document.createElement('span');
  r.className = error ? 'ripple err' : 'ripple';
  t.appendChild(r);
  setTimeout(() => r.remove(), 1200);
  t.classList.remove('bump');
  void t.offsetWidth;
  t.classList.add('bump');
}

function pulseModules(ids, cls, ms) {
  for (const id of ids) S.tiles.get(id)?.classList.add(cls);
  setTimeout(() => { for (const id of ids) S.tiles.get(id)?.classList.remove(cls); }, ms);
}

/** Sends a spark along an edge path. `reverse` runs it from the arrow head back to the start. */
function travel(p, { reverse = false, error = false, done } = {}) {
  if ((S.sparks || 0) > 90) { done?.(); return; }
  S.sparks = (S.sparks || 0) + 1;
  const len = p.getTotalLength();
  const c = document.createElementNS(SVGNS, 'circle');
  c.setAttribute('r', 4);
  c.setAttribute('class', error ? 'spark err' : 'spark');
  sparkLayer.appendChild(c);
  const start = performance.now();
  const dur = 750 + Math.random() * 300;
  const step = (ts) => {
    const k = Math.min(1, (ts - start) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    const pt = p.getPointAtLength(len * (reverse ? 1 - e : e));
    c.setAttribute('cx', pt.x);
    c.setAttribute('cy', pt.y);
    c.setAttribute('opacity', k > 0.85 ? (1 - k) / 0.15 : 1);
    if (k < 1) requestAnimationFrame(step);
    else { c.remove(); S.sparks--; done?.(); }
  };
  requestAnimationFrame(step);
}

/** Sparks run from the changed module to every module that depends on it. */
function impact(id) {
  for (const p of edgeLayer.children) {
    if (p.dataset.to !== id) continue;
    p.classList.add('hot');
    travel(p, {
      reverse: true,
      done: () => {
        if (S.hover !== p.dataset.from && S.hover !== p.dataset.to) p.classList.remove('hot');
        pulse(p.dataset.from);
      },
    });
  }
}

function flash(a) {
  const f = $('flash');
  f.hidden = true;
  void f.offsetWidth;
  f.innerHTML = `<span class="eyebrow">New commit · ${esc(a.short || '')}</span><strong>${esc(a.subject || '')}</strong>`
    + `<span class="sub">${esc(a.author || '')} · ${commitNodes(a).length} ${commitNodes(a).length === 1 ? 'part' : 'parts'}</span>`;
  f.hidden = false;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => { f.hidden = true; }, 3300);
}

// ---------- header ----------

function countTo(el, value) {
  const from = Number(el.dataset.v || 0);
  el.dataset.v = value;
  const start = performance.now();
  const step = (ts) => {
    const k = Math.min(1, (ts - start) / 900);
    const v = Math.round(from + (value - from) * (1 - Math.pow(1 - k, 3)));
    el.textContent = fmtNum(v);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderHeader() {
  const g = S.graph;
  if (!g) return;
  $('repo-name').textContent = g.repo.name;
  document.title = `${g.repo.name} · Architecture Overview`;
  const br = $('branch');
  br.hidden = !S.git.branch;
  $('branch-name').textContent = S.git.branch || '';
  countTo($('st-modules'), V().nodes.length);
  countTo($('st-files'), g.stats.files);
  countTo($('st-lines'), g.stats.lines);
  countTo($('st-edges'), V().edges.length);
}

// ---------- now ----------

function renderNow(animate = false) {
  if (S.view === 'runtime') { renderTraffic(); return; }
  const box = $('now');
  const body = $('now-body');
  const t = now();
  const last = S.activity.find((a) => a.kind !== 'commit' && modOf(a));
  const recent = last && !last.seeded && t - last.t < FOCUS_WINDOW;
  box.classList.toggle('idle', !recent);
  box.querySelector('.eyebrow').textContent = recent ? 'Working on now' : (S.git.live?.length ? 'Uncommitted work' : 'Last activity');
  if (!last) {
    const c = S.git.commits?.[0];
    if (c) {
      box.querySelector('.eyebrow').textContent = 'Last commit';
      const syms = (c.touched || []).flatMap((x) => x.symbols || []).slice(0, 5);
      body.innerHTML = `<span class="now-module">${esc(commitNodes(c).map(label).slice(0, 2).join(' · ') || S.graph?.repo.name || '')}</span>`
        + `<div class="now-file">${esc(c.subject)}</div>`
        + (syms.length ? `<div class="now-syms">${syms.map(symChip).join('')}</div>` : '')
        + `<div class="now-foot"><span data-t="${c.time}">${ago(c.time)}</span><span>Save a file and the map follows you</span></div>`;
      return;
    }
    body.innerHTML = `<span class="now-module">Waiting</span><div class="now-file">Save a file in this repo and the map follows you.</div>`;
    return;
  }
  const lastNode = modOf(last);
  const m = nodeById(lastNode);
  const syms = (last.symbols || []).slice(0, 5);
  const streak = S.activity.filter((a) => modOf(a) === lastNode && a.kind !== 'commit' && t - a.t < FOCUS_WINDOW && !a.seeded).length;
  body.innerHTML = `<span class="now-module">${esc(m?.label || lastNode)}</span>`
    + (S.view === 'logic' && m && !m.own ? `<div class="now-group">${esc(groupName(m.group))}</div>` : '')
    + `<div class="now-file">${esc(dir(last.file))}/<b>${esc(base(last.file))}</b>${last.line ? ` · line ${last.line}` : ''}</div>`
    + (syms.length ? `<div class="now-syms">${syms.map(symChip).join('')}</div>` : '')
    + `<div class="now-foot"><span data-t="${last.t}">${ago(last.t)}</span>`
    + (recent ? `<span><b>${streak}</b> ${streak === 1 ? 'save' : 'saves'} here in 30 min</span>` : `<span>${(S.git.live || []).length} files uncommitted</span>`)
    + '</div>';
  if (animate) { box.classList.remove('flash-in'); void box.offsetWidth; box.classList.add('flash-in'); }
}

// ---------- feed ----------

function feedItem(a) {
  const li = document.createElement('li');
  if (a.seeded) li.classList.add('seeded');
  let title;
  let sub;
  let syms = [];
  if (a.kind === 'commit') {
    title = esc(a.subject);
    sub = `${esc(a.short)} · ${esc(a.author)} · ${commitNodes(a).map((m) => esc(label(m))).join(', ') || 'no source files'}`;
    syms = (a.touched || []).flatMap((x) => x.symbols || []).slice(0, 4);
  } else {
    title = esc(base(a.file));
    const verb = { edit: a.seeded ? 'uncommitted' : 'edited', add: 'new file', delete: 'deleted' }[a.kind];
    sub = `${esc(label(modOf(a)) || '')} · ${verb}`;
    syms = (a.symbols || []).slice(0, 4);
  }
  const delta = a.added || a.removed ? `<span class="f-delta">${a.added ? `<span class="add">+${a.added}</span> ` : ''}${a.removed ? `<span class="del">−${a.removed}</span>` : ''}</span>` : '';
  li.innerHTML = `<span class="f-icon ${a.kind}">${ICONS[a.kind] || ICONS.edit}</span>`
    + `<div class="f-main"><div class="f-title">${title}</div><div class="f-sub">${sub}</div>${syms.length ? `<div class="f-syms">${syms.map(symChip).join('')}</div>` : ''}</div>`
    + `<span class="f-time"><span data-t="${a.t}">${ago(a.t)}</span>${delta}</span>`;
  li.addEventListener('click', () => {
    if (a.kind === 'commit') { pulseModules(commitNodes(a), 'replay', 2000); return; }
    if (modOf(a)) { selectModule(modOf(a)); pulse(modOf(a)); }
  });
  li.addEventListener('mouseenter', () => highlightModules(a.kind === 'commit' ? commitNodes(a) : [modOf(a)]));
  li.addEventListener('mouseleave', () => setHover(null));
  return li;
}

function renderFeed() {
  const feed = $('feed');
  feed.innerHTML = '';
  for (const a of S.activity.slice(0, 80)) feed.appendChild(feedItem(a));
  $('feed-count').textContent = `${S.activity.length} events`;
}

function prependFeed(a, fresh) {
  const feed = $('feed');
  const li = feedItem(a);
  if (fresh) li.classList.add('fresh');
  feed.prepend(li);
  while (feed.children.length > 80) feed.lastChild.remove();
  $('feed-count').textContent = `${S.activity.length} events`;
}

setInterval(() => {
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = ago(Number(el.dataset.t));
  applyState();
}, 10000);

// ---------- detail ----------

function selectModule(id) {
  S.selected = id;
  renderDetail(id);
  applyState();
}

function closeDetail() {
  S.selected = null;
  $('detail').hidden = true;
  applyState();
}

function renderDetail(id) {
  const m = nodeById(id);
  if (!m) return;
  const edges = V().edges;
  const outs = edges.filter((e) => e.from === id).sort((a, b) => b.weight - a.weight);
  const ins = edges.filter((e) => e.to === id).sort((a, b) => b.weight - a.weight);
  const live = new Set((S.git.live || []).map((l) => l.path).filter((p) => nodeOf(p) === id));
  const chips = (list, key) => list.map((e) => `<button class="d-chip" data-go="${esc(e[key])}">${esc(label(e[key]))} <span style="color:var(--steel)">${e.weight}</span></button>`).join('') || '<span class="f-sub">none</span>';
  const info = (p) => S.graph.files[p] || { lines: 0, symbols: [] };
  const files = [...m.files].sort((a, b) => (live.has(b) - live.has(a)) || info(b).lines - info(a).lines);
  const rel = (p) => (S.view === 'layers' && m.path !== '.' ? p.slice(m.path.length + 1) : p);
  $('detail-eyebrow').textContent = S.view === 'logic' ? `Logic · ${groupName(m.group)}` : `${groupName(m.group)} · ${areaName(m.area)}`;
  const where = S.view === 'logic' ? (m.description || `${uniq(m.files.map(dir)).length} folders`) : (m.path === '.' ? 'repository root' : m.path);
  $('detail-body').innerHTML = `<div class="d-title">${esc(m.own && S.view === 'logic' ? groupName(m.group) : m.label)}</div><div class="d-path">${esc(where)} · ${m.files.length} files · ${fmtNum(m.lines)} lines</div>`
    + `<div class="d-sec"><span class="eyebrow">Uses</span><div class="d-row">${chips(outs, 'to')}</div></div>`
    + `<div class="d-sec"><span class="eyebrow">Used by</span><div class="d-row">${chips(ins, 'from')}</div></div>`
    + `<div class="d-sec"><span class="eyebrow">Files</span>${files.map((f) => {
      const fi = info(f);
      return `<div class="d-file${live.has(f) ? ' live' : ''}"><div class="d-file-name"><span>${esc(rel(f))}</span><span>${fi.lines}</span></div>`
        + (fi.symbols.length ? `<div class="d-syms">${fi.symbols.slice(0, 10).map(([name, kind]) => symChip({ name, kind })).join('')}${fi.symbols.length > 10 ? `<span class="f-sub">+${fi.symbols.length - 10}</span>` : ''}</div>` : '')
        + '</div>';
    }).join('')}</div>`;
  for (const b of $('detail-body').querySelectorAll('[data-go]')) b.addEventListener('click', () => selectModule(b.dataset.go));
  $('detail').hidden = false;
  document.body.classList.remove('no-rail');
}

$('detail-close').addEventListener('click', closeDetail);

// ---------- timeline ----------

function renderTimeline() {
  const dots = $('tl-dots');
  dots.innerHTML = '';
  const commits = [...(S.git.commits || [])].slice(0, 40).reverse();
  if (!commits.length) {
    $('tl-caption-text').textContent = S.git.enabled ? 'No commits yet' : 'Not a git repository';
    return;
  }
  commits.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'tl-dot' + (i === commits.length - 1 ? ' head' : '');
    const pos = commits.length === 1 ? 50 : 2 + (i / (commits.length - 1)) * 96;
    b.style.left = `${pos}%`;
    b.style.setProperty('--s', `${10 + Math.min(12, c.files.length)}px`);
    b.style.setProperty('--i', i);
    b.setAttribute('aria-label', c.subject);
    b.addEventListener('mouseenter', () => showCommit(c, b));
    b.addEventListener('mouseleave', () => { if (!S.replay) restoreCaption(); setHover(null); });
    b.addEventListener('click', () => {
      S.pinned = S.pinned?.hash === c.hash ? null : c;
      for (const d of dots.children) d.classList.toggle('on', d === b && !!S.pinned);
      if (S.pinned) highlightModules(commitNodes(c)); else setHover(null);
    });
    c.el = b;
    dots.appendChild(b);
  });
  restoreCaption();
}

function showCommit(c, dotEl) {
  $('tl-caption-text').innerHTML = `<b style="color:var(--paper)">${esc(c.subject)}</b> · ${esc(c.short)} · ${esc(c.author)} · ${ago(c.time)}`;
  highlightModules(commitNodes(c));
  if (dotEl) {
    const tip = $('tip');
    tip.innerHTML = `<b>${esc(c.subject)}</b><div class="t-sub">${esc(c.short)} · ${ago(c.time)} ago · ${c.files.length} files</div>`
      + `<div class="t-sub">${commitNodes(c).map((m) => esc(label(m))).join(' · ') || 'no source files'}</div>`;
    tip.hidden = false;
    const r = dotEl.getBoundingClientRect();
    tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 12, Math.max(12, r.left - tip.offsetWidth / 2))}px`;
    tip.style.top = `${r.top - tip.offsetHeight - 14}px`;
  }
}

function restoreCaption() {
  const head = S.git.commits?.[0];
  $('tl-caption-text').innerHTML = head ? `Last commit <b style="color:var(--paper)">${esc(head.subject)}</b> · ${ago(head.time)}` : '';
}

async function replay() {
  const btn = $('btn-replay');
  if (S.replay) { S.replay.stop = true; return; }
  const commits = [...(S.git.commits || [])].slice(0, 15).reverse();
  if (!commits.length) return;
  const run = { stop: false };
  S.replay = run;
  btn.classList.add('playing');
  btn.querySelector('span').textContent = 'Stop';
  for (const c of commits) {
    if (run.stop) break;
    for (const d of $('tl-dots').children) d.classList.toggle('on', d === c.el);
    $('tl-caption-text').innerHTML = `<b style="color:var(--paper)">${esc(c.subject)}</b> · ${ago(c.time)} ago`;
    const parts = commitNodes(c);
    highlightModules(parts);
    pulseModules(parts, 'replay', 1100);
    for (const m of parts) { pulse(m); impact(m); }
    await new Promise((r) => setTimeout(r, 1500));
  }
  for (const d of $('tl-dots').children) d.classList.remove('on');
  S.replay = null;
  btn.classList.remove('playing');
  btn.querySelector('span').textContent = 'Replay';
  setHover(null);
  restoreCaption();
}

// ---------- runtime (OpenTelemetry) ----------

const RT_WINDOW = 5 * 60e3;
const RT_RATE = 60e3;
const fmtMs = (ms) => (ms < 1 ? '<1 ms' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`);

function rtInit(o) {
  S.rt = { spans: [], byId: new Map(), received: o?.received || 0, services: o?.services || [], port: o?.port ?? null,
    mainPort: o?.mainPort, edges: [], edgeKey: '', metrics: new Map(), unmapped: new Map(), roots: [], pinned: null };
  for (const sp of o?.spans || []) rtAdd(sp, sp.st);
  rtRecompute();
}

function rtAdd(sp, at) {
  sp.at = at;
  S.rt.spans.push(sp);
  S.rt.byId.set(sp.id, sp);
}

const isRoot = (sp) => !sp.p || !S.rt.byId.has(sp.p);

/** Logic part of a span; spans without a file take their parent's. Children often arrive first. */
function spanNode(sp, depth = 0) {
  if (sp._node && sp._v === S.ownerVersion) return sp._node;
  let n = S.graph ? nodeOf(sp.f) : null;
  if (!n && sp.p && depth < 16) {
    const parent = S.rt.byId.get(sp.p);
    if (parent) n = spanNode(parent, depth + 1);
  }
  if (n) { sp._node = n; sp._v = S.ownerVersion; }
  return n;
}

function rtRecompute() {
  const rt = S.rt;
  if (!rt) return;
  const t = Date.now();
  const cut = t - RT_WINDOW;
  let drop = 0;
  while (drop < rt.spans.length && rt.spans[drop].at < cut) rt.byId.delete(rt.spans[drop++].id);
  if (drop) rt.spans.splice(0, drop);
  const metrics = new Map();
  const edges = new Map();
  const unmapped = new Map();
  const bucket = RT_RATE / SPARK_BUCKETS;
  for (const sp of rt.spans) {
    const n = spanNode(sp);
    const parent = sp.p ? rt.byId.get(sp.p) : null;
    const pn = parent ? spanNode(parent) : null;
    if (!n) {
      if (!parent) unmapped.set(sp.l || sp.n, (unmapped.get(sp.l || sp.n) || 0) + 1);
      continue;
    }
    if (pn && pn !== n) edges.set(`${pn}\u0000${n}`, (edges.get(`${pn}\u0000${n}`) || 0) + 1);
    const age = t - sp.at;
    if (age > RT_RATE) continue;
    let m = metrics.get(n);
    if (!m) metrics.set(n, (m = { count: 0, errors: 0, durs: [], spark: new Array(SPARK_BUCKETS).fill(0) }));
    // A call into a part is a span whose caller sits elsewhere (or nowhere).
    if (pn !== n) {
      m.count++;
      m.durs.push(sp.d);
      m.spark[SPARK_BUCKETS - 1 - Math.min(SPARK_BUCKETS - 1, Math.floor(age / bucket))]++;
    }
    if (sp.e) m.errors++;
  }
  for (const m of metrics.values()) {
    m.durs.sort((a, b) => a - b);
    m.p95 = m.durs.length ? m.durs[Math.min(m.durs.length - 1, Math.floor(m.durs.length * 0.95))] : 0;
  }
  rt.metrics = metrics;
  rt.unmapped = unmapped;
  rt.edges = [...edges].map(([k, w]) => { const [from, to] = k.split('\u0000'); return { from, to, weight: w }; });
  rt.roots = rt.spans.filter(isRoot).slice(-40).reverse();
  const key = rt.edges.map((e) => `${e.from}>${e.to}`).sort().join('|');
  if (S.view === 'runtime' && key !== rt.edgeKey && S.tiles.size) {
    rt.edgeKey = key;
    drawEdges(false);
    countTo($('st-edges'), rt.edges.length);
  }
}

function applyRuntimeState() {
  const rt = S.rt;
  for (const [id, t] of S.tiles) {
    const m = rt.metrics.get(id);
    const count = m?.count || 0;
    t.style.setProperty('--heat', (1 - Math.exp(-count / 8)).toFixed(3));
    t.classList.toggle('is-error', !!m?.errors);
    t.classList.toggle('idle', !count && !m?.errors);
    t.classList.remove('is-live', 'committed', 'focus');
    t.classList.toggle('selected', id === S.selected);
    t.querySelector('.tile-meta').innerHTML = m
      ? `<span>${count}/min</span><span>p95 ${fmtMs(m.p95)}</span>${m.errors ? `<span class="err">${m.errors} ${m.errors === 1 ? 'error' : 'errors'}</span>` : ''}`
      : '<span>no traffic</span>';
    let html = '';
    for (let i = 0; i < SPARK_BUCKETS; i++) {
      const c = m?.spark[i] || 0;
      const h = c ? Math.min(16, 3 + c * 2) : 2;
      html += `<rect x="${i * 10}" y="${16 - h}" width="7" height="${h}" rx="1"${c ? ' class="on"' : ''}/>`;
    }
    t.querySelector('.tile-spark').innerHTML = html;
  }
  for (const band of bandsEl.children) {
    band.classList.toggle('hot', [...band.querySelectorAll('.tile')].some((x) => !x.classList.contains('idle')));
  }
}

function onSpans(d) {
  const rt = S.rt;
  rt.received = d.received;
  rt.services = d.services;
  const at = Date.now();
  for (const sp of d.spans) rtAdd(sp, at);
  if (S.view !== 'runtime') return;
  rtRecompute();
  applyRuntimeState();
  renderTraffic();
  renderRuntimeChrome();
  // Replay each trace in its real order, compressed to at most 1.5 s.
  const byTrace = new Map();
  for (const sp of d.spans) {
    if (!byTrace.has(sp.tr)) byTrace.set(sp.tr, []);
    byTrace.get(sp.tr).push(sp);
  }
  for (const list of byTrace.values()) {
    list.sort((a, b) => a.st - b.st);
    const t0 = list[0].st;
    const span = Math.max(1, list[list.length - 1].st - t0);
    const k = span > 1500 ? 1500 / span : 1;
    for (const sp of list) setTimeout(() => rtSpark(sp), (sp.st - t0) * k);
  }
}

function rtSpark(sp) {
  const n = spanNode(sp);
  if (!n) return;
  const parent = sp.p ? S.rt.byId.get(sp.p) : null;
  const pn = parent ? spanNode(parent) : null;
  if (!pn) { pulse(n, !!sp.e); return; }
  if (pn === n) { if (sp.e) pulse(n, true); return; }
  const path = edgeLayer.querySelector(`path[data-from="${CSS.escape(pn)}"][data-to="${CSS.escape(n)}"]`);
  if (path) travel(path, { error: !!sp.e, done: () => pulse(n, !!sp.e) });
  else pulse(n, !!sp.e);
}

function renderTraffic() {
  const box = $('now');
  const body = $('now-body');
  const rt = S.rt;
  const t = Date.now();
  const roots = rt.spans.filter((sp) => isRoot(sp) && t - sp.at <= RT_RATE);
  const errors = roots.filter((sp) => sp.e).length;
  const durs = roots.map((sp) => sp.d).sort((a, b) => a - b);
  const p95 = durs.length ? durs[Math.min(durs.length - 1, Math.floor(durs.length * 0.95))] : 0;
  box.classList.toggle('idle', !roots.length);
  box.querySelector('.eyebrow').textContent = rt.received ? 'Live traffic · last minute' : 'Live traffic';
  if (!rt.received) {
    body.innerHTML = '<span class="now-module">No telemetry yet</span><div class="now-file">Start your app with an OpenTelemetry exporter pointed at this tool. The map shows how.</div>';
    return;
  }
  body.innerHTML = `<span class="now-module">${roots.length}<small> req/min</small></span>`
    + `<div class="rt-kpis"><span><b>${fmtMs(p95)}</b> p95</span><span class="${errors ? 'bad' : ''}"><b>${roots.length ? Math.round((errors / roots.length) * 100) : 0}%</b> errors</span><span><b>${rt.metrics.size}</b> parts busy</span></div>`
    + `<div class="now-foot"><span>${rt.services.map(esc).join(' · ') || ''}</span><span>${fmtNum(rt.received)} spans received</span></div>`;
  renderTraces();
}

function renderTraces() {
  const list = $('traces');
  const rt = S.rt;
  const counts = new Map();
  for (const sp of rt.spans) counts.set(sp.tr, (counts.get(sp.tr) || 0) + 1);
  list.innerHTML = '';
  for (const sp of rt.roots.slice(0, 30)) {
    const li = document.createElement('li');
    const n = spanNode(sp);
    const title = sp.l && sp.l !== sp.n ? `${/^[A-Z]+$/.test(sp.n) ? sp.n + ' ' : ''}${sp.l}` : sp.n;
    li.className = (sp.e ? 'bad' : '') + (rt.pinned === sp.tr ? ' on' : '');
    li.innerHTML = `<span class="tr-dot"></span><div class="f-main"><div class="f-title">${esc(title)}</div>`
      + `<div class="f-sub">${esc(n ? label(n) : 'not on the map')} · ${counts.get(sp.tr) || 1} spans${sp.e && sp.em ? ` · ${esc(sp.em)}` : ''}</div></div>`
      + `<span class="f-time">${fmtMs(sp.d)}<span class="f-delta">${ago(sp.at - S.skew)}</span></span>`;
    li.addEventListener('click', () => showTrace(sp.tr));
    li.addEventListener('mouseenter', () => highlightModules(uniq(rt.spans.filter((x) => x.tr === sp.tr).map((x) => spanNode(x)))));
    li.addEventListener('mouseleave', () => setHover(null));
    list.appendChild(li);
  }
  const un = [...rt.unmapped].sort((a, b) => b[1] - a[1]).slice(0, 4);
  $('traces-unmapped').innerHTML = un.length ? `Not on the map: ${un.map(([k, c]) => `<code>${esc(k)}</code> ${c}`).join(' · ')}` : '';
  $('traces-count').textContent = `${rt.roots.length} in 5 min`;
}

/** Waterfall of one trace in the detail panel; its parts light up on the map. */
function showTrace(tr) {
  const rt = S.rt;
  rt.pinned = tr;
  const mine = rt.spans.filter((x) => x.tr === tr);
  if (!mine.length) return;
  const byId = new Map(mine.map((x) => [x.id, x]));
  const depth = new Map();
  const depthOf = (sp, guard = 0) => {
    if (depth.has(sp.id)) return depth.get(sp.id);
    const parent = sp.p && byId.get(sp.p);
    const d = parent && guard < 32 ? depthOf(parent, guard + 1) + 1 : 0;
    depth.set(sp.id, d);
    return d;
  };
  // Parents before children when they start in the same millisecond.
  const spans = mine.sort((a, b) => a.st - b.st || depthOf(a) - depthOf(b));
  const t0 = spans[0].st;
  const total = Math.max(1, ...spans.map((x) => x.st + x.d - t0));
  const root = spans.find(isRoot) || spans[0];
  $('detail-eyebrow').textContent = `Trace · ${tr.slice(0, 8)}`;
  $('detail-body').innerHTML = `<div class="d-title">${esc(root.l && root.l !== root.n ? root.l : root.n)}</div>`
    + `<div class="d-path">${esc(root.svc)} · ${fmtMs(total)} · ${spans.length} spans</div>`
    + '<div class="wf">' + spans.map((sp) => {
      const n = spanNode(sp);
      const left = ((sp.st - t0) / total) * 100;
      const width = Math.max(0.8, (sp.d / total) * 100);
      return `<div class="wf-row${sp.e ? ' bad' : ''}" data-node="${esc(n || '')}"><div class="wf-label" style="padding-left:${Math.min(5, depth.get(sp.id)) * 10}px">`
        + `<b>${esc(n ? label(n) : '?')}</b> ${esc(sp.l && sp.l !== sp.n ? sp.l : sp.n)}</div>`
        + `<div class="wf-track"><span class="wf-bar" style="left:${left}%;width:${width}%"></span></div><div class="wf-ms">${fmtMs(sp.d)}</div></div>`;
    }).join('') + '</div>';
  for (const row of $('detail-body').querySelectorAll('.wf-row[data-node]')) {
    if (row.dataset.node) row.addEventListener('mouseenter', () => highlightModules([row.dataset.node]));
  }
  $('detail').hidden = false;
  highlightModules(uniq(spans.map((x) => spanNode(x))));
  renderTraces();
}

function renderRuntimeChrome() {
  const rt = S.rt;
  if (!rt) return;
  const receiving = rt.received > 0;
  const fresh = rt.spans.length && Date.now() - rt.spans[rt.spans.length - 1].at < 15000;
  const bar = $('rt-bar');
  bar.classList.toggle('on', !!fresh);
  $('rt-status').textContent = fresh ? `Receiving from ${rt.services.join(', ')}` : receiving ? 'Quiet: no spans in the last 15 s' : 'Waiting for OpenTelemetry';
  const endpoint = rt.port ? `http://localhost:${rt.port}` : `http://localhost:${rt.mainPort || location.port}`;
  $('rt-endpoint').textContent = `OTLP ${endpoint}`;
  $('rt-empty').hidden = S.view !== 'runtime' || receiving;
  const pm = S.graph?.repo.pm || 'npm';
  $('rt-cmd').textContent = `OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint} \\\nOTEL_SERVICE_NAME=${S.graph?.repo.name || 'my-app'} \\\nNODE_OPTIONS="--import @opentelemetry/auto-instrumentations-node/register" \\\n${pm === 'npm' ? 'npm run dev' : `${pm} dev`}`;
  $('rt-install').textContent = `${pm === 'npm' ? 'npm i' : `${pm} add`} @opentelemetry/auto-instrumentations-node`;
}

setInterval(() => {
  if (S.view !== 'runtime' || !S.rt) return;
  rtRecompute();
  applyRuntimeState();
  renderTraffic();
  renderRuntimeChrome();
}, 2000);

// ---------- controls ----------

$('btn-replay').addEventListener('click', replay);
$('rt-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('rt-cmd').textContent.replace(/\\\n/g, '')); toast(`Copied. Install once: ${$('rt-install').textContent}`); }
  catch { toast('Copy was blocked by the browser.'); }
});
for (const b of document.querySelectorAll('.switch [data-view]')) b.addEventListener('click', () => setView(b.dataset.view));
$('btn-map-claude').addEventListener('click', () => {
  S.mapping = { ...(S.mapping || {}), running: true, error: null };
  renderViewSwitch();
  fetch(`/api/logic/generate${projectQuery()}`, { method: 'POST' });
});
$('btn-map-prompt').addEventListener('click', async () => {
  const text = await (await fetch(`/api/logic/prompt${projectQuery()}`)).text();
  try {
    await navigator.clipboard.writeText(text);
    toast('Prompt copied. Paste it into Claude Code; the map updates here when the file is saved.');
  } catch {
    toast('Copy was blocked by the browser. Open /api/logic/prompt and copy it from there.');
  }
});
$('btn-rail').addEventListener('click', () => { document.body.classList.toggle('no-rail'); setTimeout(relayout, 420); });
$('btn-full').addEventListener('click', toggleFull);
function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.();
}
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, textarea')) return;
  if (e.key === 'f' || e.key === 'F') toggleFull();
  else if (e.key === 'r' || e.key === 'R') $('btn-rail').click();
  else if (e.key === 'p' || e.key === 'P') replay();
  else if (e.key === 'l' || e.key === 'L') setView({ layers: 'logic', logic: 'runtime', runtime: 'agents', agents: evalsView.enabled() ? 'evals' : usageView.enabled() ? 'usage' : 'layers', evals: usageView.enabled() ? 'usage' : 'layers', usage: 'layers' }[S.view]);
  else if (e.key === 'o' || e.key === 'O') ($('projects').hidden ? openProjects() : closeProjects());
  else if (e.key === 'Escape' && !$('projects').hidden) closeProjects();
  else if (e.key === 'Escape') { closeDetail(); S.pinned = null; if (S.rt) S.rt.pinned = null; setHover(null); }
});

function relayout() {
  if (!S.graph) return;
  fit();
  drawEdges(false);
}
let resizeT;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(relayout, 150); });
document.fonts?.ready.then(() => setTimeout(relayout, 50));

const agentsView = createAgentsView({ toast });
const evalsView = createEvalsView({ projectQuery, repoName: () => S.graph?.repo.name });
const usageView = createUsageView({ projectQuery });

/** The Evals and Usage tabs only exist for projects that have a source for them. */
function setEvalsTab(on) { setOptionalTab('evals', on); }
function setUsageTab(on) { setOptionalTab('usage', on); }
function setOptionalTab(view, on) {
  document.querySelector(`.switch [data-view="${view}"]`).hidden = !on;
  const sw = document.querySelector('.switch');
  const tabs = [...sw.querySelectorAll('[data-view]')].filter((b) => !b.hidden);
  sw.style.setProperty('--tabs', tabs.length);
  for (const b of tabs) b.dataset.idx = tabs.indexOf(b);
  sw.classList.toggle('five', tabs.length >= 5);
  document.body.classList.toggle('tabs-5', tabs.length >= 5);
  if (!on && S.view === view) setView('layers');
  renderViewSwitch();
}
$('btn-projects').addEventListener('click', () => ($('projects').hidden ? openProjects() : closeProjects()));
$('repo-name').addEventListener('click', openProjects);
$('pj-close').addEventListener('click', closeProjects);
for (const b of document.querySelectorAll('[data-pjmode]')) {
  b.addEventListener('click', () => {
    pjMode = b.dataset.pjmode;
    try { localStorage.setItem(PJMODE_KEY, pjMode); } catch { /* storage blocked */ }
    renderPjMode();
    refreshOverview();
  });
}
for (const b of document.querySelectorAll('.pj-filter [data-all]')) {
  b.addEventListener('click', () => {
    projectsAll = b.dataset.all === '1';
    for (const x of document.querySelectorAll('.pj-filter [data-all]')) x.setAttribute('aria-pressed', String(x === b));
    loadProjects();
  });
}
window.addEventListener('hashchange', () => { const p = projectFromHash(); if (p && p !== S.project) openProject(p); });
S.project = projectFromHash();
agentsView.setProject(S.project);
connect();
