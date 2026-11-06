// Agents view: Claude Code sessions on this machine, the subagents they split into,
// which models and tools they use, and where on earth their web requests go.
// Everything stays on screen, so a finished run reads like a long exposure.

const SVGNS = 'http://www.w3.org/2000/svg';
const FAMILY = { opus: '#FF6A2B', sonnet: '#6FE3FF', haiku: '#5CF0B4', fable: '#A08CFF', other: '#FFC24B', unknown: '#7F8DB3' };
const FAMILY_NAME = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable', other: 'Other', unknown: 'Unknown' };
// Harness plumbing that says nothing about the work itself.
const QUIET_TOOLS = /^(SubagentHandback|ToolSearch|ScheduleWakeup|TodoWrite|Task(Create|Update|List|Get|Stop)|mcp__ccd_)/;
const HOME = [50.1, 8.7];
const ACTIVE_MS = 60e3;
// A conversation line stays lit this long after its last message.
const HOT_MS = 15 * 60e3;
const PRECISION = {
  known: 'Seat of the organisation',
  tld: 'Country of the domain',
  ip: 'Server location, may be a network node',
  cdn: 'CDN network node, no real place',
};
const KIND_ICON = { search: '⌕', fetch: '↗', file: '✎', shell: '›_', spawn: '⑂', mcp: '◆', other: '·' };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
const short = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
function dur(ms) {
  const m = Math.round(ms / 60000);
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0) / 4294967296; };
const el = (name, attrs = {}, parent) => {
  const e = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};

