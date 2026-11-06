import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Evals, hostOf, evalSpan } from '../src/evals.js';

const span = (o) => ({ traceId: 't1', spanId: o.id, parentId: o.p || null, name: o.name, kind: o.kind || 1, start: o.start || 0, dur: o.dur || 10,
  error: !!o.error, statusMessage: '', attrs: o.attrs || {}, service: o.svc || 'kn-fachtest' });

function project() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ao-evals-')));
  mkdirSync(path.join(root, 'data/runs/r1/traces'), { recursive: true });
  return root;
}

test('hosts: client spans only, loopback and ports dropped', () => {
  assert.equal(hostOf({ kind: 3, attrs: { 'server.address': 'EC.europa.eu' } }), 'ec.europa.eu');
  assert.equal(hostOf({ kind: 3, attrs: { 'url.full': 'https://api.worldbank.org:443/v2/x' } }), 'api.worldbank.org');
  assert.equal(hostOf({ kind: 3, attrs: { 'server.address': 'localhost' } }), null);
  assert.equal(hostOf({ kind: 3, attrs: { 'url.full': 'http://127.0.0.1:8352/mcp' } }), null);
  assert.equal(hostOf({ kind: 2, attrs: { 'server.address': 'ec.europa.eu' } }), null);
});

test('config: paths outside the project are refused', () => {
  const root = project();
  const ev = new Evals(root);
  ev.configure({ live: '../../etc/passwd', runs: '/tmp' });
  assert.equal(ev.enabled, false);
  ev.configure({ live: 'data/live.json' });
  assert.equal(ev.enabled, true);
  ev.close();
});

test('live.json, runs and verdicts are read; bad run ids are refused', () => {
  const root = project();
  writeFileSync(path.join(root, 'data/live.json.tmp'), JSON.stringify({ run_id: 'r1', state: 'running', updated_at: 'x', progress: { done: 1, total: 3 } }));
  renameSync(path.join(root, 'data/live.json.tmp'), path.join(root, 'data/live.json'));
  writeFileSync(path.join(root, 'data/runs/r1/summary.json'), JSON.stringify({ label: 'Run 1', state: 'done', started_at: '2026-10-27T10:00:00Z' }));
  writeFileSync(path.join(root, 'data/runs/r1/verdicts.jsonl'), '{"question_id":"q1","status":"answered","trace_id":"t1"}\n{"broken\n');
  const sent = [];
  const ev = new Evals(root, { send: (e, d) => sent.push([e, d]) });
  ev.configure({ live: 'data/live.json', runs: 'data/runs' });
  assert.equal(ev.live.run_id, 'r1');
  assert.ok(sent.some(([e, d]) => e === 'evals-live' && d?.run_id === 'r1'));
  assert.deepEqual(ev.runs().map((r) => [r.id, r.label, r.state]), [['r1', 'Run 1', 'done']]);
  assert.equal(ev.verdicts('r1').length, 1);
  assert.equal(ev.run('../r1'), null);
  assert.equal(ev.run('r1').verdicts[0].status, 'answered');
  ev.close();
});

test('spans: a tool call sends one flow with the hosts below it, the root sends the outcome', () => {
  const root = project();
  const sent = [];
  const ev = new Evals(root, { send: (e, d) => sent.push([e, d]) });
  const run = { 'fachtest.run_id': 'r1', 'fachtest.question_id': 'q1' };
  // Children end first, and the server under test exports on its own: hosts come before the tool span.
  ev.addSpans([
    span({ id: 'h1', p: 'srv', kind: 3, svc: 'data-hub', attrs: { 'server.address': 'ec.europa.eu' } }),
    span({ id: 'srv', p: 'tool', kind: 2, svc: 'data-hub', name: 'POST' }),
  ]);
  assert.equal(sent.length, 0);
  ev.addSpans([span({ id: 'tool', p: 'root', name: 'execute_tool data_fetch', attrs: { ...run, 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'data_fetch' } })]);
  const [[event, flows]] = sent;
  assert.equal(event, 'evals-flow');
  assert.equal(flows[0].tool, 'data_fetch');
  assert.equal(flows[0].qid, 'q1');
  assert.deepEqual(flows[0].hosts, [{ host: 'ec.europa.eu', e: 0 }]);
  ev.addSpans([span({ id: 'root', name: 'fachtest.question', attrs: { ...run, 'fachtest.status': 'honest_gap', 'gen_ai.request.model': 'm/x' } })]);
  assert.equal(sent[1][1][0].done, 'honest_gap');
  const tr = ev.trace('t1');
  assert.equal(tr.spans.length, 4);
  assert.equal(tr.model, 'm/x');
  ev.close();
});

