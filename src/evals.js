// Evals: a test run where models answer questions against the project through tools, and a
// judge grades the answers. Two sources, both optional:
//  - files the runner writes (config "evals": { "live": "…/live.json", "runs": "…/runs" }),
//    live.json replaced atomically every few seconds, runs/<id>/ with summary, verdicts, report;
//  - OpenTelemetry spans following the GenAI conventions (gen_ai.operation.name chat /
//    execute_tool), which give the light points agent → tool → source host and the waterfall.

import { readFileSync, readdirSync, existsSync, statSync, watchFile, unwatchFile } from 'node:fs';
import path from 'node:path';

const MAX_TRACES = 800;
const MAX_VERDICTS = 5000;
const RUN_ID = /^[\w.@-]{1,120}$/;
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)$/i;

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

/** The host an outgoing call went to, or null for calls that stay on this machine. */
export function hostOf(sp) {
  if (sp.kind !== 3) return null;
  const a = sp.attrs || {};
  let host = a['server.address'] || a['net.peer.name'] || a['http.host'] || null;
  if (!host) {
    const url = a['url.full'] || a['http.url'];
    if (url) { try { host = new URL(url).hostname; } catch { /* not a url */ } }
  }
  if (!host) return null;
  host = String(host).toLowerCase().replace(/:\d+$/, '');
  return LOOPBACK.test(host) ? null : host;
}

/** The fields of a span the evals view needs, in a small shape for the wire. */
export function evalSpan(sp) {
  const a = sp.attrs || {};
  const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));
  return {
    id: sp.spanId,
    p: sp.parentId,
    n: sp.name,
    svc: sp.service,
    st: Math.round(sp.start * 1000) / 1000,
    d: Math.round(sp.dur * 100) / 100,
    e: sp.error ? 1 : 0,
    em: sp.error ? sp.statusMessage || String(a['http.response.status_code'] ?? a['error.type'] ?? '') : undefined,
    op: a['gen_ai.operation.name'],
    tool: a['gen_ai.tool.name'],
    agent: a['gen_ai.agent.name'],
    model: a['gen_ai.request.model'] || a['gen_ai.response.model'],
    qid: a['fachtest.question_id'] ?? a['eval.question_id'],
    run: a['fachtest.run_id'] ?? a['eval.run_id'],
    field: a['fachtest.field'],
    persona: a['fachtest.persona'],
    status: a['fachtest.status'] ?? a['eval.status'],
    cost: num(a['gen_ai.usage.cost_usd'] ?? a['fachtest.cost_usd']),
    tin: num(a['gen_ai.usage.input_tokens']),
    tout: num(a['gen_ai.usage.output_tokens']),
    host: hostOf(sp),
    hosts: a['fachtest.tool.hosts'] ? String(a['fachtest.tool.hosts']).split(',').map((h) => h.trim().toLowerCase()).filter(Boolean) : undefined,
  };
}

const isEvalSpan = (w) => !!(w.run || w.qid || w.op);

export class Evals {
  constructor(root, { send = () => {}, log = () => {} } = {}) {
    this.root = root;
    this.send = send;
    this.log = log;
    this.cfg = null;
    this.live = null;
    this.liveStamp = '';
    this.traces = new Map(); // traceId -> { t, spans: Map, eval, qid, model }
    this.transcripts = new Map(); // run id -> { files, byTrace: Map(trace_id -> file) }
    this.onLive = () => this.readLive();
  }

  /** Paths from the project config; only paths inside the project are accepted. */
  configure(cfg) {
    const inside = (rel) => {
      if (typeof rel !== 'string' || !rel) return null;
      const abs = path.resolve(this.root, rel);
      return abs === this.root || abs.startsWith(this.root + path.sep) ? abs : null;
    };
    let next = cfg && typeof cfg === 'object' ? { live: inside(cfg.live), runs: inside(cfg.runs) } : null;
    if (next) {
      // Comparisons, the cost ledger and the source needs sit next to runs/ unless named.
      const base = next.runs ? path.dirname(next.runs) : next.live ? path.dirname(next.live) : null;
      const near = (key, name) => inside(cfg[key]) || (base && inside(path.relative(this.root, path.join(base, name))));
      next = { ...next, compare: near('compare', 'compare'), ledger: near('ledger', 'ledger.jsonl'), needs: near('needs', 'needs.md'),
        totalLimit: Number(cfg.total_limit_usd) || null };
    }
    const same = JSON.stringify(next) === JSON.stringify(this.cfg);
    if (same) return;
    if (this.cfg?.live) unwatchFile(this.cfg.live, this.onLive);
    this.cfg = next && (next.live || next.runs) ? next : null;
    this.live = null;
    this.liveStamp = '';
    // watchFile polls the path, so it survives the write-and-rename the runner does.
    if (this.cfg?.live) { watchFile(this.cfg.live, { interval: 1000 }, this.onLive); this.readLive(); }
    this.send('evals-config', { enabled: this.enabled });
    this.send('evals-live', this.live);
  }