export function createAgentsView({ toast = () => {} } = {}) {
  const st = { sessions: [], id: null, snap: null, world: null, visible: false, userPicked: false, project: null, everywhere: false,
    mode: 'chat', modeByUser: false, talkWide: (() => { try { return localStorage.getItem('ao-talk-wide') === '1'; } catch { return false; } })(), team: null, teamCards: new Map(), teamLinks: new Map(), teamTimer: null, nodes: new Map(), markers: new Map(), timer: null, syncTimer: null };
  const tree = $('ag-tree-lines');
  const world = $('ag-world');

  // ---------- data ----------

  async function loadWorld() {
    if (st.world) return st.world;
    st.world = await (await fetch('world-dots.json')).json();
    return st.world;
  }

  async function select(id, { user = false, full = true } = {}) {
    if (id !== st.id) st.maxCards = MAX_CARDS;
    if (user) st.userPicked = true;
    if (id !== st.id) full = true;
    st.id = id;
    const res = await fetch(`/api/agents/session?id=${encodeURIComponent(id)}`);
    if (!res.ok) return;
    st.snap = await res.json();
    st.snap.hostMap = new Map(st.snap.hosts.map((h) => [h.host, h]));
    st.snap.byId = new Map(st.snap.agents.map((a) => [a.id, a]));
    renderPicker();
    renderTree(full);
    await renderWorld(full);
    renderRail();
  }

  const within = (p, root) => !!p && (p === root || p.startsWith(root + '/'));
  /** Chats of the current project (a chat belongs where it recently worked), or all of them. */
  function scoped() {
    if (st.everywhere || !st.project) return st.sessions;
    return st.sessions.filter((s) => (s.places || []).some((p) => within(p, st.project)) || within(s.cwd, st.project));
  }

  function pickDefault() {
    const list = scoped();
    if (st.userPicked && list.some((s) => s.id === st.id)) return;
    const best = list.find((s) => s.active && s.activeAgents > 0)
      || list.find((s) => s.active && s.agents > 0)
      || list.find((s) => s.agents > 0)
      || list[0];
    if (best && best.id !== st.id) select(best.id);
    if (!best) { st.id = null; st.snap = null; renderEmpty(); }
  }

  function renderEmpty() {
    $('ag-cards').innerHTML = '<div class="ag-empty"><span class="eyebrow">No chats here yet</span><p>No Claude session has worked in this project in the last 14 days. Pick “All chats on this Mac” above to see the others.</p></div>';
    tree.innerHTML = '';
    for (const id of ['ag-now', 'ag-models', 'ag-types', 'ag-tools', 'ag-places', 'ag-tokens']) $(id).innerHTML = '';
  }

  function setProject(root) {
    if (root === st.project) return;
    st.project = root;
    st.userPicked = false;
    st.team = null;
    st.modeByUser = false;
    if (st.visible) show();
  }

  const isActive = (a) => !a.ended && Date.now() - (a.last || a.start) < ACTIVE_MS;

  // ---------- tree: an org chart of cards ----------

  const MAX_CARDS = 16;
  const KIND_LABEL = { search: 'Search', fetch: 'Web', shell: 'Shell', file: 'Files', mcp: 'MCP', spawn: 'Agents', other: 'Other' };
  const KIND_ORDER = ['spawn', 'search', 'fetch', 'shell', 'file', 'mcp', 'other'];

  function kindOf(name) {
    if (name === 'Agent' || name === 'Task') return 'spawn';
    if (name === 'WebSearch' || (/search/i.test(name) && /web|apify|rag/i.test(name))) return 'search';
    if (name === 'WebFetch' || /navigate|fetch|scrape|crawl|browser|call-actor/i.test(name)) return 'fetch';
    if (['Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep', 'NotebookEdit'].includes(name)) return 'file';
    if (name === 'Bash') return 'shell';
    if (name.startsWith('mcp__')) return 'mcp';
    return 'other';
  }

  function tallies(a) {
    const t = {};
    for (const [name, n] of Object.entries(a.tools || {})) {
      if (QUIET_TOOLS.test(name)) continue;
      const k = kindOf(name);
      t[k] = (t[k] || 0) + n;
    }
    return KIND_ORDER.filter((k) => t[k]).map((k) => [k, t[k]]);
  }

  /** Hosts each agent opened, most visited first. */
  function hostsByAgent() {
    const out = new Map();
    for (const h of st.snap.hosts) {
      if (!h.fetch) continue;
      for (const id of h.agents || []) {
        if (!out.has(id)) out.set(id, []);
        out.get(id).push(h);
      }
    }
    for (const list of out.values()) list.sort((x, y) => y.fetch - x.fetch);
    return out;
  }

  /** Cards to show: active agents first, then the latest finished; the rest fold into one card. */
  function cardOrder() {
    const subs = st.snap.agents.filter((a) => a.id !== 'main');
    const top = subs.filter((a) => a.parent === 'main' || !st.snap.byId.has(a.parent));
    const act = top.filter(isActive).sort((x, y) => (y.last || 0) - (x.last || 0));
    const done = top.filter((a) => !isActive(a)).sort((x, y) => (y.ended || y.last || 0) - (x.ended || x.last || 0));
    const shown = [...act, ...done].slice(0, st.maxCards || MAX_CARDS);
    const shownIds = new Set(shown.map((a) => a.id));
    const rest = top.filter((a) => !shownIds.has(a.id));
    return { shown, rest, top };
  }

  const famChip = (a) => `<span class="ag-fam" style="--c:${FAMILY[a.family] || FAMILY.unknown}">${esc(FAMILY_NAME[a.family] || a.family)}</span>`;
  const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 3600 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : dur(ms); };

  function cardHtml(a, hosts, kids) {
    const active = isActive(a);
    const status = active
      ? `<span class="ag-state on">working ${clock(Date.now() - a.start)}</span>`
      : `<span class="ag-state">✓ ${dur(Math.max(1000, (a.ended || a.last) - a.start))}</span>`;
    const nowLine = a.now ? `<div class="ag-act"><b>${KIND_ICON[a.now.kind] || '·'}</b> ${esc(short(prettyTarget(a.now), 46))}</div>` : '<div class="ag-act muted">starting…</div>';
    const tools = tallies(a).map(([k, n]) => `<span class="ag-tool k-${k}" data-kind="${k}"><b>${KIND_ICON[k]}</b>${KIND_LABEL[k]}<em>${fmt(n)}</em></span>`).join('');
    const hostRow = hosts.length ? `<div class="ag-hosts">${hosts.slice(0, 3).map((h) => `<span${h.precision === 'ip' || h.precision === 'cdn' ? ' class="node"' : ''}><i>${esc(h.cc || '··')}</i>${esc(short(h.host.replace(/^www\./, ''), 22))}</span>`).join('')}${hosts.length > 3 ? `<span class="more">+${hosts.length - 3}</span>` : ''}</div>` : '';
    const kidRow = kids.length ? `<div class="ag-kids"><b>⑂ ${kids.length}</b> ${kids.slice(0, 3).map((k) => `<span class="${isActive(k) ? 'on' : ''}" style="--c:${FAMILY[k.family] || FAMILY.unknown}">${esc(short(k.desc || k.type, 18))}</span>`).join('')}${kids.length > 3 ? ` +${kids.length - 3}` : ''}</div>` : '';
    return `<div class="ag-card-head">${famChip(a)}<span class="ag-type">${esc(a.type || 'agent')}</span>${status}</div>`
      + `<div class="ag-name">${esc(a.desc || a.type || 'Agent')}</div>${nowLine}`
      + (tools ? `<div class="ag-tools">${tools}</div>` : '') + hostRow + kidRow;
  }

  function rootHtml() {
    const s = st.snap;
    const main = s.byId.get('main');
    const subs = s.agents.length - 1;
    const active = s.agents.filter((a) => a.id !== 'main' && isActive(a)).length;
    return `<div class="ag-card-head">${famChip(main)}<span class="ag-type">session</span><span class="ag-state${active ? ' on' : ''}">${active ? `${active} at work` : subs ? 'all done' : 'no agents yet'}</span></div>`
      + `<div class="ag-name big">${esc(s.title || 'Session')}</div>`
      + (main.now ? `<div class="ag-act"><b>${KIND_ICON[main.now.kind] || '·'}</b> ${esc(short(prettyTarget(main.now), 60))}</div>` : '')
      + `<div class="ag-root-stats"><span><b>${subs}</b> agents</span><span><b>${s.peak}</b> peak</span><span><b>${fmt(s.fetches)}</b> pages</span></div>`;
  }

  function renderTree(full = false) {
    if (!st.snap || st.mode === 'team') return;
    const wrap = $('ag-cards');
    if (full) { wrap.innerHTML = ''; st.nodes.clear(); }
    let root = wrap.querySelector('.ag-root-card');
    let grid = wrap.querySelector('.ag-grid');
    if (!root) {
      root = document.createElement('div');
      root.className = 'ag-card ag-root-card';
      grid = document.createElement('div');
      grid.className = 'ag-grid';
      wrap.append(root, grid);
    }
    root.style.setProperty('--c', FAMILY[st.snap.byId.get('main')?.family] || FAMILY.unknown);
    root.innerHTML = rootHtml();
    root.classList.toggle('active', st.snap.agents.some((a) => a.id !== 'main' && isActive(a)));

    const { shown, rest } = cardOrder();
    const hosts = hostsByAgent();
    const kidsOf = new Map();
    for (const a of st.snap.agents) {
      if (a.id === 'main' || a.parent === 'main' || !st.snap.byId.has(a.parent)) continue;
      if (!kidsOf.has(a.parent)) kidsOf.set(a.parent, []);
      kidsOf.get(a.parent).push(a);
    }
    const keep = new Set(shown.map((a) => a.id));
    for (const [id, n] of st.nodes) if (!keep.has(id)) { n.el.remove(); st.nodes.delete(id); }
    for (const a of shown) {
      let n = st.nodes.get(a.id);
      if (!n) {
        const el = document.createElement('div');
        el.className = 'ag-card' + (full ? '' : ' born');
        el.dataset.id = a.id;
        el.addEventListener('mouseenter', (ev) => tip(ev, a.id));
        el.addEventListener('mouseleave', () => { $('tip').hidden = true; });
        n = { el };
        st.nodes.set(a.id, n);
      }
      n.el.style.setProperty('--c', FAMILY[a.family] || FAMILY.unknown);
      n.el.classList.toggle('active', isActive(a));
      n.el.classList.toggle('done', !isActive(a));
      n.el.innerHTML = cardHtml(a, hosts.get(a.id) || [], kidsOf.get(a.id) || []);
      grid.appendChild(n.el); // keeps the grid in the order of cardOrder()
    }
    let more = grid.querySelector('.ag-more');
    if (rest.length) {
      if (!more) { more = document.createElement('div'); more.className = 'ag-card ag-more'; }
      const fam = new Map();
      for (const a of rest) fam.set(a.family, (fam.get(a.family) || 0) + 1);
      const restActive = rest.filter(isActive).length;
      more.innerHTML = `<div class="ag-more-n">+${rest.length}</div><div class="ag-more-t">${restActive ? `${restActive} working, ` : ''}${rest.length - restActive} finished</div>`
        + `<div class="ag-more-fam">${[...fam].map(([f, c]) => `<span style="--c:${FAMILY[f] || FAMILY.unknown}">${FAMILY_NAME[f] || f} ${c}</span>`).join('')}</div>`;
      grid.appendChild(more);
    } else if (more) more.remove();
    // Show as many cards as fit; the rest folds into the "+N" card.
    const cards = $('ag-cards');
    if (cards.scrollHeight > cards.clientHeight + 4 && shown.length > 2) {
      st.maxCards = shown.length - 1;
      renderTree();
      return;
    }
    requestAnimationFrame(drawLines);
  }

  /** Org-chart wiring: down from the session, along a bus, down into every card. */
  function drawLines() {
    const wrap = $('ag-tree-wrap');
    const svg = tree;
    const box = wrap.getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
    svg.innerHTML = '';
    const root = wrap.querySelector('.ag-root-card');
    if (!root) return;
    const r = root.getBoundingClientRect();
    const rx = r.left + r.width / 2 - box.left;
    const ry = r.bottom - box.top;
    const cards = [...wrap.querySelectorAll('.ag-grid .ag-card')];
    if (!cards.length) return;
    // One bus line per grid row, just above that row.
    const rows = new Map();
    for (const c of cards) {
      const cr = c.getBoundingClientRect();
      const top = Math.round(cr.top - box.top);
      if (!rows.has(top)) rows.set(top, []);
      rows.get(top).push({ c, x: cr.left + cr.width / 2 - box.left, y: top });
    }
    const tops = [...rows.keys()].sort((a, b) => a - b);
    const trunkEnd = tops[tops.length - 1] - 9;
    const trunkX = rx;
    el('path', { class: 'ag-wire trunk', d: `M${rx},${ry} V${trunkEnd}` }, svg);
    for (const top of tops) {
      const items = rows.get(top);
      const busY = top - 9;
      const xs = items.map((i) => i.x).concat(trunkX);
      el('path', { class: 'ag-wire', d: `M${Math.min(...xs)},${busY} H${Math.max(...xs)}` }, svg);
      for (const it of items) {
        const id = it.c.dataset.id;
        const a = id && st.snap.byId.get(id);
        const p = el('path', { class: `ag-wire drop${a && isActive(a) ? ' live' : ''}`, d: `M${it.x},${busY} V${top}` }, svg);
        if (a) { p.style.setProperty('--c', FAMILY[a.family] || FAMILY.unknown); p.dataset.id = id; }
      }
    }
  }

  function prettyTarget(now) {
    if (!now) return '';
    const tool = String(now.tool || '').replace(/^mcp__.+?__/, '').replace(/_/g, ' ');
    if (!now.target) return tool;
    if (now.kind === 'fetch') { try { return new URL(now.target).hostname; } catch { return now.target; } }
    if (now.kind === 'file') return String(now.target).split('/').slice(-2).join('/');
    return now.target;
  }

  /** A tool call: the card flashes and the matching tool node blinks. */
  function pulseCard(id, kind) {
    const n = st.nodes.get(id);
    if (!n) return;
    const a = st.snap.byId.get(id);
    n.el.innerHTML = cardHtml(a, hostsByAgent().get(id) || [], st.snap.agents.filter((k) => k.parent === id));
    n.el.classList.remove('flash');
    void n.el.offsetWidth;
    n.el.classList.add('flash');
    n.el.querySelector(`.ag-tool[data-kind="${kind}"]`)?.classList.add('bump');
  }

  // ---------- world ----------

  const project = (lat, lng) => {
    const w = st.world;
    return [(lng + 180) / w.step, (w.latMax - lat) / w.step];
  };

  async function renderWorld(full = false) {
    if (st.mode === 'team') return;
    const w = await loadWorld();
    const W = 360 / w.step;
    const H = (w.latMax - w.latMin) / w.step;
    if (full || !world.querySelector('.ag-land')) {
      world.innerHTML = '';
      world.setAttribute('viewBox', `0 0 ${W} ${H}`);
      const land = el('g', { class: 'ag-land' }, world);
      land.innerHTML = w.dots.map(([x, y]) => `<circle cx="${x + 0.5}" cy="${y + 0.5}" r=".36"/>`).join('');
      el('g', { class: 'ag-trails' }, world);
      el('g', { class: 'ag-found' }, world);
      el('g', { class: 'ag-markers' }, world);
      el('g', { class: 'ag-live' }, world);
      const [hx, hy] = project(...HOME);
      const home = el('g', { class: 'ag-home', transform: `translate(${hx},${hy})` }, world);
      el('circle', { r: 2.4, class: 'ag-home-ring' }, home);
      el('circle', { r: 0.9, class: 'ag-home-dot' }, home);
      st.markers.clear();
    }
    if (!st.snap) return;
    for (const h of st.snap.hosts) placeHost(h, false);
    renderCdn();
  }

  function hostPoint(h) {
    // Spread the hosts of one country into a small cloud so they do not stack on one dot.
    const [x, y] = project(h.lat, h.lng);
    const a = hash(h.host) * Math.PI * 2;
    const r = 0.4 + hash(h.host + '#') * 1.9;
    return [x + Math.cos(a) * r, y + Math.sin(a) * r * 0.75];
  }

  function colorOf(h) {
    const a = st.snap.byId.get(h.agents?.[0]);
    return FAMILY[a?.family] || FAMILY.sonnet;
  }

  function placeHost(h, live) {
    if (!h.cc || h.precision === 'cdn') return;
    const [x, y] = hostPoint(h);
    let m = st.markers.get(h.host);
    const c = colorOf(h);
    if (!m) {
      if (h.fetch > 0) {
        const [hx, hy] = project(...HOME);
        const d = Math.hypot(x - hx, y - hy);
        const trail = el('path', { class: 'ag-trail', d: arc(hx, hy, x, y, d), stroke: c }, world.querySelector('.ag-trails'));
        trail.dataset.host = h.host;
      }
      const g = el('g', { class: `ag-marker p-${h.precision}${h.fetch ? '' : ' found-only'}`, transform: `translate(${x.toFixed(2)},${y.toFixed(2)})` },
        world.querySelector(h.fetch ? '.ag-markers' : '.ag-found'));
      el('circle', { r: 0.5, class: 'ag-m' }, g);
      g.addEventListener('mouseenter', (ev) => hostTip(ev, h.host));
      g.addEventListener('mouseleave', () => { $('tip').hidden = true; });
      m = { g, x, y };
      st.markers.set(h.host, m);
    } else if (h.fetch > 0 && m.g.classList.contains('found-only')) {
      m.g.classList.remove('found-only');
      world.querySelector('.ag-markers').appendChild(m.g);
      const [hx, hy] = project(...HOME);
      el('path', { class: 'ag-trail', d: arc(hx, hy, x, y, Math.hypot(x - hx, y - hy)), stroke: c }, world.querySelector('.ag-trails'));
    }
    const r = h.fetch ? 0.32 + Math.min(0.75, Math.log2(h.fetch + 1) * 0.16) : 0.22;
    m.g.querySelector('.ag-m').setAttribute('r', r.toFixed(2));
    m.g.style.setProperty('--c', c);
    if (live) {
      const ring = el('circle', { r: r + 0.4, class: 'ag-m-burst' }, m.g);
      setTimeout(() => ring.remove(), 1400);
    }
  }

  const arc = (x1, y1, x2, y2, d) => {
    // Bend every flight upwards, more for longer ones, like a route on a globe.
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2 - Math.min(18, d * 0.32);
    return `M${x1.toFixed(2)},${y1.toFixed(2)} Q${mx.toFixed(2)},${my.toFixed(2)} ${x2.toFixed(2)},${y2.toFixed(2)}`;
  };

  function flight(h, agentId) {
    if (!h.cc) return;
    if (h.precision === 'cdn') {
      const box = $('ag-cdn');
      box.classList.remove('ping');
      void box.offsetWidth;
      box.classList.add('ping');
      return;
    }
    const m = st.markers.get(h.host);
    if (!m) return;
    const [hx, hy] = project(...HOME);
    const a = st.snap.byId.get(agentId);
    const c = FAMILY[a?.family] || FAMILY.sonnet;
    const p = el('path', { class: 'ag-flight', d: arc(hx, hy, m.x, m.y, Math.hypot(m.x - hx, m.y - hy)), stroke: c }, world.querySelector('.ag-live'));
    const len = p.getTotalLength();
    p.style.strokeDasharray = `${len}`;
    p.style.strokeDashoffset = `${len}`;
    const dot = el('circle', { r: 0.55, class: 'ag-spark', fill: c }, world.querySelector('.ag-live'));
    const t0 = performance.now();
    const step = (ts) => {
      const k = Math.min(1, (ts - t0) / 1100);
      const e = 1 - Math.pow(1 - k, 3);
      p.style.strokeDashoffset = `${len * (1 - e)}`;
      const pt = p.getPointAtLength(len * e);
      dot.setAttribute('cx', pt.x);
      dot.setAttribute('cy', pt.y);
      if (k < 1) requestAnimationFrame(step);
      else { dot.remove(); p.classList.add('fade'); setTimeout(() => p.remove(), 1600); }
    };
    requestAnimationFrame(step);
  }

  function renderCdn() {
    const cdn = st.snap.hosts.filter((h) => h.precision === 'cdn');
    const box = $('ag-cdn');
    box.hidden = !cdn.length;
    box.innerHTML = `<span class="ag-cdn-n">${fmt(cdn.length)}</span><span>hosts behind CDN nodes<br><small>no real place, not on the map</small></span>`;
  }

  // ---------- team: the chats of a project as an org chart ----------

  const setTitles = (map) => { for (const [id, t] of Object.entries(map)) { const e = $(id)?.closest('.ag-block')?.querySelector('.eyebrow'); if (e) e.textContent = t; } };
  const roleLabel = (r) => String(r || '').replace(/\s+(n|<n>|#|x)$/i, '');
  const hhmm = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const pairKey = (a, b) => [a, b].sort().join('|');

  async function loadTeam() {
    const res = await fetch(`/api/agents/team${st.project ? `?project=${encodeURIComponent(st.project)}` : ''}`);
    if (!res.ok) return null;
    const t = await res.json();
    t.byId = new Map(t.members.map((m) => [m.id, m]));
    // The person behind the prompts: "owner → chat" lines start at their card.
    t.byId.set('owner', { id: 'owner', title: t.owner?.name || 'You', family: 'owner', owner: true });
    st.team = t;
    return t;
  }

  function setMode(mode, { user = false } = {}) {
    if (user) st.modeByUser = true;
    st.mode = mode;
    const team = mode === 'team';
    for (const b of document.querySelectorAll('.ag-mode [data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    $('ag-tree-wrap').classList.toggle('team-mode', team);
    $('agents-stage').classList.toggle('team-stage', team);
    $('agents-stage').classList.toggle('talk-wide', team && st.talkWide);
    document.querySelector('.ag-world-wrap').classList.toggle('team-mode', team);
    $('tm-wrap').hidden = !team;
    $('tm-talk').hidden = !team;
    $('ag-session').hidden = team;
    clearInterval(st.teamTimer);
    if (team) {
      renderTeamAll();
      st.teamTimer = setInterval(() => { if (st.visible && st.mode === 'team') renderTeamAll(); }, 10000);
    } else {
      $('ag-cap').textContent = 'Agents';
      $('tm-lines').innerHTML = '';
      if (st.id) select(st.id); else pickDefault();
    }
  }

  async function renderTeamAll() {
    const t = await loadTeam();
    if (!t || st.mode !== 'team') return;
    renderTeam();
    renderTalk();
    renderTeamRail();
  }

  function teamCard(m) {
    const card = document.createElement('button');
    card.dataset.id = m.id;
    if (m.owner) {
      const prompts = st.team.members.reduce((n, x) => n + x.prompts24h, 0);
      card.className = 'tm-card tm-owner';
      card.innerHTML = '<div class="tm-head"><span class="tm-role">Owner</span></div>'
        + `<div class="ag-name">${esc(m.title)}</div><div class="tm-topic">${esc(short(m.task, 90))}</div>`
        + `<div class="tm-meta"><b>${prompts}</b> prompts to the team in 24 h</div>`;
      return card;
    }
    if (m.ghost) return ghostCard(m);
    const working = m.status === 'busy';
    const dots = m.subagents.recent.map((a) => `<i class="${a.active ? 'on' : ''}" style="--c:${FAMILY[a.family] || FAMILY.unknown}" title="${esc(a.desc)}" data-id="${esc(a.id)}"></i>`).join('');
    const tools = Object.entries(m.tools).filter(([k]) => !QUIET_TOOLS.test(k)).sort((x, y) => y[1] - x[1]).slice(0, 3);
    card.className = 'tm-card' + (working ? ' working' : '') + (m.role ? '' : ' no-role');
    card.style.setProperty('--c', FAMILY[m.family] || FAMILY.unknown);
    card.innerHTML = `<div class="tm-head">${famChip(m)}<span class="tm-role">${esc(m.role ? roleLabel(m.role) : '')}</span>`
      + `<span class="ag-state${working ? ' on' : ''}">${working ? 'working' : m.live ? 'waiting' : 'closed'}</span></div>`
      + `<div class="ag-name">${esc(m.title)}</div>`
      + (m.topic || m.task ? `<div class="tm-topic">${esc(short(m.topic || m.task, 96))}</div>` : '')
      + (m.now ? `<div class="ag-act"><b>${KIND_ICON[m.now.kind] || '·'}</b> ${esc(short(prettyTarget(m.now), 52))}</div>` : '')
      + `<div class="tm-subs"><span class="tm-dots">${dots}</span><span class="tm-subs-n">⑂ <b>${m.subagents.active}</b> working · ${m.subagents.total} total</span></div>`
      + `<div class="tm-meta">${m.prompts24h ? `<b>${m.prompts24h}</b> prompts from you in 24 h · ` : ''}${tools.map(([k, n]) => `${esc(k.replace(/^mcp__.+?__/, ''))} ${fmt(n)}`).join(' · ')}</div>`;
    if (m.roster) {
      card.classList.add(`rs-${m.roster.state.replace(/\s/g, '-')}`);
      card.insertAdjacentHTML('beforeend', rosterLine(m.roster));
    }
    card.addEventListener('click', () => { setMode('chat', { user: true }); select(m.id, { user: true }); });
    return card;
  }

  const ago = (iso) => {
    if (!iso) return 'never ran';
    const min = (Date.now() - Date.parse(iso)) / 60000;
    if (min < 60) return `${Math.max(1, Math.round(min))} min ago`;
    if (min < 1440) return `${Math.round(min / 60)} h ago`;
    return `${Math.round(min / 1440)} d ago`;
  };

  /** What the team status says about a role: last run, open findings, why it is due. */
  function rosterLine(r) {
    const open = r.open ? ` · <b class="${r.openHigh ? 'rs-high' : ''}">${r.open} open</b>` : '';
    const why = r.state === 'waiting' ? r.waitingFor : r.state === 'due' ? r.due.join('; ') : r.lastResult;
    const when = !r.lastRun && (r.kind === 'onCall' || r.kind === 'chat') ? '' : esc(ago(r.lastRun));
    return `<div class="tm-roster"><span class="rs-state">${esc(r.state)}</span> ${when}${open}</div>`
      + (why ? `<div class="rs-why" title="${esc(why)}">${esc(short(why, 70))}</div>` : '');
  }

  /** A role with no chat right now: it still belongs to the team, so it keeps its place. */
  function ghostCard(m) {
    const card = document.createElement('div');
    card.dataset.id = m.id;
    card.className = `tm-card tm-ghost rs-${m.roster.state.replace(/\s/g, '-')}`;
    card.title = [m.task, m.roster.schedule].filter(Boolean).join(' · ');
    card.innerHTML = `<div class="tm-head"><span class="tm-role">${esc(m.topic ? short(m.topic, 34) : '')}</span></div>`
      + `<div class="ag-name">${esc(m.title)}</div>${rosterLine(m.roster)}`;
    return card;
  }

  function renderTeam() {
    const t = st.team;
    const wrap = $('tm-wrap');
    $('ag-cap').textContent = t.file ? `Team · ${t.file}` : 'Chats in this project';
    wrap.innerHTML = '';
    st.teamCards.clear();
    const rows = new Map();
    if (t.owner) rows.set(0, [{ owner: true, id: 'owner', title: t.owner.name, task: t.owner.task }]);
    for (const m of t.members) {
      const r = m.rank ?? 99;
      if (!rows.has(r)) rows.set(r, []);
      rows.get(r).push(m);
    }
    if (!t.members.length) {
      wrap.innerHTML = '<div class="ag-empty"><span class="eyebrow">No chats here</span><p>No Claude session has worked in this project in the last 7 days.</p></div>';
      return;
    }
    const addRow = (label, groups, cls = '') => {
      const row = document.createElement('div');
      row.className = `tm-row ${cls}`;
      row.innerHTML = `<span class="tm-rank">${esc(label)}</span><div class="tm-row-cards"></div>`;
      for (const g of groups) {
        if (!g.items.length) continue;
        const box = document.createElement('div');
        box.className = 'tm-group' + (g.label ? ' labelled' : '');
        if (g.label) box.innerHTML = `<span class="tm-group-label">${esc(g.label)}</span>`;
        const cards = document.createElement('div');
        cards.className = 'tm-group-cards';
        for (const m of g.items) { const c = teamCard(m); cards.appendChild(c); st.teamCards.set(m.id, c); }
        box.appendChild(cards);
        row.querySelector('.tm-row-cards').appendChild(box);
      }
      if (row.querySelector('.tm-card')) inner.appendChild(row);
    };
    const inner = document.createElement('div');
    inner.className = 'tm-inner';
    wrap.appendChild(inner);
    if (t.layout) {
      // Display levels (from the tool's team layout); the team file's ranks stay in the cards' role.
      if (rows.has(0)) addRow('Owner', [{ items: rows.get(0) }], 'tm-row-owner');
      for (const lv of t.layout.levels) addRow(lv.label, lv.groups.map((g) => ({ label: g.label, items: g.members.map((id) => t.byId.get(id)).filter(Boolean) })));
      addRow('Not placed', [{ items: t.layout.unplaced.map((id) => t.byId.get(id)).filter(Boolean) }], 'tm-row-loose');
    } else {
      for (const r of [...rows.keys()].sort((a, b) => a - b)) addRow(r === 0 ? 'Owner' : r === 99 ? 'No role' : `Rank ${r}`, [{ items: rows.get(r) }], r === 0 ? 'tm-row-owner' : '');
    }
    fitTeam();
    requestAnimationFrame(drawTeamLines);
  }

  /** Shrinks the chart until every level fits; a second screen should show the whole team at once. */
  function fitTeam() {
    const wrap = $('tm-wrap');
    const inner = wrap.querySelector('.tm-inner');
    if (!inner) return;
    inner.style.transform = '';
    const need = inner.offsetHeight;
    const have = wrap.clientHeight;
    const k = need > have && have > 0 ? Math.max(0.6, have / need) : 1;
    if (k < 1) inner.style.transform = `scale(${k.toFixed(3)})`;
  }

  /** Rank wiring between the rows, and one arc per pair of chats that wrote to each other. */
  function drawTeamLines() {
    const svg = $('tm-lines');
    const host = $('ag-tree-wrap').getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${host.width} ${host.height}`);
    svg.innerHTML = '';
    st.teamLinks.clear();
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left - host.left, y: r.top - host.top, w: r.width, h: r.height }; };
    const rows = [...$('tm-wrap').querySelectorAll('.tm-row')];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].classList.contains('tm-row-loose')) continue;
      const above = [...rows[i - 1].querySelectorAll('.tm-card')].map(box);
      const cards = [...rows[i].querySelectorAll('.tm-card')].map(box);
      if (!above.length || !cards.length) continue;
      const fromX = above.reduce((n, b) => n + b.x + b.w / 2, 0) / above.length;
      const fromY = Math.max(...above.map((b) => b.y + b.h));
      const busY = Math.min(...cards.map((b) => b.y)) - 12;
      const xs = cards.map((b) => b.x + b.w / 2).concat(fromX);
      el('path', { class: 'tm-wire', d: `M${fromX},${fromY} V${busY} M${Math.min(...xs)},${busY} H${Math.max(...xs)}` }, svg);
      for (const b of cards) el('path', { class: 'tm-wire', d: `M${b.x + b.w / 2},${busY} V${b.y}` }, svg);
    }
    // Messages: one line per pair of cards, both directions summed. Lines with traffic in the
    // last minutes run and glow; older ones stay as a faint trace of who works with whom.
    const pairs = new Map();
    const now = Date.now();
    for (const c of st.teamCards.values()) c.classList.remove('talking');
    for (const m of st.team.messages) {
      if (!m.toId || !st.teamCards.has(m.from) || !st.teamCards.has(m.toId)) continue;
      const k = pairKey(m.from, m.toId);
      if (!pairs.has(k)) pairs.set(k, { a: [m.from, m.toId].sort()[0], b: [m.from, m.toId].sort()[1], ab: 0, ba: 0, last: m });
      const p = pairs.get(k);
      if (m.from === p.a) p.ab++; else p.ba++;
      p.last = m;
    }
    let i = 0;
    for (const [k, p] of [...pairs].sort((x, y) => x[1].last.t - y[1].last.t)) {
      const A = box(st.teamCards.get(p.a));
      const B = box(st.teamCards.get(p.b));
      const sameRow = Math.abs(A.y - B.y) < 10;
      const [up, down] = A.y <= B.y ? [A, B] : [B, A];
      const lean = ((i % 5) - 2) * 18;
      const d = sameRow
        ? `M${A.x + A.w / 2},${A.y} C${A.x + A.w / 2},${A.y - 40 - Math.abs(lean)} ${B.x + B.w / 2},${B.y - 40 - Math.abs(lean)} ${B.x + B.w / 2},${B.y}`
        : `M${up.x + up.w / 2 + lean},${up.y + up.h} C${up.x + up.w / 2 + lean},${(up.y + up.h + down.y) / 2} ${down.x + down.w / 2 - lean},${(up.y + up.h + down.y) / 2} ${down.x + down.w / 2 - lean},${down.y}`;
      const n = p.ab + p.ba;
      const hot = now - p.last.t < HOT_MS;
      const owner = p.a === 'owner' || p.b === 'owner';
      const path = el('path', { class: `tm-msg${hot ? ' hot' : ''}${owner ? ' from-owner' : ''}`, d, 'stroke-width': (hot ? 2.2 : 1.2) + Math.min(2.4, Math.log2(n + 1) * 0.5) }, svg);
      if (hot) {
        st.teamCards.get(p.a)?.classList.add('talking');
        st.teamCards.get(p.b)?.classList.add('talking');
      }
      path.addEventListener('mouseenter', (ev) => place(ev, `<b>${esc(st.team.byId.get(p.a)?.title)} ⇄ ${esc(st.team.byId.get(p.b)?.title)}</b><div class="t-sub">${p.ab} ⇄ ${p.ba} · ${n} messages in 48 h</div><div class="t-sub">Last ${hhmm(p.last.t)}: ${esc(p.last.summary)}</div>`));
      path.addEventListener('mouseleave', () => { $('tip').hidden = true; });
      st.teamLinks.set(k, { path, a: p.a });
      i++;
    }
  }

  /** Short names in the conversation: the role when there is one, else the chat title. */
  const roleOrTitle = (m) => (!m ? '' : m.owner ? m.title : m.role ? roleLabel(m.role) : m.title.replace(/^KN[_ -]/, '').replace(/_/g, ' ').split(' ').slice(0, 3).join(' '));

  function renderTalk() {
    const t = st.team;
    const name = (id, raw) => (id && (roleOrTitle(t.byId.get(id)))) || raw || '?';
    const fam = (id) => (id === 'owner' ? 'var(--orange)' : FAMILY[t.byId.get(id)?.family] || FAMILY.unknown);
    $('tm-feed').innerHTML = t.messages.slice(-80).reverse().map((m) => `<li><span class="tm-time">${hhmm(m.t)}</span>`
      + `<div><span class="tm-who"><b style="color:${fam(m.from)}">${esc(name(m.from))}</b> → <b style="color:${fam(m.toId)}">${esc(name(m.toId, m.to))}</b></span>`
      + `<div class="tm-sum">${esc(m.summary)}</div></div></li>`).join('') || '<li class="tm-none">No messages between these chats in the last 48 hours.</li>';
  }

  function renderTeamRail() {
    const t = st.team;
    setTitles({ 'ag-models': 'Models in the team', 'ag-types': 'Roles', 'ag-tools': 'Tools', 'ag-places': 'Who talks to whom', 'ag-tokens': 'Tokens' });
    const chats = t.members.filter((m) => !m.ghost);
    const working = chats.filter((m) => m.status === 'busy').length;
    const subsActive = t.members.reduce((n, m) => n + m.subagents.active, 0);
    const subsTotal = t.members.reduce((n, m) => n + m.subagents.total, 0);
    $('ag-now').classList.toggle('idle', !working && !subsActive);
    $('ag-now').innerHTML = `<span class="eyebrow">Team now</span><span class="now-module">${working}<small> of ${chats.length} chats working</small></span>`
      + `<div class="rt-kpis"><span><b>${subsActive}</b> subagents at work</span><span><b>${subsTotal}</b> spawned</span><span><b>${t.messages.length}</b> messages 48 h</span>`
      + (t.roster ? `<span><b>${t.roster.openFindings}</b> open findings</span><span>pulse <b>${esc(t.roster.pulse?.level || 'unknown')}</b></span>` : '') + '</div>';
    const fam = new Map();
    for (const m of chats) { fam.set(m.family, (fam.get(m.family) || 0) + 1); for (const a of m.subagents.recent) fam.set(a.family, (fam.get(a.family) || 0) + 1); }
    const total = [...fam.values()].reduce((a, b) => a + b, 0) || 1;
    $('ag-models').innerHTML = `<div class="ag-bar">${[...fam].map(([f, n]) => `<span style="flex:${n};background:${FAMILY[f] || FAMILY.unknown}"></span>`).join('')}</div>`
      + [...fam].sort((x, y) => y[1] - x[1]).map(([f, n]) => `<div class="ag-row"><i style="background:${FAMILY[f] || FAMILY.unknown}"></i><span>${FAMILY_NAME[f] || f}</span><b>${n}</b><em>${Math.round((n / total) * 100)}%</em></div>`).join('')
      + '<div class="ag-note">Chats plus their 30 latest subagents each</div>';
    if (t.roster) {
      setTitles({ 'ag-types': 'Open findings' });
      $('ag-types').innerHTML = t.roster.findings.slice(0, 12).map((f) => `<div class="rs-finding rs-${esc(f.severity)}"><b>${esc(f.severity)}</b><span>${esc(f.title)}</span><em>${esc(f.from)} → ${esc(f.to)} · ${esc(f.status)}</em></div>`).join('')
        || '<div class="f-sub">nothing open</div>';
    } else $('ag-types').innerHTML = t.members.map((m) => `<div class="ag-row"><span>${esc(m.role ? roleLabel(m.role) : m.title)}</span><b>${m.status === 'busy' ? '●' : '·'}</b></div>`).join('');
    const tools = {};
    for (const m of t.members) for (const [k, n] of Object.entries(m.tools)) if (!QUIET_TOOLS.test(k)) tools[k] = (tools[k] || 0) + n;
    const top = Object.entries(tools).sort((x, y) => y[1] - x[1]).slice(0, 7);
    const maxT = top[0]?.[1] || 1;
    $('ag-tools').innerHTML = top.map(([k, n]) => `<div class="ag-meter"><span>${esc(k.replace(/^mcp__.+?__/, ''))}</span><b>${fmt(n)}</b><i style="width:${(n / maxT) * 100}%"></i></div>`).join('');
    const pairs = new Map();
    for (const m of t.messages) { if (!m.toId) continue; const k = `${roleOrTitle(t.byId.get(m.from))} → ${roleOrTitle(t.byId.get(m.toId))}`; pairs.set(k, (pairs.get(k) || 0) + 1); }
    $('ag-places').innerHTML = [...pairs].sort((x, y) => y[1] - x[1]).slice(0, 7).map(([k, n]) => `<div class="ag-row"><span>${esc(k)}</span><b>${n}</b></div>`).join('') || '<div class="f-sub">no messages yet</div>';
    const tok = t.members.reduce((acc, m) => ({ in: acc.in + m.tokens.in, out: acc.out + m.tokens.out }), { in: 0, out: 0 });
    $('ag-tokens').innerHTML = `<div class="ag-row"><span>In</span><b>${fmt(tok.in)}</b></div><div class="ag-row"><span>Out</span><b>${fmt(tok.out)}</b></div>`;
  }

  /** A new message: it joins the conversation and a spark runs along the arc from sender to recipient. */
  function teamMessage(msg) {
    const t = st.team;
    if (!t || !t.byId.has(msg.from)) return;
    t.messages.push(msg);
    renderTalk();
    renderTeamRail();
    if (!msg.toId || !t.byId.has(msg.toId)) return;
    drawTeamLines(); // the pair turns "hot" and moves to the front
    const link = st.teamLinks.get(pairKey(msg.from, msg.toId));
    if (!link) return;
    const p = link.path;
    const len = p.getTotalLength();
    const reverse = link.a !== msg.from;
    const dot = el('circle', { r: 6, class: 'tm-spark' }, $('tm-lines'));
    const t0 = performance.now();
    const step = (ts) => {
      const k = Math.min(1, (ts - t0) / 1200);
      const e = 1 - Math.pow(1 - k, 3);
      const pt = p.getPointAtLength(len * (reverse ? 1 - e : e));
      dot.setAttribute('cx', pt.x);
      dot.setAttribute('cy', pt.y);
      if (k < 1) requestAnimationFrame(step);
      else { dot.remove(); flashCard(msg.toId); }
    };
    requestAnimationFrame(step);
    flashCard(msg.from);
  }

  function flashCard(id) {
    const c = st.teamCards.get(id);
    if (!c) return;
    c.classList.remove('flash');
    void c.offsetWidth;
    c.classList.add('flash');
  }

  // ---------- tooltips ----------

  function place(ev, html) {
    const tipEl = $('tip');
    tipEl.innerHTML = html;
    tipEl.hidden = false;
    const r = ev.currentTarget.getBoundingClientRect();
    const w = tipEl.offsetWidth;
    tipEl.style.left = `${Math.min(window.innerWidth - w - 12, Math.max(12, r.left + r.width / 2 - w / 2))}px`;
    tipEl.style.top = `${r.top - tipEl.offsetHeight - 10 < 8 ? r.bottom + 10 : r.top - tipEl.offsetHeight - 10}px`;
  }

  function tip(ev, id) {
    const a = st.snap.byId.get(id);
    if (!a) return;
    const tools = Object.entries(a.tools || {}).filter(([k]) => !QUIET_TOOLS.test(k)).sort((x, y) => y[1] - x[1]).slice(0, 4);
    place(ev, `<b>${esc(a.desc || a.type || 'Agent')}</b>`
      + `<div class="t-sub">${esc(a.type)} · ${esc(a.model || FAMILY_NAME[a.family])} · ${a.ended || !isActive(a) ? 'done' : 'working'} · ${dur((a.ended || a.last) - a.start || 0)}</div>`
      + (tools.length ? `<div class="t-sub">${tools.map(([k, v]) => `${esc(k.replace(/^mcp__.+?__/, ''))} ${v}`).join(' · ')}</div>` : '')
      + `<div class="t-sub">${fmt(a.tokensIn + a.cacheRead)} tokens in · ${fmt(a.tokensOut)} out</div>`);
  }

  function hostTip(ev, host) {
    const h = st.snap.hostMap.get(host);
    if (!h) return;
    place(ev, `<b>${esc(h.host)}</b><div class="t-sub">${esc(h.name || h.cc)} · ${esc(PRECISION[h.precision] || '')}</div>`
      + `<div class="t-sub">${h.fetch} opened · ${h.found} found in searches · ${h.agents.length} ${h.agents.length === 1 ? 'agent' : 'agents'}</div>`);
  }

  // ---------- rail ----------

  function renderPicker() {
    const sel = $('ag-session');
    const list = scoped();
    sel.innerHTML = `<option value="__scope__">${st.everywhere ? '↩ Only chats of this project' : `⊕ All chats on this Mac (${st.sessions.length})`}</option>`
      + (list.length ? '' : '<option disabled>No chats in this project</option>')
      + list.map((s) => `<option value="${esc(s.id)}"${s.id === st.id ? ' selected' : ''}>${s.active ? '● ' : ''}${s.source === 'cowork' ? 'Cowork · ' : ''}${esc(short(s.title, 42))}${s.agents ? ` · ${s.agents} agents` : ''}</option>`).join('');
  }

  function renderRail() {
    const s = st.snap;
    if (!s || st.mode === 'team') return;
    setTitles({ 'ag-models': 'Models', 'ag-types': 'Types', 'ag-tools': 'Tools', 'ag-places': 'Places', 'ag-tokens': 'Tokens' });
    const agents = s.agents.filter((a) => a.id !== 'main');
    const active = agents.filter(isActive);
    const running = Date.now() - s.last < 2 * ACTIVE_MS;
    const located = s.hosts.filter((h) => h.cc && h.fetch > 0);
    const countries = new Map();
    for (const h of located) {
      if (h.precision === 'cdn') continue;
      if (!countries.has(h.cc)) countries.set(h.cc, { n: 0, name: h.name });
      countries.get(h.cc).n++;
    }
    const now = $('ag-now');
    now.classList.toggle('idle', !running);
    const span = dur(Math.max(0, (s.last || 0) - (s.start || 0)));
    now.innerHTML = running
      ? `<span class="eyebrow">At work now</span><span class="now-module">${active.length}<small> of ${agents.length} agents</small></span>`
        + `<div class="rt-kpis"><span><b>${s.peak}</b> peak</span><span><b>${span}</b> running</span><span><b>${countries.size}</b> countries</span></div>`
      : `<span class="eyebrow">Run complete</span><span class="now-module">${agents.length}<small> agents</small></span>`
        + `<div class="ag-summary">Peak of <b>${s.peak}</b> at once · <b>${span}</b><br><b>${fmt(s.fetches)}</b> pages opened on <b>${fmt(located.length)}</b> hosts in <b>${countries.size}</b> countries · <b>${fmt(s.found)}</b> links found in searches</div>`;

    const fam = new Map();
    for (const a of s.agents) fam.set(a.family, (fam.get(a.family) || 0) + 1);
    const total = s.agents.length || 1;
    $('ag-models').innerHTML = `<div class="ag-bar">${[...fam].map(([f, n]) => `<span style="flex:${n};background:${FAMILY[f] || FAMILY.unknown}"></span>`).join('')}</div>`
      + [...fam].sort((x, y) => y[1] - x[1]).map(([f, n]) => `<div class="ag-row"><i style="background:${FAMILY[f] || FAMILY.unknown}"></i><span>${FAMILY_NAME[f] || f}</span><b>${n}</b><em>${Math.round((n / total) * 100)}%</em></div>`).join('');

    const types = new Map();
    for (const a of agents) types.set(a.type, (types.get(a.type) || 0) + 1);
    $('ag-types').innerHTML = [...types].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([t, n]) => `<div class="ag-row"><span>${esc(t)}</span><b>${n}</b></div>`).join('') || '<div class="f-sub">no subagents yet</div>';

    const tools = Object.entries(s.tools).filter(([k]) => !QUIET_TOOLS.test(k)).sort((x, y) => y[1] - x[1]).slice(0, 7);
    const maxT = tools[0]?.[1] || 1;
    $('ag-tools').innerHTML = tools.map(([k, n]) => `<div class="ag-meter"><span>${esc(k.replace(/^mcp__.+?__/, ''))}</span><b>${fmt(n)}</b><i style="width:${(n / maxT) * 100}%"></i></div>`).join('');

    const top = [...countries].sort((x, y) => y[1].n - x[1].n).slice(0, 7);
    const cdn = s.hosts.filter((h) => h.precision === 'cdn').length;
    const ipOnly = located.filter((h) => h.precision === 'ip').length;
    $('ag-places').innerHTML = top.map(([cc, v]) => `<div class="ag-row"><span class="cc">${esc(cc)}</span><span>${esc(v.name)}</span><b>${v.n}</b></div>`).join('')
      + `<div class="ag-note">${ipOnly} hosts placed by server IP (may be network nodes) · ${cdn} behind CDN nodes</div>`;

    $('ag-tokens').innerHTML = `<div class="ag-row"><span>In</span><b>${fmt(s.tokens.in)}</b></div><div class="ag-row"><span>Cache read</span><b>${fmt(s.tokens.cache)}</b></div><div class="ag-row"><span>Out</span><b>${fmt(s.tokens.out)}</b></div>`;
  }

  // ---------- live events ----------

  function on(event, d) {
    if (event === 'agent-sessions') {
      st.sessions = d;
      if (st.visible) { renderPicker(); pickDefault(); }
      return;
    }
    if (st.mode === 'team' && st.team) {
      if (event === 'agent-msg') teamMessage(d.msg);
      else if (event === 'agent-tool' && st.team.byId.has(d.s)) {
        flashCard(d.s);
        if (d.a !== 'main') st.teamCards.get(d.s)?.querySelector(`.tm-dots i[data-id="${CSS.escape(d.a)}"]`)?.classList.add('ping');
      }
    }
    if (!st.snap || d.s !== st.id) return;
    const s = st.snap;
    if (event === 'agent-spawn') {
      if (!s.byId.has(d.agent.id)) { s.agents.push(d.agent); s.byId.set(d.agent.id, d.agent); }
      if (st.visible) { renderTree(); renderRail(); }
    } else if (event === 'agent-tool') {
      const a = s.byId.get(d.a);
      if (a) { a.now = { tool: d.tool, kind: d.kind, target: d.target, t: d.t }; a.last = Math.max(a.last || 0, d.t || Date.now()); a.tools[d.tool] = (a.tools[d.tool] || 0) + 1; }
      s.tools[d.tool] = (s.tools[d.tool] || 0) + 1;
      s.last = Math.max(s.last, d.t || Date.now());
      if (st.visible) {
        if (st.nodes.has(d.a)) pulseCard(d.a, d.kind);
        else if (d.a === 'main') renderTree();
      }
    } else if (event === 'agent-hit') {
      const h = d.hit;
      const known = s.hostMap.get(h.host);
      if (known) Object.assign(known, h); else { s.hosts.push(h); s.hostMap.set(h.host, h); }
      if (h.kind === 'fetch') s.fetches++; else s.found++;
      if (st.visible) { placeHost(s.hostMap.get(h.host), true); if (h.kind === 'fetch') flight(h, d.hit.a); }
    } else if (event === 'agent-end') {
      const a = s.byId.get(d.a);
      if (a) a.ended = d.t;
      if (st.visible) { renderTree(); renderRail(); }
    }
  }

  // ---------- show / hide ----------

  async function show() {
    st.visible = true;
    $('agents-stage').hidden = false;
    await loadWorld();
    if (!st.sessions.length) st.sessions = await (await fetch('/api/agents/sessions')).json();
    renderPicker();
    if (!st.modeByUser) {
      const t = await loadTeam();
      st.mode = t && t.members.length >= 2 ? 'team' : 'chat';
    }
    setMode(st.mode);
    clearInterval(st.timer);
    clearInterval(st.syncTimer);
    // Status and labels follow the clock; a full resync picks up hosts located in the background.
    st.timer = setInterval(() => { if (st.snap) { renderTree(); renderRail(); } }, 3000);
    st.syncTimer = setInterval(() => { if (st.id) select(st.id, { full: false }); }, 30000);
  }

  window.addEventListener('resize', () => {
    if (!st.visible) return;
    if (st.mode === 'team') { fitTeam(); requestAnimationFrame(drawTeamLines); }
    else { st.maxCards = MAX_CARDS; renderTree(); }
  });
  for (const b of document.querySelectorAll('.ag-mode [data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode, { user: true }));
  $('tm-talk-size').addEventListener('click', () => {
    st.talkWide = !st.talkWide;
    try { localStorage.setItem('ao-talk-wide', st.talkWide ? '1' : '0'); } catch { /* private window */ }
    $('agents-stage').classList.toggle('talk-wide', st.talkWide);
    $('tm-talk-size').setAttribute('aria-pressed', String(st.talkWide));
    setTimeout(() => { fitTeam(); drawTeamLines(); }, 420);
  });

  function hide() {
    st.visible = false;
    $('agents-stage').hidden = true;
    clearInterval(st.teamTimer);
    clearInterval(st.timer);
    clearInterval(st.syncTimer);
  }

  $('ag-session').addEventListener('change', (e) => {
    if (e.target.value === '__scope__') {
      st.everywhere = !st.everywhere;
      st.userPicked = false;
      renderPicker();
      pickDefault();
      return;
    }
    select(e.target.value, { user: true });
  });

  return { show, hide, on, setProject };
}
