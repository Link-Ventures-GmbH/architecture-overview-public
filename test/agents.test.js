import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentWatcher, modelFamily } from '../src/agents.js';
import { countryOfHost } from '../src/geo.js';

const line = (o) => JSON.stringify(o) + '\n';
const ts = (s) => new Date(Date.now() - 30000 + s * 1000).toISOString();
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });

function fakeProjects() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ao-agents-'));
  const proj = path.join(root, '-repo');
  const sid = 'sess-1';
  mkdirSync(path.join(proj, sid, 'subagents'), { recursive: true });
  writeFileSync(path.join(proj, sid, 'custom-title.json'), JSON.stringify({ customTitle: 'Research run' }));
  writeFileSync(path.join(proj, `${sid}.jsonl`),
    line({ type: 'user', timestamp: ts(0), cwd: '/repo', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } })
    + line({ type: 'assistant', timestamp: ts(1), message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5 },
      content: [toolUse('tu_spawn', 'Agent', { description: 'Japan stats', subagent_type: 'general-purpose' }),
        toolUse('tu_bash', 'Bash', { command: 'echo https://not-a-visit.example.de' })] } }));
  writeFileSync(path.join(proj, sid, 'subagents', 'agent-a1.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', description: 'Japan stats', toolUseId: 'tu_spawn', spawnDepth: 1, model: 'haiku' }));
  writeFileSync(path.join(proj, sid, 'subagents', 'agent-a1.jsonl'),
    line({ type: 'assistant', timestamp: ts(2), isSidechain: true, message: { model: 'claude-haiku-5-5', usage: { input_tokens: 100, output_tokens: 20 },
      content: [toolUse('tu_s', 'WebSearch', { query: 'statistics bureau japan' })] } })
    + line({ type: 'user', timestamp: ts(3), message: { content: [{ type: 'tool_result', tool_use_id: 'tu_s',
      content: 'Links: [{"title":"Stat","url":"https://www.stat.go.jp/english/"},{"title":"Wiki","url":"https://en.wikipedia.org/wiki/X"}]' }] } })
    + line({ type: 'assistant', timestamp: ts(4), message: { model: 'claude-haiku-5-5', content: [toolUse('tu_f', 'WebFetch', { url: 'https://www.stat.go.jp/english/', prompt: 'title?' })] } }));
  return { root, proj, sid };
}

test('reads sessions, subagents, models and web visits', async () => {
  const { root, sid } = fakeProjects();
  const w = new AgentWatcher({ root });
  w.scan();
  w.tick();
  await Promise.all([...w.sessions.get(sid).hosts.values()].map((h) => h.located));
  const snap = w.snapshot(sid);
  assert.equal(snap.title, 'Research run');
  assert.equal(snap.cwd, '/repo');
  assert.equal(snap.agents.length, 2);
  const sub = snap.agents.find((a) => a.id === 'agent-a1');
  assert.equal(sub.parent, 'main');
  assert.equal(sub.family, 'haiku');
  assert.equal(sub.desc, 'Japan stats');
  assert.equal(sub.now.tool, 'WebFetch');
  assert.equal(snap.agents.find((a) => a.id === 'main').family, 'opus');
  const stat = snap.hosts.find((h) => h.host === 'www.stat.go.jp');
  assert.equal(stat.fetch, 1);
  assert.equal(stat.found, 1);
  assert.equal(stat.cc, 'JP');
  assert.equal(stat.precision, 'tld');
  assert.ok(snap.hosts.some((h) => h.host === 'en.wikipedia.org' && h.found === 1 && h.fetch === 0));
  assert.ok(!snap.hosts.some((h) => h.host === 'not-a-visit.example.de'), 'echo is not a visit');
});

test('live lines animate and a hand-back ends the agent', async () => {
  const { root, proj, sid } = fakeProjects();
  const events = [];
  const w = new AgentWatcher({ root, emit: (e, d) => events.push([e, d]) });
  w.scan();
  w.tick();
  appendFileSync(path.join(proj, sid, 'subagents', 'agent-a1.jsonl'),
    line({ type: 'assistant', timestamp: ts(6), message: { model: 'claude-haiku-5-5', content: [toolUse('tu_h', 'SubagentHandback', { report: 'done' })] } }));
  w.tick();
  assert.deepEqual(events.map(([e]) => e), ['agent-end']);
  assert.ok(w.snapshot(sid).agents.find((a) => a.id === 'agent-a1').ended > 0);
  assert.equal(w.snapshot(sid).peak, 2);
});

test('model families and host countries', () => {
  assert.equal(modelFamily('claude-sonnet-5-5'), 'sonnet');
  assert.equal(modelFamily('haiku'), 'haiku');
  assert.equal(modelFamily(''), 'unknown');
  assert.deepEqual(countryOfHost('www.destatis.de'), { cc: 'DE', precision: 'tld' });
  assert.deepEqual(countryOfHost('api.worldbank.org'), { cc: 'US', precision: 'known' });
  assert.deepEqual(countryOfHost('foo.co.uk'), { cc: 'GB', precision: 'tld' });
  assert.equal(countryOfHost('cool.io'), null); // vanity endings say nothing
});

test('local Cowork sessions are read like Claude Code sessions, titled from their metadata', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ao-cowork-'));
  const local = path.join(base, 'account', 'space', 'local_abc');
  const proj = path.join(local, '.claude', 'projects', '-somewhere');
  mkdirSync(proj, { recursive: true });
  writeFileSync(`${local}.json`, JSON.stringify({ title: 'Sales outlook deck', model: 'claude-opus-5' }));
  writeFileSync(path.join(proj, 'cw-1.jsonl'),
    line({ type: 'assistant', timestamp: ts(1), cwd: '/somewhere', message: { model: 'claude-opus-5', content: [toolUse('t1', 'WebSearch', { query: 'market' })] } }));
  const w = new AgentWatcher({ root: path.join(base, 'no-code-logs'), cowork: base });
  w.scan();
  const s = w.list().find((x) => x.id === 'cw-1');
  assert.ok(s, 'cowork session listed');
  assert.equal(s.source, 'cowork');
  assert.equal(s.title, 'Sales outlook deck');
});
