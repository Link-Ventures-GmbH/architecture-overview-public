#!/usr/bin/env node
// A pretend eval run for the Evals view: writes live.json and runs/<id>/ into
// examples/evals-demo/data/ and sends GenAI spans to the OTLP port, tagged with project.dir.
//   node tools/evals-demo.mjs [--otlp http://localhost:4318] [--questions 60] [--speed 1]

import { writeFileSync, renameSync, mkdirSync, appendFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const OTLP = opt('--otlp', 'http://localhost:4318');
const TOTAL = Number(opt('--questions', 60));
const SPEED = Number(opt('--speed', 1));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/evals-demo');
const DATA = path.join(ROOT, 'data');
const RUN = `demo-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
rmSync(DATA, { recursive: true, force: true });
mkdirSync(path.join(DATA, 'runs', RUN), { recursive: true });

const MODELS = ['anthropic/claude-sonnet-5.5', 'openai/gpt-5.5', 'google/gemini-3-pro', 'mistralai/mistral-large-3'];
const FIELDS = [
  ['Chemistry', 'Purchasing lead, chemicals', 'Price trend of ethylene in the EU since 2020?'],
  ['Energy', 'Grid planner, utility', 'Installed wind capacity per German state in 2025?'],
  ['Labour market', 'HR analyst, automotive', 'Unemployment rate for mechatronics technicians in Bavaria?'],
  ['Public procurement', 'Bid manager, IT services', 'Open tenders for cloud hosting by German federal agencies?'],
  ['Company data', 'Credit analyst, bank', 'Who are the shareholders of a GmbH registered in Hamburg?'],
  ['Agriculture', 'Advisor, farming cooperative', 'Wheat yield per hectare in Lower Saxony over ten years?'],
  ['Health', 'Hospital controller', 'Number of hospital beds per 1,000 inhabitants by district?'],
  ['Transport', 'Logistics planner', 'Freight volume on the Rhine in 2025 by month?'],
];
const TOOLS = ['data_find', 'data_fetch', 'data_check', 'company_lookup'];
const HOSTS = [['ec.europa.eu', 'EU'], ['www-genesis.destatis.de', 'DE'], ['api.bundesagentur.de', 'DE'], ['www.handelsregister.de', 'DE'],
  ['ted.europa.eu', 'EU'], ['data.oecd.org', 'INT'], ['www.smard.de', 'DE'], ['api.worldbank.org', 'INT']];
const OUT = ['answered', 'answered', 'answered', 'partial', 'honest_gap', 'wrong', 'platform_error'];

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const hex = (n) => randomBytes(n).toString('hex');
const now = () => Date.now();
const p = (arr, q) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]); };

const state = {
  started: new Date().toISOString(), done: 0, spent: 0, errors: 0, limited: 0, toolCalls: 0, latencies: [],
  tools: new Map(TOOLS.map((t) => [t, { name: t, calls: 0, errors: 0, lat: [] }])),
  hosts: new Map(), matrix: {}, agents: [], next: 0,
};

function newAgent() {
  if (state.next >= TOTAL) return null;
  const [field, persona, question] = FIELDS[state.next % FIELDS.length];
  const model = MODELS[Math.floor(state.next / FIELDS.length) % MODELS.length];
  const n = ++state.next;
  return { id: `q-${field.toLowerCase().replace(/\W+/g, '-').slice(0, 10)}-${String(n).padStart(2, '0')}@${model.split('/')[1].split('-')[0]}`,
    qid: `q-${String(n).padStart(3, '0')}`, persona, field, model, role: 'executor', state: 'asking', step: 'chat', question,
    trace_id: hex(16), root: hex(8), t0: now(), ticks: 0, toolsLeft: 1 + Math.floor(Math.random() * 3), started_at: new Date().toISOString() };
}

// ---------- spans ----------

const resource = { attributes: [
  { key: 'service.name', value: { stringValue: 'kn-fachtest' } },
  { key: 'project.dir', value: { stringValue: ROOT } },
] };
const attr = (o) => Object.entries(o).filter(([, v]) => v !== undefined).map(([key, v]) => ({ key, value: typeof v === 'number' ? (Number.isInteger(v) ? { intValue: v } : { doubleValue: v }) : { stringValue: String(v) } }));
const span = (a, { id = hex(8), parent, name, kind = 1, t0, t1, attrs = {}, error = false }) => ({
  traceId: a.trace_id, spanId: id, parentSpanId: parent, name, kind,
  startTimeUnixNano: String(BigInt(Math.round(t0 * 1e6))), endTimeUnixNano: String(BigInt(Math.round(t1 * 1e6))),
  attributes: attr({ 'fachtest.run_id': RUN, 'fachtest.question_id': a.qid, ...attrs }),
  status: { code: error ? 2 : 1 },
});
let otlpOk = true;
async function send(spans) {
  try {
    await fetch(`${OTLP}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceSpans: [{ resource, scopeSpans: [{ scope: { name: 'evals-demo' }, spans }] }] }) });
  } catch (e) { if (otlpOk) console.warn(`  no OTLP receiver at ${OTLP} (${e.message}); live.json only`); otlpOk = false; }
}

