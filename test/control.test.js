import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Products, buildFeed } from '../src/products.js';
import { Control, summarize } from '../src/control.js';

const adapters = mkdtempSync(path.join(os.tmpdir(), 'ao-adapters-'));
for (const [name, file] of [['demo', 'usage-feed.cjs'], ['demo-py', 'usage-feed.py']]) {
  mkdirSync(path.join(adapters, name));
  writeFileSync(path.join(adapters, name, file), '');
}
const feed = { type: 'ssh-docker-sqlite', host: 'root@10.0.0.1', container: 'app', db: '/data/c.db', script: 'demo' };

test('feeds: only allowed hosts, safe parameters and built-in adapters', () => {
  const ok = buildFeed(feed, { known: { names: ['Ada'] } }, ['root@10.0.0.1'], adapters);
  assert.equal(ok.command.at(-2), 'root@10.0.0.1');
  assert.equal(ok.command.at(-1), 'docker exec -i -w /app app node - /data/c.db 1500');
  assert.match(ok.stdin, /demo\/usage-feed\.cjs$/);
  assert.deepEqual(ok.known, { names: ['Ada'] });
  assert.match(buildFeed(feed, {}, [], adapters).error, /not allowed/);
  assert.match(buildFeed({ ...feed, db: '/x; rm -rf /' }, {}, ['root@10.0.0.1'], adapters).error, /unsafe/);
  assert.match(buildFeed({ ...feed, script: '../../evil' }, {}, ['root@10.0.0.1'], adapters).error, /adapter name/);
  assert.match(buildFeed({ ...feed, type: 'shell' }, {}, ['root@10.0.0.1'], adapters).error, /not built yet/);
});

test('feeds: adapters come from the folder in control.json, by default from this repo', () => {
  assert.match(buildFeed({ ...feed, script: 'example' }, {}, ['root@10.0.0.1']).stdin, /adapters\/example\/usage-feed\.cjs$/);
  assert.match(buildFeed({ ...feed, script: 'example' }, {}, ['root@10.0.0.1'], adapters).error, /no adapter/);
});

test('fly feeds: the allowed app, its database and the adapter\'s own interpreter', () => {
  const fly = { type: 'fly-sqlite', app: 'demo-app', db: '/data/app.db', script: 'demo-py' };
  const ok = buildFeed(fly, { owners: { domains: ['acme.example'] } }, ['fly:demo-app'], adapters);
  assert.deepEqual(ok.command, ['fly', 'ssh', 'console', '-a', 'demo-app', '-C', 'python3 - /data/app.db 1500']);
  assert.match(ok.stdin, /demo-py\/usage-feed\.py$/);
  assert.equal(ok.flyToken, true);
  assert.deepEqual(ok.owners, { domains: ['acme.example'] });
  assert.match(buildFeed(fly, {}, ['fly:other'], adapters).error, /not allowed/);
  assert.match(buildFeed({ ...fly, db: '/data/x.db && curl evil' }, {}, ['fly:demo-app'], adapters).error, /unsafe/);
});

function registryWith(products, hosts = ['root@10.0.0.1']) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ao-leitstand-'));
  const ws = path.join(dir, 'ws');
  mkdirSync(path.join(ws, 'app'), { recursive: true });
  mkdirSync(path.join(dir, 'reg', 'products'), { recursive: true });
  for (const [id, p] of Object.entries(products)) writeFileSync(path.join(dir, 'reg', 'products', `${id}.json`), JSON.stringify(p));
  writeFileSync(path.join(dir, 'control.json'), JSON.stringify({ products: path.join(dir, 'reg'), hosts, adapters }));
  return { reg: new Products({ workspace: ws, file: path.join(dir, 'control.json') }).load(), dir, ws };
}

test('registry: products with their repos, environments and the feed for a project', () => {
  const { reg, dir } = registryWith({
    app: { name: 'App', repos: ['app'], environments: [{ name: 'prod', url: 'https://app.test/', health: '/health', every: 5, feed }] },
    site: { name: 'Site', group: 'Websites', repos: ['gone'], environments: [{ url: 'https://site.test' }, { url: 'ftp://nope' }] },
  });
  const [app, site] = reg.list;
  assert.equal(app.environments[0].url, 'https://app.test');
  assert.equal(app.environments[0].every, 30); // never more often than every 30 s
  assert.equal(site.repos[0].root, null);
  assert.equal(site.environments.length, 1);
  const root = app.repos[0].root;
  assert.ok(reg.feedFor(root).command);
  assert.deepEqual(reg.feedRoots(), [root]);
  assert.equal(reg.feedFor(path.join(dir, 'elsewhere')), null);
  reg.close();
});

test('control: checks, the 24-hour strip and the day in numbers', async () => {
  const { reg, dir } = registryWith({ app: { name: 'App', repos: ['app'], environments: [{ name: 'prod', url: 'https://app.test' }] } });
  let status = 200;
  const control = new Control({ registry: reg, file: path.join(dir, 'h.json'), fetchImpl: async () => ({ status }) });
  const [p] = reg.list;
  await control.check(p, p.environments[0]);
  status = 503;
  await control.check(p, p.environments[0]);
  const env = control.snapshot().products[0].environments[0];
  assert.equal(env.state, 'down');
  assert.equal(env.status, 503);
  assert.equal(env.uptime, 0.5);
  assert.equal(env.strip.length, 48);
  assert.equal(env.strip.at(-1), 'p');
  control.close();
  reg.close();

  const now = Date.parse('2026-11-02T12:00:00Z');
  const s = summarize({
    enabled: true, status: { state: 'live' },
    users: [
      { id: 'a', kind: 'owner', last: '2026-11-02T10:00:00Z', joined: '2026-01-01 10:00:00' },
      { id: 'b', kind: 'stranger', last: '2026-11-02T09:00:00Z', joined: '2026-10-30 10:00:00' },
      { id: 't', kind: 'test', test: true, last: '2026-11-02T11:00:00Z' },
    ],
    hours: [{ h: '2026-11-02T10', u: 'a', n: 4 }, { h: '2026-11-02T11', u: 't', n: 9 }],
    traces: [{ outcome: 'error', start: '2026-11-02T08:00:00Z' }, { outcome: 'error', partial: true, start: '2026-11-02T08:00:00Z' }],
    outside: { web: { classes: [{ c: 'bot', v: 2 }, { c: 'browser', v: 3 }], kinds: [{ auth: 'refused', n: 7 }, { auth: 'none', n: 1 }] } },
  }, now);
  assert.deepEqual(s, { status: 'live', accounts: 2, active: 2, calls: 4, strangers: 1, strangersActive: 1, fresh: 1, errors: 1, visitors: 5, refused: 7 });
  assert.equal(summarize({ enabled: false }), null);
});