  get enabled() { return !!this.cfg; }

  readLive() {
    if (!this.cfg?.live) return;
    const d = existsSync(this.cfg.live) ? readJson(this.cfg.live) : null;
    if (!d && existsSync(this.cfg.live)) return; // half written; the next poll gets it
    const stamp = d ? `${d.run_id}|${d.updated_at}|${d.state}|${d.progress?.done}` : '';
    if (stamp === this.liveStamp) return;
    this.liveStamp = stamp;
    this.live = d;
    this.send('evals-live', d);
  }

  /** Past runs, newest first: what each summary says, without the verdicts. */
  runs() {
    const dir = this.cfg?.runs;
    const out = [];
    if (dir && existsSync(dir)) {
      for (const id of readdirSync(dir)) {
        if (!RUN_ID.test(id)) continue;
        const p = path.join(dir, id);
        try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
        const s = readJson(path.join(p, 'summary.json')) || {};
        out.push({ id, label: s.label || id, state: s.state || (existsSync(path.join(p, 'verdicts.jsonl')) ? 'running' : 'unknown'),
          progress: s.progress || null, budget: s.budget || null, started_at: s.started_at || null, updated_at: s.updated_at || null,
          report: existsSync(path.join(p, 'report.md')), funnel: existsSync(path.join(p, 'funnel.json')), coverage: existsSync(path.join(p, 'coverage.jsonl')),
          group: groupOf(id) });
      }
    }
    out.sort((a, b) => String(b.started_at || b.id).localeCompare(String(a.started_at || a.id)));
    return out;
  }

