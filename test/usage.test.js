import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Usage, kindOf, sourceCall } from '../src/usage.js';

test('kinds: owner, test, team by the owner\'s organisation, known by name or domain, else stranger', () => {
  const cfg = { known: { names: ['Dr. Ada Example'], domains: ['partner.example'] } };
  assert.equal(kindOf({ role: 'owner' }, cfg, 'Acme'), 'owner');
  assert.equal(kindOf({ role: 'member', test: true }, cfg, 'Acme'), 'test');
  assert.equal(kindOf({ role: 'member', org: 'Acme' }, cfg, 'Acme'), 'team');
  assert.equal(kindOf({ role: 'member', name: 'dr. ada example' }, cfg, 'Acme'), 'known');
  assert.equal(kindOf({ role: 'member', name: 'X', domain: 'Partner.example' }, cfg, 'Acme'), 'known');
  assert.equal(kindOf({ role: 'member', name: 'Y', domain: 'gmail.com' }, cfg, 'Acme'), 'stranger');
  assert.equal(kindOf({ role: 'member', domain: 'acme.example' }, { owners: { domains: ['ACME.example'] } }, null), 'owner');
});

test('source calls: id and host from the adapter line', () => {
  assert.deepEqual(sourceCall('→ ecb GET data-api.ecb.europa.eu/service/data/EXR'), { id: 'ecb', host: 'data-api.ecb.europa.eu' });
  assert.equal(sourceCall('← 200 · 3 kB'), null);
});

function feed(lines) {
  const script = `for (const l of ${JSON.stringify(lines.map((l) => JSON.stringify(l)))}) console.log(l); setTimeout(() => {}, 400);`;
  return { command: [process.execPath, '-e', script], known: { names: ['Ada'] }, own_tools: ['company_lookup'] };
}

test('feed: requests become traces with phases, paired source calls and the outcome', async () => {
  const at = (s) => `2026-10-29T10:00:${String(s).padStart(2, '0')}.000Z`;
  const ev = (id, s, stage, status, text, data, user = 'u2', trace = 't1') => ({ t: 'ev', id, trace, at: at(s), stage, status, text, data, user });
  const sent = [];
  const u = new Usage('/nowhere', { send: (e, d) => sent.push([e, d]) });
  u.cfg = feed([
    { t: 'hello', system: 'demo' },
    { t: 'users', users: [{ id: 'u1', name: 'Owner', role: 'owner', org: 'Acme' }, { id: 'u2', name: 'Ada', role: 'member' }, { id: 'u3', name: 'Neu', role: 'member', domain: 'gmail.com' }], hours: [], tools7: [] },
    ev(1, 0, 'agent', 'start', 'Claude calls data_fetch', { tool: 'data_fetch', client: 'Claude (OAuth)', args: {} }),
    ev(2, 1, 'check', 'start', 'ecb_rates', { unit: 'ecb_rates', source_id: 'ecb' }),
    ev(3, 1, 'source', 'start', '→ ecb GET data-api.ecb.europa.eu/x'),
    ev(4, 3, 'source', 'ok', '← 200 · 3 kB'),
    ev(5, 3, 'deliver', 'ok', 'answer back', { ms: 2900, summary: '3 values' }),
    ev(6, 9, 'receipt', 'ok', 'private source: not kept', undefined, 'u3', 't2'),
    { t: 'ready' },
    { t: 'web', id: 1, at: at(10), method: 'POST', route: '/mcp', status: 401, ms: 4, kind: 'mcp', auth: 'refused', visitor: 'abc', ua: 'claude', ref: null, user: null },
  ]);
  u.start();
  await new Promise((r) => setTimeout(r, 900));
  const t = u.trace('t1');
  assert.equal(t.tool, 'data_fetch');
  assert.equal(t.outcome, 'ok');
  assert.equal(t.ms, 2900);
  assert.equal(t.unit, 'ecb_rates');
  assert.deepEqual(t.sources.find((s) => !s.logical), { id: 'ecb', host: 'data-api.ecb.europa.eu', ms: 2000, status: 'ok', logical: undefined });
  assert.deepEqual(Object.keys(t.phases), ['agent', 'check', 'source', 'deliver']);
  const t2 = u.trace('t2');
  assert.equal(t2.partial, true);
  assert.equal(t2.private, true);
  const snap = u.snapshot();
  assert.deepEqual(snap.users.map((p) => p.kind), ['owner', 'known', 'stranger']);
  assert.ok(sent.some(([e, d]) => e === 'usage-status' && d.state === 'live'));
  assert.deepEqual(snap.web.map((r) => [r.route, r.auth, r.t]), [['/mcp', 'refused', undefined]]);
  assert.ok(sent.some(([e, d]) => e === 'usage-web' && d[0].ua === 'claude'));
  u.close();
});