test('spans: runner-named hosts stand in when the server sends no client spans', () => {
  const sent = [];
  const ev = new Evals(project(), { send: (e, d) => sent.push([e, d]) });
  ev.addSpans([span({ id: 'tool', name: 'execute_tool data_find', attrs: { 'fachtest.run_id': 'r1', 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'data_find', 'fachtest.tool.hosts': 'ine.es, ec.europa.eu' } })]);
  assert.deepEqual(sent[0][1][0].hosts.map((h) => h.host), ['ine.es', 'ec.europa.eu']);
  assert.deepEqual(evalSpan(span({ id: 'x', name: 'chat', attrs: { 'gen_ai.usage.cost_usd': '0.01' } })).cost, 0.01);
  ev.close();
});

test('trace: verdict and stored transcript of a past run', () => {
  const root = project();
  writeFileSync(path.join(root, 'data/runs/r1/verdicts.jsonl'), JSON.stringify({ question_id: 'q1', status: 'partial', trace_id: 'abc' }) + '\n');
  writeFileSync(path.join(root, 'data/runs/r1/traces/q1@m.json'), JSON.stringify({
    verdict: { trace_id: 'abc', answer: 'About 3 %.' }, question: { question: 'Inflation in Spain?' },
    tools: [{ name: 'data_find', args: { question: 'x' }, isError: false, ms: 32, chars: 3926 }],
  }));
  const ev = new Evals(root);
  ev.configure({ runs: 'data/runs' });
  const t = ev.trace('abc', 'r1');
  assert.equal(t.verdict.status, 'partial');
  assert.equal(t.transcript.question, 'Inflation in Spain?');
  assert.equal(t.transcript.tools[0].ms, 32);
  assert.equal(t.transcript.answer, 'About 3 %.');
  ev.close();
});

test('overview: funnels add up over runs, coverage per question, compare and ledger next to runs/', () => {
  const root = project();
  const run = (id, field, cov, funnel) => {
    mkdirSync(path.join(root, 'data/runs', id), { recursive: true });
    writeFileSync(path.join(root, 'data/runs', id, 'funnel.json'), JSON.stringify({ total: funnel, by_field: { [field]: funnel }, by_model: { m: funnel } }));
    writeFileSync(path.join(root, 'data/runs', id, 'coverage.jsonl'), JSON.stringify({ question_id: `${id}-q`, field, coverage: cov, missing: 'x', best_category: 'network' }) + '\n');
    writeFileSync(path.join(root, 'data/runs', id, 'verdicts.jsonl'), JSON.stringify({ question_id: `${id}-q`, question: 'Q?', status: 'unbacked', judge: { backing: 'unbacked' } }) + '\n');
  };
  run('b1-r01', 'Energy', 'full', { runs: 4, covered: 3, found: 2, used: 2, answered: 1, partial: 1 });
  run('b1-r02', 'Health', 'none', { runs: 4, covered: 0, found: 0, used: 0, answered: 0, partial: 0 });
  mkdirSync(path.join(root, 'data/compare'));
  writeFileSync(path.join(root, 'data/compare/c1.jsonl'), JSON.stringify({ question_id: 'q', field: 'Energy', best: 'kn', scores: { kn: { correctness: 4 } } }) + '\n');
  writeFileSync(path.join(root, 'data/ledger.json'), JSON.stringify({ spent_usd: 1, entries: [{ at: 'a', kind: 'run', ref: 'x', usd: 1 }] }));
  writeFileSync(path.join(root, 'data/ledger.jsonl'), JSON.stringify({ at: 'b', kind: 'compare', ref: 'c1', usd: 0.5 }) + '\n');
  const ev = new Evals(root);
  ev.configure({ runs: 'data/runs', total_limit_usd: 215 });
  assert.deepEqual(ev.runs().filter((r) => r.funnel).map((r) => r.group), ['b1', 'b1']);
  const o = ev.overview(['b1-r01', 'b1-r02', '../x']);
  assert.deepEqual(o.runs, ['b1-r01', 'b1-r02']);
  assert.equal(o.total.runs, 8);
  assert.equal(o.total.answered, 1);
  assert.deepEqual([o.coverage.full, o.coverage.none, o.questions], [1, 1, 2]);
  assert.equal(o.by_field.Health.questions[0].question, 'Q?');
  assert.equal(o.status.unbacked, 2);
  assert.equal(o.axes.backing.unbacked, 2);
  assert.deepEqual(ev.compares().map((c) => c.name), ['c1']);
  assert.equal(ev.compare('c1').rows[0].best, 'kn');
  const g = ev.ledger();
  assert.equal(g.spent_usd, 1.5);
  assert.equal(g.limit_usd, 215);
  ev.close();
});