  verdicts(id) {
    if (!this.cfg?.runs || !RUN_ID.test(id || '')) return [];
    const p = path.join(this.cfg.runs, id, 'verdicts.jsonl');
    if (!existsSync(p)) return [];
    const out = [];
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* a line being written */ }
      if (out.length >= MAX_VERDICTS) break;
    }
    return out;
  }

  run(id) {
    if (!this.cfg?.runs || !RUN_ID.test(id || '')) return null;
    const dir = path.join(this.cfg.runs, id);
    if (!existsSync(dir)) return null;
    const report = path.join(dir, 'report.md');
    return { id, summary: readJson(path.join(dir, 'summary.json')), verdicts: this.verdicts(id), report: existsSync(report) ? readFileSync(report, 'utf8').slice(0, 200000) : null };
  }

  // ---------- overview across runs ----------

  /**
   * Coverage and funnel over one or more runs: per field how much of the questions the project
   * covers (full, gateway, partial, none) and how far answers got (covered → found → used → answered).
   */
  overview(ids) {
    const runs = [...new Set(ids)].filter((id) => RUN_ID.test(id) && this.cfg?.runs && existsSync(path.join(this.cfg.runs, id)));
    const zero = () => ({ runs: 0, covered: 0, found: 0, used: 0, answered: 0, partial: 0 });
    const add = (a, b) => { for (const k of Object.keys(a)) a[k] += num(b?.[k]); return a; };
    const total = zero();
    const byModel = {};
    const fields = {};
    const questions = new Map(); // question_id -> coverage row (last run wins)
    const status = {};
    const axes = { correctness: {}, backing: {}, labelled: {} };
    const field = (name) => (fields[name] ??= { funnel: zero(), cov: { full: 0, partial: 0, gateway: 0, none: 0 }, questions: [] });
    for (const id of runs) {
      const dir = path.join(this.cfg.runs, id);
      const f = readJson(path.join(dir, 'funnel.json'));
      if (f) {
        add(total, f.total);
        for (const [m, v] of Object.entries(f.by_model || {})) add(byModel[m] ??= zero(), v);
        for (const [name, v] of Object.entries(f.by_field || {})) add(field(name).funnel, v);
      }
      for (const row of jsonl(path.join(dir, 'coverage.jsonl'))) if (row.question_id) questions.set(row.question_id, { ...row, run: id });
      for (const v of this.verdicts(id)) {
        status[v.status] = (status[v.status] || 0) + 1;
        const j = v.judge || {};
        for (const k of Object.keys(axes)) { const val = String(j[k] ?? 'n/a'); axes[k][val] = (axes[k][val] || 0) + 1; }
        const q = questions.get(v.question_id);
        if (q && !q.question && v.question) q.question = v.question;
      }
    }
    const coverage = { full: 0, partial: 0, gateway: 0, none: 0, best_category: {}, none_paid_likely: 0 };
    for (const q of questions.values()) {
      const c = ['full', 'partial', 'gateway', 'none'].includes(q.coverage) ? q.coverage : 'none';
      coverage[c]++;
      if (q.best_category) coverage.best_category[q.best_category] = (coverage.best_category[q.best_category] || 0) + 1;
      if (c === 'none' && q.paid_likely) coverage.none_paid_likely++;
      const fd = field(q.field || '–');
      fd.cov[c]++;
      fd.questions.push({ question_id: q.question_id, question: q.question || null, type: q.type, coverage: c, missing: q.missing || null, why: q.why || null,
        best_category: q.best_category || null, paid_likely: !!q.paid_likely, run: q.run });
    }
    return { runs, questions: questions.size, coverage, total, by_model: byModel, by_field: fields, status, axes };
  }

  /** Variant comparisons (compare/<name>.jsonl), newest first. */
  compares() {
    const dir = this.cfg?.compare;
    if (!dir || !existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.jsonl') && RUN_ID.test(f.slice(0, -6)))
      .map((f) => ({ name: f.slice(0, -6), t: statSync(path.join(dir, f)).mtimeMs, report: existsSync(path.join(dir, f.slice(0, -6) + '.md')) }))
      .sort((a, b) => b.t - a.t);
  }

  compare(name) {
    const dir = this.cfg?.compare;
    if (!dir || !RUN_ID.test(name || '')) return null;
    const p = path.join(dir, `${name}.jsonl`);
    if (!existsSync(p)) return null;
    const md = path.join(dir, `${name}.md`);
    return { name, rows: jsonl(p), report: existsSync(md) ? readFileSync(md, 'utf8').slice(0, 300000) : null };
  }

  /** Money spent over all runs: ledger.json (older, { entries }) plus ledger.jsonl. */
  ledger() {
    const p = this.cfg?.ledger;
    if (!p) return null;
    const seen = new Set();
    const entries = [];
    const take = (e) => {
      const key = `${e.at}|${e.ref}|${e.usd}`;
      if (!seen.has(key) && Number.isFinite(Number(e.usd))) { seen.add(key); entries.push(e); }
    };
    const older = readJson(p.replace(/\.jsonl$/, '.json'));
    for (const e of older?.entries || []) take(e);
    for (const e of jsonl(p)) take(e);
    if (!entries.length) return null;
    const byKind = {};
    for (const e of entries) byKind[e.kind || 'other'] = (byKind[e.kind || 'other'] || 0) + Number(e.usd);
    const limit = this.cfg.totalLimit || num(this.live?.budget?.total_limit_usd) || null;
    return { spent_usd: entries.reduce((a, e) => a + Number(e.usd), 0), limit_usd: limit, by_kind: byKind, entries: entries.length,
      last: entries.map((e) => e.at).sort().pop() || null };
  }

  needs() {
    const p = this.cfg?.needs;
    return p && existsSync(p) ? readFileSync(p, 'utf8').slice(0, 300000) : null;
  }

  // ---------- spans ----------

  /** Takes decoded spans; keeps traces that belong to an eval and sends the light points. */
  addSpans(list) {
    const now = Date.now();
    const fresh = [];
    for (const sp of list) {
      if (!sp.traceId) continue;
      let tr = this.traces.get(sp.traceId);
      if (!tr) { tr = { t: now, spans: new Map(), eval: false, qid: null, model: null, run: null }; this.traces.set(sp.traceId, tr); }
      const w = evalSpan(sp);
      tr.t = now;
      tr.spans.set(w.id, w);
      if (isEvalSpan(w)) tr.eval = true;
      if (w.qid && !tr.qid) tr.qid = w.qid;
      if (w.run && !tr.run) tr.run = w.run;
      if (w.model && (!tr.model || n(w.n) === 'fachtest.question')) tr.model = w.model;
      fresh.push([sp.traceId, w]);
    }
    if (this.traces.size > MAX_TRACES) {
      const old = [...this.traces].sort((a, b) => a[1].t - b[1].t).slice(0, this.traces.size - MAX_TRACES);
      for (const [id] of old) this.traces.delete(id);
    }
    const flows = [];
    const seenTool = new Set();
    for (const [traceId, w] of fresh) {
      const tr = this.traces.get(traceId);
      if (!tr?.eval) continue;
      if (w.op === 'execute_tool') {
        seenTool.add(w.id);
        let hosts = descendants(tr, w.id).filter((s) => s.host).map((s) => ({ host: s.host, e: s.e }));
        // Without client spans from the server under test, the runner may name the hosts itself.
        if (!hosts.length && w.hosts) hosts = w.hosts.map((host) => ({ host, e: w.e }));
        flows.push({ tr: traceId, qid: tr.qid, model: tr.model, tool: w.tool || w.n.replace(/^execute_tool\s+/, ''), hosts, e: w.e, d: w.d });
      } else if (w.host) {
        const tool = ancestor(tr, w, (s) => s.op === 'execute_tool');
        // Hosts below a tool span that arrives in this batch travel with that tool's flow.
        if (tool && !seenTool.has(tool.id) && !fresh.some(([t, x]) => t === traceId && x.id === tool.id)) {
          flows.push({ tr: traceId, qid: tr.qid, model: tr.model, tool: tool.tool || tool.n, hosts: [{ host: w.host, e: w.e }], e: 0, d: w.d });
        }
      } else if (w.status && (w.qid || n(w.n) === 'fachtest.question')) {
        flows.push({ tr: traceId, qid: tr.qid, model: tr.model, done: w.status, e: w.e, d: w.d });
      }
    }
    if (flows.length) this.send('evals-flow', flows);
  }

  /** All spans of one trace, for the waterfall, plus the verdict and the stored transcript. */
  trace(id, runHint) {
    const tr = this.traces.get(id);
    const spans = tr ? [...tr.spans.values()].sort((a, b) => a.st - b.st) : [];
    let verdict = null;
    let run = null;
    for (const r of new Set([runHint, tr?.run, this.live?.run_id].filter((x) => x && RUN_ID.test(x)))) {
      verdict = this.verdicts(r).find((v) => v.trace_id === id) || null;
      if (verdict) { run = r; break; }
    }
    return { id, qid: tr?.qid || verdict?.question_id || null, model: tr?.model || verdict?.model || null, spans, verdict, transcript: run ? this.transcript(run, id) : null };
  }

  /** runs/<id>/traces/*.json: the question, the tool calls with their times and the answer. */
  transcript(run, traceId) {
    const dir = path.join(this.cfg.runs, run, 'traces');
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    let idx = this.transcripts.get(run);
    if (!idx || idx.files !== files.length) {
      idx = { files: files.length, byTrace: new Map() };
      for (const f of files) {
        const d = readJson(path.join(dir, f));
        const t = d?.verdict?.trace_id;
        if (t) idx.byTrace.set(t, f);
      }
      this.transcripts.set(run, idx);
    }
    const f = idx.byTrace.get(traceId);
    const d = f ? readJson(path.join(dir, f)) : null;
    if (!d) return null;
    const q = d.question;
    return {
      question: typeof q === 'string' ? q : q?.text || q?.question || null,
      tools: (d.tools || []).map((t) => ({ name: t.name, ms: t.ms, error: !!t.isError, chars: t.chars, args: t.args ? JSON.stringify(t.args).slice(0, 300) : '' })),
      answer: typeof d.verdict?.answer === 'string' ? d.verdict.answer.slice(0, 4000) : null,
    };
  }

  snapshot() {
    return { enabled: this.enabled, live: this.live, runs: this.enabled ? this.runs() : [], ledger: this.enabled ? this.ledger() : null,
      compares: this.enabled ? this.compares().length : 0, needs: !!(this.cfg?.needs && existsSync(this.cfg.needs)) };
  }

  close() {
    if (this.cfg?.live) unwatchFile(this.cfg.live, this.onLive);
  }
}

const n = (s) => String(s || '').toLowerCase();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Runs of one block share the part before the first dash: b1-r01 … b1-r04 → "b1". */
export const groupOf = (id) => (String(id).includes('-') ? String(id).split('-')[0] : null);

function jsonl(p) {
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a line being written */ }
    if (out.length >= MAX_VERDICTS) break;
  }
  return out;
}

function descendants(tr, id) {
  const kids = new Map();
  for (const s of tr.spans.values()) {
    if (!s.p) continue;
    if (!kids.has(s.p)) kids.set(s.p, []);
    kids.get(s.p).push(s);
  }
  const out = [];
  const stack = [...(kids.get(id) || [])];
  while (stack.length) {
    const s = stack.pop();
    out.push(s);
    stack.push(...(kids.get(s.id) || []));
  }
  return out;
}

function ancestor(tr, w, test) {
  let cur = w.p ? tr.spans.get(w.p) : null;
  for (let i = 0; cur && i < 64; i++) {
    if (test(cur)) return cur;
    cur = cur.p ? tr.spans.get(cur.p) : null;
  }
  return null;
}
