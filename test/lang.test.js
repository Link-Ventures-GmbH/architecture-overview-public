import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layerOfFile, areaOf, parseImports, extractSymbols, symbolsInRanges, changedRange } from '../src/lang.js';
import { parseHunks } from '../src/git.js';

test('layers come from the deepest meaningful folder', () => {
  assert.equal(layerOfFile('src/web/components/Button.tsx'), 'ui');
  assert.equal(layerOfFile('src/core/db/users.ts'), 'data');
  assert.equal(layerOfFile('internal/handlers/auth.go'), 'api');
  assert.equal(layerOfFile('src/core/ledger.ts'), 'domain');
  assert.equal(layerOfFile('src/server.ts'), 'api');
  assert.equal(layerOfFile('pkg/billing/invoice_test.go'), 'test');
  assert.equal(layerOfFile('scripts/deploy.sh.js'), 'infra');
});

test('areas skip container folders', () => {
  assert.equal(areaOf('src/web/assets'), 'web');
  assert.equal(areaOf('packages/api/src'), 'api');
  assert.equal(areaOf('src'), 'src');
  assert.equal(areaOf('.'), '.');
});

test('imports per language', () => {
  assert.deepEqual(parseImports('ts', `import { a } from './a.js';\nimport './side';\nexport * from "../b";\nconst c = await import('./c');`), ['./a.js', './side', '../b', './c']);
  assert.deepEqual(parseImports('go', 'import (\n  "fmt"\n  db "example.com/app/internal/db"\n)'), ['fmt', 'example.com/app/internal/db']);
  assert.deepEqual(parseImports('py', 'from .models import User\nfrom . import utils, views\nimport os, app.core'), ['.models', '.utils', '.views', 'os', 'app.core']);
});

test('symbols and the ones a change touches', () => {
  const src = ['export function a() {', '  return 1;', '}', '', 'export class B {', '  run() {', '    go();', '  }', '}'].join('\n');
  const syms = extractSymbols('ts', src);
  assert.deepEqual(syms.map((s) => [s.name, s.kind, s.line]), [['a', 'function', 1], ['B', 'class', 5], ['run', 'method', 6]]);
  assert.deepEqual(symbolsInRanges(syms, [[7, 7]]).map((s) => s.name), ['run']);
  assert.deepEqual(symbolsInRanges(syms, [[2, 5]]).map((s) => s.name).sort(), ['B', 'a']);
  const go = extractSymbols('go', 'func (s *Server) Start() error {\n}\nfunc helper() {}\ntype Store struct{}');
  assert.deepEqual(go.map((s) => s.name), ['Server.Start', 'helper', 'Store']);
});

test('changed range between two versions', () => {
  assert.equal(changedRange('a\nb\nc', 'a\nb\nc'), null);
  assert.deepEqual(changedRange('a\nb\nc', 'a\nX\nY\nc'), { from: 2, to: 3, added: 2, removed: 1 });
});

test('diff hunks map to line ranges', () => {
  const diff = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -3,0 +4,2 @@\n+a\n+b\n@@ -10 +12 @@\n-c\n+d\n';
  assert.deepEqual(parseHunks(diff).get('x.ts'), [[4, 5], [12, 12]]);
});
