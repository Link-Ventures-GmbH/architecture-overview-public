// Usage view: who uses the running system right now and what their requests do inside it.
// Three bands (people, the system's tools, the sources behind them), a light point per step,
// the live list of requests with their phases, and on the right the day, the power users and
// where the time goes. Data from a usage-live/1 feed (src/usage.js).

const SVGNS = 'http://www.w3.org/2000/svg';
const PHASES = ['agent', 'find', 'check', 'price', 'fetch', 'source', 'cut', 'receipt', 'deliver'];
const PHASE_NAME = { agent: 'Call', find: 'Search', check: 'Check', price: 'Price', fetch: 'Fetch', source: 'Source', cut: 'Cut', receipt: 'Receipt', deliver: 'Deliver' };
const PHASE_COLOR = { agent: '#B9C4E2', find: '#6FE3FF', check: '#A08CFF', price: '#FFC24B', fetch: '#FF6A2B', source: '#5CF0B4', cut: '#7F8DB3', receipt: '#5CF0B4', deliver: '#F2F5FC' };
const KIND = { owner: ['Owner', '#FF6A2B'], team: ['Team', '#6FE3FF'], known: ['Known', '#5CF0B4'], stranger: ['Stranger', '#FFC24B'], test: ['Test', '#7F8DB3'], unknown: ['New account', '#FF7B93'] };
const OUTCOME = { ok: ['Answered', 'var(--mint)'], nothing: ['Nothing found', 'var(--amber)'], error: ['Error', 'var(--coral)'], running: ['Running', 'var(--ice)'] };
const ACTIVE_MS = 120_000;
const UA = { browser: ['People', '#5CF0B4', 'browsers'], claude: ['Claude', '#FF6A2B', 'AI client'], chatgpt: ['ChatGPT', '#6FE3FF', 'AI client'], bot: ['Bots', '#7F8DB3', 'crawlers and scripts'], other: ['Other', '#A08CFF', 'unknown callers'] };
const UA_ORDER = ['browser', 'claude', 'chatgpt', 'bot', 'other'];
const uaOf = (c) => UA[c] || UA.other;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const fmtN = (n) => (n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n || 0)));
const ms = (v) => (v == null || !Number.isFinite(v) ? '–' : v >= 10000 ? `${Math.round(v / 1000)} s` : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const pct = (list, p) => { if (!list.length) return null; const s = [...list].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function ago(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
}
const clientName = (c) => String(c || '').replace(/\s*\((OAuth|API)\)\s*$/, '').replace(/^API · /, 'API ');

export function createUsageView({ projectQuery = () => '' } = {}) {
  const st = { visible: false, enabled: false, status: null, users: [], hours: [], tools7: [], sources: new Map(), own: { tools: [], sources: [] }, traces: new Map(), timer: null };
  const stage = $('us-stage');
  const lines = $('us-lines');
  st.web = [];
  st.mode = (() => { try { return localStorage.getItem('ao-usmode') || 'accounts'; } catch { return 'accounts'; } })();

  // the outside view needs the system's access log; without one the toggle goes and accounts show
  const hasWeb = () => !!st.outside?.web;
  const mode = () => (st.mode === 'outside' && !hasWeb() ? 'accounts' : st.mode);
  // words the feed brings for its own system (a golf app counts rounds, not questions)
  const word = (k, fallback) => st.status?.labels?.[k] ?? fallback;

  function setMode(m) {
    st.mode = m;
    try { localStorage.setItem('ao-usmode', m); } catch { /* private window */ }
    applyMode();
    if (mode() === 'outside') renderOutsideView();
    else renderBands();
  }

  function applyMode() {
    const m = mode();
    $('us-tools-title').textContent = word('tools', 'Tools');
    $('us-tools-meta').textContent = word('tools_meta', 'what their AI calls');
    stage.querySelector('[data-usmode]').parentElement.hidden = !hasWeb();
    for (const b of stage.querySelectorAll('[data-usmode]')) b.setAttribute('aria-pressed', String(b.dataset.usmode === m));
    if (stage.dataset.mode === m) return;
    stage.dataset.mode = m;
    $('us-out-view').hidden = m !== 'outside';
    $('us-trace').hidden = true;
    lines.innerHTML = '';
  }
  for (const b of stage.querySelectorAll('[data-usmode]')) b.addEventListener('click', () => setMode(b.dataset.usmode));

  // ---------- data in ----------

  function setSnapshot(u) {
    st.enabled = !!u?.enabled;
    st.status = u?.status || null;
    st.users = u?.users || [];
    st.hours = u?.hours || [];
    st.tools7 = u?.tools7 || [];
    st.outside = u?.outside || null;
    st.web = u?.web || [];
    st.sources = new Map((u?.sources || []).map((s) => [s.id, s]));
    st.own = u?.own || { tools: [], sources: [] };
    st.traces = new Map((u?.traces || []).map((t) => [t.trace, t]));
    if (st.visible) render();
  }

  function onWeb(rows) {
    st.web.push(...rows);
    if (st.web.length > 300) st.web.splice(0, st.web.length - 300);
    if (st.visible && mode() === 'outside') renderOutsideLive();
  }

  function onStatus(s) { st.status = s; if (st.visible) renderStatus(); }

  function onUsers(d) {
    st.users = d.users || [];
    st.hours = d.hours || [];
    st.tools7 = d.tools7 || [];
    st.outside = d.outside || null;
    if (st.visible) render();
  }

  function onEvents(d) {
    for (const t of d.traces || []) st.traces.set(t.trace, t);
    while (st.traces.size > 600) st.traces.delete(st.traces.keys().next().value);
    if (!st.visible) return;
    const needBands = (d.events || []).some((e) => (e.tool && !toolEl(e.tool)) || (e.source && !sourceEl(e.source)) || (e.user && !personEl(e.user)));
    if (mode() === 'outside') { renderRail(); return; }
    if (needBands) renderBands();
    else markActive();
    renderRequests();
    renderRail();
    requestAnimationFrame(() => (d.events || []).forEach((e, i) => setTimeout(() => play(e), Math.min(i, 12) * 70)));
  }

  function play(e) {
    const color = kindColor(e.user);
    if (e.stage === 'agent' && e.status === 'start') shoot(personEl(e.user), toolEl(e.tool), color);
    else if ((e.stage === 'source' || e.stage === 'fetch') && e.status === 'start' && e.source) shoot(toolEl(e.tool), sourceEl(e.source), color);
    else if (e.stage === 'deliver') burst(personEl(e.user), e.status === 'ok' ? 'var(--mint)' : 'var(--coral)');
  }

  // ---------- lookups ----------

  const person = (id) => st.users.find((u) => u.id === id);
  const kindOf = (id) => (id ? person(id)?.kind || 'unknown' : 'unknown');
  const kindColor = (id) => KIND[kindOf(id)][1];
  const sel = (attr, v) => (v ? stage.querySelector(`[${attr}="${CSS.escape(String(v))}"]`) : null);
  const personEl = (id) => sel('data-person', id) || $('us-people-more');
  const toolEl = (name) => sel('data-tool', name);
  const sourceEl = (id) => sel('data-source', id) || $('us-src-more');
  const isOwnSource = (id) => st.own.sources.includes(id);
  const isOwnTool = (t) => st.own.tools.includes(t);
  const traceList = () => [...st.traces.values()].sort((a, b) => (a.start < b.start ? 1 : -1));

  // ---------- render ----------

  function render() {
    applyMode();
    renderStatus();
    if (mode() === 'outside') renderOutsideView(); else renderBands();
    renderRequests();
    renderRail();
  }

  function renderStatus() {
    const s = st.status || {};
    const state = s.state || 'off';
    const label = { live: 'live', loading: 'loading', connecting: 'connecting', offline: 'offline', error: 'error', off: 'off' }[state] || state;
    $('us-status').innerHTML = `<span class="us-state st-${esc(state)}"><i></i>${esc(label)}</span>`
      + `<b>${esc(s.system || 'Feed')}</b>`
      + (s.error && state !== 'live' ? `<small>${esc(short(s.error, 140))} · next try within a minute</small>` : s.since ? `<small>since ${esc(clock(s.since))}</small>` : '');
  }

  function renderBands() {
    const traces = traceList();
    // people: the ones who used it, the latest first; test accounts only while they are active
    const lastOf = new Map();
    for (const t of traces) if (t.user && !lastOf.has(t.user)) lastOf.set(t.user, t.start);
    const known = new Set(st.users.map((u) => u.id));
    const extra = [...lastOf.keys()].filter((id) => !known.has(id)).map((id) => ({ id, name: 'New account', kind: 'unknown', calls7: 0 }));
    const people = [...st.users, ...extra]
      .filter((u) => u.kind !== 'test' || (lastOf.get(u.id) && Date.now() - Date.parse(lastOf.get(u.id)) < ACTIVE_MS))
      .map((u) => ({ ...u, seen: [lastOf.get(u.id), u.last].filter(Boolean).sort().pop() || null }))
      .sort((a, b) => String(b.seen || '').localeCompare(String(a.seen || '')));
    const box = $('us-people').getBoundingClientRect();
    const max = Math.max(1, Math.floor((box.width + 10) / 200));
    const shown = people.length > max ? people.slice(0, max - 1) : people;
    $('us-people-meta').textContent = `${people.length} accounts · ${people.filter((p) => p.kind === 'stranger' || p.kind === 'unknown').length} strangers`;
    $('us-people').innerHTML = shown.map(personCard).join('')
      + (people.length > shown.length ? `<div class="us-person us-more" id="us-people-more"><b>+${people.length - shown.length}</b><span>more</span></div>` : '<span id="us-people-more" class="us-anchor"></span>')
      || '<div class="ev-none">No account yet</div>';

    // tools: the week's numbers, plus the live latency from the requests in view
    const tools = new Map(st.tools7.map((t) => [t.tool, { name: t.tool, calls: t.n, bad: t.bad || 0, lat: [] }]));
    for (const t of traces) {
      if (!t.tool) continue;
      if (!tools.has(t.tool)) tools.set(t.tool, { name: t.tool, calls: 0, bad: 0, lat: [] });
      if (Number.isFinite(t.ms) && !t.partial) tools.get(t.tool).lat.push(t.ms);
    }
    const list = [...tools.values()].sort((a, b) => b.calls - a.calls).slice(0, 9);
    const maxCalls = Math.max(1, ...list.map((t) => t.calls));
    $('us-tools').innerHTML = list.map((t) => `<div class="ev-tool us-tool${t.bad ? ' has-err' : ''}${isOwnTool(t.name) ? ' own' : ''}" data-tool="${esc(t.name)}">`
      + `<span class="ev-tool-name">${esc(t.name)}${isOwnTool(t.name) ? '<em class="us-own">own</em>' : ''}</span>`
      + `<span class="ev-tool-n">${fmtN(t.calls)}<small>7 days</small></span>`
      + `<span class="ev-tool-meta"><span>p50 ${ms(pct(t.lat, 50))}</span>${t.bad ? `<em>${t.bad} failed</em>` : ''}</span>`
      + `<i class="ev-tool-bar"><i style="width:${Math.round((t.calls / maxCalls) * 100)}%"></i></i></div>`).join('')
      || '<div class="ev-none">No tool called yet</div>';

    // sources: every logical source, the used ones lit, own services apart
    const used = new Map();
    for (const t of traces) {
      for (const s of t.sources || []) {
        const u = used.get(s.id) || { calls: 0, http: 0, lat: [], bad: 0, hosts: new Set(), last: null };
        if (s.logical) u.calls++;
        else { u.http++; if (Number.isFinite(s.ms)) u.lat.push(s.ms); if (s.status === 'error' || s.status === 'refused') u.bad++; if (s.host) u.hosts.add(s.host); }
        u.last = !u.last || t.start > u.last ? t.start : u.last;
        used.set(s.id, u);
      }
    }
    const ids = new Set([...st.sources.keys(), ...used.keys()]);
    const all = [...ids].map((id) => ({ id, name: st.sources.get(id)?.name || id, operator: st.sources.get(id)?.operator || '', ...(used.get(id) || { calls: 0, http: 0, lat: [], bad: 0, hosts: new Set() }) }))
      .sort((a, b) => (b.calls + b.http) - (a.calls + a.http) || a.name.localeCompare(b.name));
    const chip = (s) => {
      const n = Math.max(s.calls, s.http);
      return `<div class="us-src${n ? ' used' : ''}${s.bad ? ' has-err' : ''}" data-source="${esc(s.id)}" title="${esc(`${s.name}${s.operator ? ` · ${s.operator}` : ''}${s.hosts.size ? ` · ${[...s.hosts].join(', ')}` : ''}`)}">`
        + `<span class="us-src-name">${esc(short(s.name, 34))}</span>`
        + (n ? `<b>${fmtN(n)}</b>${s.lat.length ? `<span class="us-src-ms">${ms(pct(s.lat, 50))}</span>` : ''}${s.bad ? `<em>${s.bad}</em>` : ''}` : '')
        + '</div>';
    };
    const own = all.filter((s) => isOwnSource(s.id));
    const ext = all.filter((s) => !isOwnSource(s.id));
    $('us-src-meta').textContent = `${all.filter((s) => s.calls || s.http).length} of ${all.length} used in view · hover for operator and hosts`;
    $('us-sources').innerHTML = (own.length ? `<div class="us-src-group"><span class="us-src-cap">Own</span>${own.map(chip).join('')}</div>` : '')
      + `<div class="us-src-group"><span class="us-src-cap">Connected</span>${ext.map(chip).join('')}</div><span id="us-src-more" class="us-anchor"></span>`;
    markActive();
    requestAnimationFrame(sizeLines);
  }

  function personCard(u) {
    const [kname, color] = KIND[u.kind] || KIND.unknown;
    const sub = u.org || u.domain || '';
    return `<div class="us-person k-${esc(u.kind)}" data-person="${esc(u.id)}" style="--c:${color}" title="${esc(`${u.name}${sub ? ` · ${sub}` : ''}`)}">`
      + `<div class="us-person-top"><span class="us-kind">${esc(kname)}</span><span class="us-live" aria-hidden="true"></span></div>`
      + `<div class="us-person-name">${esc(short(u.name, 26))}</div>`
      + `<div class="us-person-sub">${esc(short(sub, 28))}</div>`
      + `<div class="us-person-foot"><span>${fmtN(u.calls7 || 0)} ${word('calls', 'calls')} · 7 d</span><span>${esc(ago(u.seen))}</span></div></div>`;
  }

  function markActive() {
    const now = Date.now();
    const active = new Set(traceList().filter((t) => now - Date.parse(t.end) < ACTIVE_MS).map((t) => t.user));
    for (const el of stage.querySelectorAll('[data-person]')) el.classList.toggle('active', active.has(el.dataset.person));
  }

  function phaseTimes(t) {
    const ph = Object.entries(t.phases || {}).sort((a, b) => (a[1].first < b[1].first ? -1 : 1));
    const end = Date.parse(t.end);
    return ph.map(([stage, p], i) => {
      const next = ph[i + 1] ? Date.parse(ph[i + 1][1].first) : end;
      return { stage, status: p.status, ms: Math.max(0, next - Date.parse(p.first)) };
    });
  }

  function renderRequests() {
    const list = traceList().slice(0, 80);
    $('us-req-meta').textContent = list.length ? `${st.traces.size} requests in view · since ${clock(traceList().at(-1).start)}` : '';
    $('us-reqs').innerHTML = list.map((t) => {
      const p = person(t.user);
      const [kname, color] = KIND[kindOf(t.user)];
      const times = phaseTimes(t);
      const total = Math.max(1, times.reduce((s, x) => s + x.ms, 0));
      const [oname, ocolor] = OUTCOME[t.outcome] || OUTCOME.running;
      return `<li class="us-req" data-trace="${esc(t.trace)}" tabindex="0">`
        + `<span class="us-req-time">${esc(clock(t.start))}</span>`
        + `<span class="us-req-who" style="--c:${color}" title="${esc(kname)}"><i></i>${esc(short(p?.name || kname, 18))}</span>`
        + `<code class="us-req-tool">${esc(t.tool || (t.private ? 'private' : '?'))}</code>`
        + `<span class="us-req-q">${esc(t.question || t.unit || t.summary || (t.private ? 'Private source: the system keeps no text' : t.partial ? 'Start of this request is older than the feed' : ''))}${t.client ? `<small>${esc(clientName(t.client))}</small>` : ''}</span>`
        + `<span class="us-phases" title="${esc(times.map((x) => `${PHASE_NAME[x.stage] || x.stage} ${ms(x.ms)}`).join(' · '))}">${times.map((x) => `<i style="width:${Math.max(3, (x.ms / total) * 100)}%;background:${PHASE_COLOR[x.stage] || '#7F8DB3'}" class="${x.status === 'error' || x.status === 'refused' ? 'bad' : ''}"></i>`).join('')}</span>`
        + `<span class="us-req-ms">${ms(t.ms)}</span>`
        + `<span class="us-out" style="--o:${ocolor}">${esc(t.withheld && t.outcome === 'ok' ? 'Partly paid' : oname)}</span></li>`;
    }).join('') || '<li class="ev-none">No request in view yet. They appear here as they happen.</li>';
  }

  // ---------- outside ----------

  function renderOutsideView() {
    const w = st.outside?.web;
    if (!w) {
      $('us-ov-meta').textContent = '';
      $('us-ov-classes').innerHTML = '<div class="ev-none">The system keeps no access log yet. As soon as it does (web_log), visitors, bots, AI clients and refused calls show up here.</div>';
      for (const id of ['us-ov-hours', 'us-ov-oauth', 'us-ov-pages', 'us-ov-refs', 'us-ov-refused']) $(id).innerHTML = '';
      renderOutsideLive();
      return;
    }
    const cls = new Map(w.classes.map((c) => [c.c, c]));
    const visitors = w.classes.reduce((n, c) => n + c.v, 0);
    const requests = w.classes.reduce((n, c) => n + c.n, 0);
    const assets = w.daily.find((d) => d.kind === 'asset')?.n || 0;
    $('us-ov-meta').textContent = `${visitors} visitors · ${fmtN(requests)} requests${assets ? ` · ${fmtN(assets)} files today` : ''} · a visitor counts once per day and per restart of the system`;
    $('us-ov-classes').innerHTML = UA_ORDER.map((k) => {
      const c = cls.get(k) || { n: 0, v: 0 };
      const [name, color, sub] = uaOf(k);
      return `<div class="us-ov-class${c.n ? '' : ' none'}" style="--c:${color}"><span class="us-kind">${esc(name)}</span><b>${fmtN(c.v)}</b><small>${c.v === 1 ? 'visitor' : 'visitors'} · ${fmtN(c.n)} requests</small><small>${esc(sub)}</small></div>`;
    }).join('');

    // per hour, stacked by caller
    const end = new Date();
    end.setUTCMinutes(0, 0, 0);
    const slots = [];
    for (let i = 23; i >= 0; i--) slots.push(new Date(end.getTime() - i * 3600e3).toISOString().slice(0, 13));
    const by = new Map(slots.map((x) => [x, {}]));
    for (const h of w.hours) { const b = by.get(h.h); if (b) b[h.c] = (b[h.c] || 0) + h.n; }
    const max = Math.max(1, ...[...by.values()].map((b) => Object.values(b).reduce((a, n) => a + n, 0)));
    $('us-ov-hours').innerHTML = `<div class="us-day us-ov-day">${slots.map((x) => {
      const b = by.get(x);
      const n = Object.values(b).reduce((a, m) => a + m, 0);
      const local = new Date(x + ':00:00Z').getHours();
      return `<div class="us-day-col" title="${local}:00 · ${n} requests${n ? ' · ' + UA_ORDER.filter((k) => b[k]).map((k) => `${uaOf(k)[0]} ${b[k]}`).join(', ') : ''}">`
        + `<div class="us-day-bar" style="height:${(n / max) * 100}%">${UA_ORDER.filter((k) => b[k]).map((k) => `<i style="flex:${b[k]};background:${uaOf(k)[1]}"></i>`).join('')}</div>`
        + `<span>${local % 6 === 0 ? local : ''}</span></div>`;
    }).join('')}</div>`;

    // connecting an AI: authorize page → client registered → token issued
    const o = w.oauth || {};
    const steps = [['Login page opened', o.authorize || 0], ['Client registered', o.registered || 0], ['Token issued', o.tokens || 0]];
    const top = Math.max(1, ...steps.map((x) => x[1]));
    $('us-ov-oauth').innerHTML = steps.map(([label, n]) => `<div class="us-pc us-ov-step"><span>${esc(label)}</span><i class="us-pc-bar"><i style="width:${(n / top) * 100}%;background:var(--orange)"></i></i><b>${n}</b></div>`).join('')
      + (st.outside.started > st.outside.connected ? `<p class="us-out-note">All time: ${st.outside.started} connection starts, ${st.outside.connected} with a login.</p>` : '');

    const list = (rows, label, n, sub = () => '') => rows.map((r) => `<li><span class="us-ov-name" title="${esc(label(r))}">${esc(label(r))}</span>${sub(r)}<b>${fmtN(n(r))}</b></li>`).join('') || '<li class="ev-none">None yet</li>';
    $('us-ov-pages').innerHTML = list(w.pages, (r) => r.route, (r) => r.v, (r) => `<small>${fmtN(r.n)} views</small>`);
    $('us-ov-refs').innerHTML = list(w.refs, (r) => r.host, (r) => r.v, (r) => `<small>${fmtN(r.n)} requests</small>`);
    $('us-ov-refused').innerHTML = list(w.refused, (r) => r.route, (r) => r.n, (r) => `<small><i class="us-ua-dot" style="background:${uaOf(r.c)[1]}"></i>${esc(uaOf(r.c)[0])} · ${esc(r.kind)} · ${esc(ago(r.last))}</small>`);
    renderOutsideLive();
  }

  function renderOutsideLive() {
    const rows = [...st.web].reverse().slice(0, 80);
    $('us-ov-live-meta').textContent = rows.length ? `latest ${rows.length} · no address is kept, a visitor is a daily hash` : '';
    $('us-ov-live').innerHTML = rows.map((r) => {
      const [name, color] = uaOf(r.ua);
      const bad = r.auth === 'refused' || r.status >= 400;
      return `<li class="${bad ? 'bad' : ''}"><span class="us-req-time">${esc(clock(r.at))}</span>`
        + `<span class="us-req-who" style="--c:${color}"><i></i>${esc(name)}</span>`
        + `<code class="us-ov-visitor" title="visitor (daily hash)">${esc(String(r.visitor || '').slice(0, 6))}</code>`
        + `<span class="us-ov-route"><b>${esc(r.method)}</b> ${esc(r.route)}${r.ref && r.ref !== 'self' ? `<small>from ${esc(r.ref)}</small>` : ''}</span>`
        + `<span class="us-ov-status">${esc(r.status)}</span><span class="us-req-ms">${ms(r.ms)}</span>`
        + `<span class="us-out" style="--o:${r.auth === 'refused' ? 'var(--coral)' : r.user ? 'var(--mint)' : 'var(--steel)'}">${esc(r.auth === 'refused' ? 'refused' : r.kind)}</span></li>`;
    }).join('') || '<li class="ev-none">No request without an account in view yet.</li>';
  }

  // ---------- rail ----------

  function renderRail() {
    const traces = traceList();
    const now = Date.now();
    const done = traces.filter((t) => Number.isFinite(t.ms) && !t.partial);
    const lat = done.map((t) => t.ms);
    const hour = traces.filter((t) => now - Date.parse(t.start) < 3600e3).length;
    const day = st.hours.reduce((s, h) => s + h.n, 0);
    const active = new Set(traces.filter((t) => now - Date.parse(t.end) < 15 * 60e3).map((t) => t.user)).size;
    const strangers = new Set(st.hours.filter((h) => ['stranger', 'unknown'].includes(kindOf(h.u))).map((h) => h.u)).size;
    const errors = traces.filter((t) => t.outcome === 'error').length;
    const kpi = (label, v, cls = '', title = '') => `<div class="ev-kpi ${cls}" title="${esc(title)}"><span>${label}</span><b>${v}</b></div>`;
    $('us-kpis').innerHTML = kpi('Last hour', hour, '', 'requests in the last hour')
      + kpi('24 h', fmtN(day), '', `${word('calls', 'tool calls')} in the last 24 hours`)
      + kpi('Active', active, active ? 'good' : '', 'accounts with a request in the last 15 minutes')
      + kpi('Strangers', strangers, strangers ? 'warn' : '', 'accounts not marked as known that called in the last 24 hours')
      + kpi('p50', ms(pct(lat, 50)), '', `p95 ${ms(pct(lat, 95))}`)
      + kpi('Errors', errors, errors ? 'bad' : '', 'requests that ended in an error, in view');
    renderOutside();
    renderDay();
    renderRanking(traces);
    renderPhaseCosts(done);
  }

  /** What the system knows of people without an account: only connection starts, so far. */
  function renderOutside() {
    const o = st.outside;
    const w = o?.web;
    const row = (n, label, cls = '') => `<div class="us-out-row ${cls}"><b>${fmtN(n)}</b><span>${label}</span></div>`;
    if (w) {
      const v = (k) => w.classes.find((c) => c.c === k)?.v || 0;
      const refused = w.refused.reduce((n, r) => n + r.n, 0);
      $('us-outside').innerHTML = row(v('browser'), 'people in a browser') + row(v('claude') + v('chatgpt'), 'AI clients without a login')
        + row(v('bot') + v('other'), 'bots and other callers') + (refused ? row(refused, 'refused calls (401, 403)', 'warn') : '')
        + '<button class="bar-btn us-out-open" data-open-outside>Open outside view</button>';
    } else {
      $('us-outside').innerHTML = (o ? row(o.started, 'connection starts by an AI client') + row(o.connected, 'finished with a login')
        + (o.started > o.connected ? row(o.started - o.connected, `started, never logged in${o.lastStart ? ` · last start ${esc(ago(o.lastStart))}` : ''}`, 'warn') : '') : '')
        + '<p class="us-out-note">Website visits and refused calls show up once the system keeps its access log.</p>';
    }
    $('us-outside').querySelector('[data-open-outside]')?.addEventListener('click', () => setMode('outside'));
  }

  /** Tool calls per hour over 24 h, stacked by who called. */
  function renderDay() {
    const end = new Date();
    end.setUTCMinutes(0, 0, 0);
    const slots = [];
    for (let i = 23; i >= 0; i--) slots.push(new Date(end.getTime() - i * 3600e3).toISOString().slice(0, 13));
    const by = new Map(slots.map((s) => [s, {}]));
    for (const h of st.hours) { const b = by.get(h.h); if (b) { const k = kindOf(h.u); b[k] = (b[k] || 0) + h.n; } }
    const max = Math.max(1, ...[...by.values()].map((b) => Object.values(b).reduce((s, n) => s + n, 0)));
    const order = ['owner', 'team', 'known', 'stranger', 'unknown', 'test'];
    $('us-day').innerHTML = `<div class="us-day">${slots.map((s) => {
      const b = by.get(s);
      const n = Object.values(b).reduce((x, y) => x + y, 0);
      const local = new Date(s + ':00:00Z').getHours();
      return `<div class="us-day-col" title="${local}:00 · ${n} calls${n ? ' · ' + order.filter((k) => b[k]).map((k) => `${KIND[k][0]} ${b[k]}`).join(', ') : ''}">`
        + `<div class="us-day-bar" style="height:${(n / max) * 100}%">${order.filter((k) => b[k]).map((k) => `<i style="flex:${b[k]};background:${KIND[k][1]}"></i>`).join('')}</div>`
        + `<span>${local % 6 === 0 ? local : ''}</span></div>`;
    }).join('')}</div>`
      + `<div class="us-legend">${order.filter((k) => k !== 'unknown').map((k) => `<span><i style="background:${KIND[k][1]}"></i>${KIND[k][0]}</span>`).join('')}</div>`;
  }

  function renderRanking(traces) {
    const now = Date.now();
    const live = new Set(traces.filter((t) => now - Date.parse(t.end) < ACTIVE_MS).map((t) => t.user));
    const rows = st.users.filter((u) => u.kind !== 'test').sort((a, b) => (b.calls7 - a.calls7) || (b.calls - a.calls));
    const max = Math.max(1, ...rows.map((u) => u.calls7));
    $('us-rank').innerHTML = rows.map((u, i) => {
      const [kname, color] = KIND[u.kind] || KIND.unknown;
      const nf = u.questions ? Math.round((u.nothing / u.questions) * 100) : 0;
      return `<li class="us-rank-row${live.has(u.id) ? ' live' : ''}" style="--c:${color}">`
        + `<span class="us-rank-n">${i + 1}</span>`
        + `<div class="us-rank-main"><div class="us-rank-name"><b>${esc(u.name)}</b><span class="us-kind sm">${esc(kname)}</span></div>`
        + `<i class="us-rank-bar"><i style="width:${(u.calls7 / max) * 100}%"></i></i>`
        + `<small>${fmtN(u.calls7)} ${word('calls', 'calls')} · ${u.questions} ${word('questions', 'questions')} · ${u.answers} ${word('answers', 'receipts')}${u.questions && word('nothing', true) ? ` · ${nf} % nothing found` : ''}</small>`
        + `<small>${esc((u.clients || []).map(clientName).join(', ') || 'no client yet')} · ${esc(ago(u.last))}</small></div></li>`;
    }).join('') || '<li class="ev-none">No accounts yet</li>';
  }

  /** Where the time goes: the average share of each phase over the finished requests in view. */
  function renderPhaseCosts(done) {
    const sum = {};
    const cnt = {};
    for (const t of done) for (const x of phaseTimes(t)) { sum[x.stage] = (sum[x.stage] || 0) + x.ms; cnt[x.stage] = (cnt[x.stage] || 0) + 1; }
    const rows = PHASES.filter((p) => cnt[p]).map((p) => ({ p, avg: sum[p] / cnt[p], n: cnt[p] }));
    const max = Math.max(1, ...rows.map((r) => r.avg));
    $('us-phase-costs').innerHTML = rows.map((r) => `<div class="us-pc"><span>${esc(PHASE_NAME[r.p])}</span>`
      + `<i class="us-pc-bar"><i style="width:${(r.avg / max) * 100}%;background:${PHASE_COLOR[r.p]}"></i></i><b>${ms(r.avg)}</b></div>`).join('')
      || '<div class="ev-none">No finished request in view</div>';
  }

  // ---------- one request ----------

  async function openTrace(id) {
    let t;
    try {
      const q = projectQuery();
      const r = await fetch(`/api/usage/trace${q}${q ? '&' : '?'}id=${encodeURIComponent(id)}`);
      t = r.ok ? await r.json() : null;
    } catch { t = null; }
    if (!t) return;
    const p = person(t.user);
    const [kname, color] = KIND[kindOf(t.user)];
    const t0 = Date.parse(t.start);
    const span = Math.max(1, Date.parse(t.end) - t0);
    const [oname, ocolor] = OUTCOME[t.outcome] || OUTCOME.running;
    const steps = t.steps.map((s) => {
      const off = Date.parse(s.at) - t0;
      return `<li class="us-step${s.status === 'error' || s.status === 'refused' ? ' bad' : ''}">`
        + `<span class="us-step-off">+${ms(off)}</span>`
        + `<span class="us-step-phase" style="--p:${PHASE_COLOR[s.stage] || '#7F8DB3'}">${esc(PHASE_NAME[s.stage] || s.stage)}</span>`
        + `<span class="us-step-status">${esc(s.status)}</span>`
        + `<span class="us-step-text">${esc(s.text)}</span>`
        + `<i class="us-step-tick" style="left:${(off / span) * 100}%"></i></li>`;
    }).join('');
    const calls = (t.sources || []).filter((s) => !s.logical);
    const panel = $('us-trace');
    panel.hidden = false;
    panel.innerHTML = `<div class="ev-trace-body"><button class="icon-btn small ev-panel-close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`
      + `<div class="ev-trace-head"><div><span class="eyebrow">${esc(t.tool || 'Request')} · ${esc(clock(t.start))}</span><h3>${esc(t.question || t.unit || t.summary || t.trace)}</h3>`
      + `<div class="ev-trace-sub"><span class="us-req-who" style="--c:${color}"><i></i>${esc(p?.name || kname)}</span> · ${esc(kname)}${t.client ? ` · ${esc(clientName(t.client))}` : ''}${t.unit ? ` · <code>${esc(t.unit)}</code>` : ''}</div></div></div>`
      + `<div class="ev-verdict" style="border-color:${ocolor}"><b style="color:${ocolor}">${esc(oname)}</b><span>${ms(t.ms)} in the system</span>${t.summary ? `<span>${esc(t.summary)}</span>` : ''}${t.withheld ? '<span>part of the rows held back for payment</span>' : ''}</div>`
      + (calls.length ? `<span class="eyebrow">Source calls</span><ul class="us-calls">${calls.map((s) => `<li${s.status !== 'ok' ? ' class="bad"' : ''}><b>${esc(st.sources.get(s.id)?.name || s.id)}</b><code>${esc(s.host || '')}</code><span>${ms(s.ms)}</span><em>${esc(s.status)}</em></li>`).join('')}</ul>` : '')
      + `<span class="eyebrow">Steps</span><ol class="us-steps">${steps}</ol></div>`;
    panel.querySelector('.ev-panel-close').onclick = () => { panel.hidden = true; };
  }
  $('us-reqs').addEventListener('click', (e) => { const li = e.target.closest('[data-trace]'); if (li) openTrace(li.dataset.trace); });
  $('us-reqs').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const li = e.target.closest('[data-trace]'); if (li) openTrace(li.dataset.trace); } });

  // ---------- light points ----------

  function sizeLines() {
    const host = stage.getBoundingClientRect();
    lines.setAttribute('viewBox', `0 0 ${host.width} ${host.height}`);
  }

  function center(el, side) {
    const host = stage.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return [r.left - host.left + r.width / 2, side === 'top' ? r.top - host.top : r.bottom - host.top];
  }

  function shoot(fromEl, toEl, color) {
    if (!fromEl || !toEl || !st.visible || !fromEl.getClientRects().length || !toEl.getClientRects().length) return;
    const [x1, y1] = center(fromEl, 'bottom');
    const [x2, y2] = center(toEl, 'top');
    const my = (y1 + y2) / 2;
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', `M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}`);
    path.setAttribute('class', 'ev-trail');
    path.style.setProperty('stroke', color);
    const dot = document.createElementNS(SVGNS, 'circle');
    dot.setAttribute('r', '5');
    dot.setAttribute('class', 'ev-dot');
    dot.style.setProperty('fill', color);
    lines.append(path, dot);
    const len = path.getTotalLength();
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 650);
      const e = k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      const p = path.getPointAtLength(e * len);
      dot.setAttribute('cx', p.x); dot.setAttribute('cy', p.y);
      if (k < 1) { requestAnimationFrame(step); return; }
      dot.remove();
      path.classList.add('fade');
      setTimeout(() => path.remove(), 1400);
      toEl.classList.remove('hit'); void toEl.offsetWidth; toEl.classList.add('hit');
    };
    requestAnimationFrame(step);
  }

  function burst(el, color) {
    if (!el) return;
    el.style.setProperty('--burst', color);
    el.classList.remove('burst'); void el.offsetWidth; el.classList.add('burst');
  }

  // ---------- show / hide ----------

  function show() {
    st.visible = true;
    stage.hidden = false;
    setMode(st.mode);
    render();
    clearInterval(st.timer);
    // "x min ago" and the active marks age without new events
    st.timer = setInterval(() => { markActive(); renderRail(); }, 15_000);
  }

  function hide() {
    st.visible = false;
    stage.hidden = true;
    $('us-trace').hidden = true;
    clearInterval(st.timer);
  }

  window.addEventListener('resize', () => { if (st.visible && mode() !== 'outside') renderBands(); });

  return { setSnapshot, onStatus, onUsers, onEvents, onWeb, show, hide, enabled: () => st.enabled };
}
