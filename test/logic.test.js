import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heuristicMap, resolveMap, parseMapJson, tokens } from '../src/logic.js';

const adapters = ['ilo', 'imf', 'oecd', 'ecb', 'gleif', 'ted', 'vies'].map((n) => `src/adapters/${n}.ts`);

test('tokens drop generic words and numbers', () => {
  assert.deepEqual(tokens('src/web/investor-routes.ts'), ['investor']);
  assert.deepEqual(tokens('ui/src/routes/+page.svelte'), []);
  assert.deepEqual(tokens('migrations/1712_updated_users.js'), ['user']);
});

test('a folder of variants becomes one section with a child each', () => {
  const map = heuristicMap([...adapters, 'src/adapters/types.ts', 'src/core/db.ts']);
  const sec = map.sections.find((s) => s.label === 'Adapters');
  assert.ok(sec);
  assert.equal(sec.children.length, adapters.length);
  assert.ok(sec.children.some((c) => c.label === 'ILO'));
  assert.deepEqual(sec.files, ['src/adapters/types.ts']);
});

test('a folder of different things is not a collection', () => {
  const core = ['ledger', 'wallet', 'search', 'policy', 'mail', 'graph', 'leads'].map((n) => `src/core/${n}.ts`);
  const map = heuristicMap(core, () => []);
  assert.ok(!map.sections.some((s) => s.label === 'Core'));
});

test('shared names across folders form one feature, tests follow it', () => {
  const map = heuristicMap(['src/web/investor-pages.ts', 'src/web/investor-routes.ts', 'src/core/investors.ts', 'test/investors.test.ts']);
  const f = map.sections.find((s) => s.id === 'features').children.find((c) => c.label === 'Investor');
  assert.deepEqual(f.files.sort(), ['src/core/investors.ts', 'src/web/investor-pages.ts', 'src/web/investor-routes.ts', 'test/investors.test.ts']);
});

test('resolving: exact paths beat globs, new files follow their folder', () => {
  const map = {
    sections: [
      { id: 'sources', label: 'Data Sources', files: ['src/adapters/**'], children: [{ id: 'ilo', label: 'ILO', files: ['src/adapters/ilo.ts'] }] },
      { id: 'web', label: 'Website', files: ['src/web/landing.ts'] },
    ],
  };
  const rels = ['src/adapters/ilo.ts', 'src/adapters/imf.ts', 'src/web/landing.ts', 'src/web/brand-new.ts', 'tools/x.ts'];
  const { owner, groups } = resolveMap(map, rels);
  assert.equal(owner.get('src/adapters/ilo.ts').id, 'sources/ilo');
  assert.equal(owner.get('src/adapters/imf.ts').id, 'sources');
  assert.equal(owner.get('src/web/brand-new.ts').id, 'web');
  assert.equal(owner.get('tools/x.ts').id, '_unmapped');
  assert.ok(groups.some((g) => g.id === '_unmapped'));
});

test('map JSON is found inside a chatty answer', () => {
  const map = parseMapJson('Here you go:\n```json\n{"sections":[{"id":"a","label":"A","files":["**"]}]}\n```');
  assert.equal(map.sections[0].label, 'A');
  assert.throws(() => parseMapJson('no json here'));
});
