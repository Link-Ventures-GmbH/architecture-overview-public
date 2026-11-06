// Evals view: models answering questions against the project through its tools, a judge
// grading them. Three bands (agents, the project's tools, the source hosts behind them), a
// light point per tool call, and on the right the run: progress, budget, latency, errors and
// the outcome matrix field × model. Data from the runner's live.json plus GenAI spans.

import { createEvalsOverview, markdown } from './evals-overview.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const OUTCOMES = ['answered', 'partial', 'unbacked', 'honest_gap', 'wrong', 'platform_error'];
const OUTCOME_NAME = { answered: 'Answered', partial: 'Partial', unbacked: 'Unbacked', honest_gap: 'Honest gap', wrong: 'Wrong', platform_error: 'Platform error', model_error: 'Model error' };
const STATE_NAME = { asking: 'asking', tool_call: 'tool call', follow_up: 'follow-up', judging: 'judging', done: 'done', error: 'error', waiting: 'waiting' };
const FAMILY = [['opus', '#FF6A2B'], ['sonnet', '#6FE3FF'], ['haiku', '#5CF0B4'], ['fable', '#A08CFF']];
const PALETTE = ['#FFC24B', '#A08CFF', '#5CF0B4', '#FF7B93', '#6FE3FF', '#FF6A2B', '#B9C4E2'];
const SPAN_FLOW_MS = 8000;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const fmtN = (n) => (n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)));
const ms = (v) => (v == null ? '–' : v >= 10000 ? `${Math.round(v / 1000)} s` : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const usd = (v) => (v == null ? '–' : `$${num(v) >= 100 ? Math.round(num(v)) : num(v) > 0 && num(v) < 1 ? num(v).toFixed(3) : num(v).toFixed(2)}`);
// When the runner sends no country, the domain often says it (.de, .eu); generic ones stay open.
const countryOf = (h) => { const tld = String(h.host || '').split('.').pop(); return h.country || (/^[a-z]{2}$/.test(tld) ? tld.toUpperCase() : '··'); };
const modelName = (m) => String(m || '?').split('/').pop();
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
function modelColor(m) {
  const s = String(m || '').toLowerCase();
  for (const [k, c] of FAMILY) if (s.includes(k)) return c;
  return PALETTE[hash(s) % PALETTE.length];
}

export function createEvalsView({ projectQuery = () => '', repoName = () => '' } = {}) {
  const st = { visible: false, enabled: false, live: null, runs: [], pick: 'live', past: null, verdicts: [], lastSpanFlow: 0,
    prevAgents: new Map(), extraTools: new Map(), extraHosts: new Map(), timer: null, shownAgents: new Set() };
  const stage = $('ev-stage');
  const lines = $('ev-lines');
  st.mode = (() => { try { return localStorage.getItem('ao-evmode') || 'live'; } catch { return 'live'; } })();
  st.ledger = null;
  st.hasNeeds = false;

  /** The big overlay panel (waterfall, field details, reports). */
  function openPanel(html) {
    const panel = $('ev-trace');
    panel.hidden = false;
    panel.innerHTML = `<div class="ev-trace-body"><button class="icon-btn small ev-panel-close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>${html}</div>`;
    panel.querySelector('.ev-panel-close').onclick = () => { panel.hidden = true; };
    panel.scrollTop = 0;
  }
  const overview = createEvalsOverview({ projectQuery, openPanel });

  function setMode(mode) {
    st.mode = mode;
    try { localStorage.setItem('ao-evmode', mode); } catch { /* private window */ }
    for (const b of stage.querySelectorAll('[data-evmode]')) b.setAttribute('aria-pressed', String(b.dataset.evmode === mode));
    stage.dataset.mode = mode;
    $('ev-cov').hidden = mode !== 'coverage';
    $('ev-cmp').hidden = mode !== 'variants';
    $('ev-trace').hidden = true;
    if (mode === 'coverage') overview.showCoverage(st.runs);
    else if (mode === 'variants') overview.showCompare();
    else renderBands();
  }
  for (const b of stage.querySelectorAll('[data-evmode]')) b.addEventListener('click', () => setMode(b.dataset.evmode));

  const data = () => (st.pick === 'live' ? st.live : st.past?.summary || null);

  // ---------- data in ----------

  function setSnapshot(ev) {
    st.enabled = !!ev?.enabled;
    st.live = ev?.live || null;
    st.runs = ev?.runs || [];
    st.ledger = ev?.ledger || null;
    st.hasNeeds = !!ev?.needs;
    st.extraTools.clear();
    st.extraHosts.clear();
    st.prevAgents.clear();
    st.pick = 'live';
    st.past = null;
    if (st.visible) render();
  }

  function onLive(d) {
    const before = st.live;
    st.live = d;
    if (d && before && d.run_id !== before.run_id) { st.extraTools.clear(); st.extraHosts.clear(); refreshRuns(); }
    if (!st.visible || st.pick !== 'live') { remember(d); return; }
    render();
    derivedDots(d);
  }

  /** Without spans, a changed tool step in live.json still gets its light point. */
  function derivedDots(d) {
    const agents = d?.agents || [];
    if (Date.now() - st.lastSpanFlow > SPAN_FLOW_MS) {
      for (const a of agents) {
        const prev = st.prevAgents.get(a.id);
        if (a.state === 'tool_call' && a.step && (!prev || prev.step !== a.step || prev.state !== a.state)) {
          requestAnimationFrame(() => shoot(agentEl(a), toolEl(a.step), modelColor(a.model)));
        }
      }
    }
    remember(d);
  }

  function remember(d) {
    st.prevAgents = new Map((d?.agents || []).map((a) => [a.id, { step: a.step, state: a.state }]));
  }

  function onFlows(list) {
    st.lastSpanFlow = Date.now();
    if (!st.visible || st.pick !== 'live') return;
    let rerender = false;
    for (const f of list) {
      if (f.tool && !toolEl(f.tool)) { st.extraTools.set(f.tool, { name: f.tool, calls: 0, errors: 0 }); rerender = true; }
      for (const h of f.hosts || []) if (!hostEl(h.host)) { st.extraHosts.set(h.host, { host: h.host, calls: 0, errors: 0, limited: 0 }); rerender = true; }
    }
    if (rerender) renderBands();
    requestAnimationFrame(() => {
      list.forEach((f, i) => setTimeout(() => playFlow(f), i * 90));
    });
  }

  function playFlow(f) {
    const a = agentFor(f.tr, f.qid);
    const from = a ? agentEl(a) : $('ev-more');
    const color = modelColor(f.model || a?.model);
    if (f.done) { burst(from, f.done === 'answered' ? 'var(--mint)' : f.done === 'wrong' || f.done === 'platform_error' ? 'var(--coral)' : 'var(--amber)'); return; }
    const tool = toolEl(f.tool);
    shoot(from, tool, f.e ? 'var(--coral)' : color, 0, () => {
      (f.hosts || []).forEach((h, i) => shoot(tool, hostEl(h.host), h.e ? 'var(--coral)' : color, i * 80));
    });
  }

  async function refreshRuns() {
    try {
      const r = await (await fetch(`/api/evals/runs${projectQuery()}`)).json();
      const grew = (r.runs || []).length !== st.runs.length;
      st.runs = r.runs || [];
      st.ledger = r.ledger || null;
      if (grew && st.visible && st.mode === 'coverage') overview.showCoverage(st.runs);
      if (st.visible) renderPicker();
    } catch { /* server restarting */ }
  }

  async function loadVerdicts() {
    const id = st.pick === 'live' ? st.live?.run_id : st.pick;
    if (!id) { st.verdicts = []; return; }
    try {
      const r = await fetch(`/api/evals/run${projectQuery()}${projectQuery() ? '&' : '?'}id=${encodeURIComponent(id)}`);
      const d = r.ok ? await r.json() : null;
      st.verdicts = d?.verdicts || [];
      if (st.pick !== 'live') st.past = d;
    } catch { st.verdicts = []; }
  }

  // ---------- lookups ----------

  const agentFor = (tr, qid) => (data()?.agents || []).find((a) => (tr && a.trace_id === tr) || (qid && (a.id === qid || String(a.id).startsWith(qid + '@'))));
  const sel = (attr, v) => stage.querySelector(`[${attr}="${CSS.escape(String(v))}"]`);
  const agentEl = (a) => (a && st.shownAgents.has(a.id) ? sel('data-agent', a.id) : $('ev-more'));
  const toolEl = (name) => (name ? sel('data-tool', name) : null);
  const hostEl = (host) => (host ? sel('data-host', host) || $('ev-hosts-more') : null);

  // ---------- render ----------

  function render() {
    renderPicker();
    renderBands();
    renderRail();
  }

  function renderPicker() {
    const s = $('ev-run');
    const live = st.live;
    const opts = [`<option value="live">${esc(live ? `Live · ${live.label || live.run_id}` : 'Live · waiting for the runner')}</option>`];
    for (const r of st.runs) if (r.id !== live?.run_id || live?.state === 'done') opts.push(`<option value="${esc(r.id)}">${esc(r.label || r.id)} · ${esc(r.state || '')}</option>`);
    s.innerHTML = opts.join('');
    s.value = st.pick;
  }

  function renderBands() {
    const d = data();
    const empty = !d;
    const live = st.mode === 'live';
    $('ev-empty').hidden = !empty || !live;
    for (const b of stage.querySelectorAll('.ev-band-agents, .ev-band-tools, .ev-band-hosts')) b.hidden = empty || !live;
    if (!live) { lines.innerHTML = ''; return; }
    if (empty) { lines.innerHTML = ''; return; }

    // agents: as many cards as fit, the rest as "+N"
    const agents = [...(d.agents || [])].sort((a, b) => (a.state === 'done') - (b.state === 'done'));
    const box = $('ev-cards').getBoundingClientRect();
    const cols = Math.max(1, Math.floor((box.width + 12) / 232));
    const rows = Math.max(1, Math.floor((box.height + 12) / 118));
    const max = cols * rows;
    const shown = agents.length > max ? agents.slice(0, max - 1) : agents;
    st.shownAgents = new Set(shown.map((a) => a.id));
    $('ev-agents-count').textContent = agents.length ? `${agents.filter((a) => a.state !== 'done').length} running · ${agents.length} total` : '';
    $('ev-cards').innerHTML = shown.map(agentCard).join('')
      + (agents.length > shown.length ? `<div class="ev-card ev-more" id="ev-more"><b>+${agents.length - shown.length}</b><span>more agents</span></div>` : '<div class="ev-more-anchor" id="ev-more"></div>')
      + (agents.length ? '' : '<div class="ev-none">No agent running right now</div>');

    // tools of the project under test
    $('ev-target-cap').textContent = `${repoName() || 'Project'} · tools`;
    $('ev-target').textContent = d.target ? d.target.replace(/^https?:\/\//, '') : '';
    const tools = new Map((d.tools || []).map((t) => [t.name, t]));
    for (const [k, t] of st.extraTools) if (!tools.has(k)) tools.set(k, t);
    const maxCalls = Math.max(1, ...[...tools.values()].map((t) => num(t.calls)));
    $('ev-tools').innerHTML = [...tools.values()].map((t) => `<div class="ev-tool${num(t.errors) ? ' has-err' : ''}" data-tool="${esc(t.name)}">`
      + `<span class="ev-tool-name">${esc(t.name)}</span>`
      + `<span class="ev-tool-n">${fmtN(num(t.calls))}<small>calls</small></span>`
      + `<span class="ev-tool-meta"><span>p95 ${ms(t.p95_ms)}</span>${num(t.errors) ? `<em>${num(t.errors)} err</em>` : ''}</span>`
      + `<i class="ev-tool-bar"><i data-w="${Math.round((num(t.calls) / maxCalls) * 100)}"></i></i></div>`).join('')
      || '<div class="ev-none">No tool calls yet</div>';
    for (const i of $('ev-tools').querySelectorAll('[data-w]')) i.style.width = `${i.dataset.w}%`;

    // source hosts
    const hosts = new Map((d.sources || []).map((h) => [h.host, h]));
    for (const [k, h] of st.extraHosts) if (!hosts.has(k)) hosts.set(k, h);
    const list = [...hosts.values()].sort((a, b) => num(b.calls) - num(a.calls));
    const cap = 36;
    $('ev-hosts').innerHTML = list.slice(0, cap).map((h) => `<div class="ev-host${num(h.errors) ? ' has-err' : ''}${num(h.limited) ? ' limited' : ''}" data-host="${esc(h.host)}" title="${esc(h.host)} · p95 ${ms(h.p95_ms)}">`
      + `<span class="cc">${esc(countryOf(h))}</span><span class="ev-host-name">${esc(h.host)}</span><b>${fmtN(num(h.calls))}</b>`
      + (num(h.errors) ? `<em>${num(h.errors)} err</em>` : '') + (num(h.limited) ? '<span class="ev-limit">limit hit</span>' : '') + '</div>').join('')
      + (list.length > cap ? `<div class="ev-host ev-host-more" id="ev-hosts-more">+${list.length - cap} more</div>` : '')
      || '<div class="ev-none">No source called yet</div>';
    requestAnimationFrame(drawWires);
  }

  function agentCard(a) {
    const c = modelColor(a.model);
    const stateKey = String(a.state || 'waiting').replace(/[^a-z_]/g, '');
    return `<div class="ev-card s-${stateKey}" data-agent="${esc(a.id)}" data-c="${c}" tabindex="0" title="${esc(a.question || '')}">`
      + `<div class="ev-card-top"><span class="ev-field">${esc(a.field || a.role || '')}</span><span class="ev-state">${esc(STATE_NAME[stateKey] || stateKey)}</span></div>`
      + `<div class="ev-persona">${esc(short(a.persona || a.id, 40))}</div>`
      + `<div class="ev-q">${esc(a.question || '')}</div>`
      + `<div class="ev-card-foot"><span class="ev-model"><i></i>${esc(modelName(a.model))}</span>${a.step ? `<code>${esc(short(a.step, 22))}</code>` : ''}</div></div>`;
  }

  /** Faint wires from each band to the next, so the eye reads agent → tool → source. */
  function drawWires() {
    const host = stage.getBoundingClientRect();
    lines.setAttribute('viewBox', `0 0 ${host.width} ${host.height}`);
    lines.innerHTML = '';
    for (const card of stage.querySelectorAll('.ev-card[data-agent], .ev-card.ev-more')) card.style.setProperty('--c', card.dataset.c || 'var(--steel)');
  }

  function center(el, side) {
    const host = stage.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const x = r.left - host.left + r.width / 2;
    const y = side === 'top' ? r.top - host.top : side === 'bottom' ? r.bottom - host.top : r.top - host.top + r.height / 2;
    return [x, y];
  }

  function shoot(fromEl, toEl, color, delay = 0, done) {
    if (!fromEl || !toEl || !st.visible) { done?.(); return; }
    setTimeout(() => {
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
      const dur = 650;
      const step = (now) => {
        const k = Math.min(1, (now - t0) / dur);
        const e = k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        const p = path.getPointAtLength(e * len);
        dot.setAttribute('cx', p.x); dot.setAttribute('cy', p.y);
        if (k < 1) { requestAnimationFrame(step); return; }
        dot.remove();
        path.classList.add('fade');
        setTimeout(() => path.remove(), 1400);
        toEl.classList.remove('hit'); void toEl.offsetWidth; toEl.classList.add('hit');
        done?.();
      };
      requestAnimationFrame(step);
    }, delay);
  }

  function burst(el, color) {
    if (!el) return;
    el.style.setProperty('--burst', color);
    el.classList.remove('burst'); void el.offsetWidth; el.classList.add('burst');
  }

  // ---------- rail ----------

  function renderRail() {
    const d = data();
    const live = st.pick === 'live';
    if (!d) {
      renderLedger();
      $('ev-now').innerHTML = `<div class="now-module">No run yet</div><div class="ag-summary">The runner writes its state to <code>live.json</code>; this view picks it up as soon as it appears.</div>`;
      for (const id of ['ev-budget', 'ev-kpis', 'ev-matrix', 'ev-questions']) $(id).innerHTML = '';
      return;
    }
    const done = num(d.progress?.done);
    const total = num(d.progress?.total);
    const pct = total ? Math.min(100, (done / total) * 100) : 0;
    const stateCls = String(d.state || '').replace(/[^a-z]/g, '');
    $('ev-now').innerHTML = `<div class="ev-run-head"><span class="ev-run-state st-${stateCls}">${esc(d.state || 'unknown')}</span>${live && d.updated_at ? `<span class="ev-updated">updated ${esc(timeAgo(d.updated_at))}</span>` : ''}</div>`
      + `<div class="now-module">${esc(d.label || d.run_id || 'Run')}</div>`
      + `<div class="ev-progress"><i data-w="${pct.toFixed(1)}"></i></div>`
      + `<div class="ev-progress-txt"><b>${done}</b> of ${total || '?'} questions · ${pct.toFixed(0)} %</div>`;

    const b = d.budget || {};
    const spent = num(b.spent_usd);
    const limit = num(b.limit_usd);
    const bp = limit ? Math.min(100, (spent / limit) * 100) : 0;
    $('ev-budget').innerHTML = `<div class="ev-budget${bp >= 90 ? ' hot' : bp >= 70 ? ' warm' : ''}"><i data-w="${bp.toFixed(1)}"></i></div>`
      + `<div class="ev-budget-txt"><b>${usd(spent)}</b> of ${usd(b.limit_usd)} this run${b.total_limit_usd ? ` · ${usd(b.total_limit_usd)} overall` : ''}</div>`;

    renderLedger();
    const c = d.counts || {};
    const l = d.latency || {};
    const kpi = (label, v, cls = '') => `<div class="ev-kpi ${cls}"><span>${label}</span><b>${v}</b></div>`;
    $('ev-kpis').innerHTML = kpi('p50', ms(l.p50_ms)) + kpi('p95', ms(l.p95_ms)) + kpi('Errors', num(c.errors), num(c.errors) ? 'bad' : '')
      + kpi('Rate limits', num(c.rate_limited), num(c.rate_limited) ? 'warn' : '') + kpi('Tool calls', fmtN(num(c.tool_calls)));

    renderMatrix(d.matrix && Object.keys(d.matrix).length ? d.matrix : matrixFrom(st.verdicts));
    renderQuestions(d);
    for (const i of $('ev-rail').querySelectorAll('[data-w]')) i.style.width = `${i.dataset.w}%`;
  }

  function renderLedger() {
    const g = st.ledger;
    $('ev-needs').hidden = !st.hasNeeds;
    if (!g) { $('ev-ledger').innerHTML = ''; return; }
    const lp = g.limit_usd ? Math.min(100, (g.spent_usd / g.limit_usd) * 100) : 0;
    const kinds = Object.entries(g.by_kind || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${usd(v)}`).join(' · ');
    $('ev-ledger').innerHTML = `<div class="ev-budget all${lp >= 90 ? ' hot' : lp >= 70 ? ' warm' : ''}" title="${esc(kinds)}"><i data-w="${lp.toFixed(1)}"></i></div>`
      + `<div class="ev-budget-txt"><b>${usd(g.spent_usd)}</b> of ${usd(g.limit_usd)} over all runs · ${g.entries} entries</div>`;
  }

  function matrixFrom(verdicts) {
    const m = {};
    for (const v of verdicts) {
      if (!OUTCOMES.includes(v.status)) continue; // model_error is the provider's fault, not the project's
      const f = v.field || '–';
      m[f] ??= {};
      m[f][v.model] ??= {};
      m[f][v.model][v.status] = (m[f][v.model][v.status] || 0) + 1;
    }
    return m;
  }

  function renderMatrix(m) {
    const fields = Object.keys(m || {}).sort();
    if (!fields.length) { $('ev-matrix').innerHTML = '<div class="ag-note">Fills in as the judge grades answers.</div>'; return; }
    const models = [...new Set(fields.flatMap((f) => Object.keys(m[f])))].sort();
    const cell = (counts) => {
      const total = OUTCOMES.reduce((s, k) => s + num(counts?.[k]), 0);
      if (!total) return '<td class="ev-cell empty"></td>';
      const tip = OUTCOMES.filter((k) => num(counts[k])).map((k) => `${OUTCOME_NAME[k]} ${counts[k]}`).join(' · ');
      return `<td class="ev-cell" title="${esc(tip)}"><span class="ev-stack">${OUTCOMES.filter((k) => num(counts[k])).map((k) => `<i class="o-${k}" data-w="${((num(counts[k]) / total) * 100).toFixed(1)}"></i>`).join('')}</span></td>`;
    };
    $('ev-matrix').innerHTML = `<div class="ev-matrix-wrap"><table class="ev-matrix"><thead><tr><th></th>${models.map((x) => `<th title="${esc(x)}"><span class="ev-model"><i data-c="${modelColor(x)}"></i>${esc(short(modelName(x), 12))}</span></th>`).join('')}</tr></thead>`
      + `<tbody>${fields.map((f) => `<tr><th title="${esc(f)}">${esc(short(f, 18))}</th>${models.map((x) => cell(m[f][x])).join('')}</tr>`).join('')}</tbody></table></div>`
      + `<div class="ev-legend">${OUTCOMES.map((k) => `<span><i class="o-${k}"></i>${OUTCOME_NAME[k]}</span>`).join('')}</div>`;
    for (const i of $('ev-matrix').querySelectorAll('i[data-c]')) i.style.setProperty('background', i.dataset.c);
  }

  function renderQuestions(d) {
    const items = [];
    for (const a of d.agents || []) if (a.trace_id) items.push({ trace: a.trace_id, title: a.question || a.id, sub: `${modelName(a.model)} · ${STATE_NAME[a.state] || a.state || ''}`, status: a.state === 'done' ? '' : 'running' });
    for (const v of [...st.verdicts].reverse()) {
      if (items.length >= 60) break;
      if (items.some((i) => i.trace && i.trace === v.trace_id)) continue;
      items.push({ trace: v.trace_id, verdict: v, title: v.question || v.question_id, sub: `${modelName(v.model)} · ${v.field || ''} · ${ms(v.latency_ms)}`, status: v.status });
    }
    $('ev-questions').innerHTML = items.length ? items.map((it, i) => `<li data-i="${i}" tabindex="0"><span class="ev-q-dot o-${esc(it.status || 'none')}"></span><span class="ev-q-txt"><b>${esc(short(it.title, 70))}</b><small>${esc(it.sub)}</small></span></li>`).join('')
      : '<li class="ev-none">No graded question yet</li>';
    $('ev-questions').onclick = (e) => {
      const li = e.target.closest('li[data-i]');
      if (li) openTrace(items[Number(li.dataset.i)]);
    };
  }

  // ---------- waterfall ----------

  async function openTrace(it) {
    const panel = $('ev-trace');
    panel.hidden = false;
    panel.innerHTML = '<div class="ev-trace-body"><span class="eyebrow">Loading trace…</span></div>';
    let t = { spans: [], verdict: it.verdict || null };
    if (it.trace) {
      const run = st.pick === 'live' ? st.live?.run_id : st.pick;
      try { t = await (await fetch(`/api/evals/trace${projectQuery()}${projectQuery() ? '&' : '?'}id=${encodeURIComponent(it.trace)}${run ? `&run=${encodeURIComponent(run)}` : ''}`)).json(); } catch { /* keep empty */ }
      t.verdict ||= it.verdict || null;
    }
    const v = t.verdict;
    const note = v ? v.note || v.judge?.notes || '' : '';
    const j = v?.judge || {};
    const axes = v ? [['Correct', j.correctness], ['Backing', j.backing], ['Labelled', j.labelled == null ? null : j.labelled ? 'yes' : 'no'], ['Variant', v.arm],
      ['Receipts', v.receipts], ['Project at', v.kn_commit]].filter(([, x]) => x != null && x !== '') : [];
    const tx = t.transcript;
    const spans = t.spans || [];
    const t0 = spans.length ? Math.min(...spans.map((s) => s.st)) : 0;
    const t1 = spans.length ? Math.max(...spans.map((s) => s.st + s.d)) : 1;
    const span = Math.max(1, t1 - t0);
    const byId = new Map(spans.map((s) => [s.id, s]));
    const depth = (s) => { let d = 0; let p = s.p && byId.get(s.p); while (p && d < 12) { d++; p = p.p && byId.get(p.p); } return d; };
    const label = (s) => (s.host ? `${s.n} → ${s.host}` : s.agent && s.op === 'chat' ? `${s.n} · ${s.agent}` : s.n);
    const kind = (s) => (s.op === 'chat' ? 'chat' : s.op === 'execute_tool' ? 'tool' : s.host ? 'host' : s.svc === spans[0]?.svc ? 'own' : 'svc');
    panel.innerHTML = `<div class="ev-trace-body">`
      + `<div class="ev-trace-head"><div><span class="eyebrow">Question</span><h3>${esc(tx?.question || (it.title !== it.verdict?.question_id ? it.title : '') || t.qid || it.trace)}</h3>`
      + `<div class="ev-trace-sub">${esc(modelName(t.model || v?.model))}${v?.field ? ` · ${esc(v.field)}` : ''}${it.trace ? ` · trace ${esc(it.trace.slice(0, 12))}` : ''}</div></div>`
      + `<button class="icon-btn small" id="ev-trace-close" aria-label="Close trace"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`
      + (v ? `<div class="ev-verdict o-${esc(v.status)}"><b>${esc(OUTCOME_NAME[v.status] || v.status)}</b><span>${usd(v.cost_usd)} · ${ms(v.latency_ms)}</span>${axes.length ? `<div class="ev-axes">${axes.map(([k, x]) => `<span><small>${k}</small>${esc(String(x).replace('_', ' '))}</span>`).join('')}</div>` : ''}${note && note !== 'mock' ? `<p>${esc(note)}</p>` : ''}`
        + (v.citations?.length ? `<div class="ev-cites">${v.citations.slice(0, 12).map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(short(String(u).replace(/^https?:\/\//, ''), 60))}</a>`).join('')}</div>` : '') + `</div>` : '<div class="ev-verdict o-none"><b>No verdict yet</b></div>')
      + (spans.length ? `<ol class="ev-wf">${spans.map((s) => `<li class="k-${kind(s)}${s.e ? ' err' : ''}" title="${esc(label(s))}${s.em ? ' · ' + esc(s.em) : ''}">`
        + `<span class="ev-wf-name" data-depth="${depth(s)}">${esc(short(label(s), 46))}</span>`
        + `<span class="ev-wf-track"><i data-l="${(((s.st - t0) / span) * 100).toFixed(2)}" data-w="${Math.max(0.4, (s.d / span) * 100).toFixed(2)}"></i></span>`
        + `<span class="ev-wf-ms">${ms(s.d)}</span></li>`).join('')}</ol>`
        : tx?.tools?.length ? transcriptTools(tx.tools)
        : '<p class="ag-note">The spans of this question are no longer in memory (or the runner sent none). The verdict comes from verdicts.jsonl.</p>')
      + (tx?.answer ? `<div class="ev-answer"><span class="eyebrow">Answer</span><p>${esc(tx.answer)}</p></div>` : '')
      + `</div>`;
    for (const i of panel.querySelectorAll('.ev-wf-track i')) { i.style.left = `${i.dataset.l}%`; i.style.width = `${i.dataset.w}%`; }
    for (const n of panel.querySelectorAll('[data-depth]')) n.style.paddingLeft = `${Number(n.dataset.depth) * 12}px`;
    $('ev-trace-close').onclick = () => { panel.hidden = true; };
  }

  /** Tool calls from the stored transcript, one after the other, when the spans are gone. */
  function transcriptTools(tools) {
    const total = Math.max(1, tools.reduce((a, t) => a + num(t.ms), 0));
    let at = 0;
    return `<span class="eyebrow ev-wf-cap">Tool calls from the stored transcript</span><ol class="ev-wf">${tools.map((t) => {
      const l = (at / total) * 100;
      at += num(t.ms);
      return `<li class="k-tool${t.error ? ' err' : ''}" title="${esc(t.args)}"><span class="ev-wf-name">${esc(t.name)}${t.chars ? ` <small>${fmtN(t.chars)} chars</small>` : ''}</span>`
        + `<span class="ev-wf-track"><i data-l="${l.toFixed(2)}" data-w="${Math.max(0.6, (num(t.ms) / total) * 100).toFixed(2)}"></i></span><span class="ev-wf-ms">${ms(t.ms)}</span></li>`;
    }).join('')}</ol>`;
  }

  stage.addEventListener('click', (e) => {
    const card = e.target.closest('.ev-card[data-agent]');
    if (!card) return;
    const a = (data()?.agents || []).find((x) => x.id === card.dataset.agent);
    if (a) openTrace({ trace: a.trace_id, title: a.question || a.id });
  });

  function timeAgo(iso) {
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
  }

  // ---------- show / hide ----------

  async function show() {
    st.visible = true;
    stage.hidden = false;
    await refreshRuns();
    await loadVerdicts();
    render();
    setMode(st.mode);
    clearInterval(st.timer);
    // Verdicts and the "updated" clock refresh slowly; live.json itself arrives over SSE.
    st.timer = setInterval(async () => { await loadVerdicts(); renderRail(); }, 8000);
  }

  function hide() {
    st.visible = false;
    stage.hidden = true;
    $('ev-trace').hidden = true;
    clearInterval(st.timer);
  }

  $('ev-run').addEventListener('change', async (e) => {
    st.pick = e.target.value;
    st.past = null;
    $('ev-trace').hidden = true;
    await loadVerdicts();
    render();
  });
  $('ev-needs').addEventListener('click', async () => {
    let md = '';
    try { md = await (await fetch(`/api/evals/needs${projectQuery()}`)).text(); } catch { /* offline */ }
    openPanel(`<span class="eyebrow">Source needs</span><div class="ev-md">${markdown(md || 'Nothing written yet.')}</div>`);
  });
  window.addEventListener('resize', () => { if (st.visible) renderBands(); });

  return { show, hide, setSnapshot, onLive, onFlows, enabled: () => st.enabled };
}