function toolCall(a) {
  const tool = a.toolsLeft === 1 && a.field === 'Company data' ? 'company_lookup' : pick(TOOLS.slice(0, 3));
  a.step = tool;
  const t1 = now();
  const dur = 120 + Math.random() * 900;
  const t0 = t1 - dur;
  const toolId = hex(8);
  const err = Math.random() < 0.04;
  const spans = [span(a, { id: toolId, parent: a.root, name: `execute_tool ${tool}`, t0, t1, error: err, attrs: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': tool } })];
  const t = state.tools.get(tool);
  t.calls++; t.lat.push(dur); if (err) t.errors++;
  state.toolCalls++;
  if (tool !== 'data_check') {
    const srv = hex(8);
    spans.push(span(a, { id: srv, parent: toolId, name: 'POST /mcp', kind: 2, t0: t0 + 10, t1: t1 - 10, attrs: { 'http.route': '/mcp' } }));
    const n = tool === 'data_find' ? 1 : 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) {
      const [host, country] = a.field === 'Company data' ? HOSTS[3] : pick(HOSTS);
      const limited = Math.random() < 0.05;
      const herr = limited || Math.random() < 0.03;
      const hs = t0 + 30 + i * 40;
      spans.push(span(a, { parent: srv, name: 'GET', kind: 3, t0: hs, t1: Math.min(t1 - 20, hs + dur * 0.6), error: herr,
        attrs: { 'server.address': host, 'http.response.status_code': limited ? 429 : herr ? 503 : 200 } }));
      const h = state.hosts.get(host) || { host, country, calls: 0, errors: 0, limited: 0, lat: [] };
      h.calls++; h.lat.push(dur * 0.6); if (herr) h.errors++; if (limited) { h.limited++; state.limited++; }
      state.hosts.set(host, h);
    }
  }
  send(spans);
}

function chat(a, agent, ms) {
  const t1 = now();
  const tin = 800 + Math.floor(Math.random() * 3000);
  const tout = 150 + Math.floor(Math.random() * 600);
  const cost = (tin * 3 + tout * 15) / 1e6;
  state.spent += cost;
  a.cost = (a.cost || 0) + cost;
  send([span(a, { parent: a.root, name: `chat ${a.model}`, t0: t1 - ms, t1, attrs: { 'gen_ai.operation.name': 'chat', 'gen_ai.system': 'openrouter', 'gen_ai.agent.name': agent,
    'gen_ai.request.model': agent === 'judge' ? 'anthropic/claude-opus-5.5' : a.model, 'gen_ai.usage.input_tokens': tin, 'gen_ai.usage.output_tokens': tout, 'gen_ai.usage.cost_usd': cost } })]);
}

function finish(a) {
  const status = pick(OUT);
  const latency = now() - a.t0;
  state.latencies.push(latency);
  if (status === 'platform_error') state.errors++;
  state.matrix[a.field] ??= {};
  const cell = (state.matrix[a.field][a.model] ??= { answered: 0, partial: 0, honest_gap: 0, wrong: 0, platform_error: 0 });
  cell[status]++;
  state.done++;
  send([span(a, { id: a.root, name: 'fachtest.question', t0: a.t0, t1: now(), error: status === 'platform_error',
    attrs: { 'fachtest.field': a.field, 'fachtest.persona': a.persona, 'gen_ai.request.model': a.model, 'fachtest.status': status, 'fachtest.cost_usd': a.cost || 0 } })]);
  appendFileSync(path.join(DATA, 'runs', RUN, 'verdicts.jsonl'), JSON.stringify({ question_id: a.qid, question: a.question, model: a.model, field: a.field, status,
    cost_usd: Number((a.cost || 0).toFixed(4)), latency_ms: latency, trace_id: a.trace_id, note: status === 'answered' ? 'Values match the source, receipts cited.' : status === 'honest_gap' ? 'Said the data is not available; correct.' : status === 'wrong' ? 'Used the wrong reference year.' : status === 'partial' ? 'Right series, region missing.' : 'Tool call failed twice.' }) + '\n');
}

// ---------- loop ----------

function tick() {
  for (const a of state.agents) {
    if (a.state === 'done') continue;
    a.ticks++;
    if (a.state === 'asking') { chat(a, 'executor', 900 + Math.random() * 2500); a.state = 'tool_call'; toolCall(a); }
    else if (a.state === 'tool_call') {
      if (--a.toolsLeft > 0) toolCall(a);
      else { a.state = Math.random() < 0.3 ? 'follow_up' : 'judging'; a.step = a.state === 'judging' ? 'judge' : 'persona'; chat(a, a.state === 'judging' ? 'judge' : 'persona', 1500); }
    } else if (a.state === 'follow_up') { a.state = 'tool_call'; a.toolsLeft = 1; toolCall(a); }
    else if (a.state === 'judging') { finish(a); a.state = 'done'; a.step = ''; a.doneAt = now(); }
  }
  state.agents = state.agents.filter((a) => a.state !== 'done' || now() - a.doneAt < 6000);
  while (state.agents.filter((a) => a.state !== 'done').length < 9) { const a = newAgent(); if (!a) break; state.agents.push(a); }
  writeLive();
  if (state.done >= TOTAL) { writeLive('done'); console.log(`  run ${RUN} done`); clearInterval(timer); }
}

function snapshot(runState) {
  return {
    schema: 'evals-live/1', run_id: RUN, label: `Demo run · ${MODELS.length} models`, state: runState, started_at: state.started, updated_at: new Date().toISOString(),
    target: 'http://localhost:8352', progress: { done: state.done, total: TOTAL },
    budget: { spent_usd: Number(state.spent.toFixed(3)), limit_usd: 5, total_limit_usd: 50 },
    latency: { p50_ms: p(state.latencies, 0.5), p95_ms: p(state.latencies, 0.95) },
    counts: { errors: state.errors, rate_limited: state.limited, tool_calls: state.toolCalls },
    agents: state.agents.map(({ id, persona, field, model, role, state: s, step, question, trace_id, started_at }) => ({ id, persona, field, model, role, state: s, step, question, trace_id, started_at })),
    tools: [...state.tools.values()].map(({ lat, ...t }) => ({ ...t, p95_ms: p(lat, 0.95) })),
    sources: [...state.hosts.values()].map(({ lat, ...h }) => ({ ...h, p95_ms: p(lat, 0.95) })),
    matrix: state.matrix,
  };
}

function writeLive(runState = 'running') {
  const d = snapshot(runState);
  const tmp = path.join(DATA, 'live.json.tmp');
  writeFileSync(tmp, JSON.stringify(d, null, 1));
  renameSync(tmp, path.join(DATA, 'live.json'));
  if (runState === 'done') writeFileSync(path.join(DATA, 'runs', RUN, 'summary.json'), JSON.stringify({ ...d, agents: [] }, null, 1));
}

console.log(`  evals demo ${RUN}: ${TOTAL} questions → ${path.relative(process.cwd(), DATA)}, spans → ${OTLP}`);
tick();
const timer = setInterval(tick, 1500 / SPEED);
