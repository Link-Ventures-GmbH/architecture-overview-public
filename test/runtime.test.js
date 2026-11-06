import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { decodeTraces } from '../src/otlp.js';
import { routeRegex, fileRoute, SpanMapper } from '../src/runtime.js';
import { extractSymbols, parseImports } from '../src/lang.js';

// ---- a tiny protobuf writer, enough to build an ExportTraceServiceRequest ----
const varint = (n) => {
  let v = BigInt(n);
  const out = [];
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return Buffer.from(out);
};
const field = (no, wire, payload) => Buffer.concat([varint((no << 3) | wire), payload]);
const len = (no, buf) => field(no, 2, Buffer.concat([varint(buf.length), buf]));
const str = (no, s) => len(no, Buffer.from(s));
const fixed64 = (no, n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return field(no, 1, b); };
const kv = (key, value) => len(1, Buffer.concat([str(1, key), len(2, typeof value === 'number' ? field(3, 0, varint(value)) : str(1, value))]));
const attr = (key, value) => len(9, kv(key, value).subarray(2)); // re-tag a KeyValue as span field 9

function request() {
  const span = Buffer.concat([
    len(1, Buffer.from('0af7651916cd43dd8448eb211c80319c', 'hex')),
    len(2, Buffer.from('b7ad6b7169203331', 'hex')),
    str(5, 'GET'),
    field(6, 0, varint(3)),
    fixed64(7, 1_700_000_000_000_000_000n),
    fixed64(8, 1_700_000_000_042_000_000n),
    attr('server.address', 'api.worldbank.org'),
    attr('http.response.status_code', 503),
    len(15, Buffer.concat([str(2, 'upstream down'), field(3, 0, varint(2))])),
  ]);
  const resource = len(1, kv('service.name', 'kn'));
  const scope = len(2, Buffer.concat([len(1, str(1, 'test-scope')), len(2, span)]));
  return len(1, Buffer.concat([resource, scope]));
}

test('decodes OTLP protobuf, also gzipped', () => {
  for (const [body, enc] of [[request(), ''], [gzipSync(request()), 'gzip']]) {
    const [s] = decodeTraces(body, 'application/x-protobuf', enc);
    assert.equal(s.traceId, '0af7651916cd43dd8448eb211c80319c');
    assert.equal(s.spanId, 'b7ad6b7169203331');
    assert.equal(s.parentId, null);
    assert.equal(s.kind, 3);
    assert.equal(s.service, 'kn');
    assert.equal(s.scope, 'test-scope');
    assert.equal(Math.round(s.dur), 42);
    assert.equal(s.error, true);
    assert.equal(s.statusMessage, 'upstream down');
    assert.deepEqual(s.attrs, { 'server.address': 'api.worldbank.org', 'http.response.status_code': 503 });
  }
});

test('decodes OTLP JSON with string enums', () => {
  const [s] = decodeTraces(Buffer.from(JSON.stringify({
    resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'web' } }] },
      scopeSpans: [{ spans: [{ traceId: 'AAAAAAAAAAAAAAAAAAAAAA==', spanId: 'ab', parentSpanId: 'cd', name: 'GET', kind: 'SPAN_KIND_SERVER',
        startTimeUnixNano: '1000000', endTimeUnixNano: '6000000', attributes: [{ key: 'http.response.status_code', value: { intValue: '500' } }] }] }] }],
  })), 'application/json');
  assert.equal(s.kind, 2);
  assert.equal(s.parentId, 'cd');
  assert.equal(s.dur, 5);
  assert.equal(s.error, true); // server span with 5xx
  assert.equal(s.traceId, '0'.repeat(32));
});

test('route patterns', () => {
  assert.ok(routeRegex('/provider/:slug').re.test('/provider/gleif'));
  assert.ok(!routeRegex('/provider/:slug').re.test('/provider/gleif/x'));
  assert.ok(routeRegex('/files/*').re.test('/files/a/b'));
  assert.ok(routeRegex('/(app)/campaigns/[id]').re.test('/campaigns/42'));
  // SvelteKit route ids keep their groups; the regex ignores them when matching a path.
  assert.equal(fileRoute('ui/src/routes/(app)/campaigns/[id]/+page.svelte'), '/(app)/campaigns/[id]');
  assert.ok(routeRegex(fileRoute('ui/src/routes/(app)/campaigns/[id]/+page.svelte')).re.test('/campaigns/7'));
  assert.equal(fileRoute('pages/blog/index.tsx'), '/blog');
  assert.equal(fileRoute('src/lib/util.ts'), null);
});

function fakeProject() {
  const sources = {
    'src/web/provider-routes.ts': "app.get('/provider/:slug', h)\napp.get('/provider/new', h)",
    'src/web/new-provider.ts': "app.get('/provider/new', h)",
    'src/adapters/worldbank.ts': "const API = 'https://api.worldbank.org/v2';\nexport async function fetch() {}",
    'src/core/db.ts': "import Database from 'better-sqlite3';",
    'src/core/search.ts': 'export function buildCatalog() {}',
    'src/mcp.ts': "server.tool('data_find', run)",
    'scripts/load.ts': "call('data_find'); call('data_find');",
  };
  const files = new Map(Object.entries(sources).map(([rel, text]) => [rel, {
    rel, text, lang: 'ts', lines: text.split('\n').length, symbols: extractSymbols('ts', text), specs: parseImports('ts', text),
  }]));
  return { root: '/repo', files };
}

test('spans land on the right file', () => {
  const m = new SpanMapper(fakeProject());
  const map = (name, kind, attrs) => m.map({ name, kind, attrs });
  assert.deepEqual(map('GET', 2, { 'url.path': '/provider/gleif' }), { file: 'src/web/provider-routes.ts', via: 'route', label: '/provider/gleif' });
  assert.equal(map('GET /provider/:slug', 2, {}).file, 'src/web/provider-routes.ts');
  assert.equal(map('GET', 2, { 'http.route': '/provider/new' }).file, 'src/web/provider-routes.ts'); // exact pattern wins
  assert.equal(map('GET', 3, { 'url.full': 'https://api.worldbank.org/v2/x' }).file, 'src/adapters/worldbank.ts');
  assert.equal(map('query', 3, { 'db.system': 'sqlite' }).file, 'src/core/db.ts');
  assert.equal(map('x', 1, { 'code.function.name': 'buildCatalog' }).file, 'src/core/search.ts');
  assert.equal(map('x', 1, { 'code.filepath': '/repo/src/core/search.ts' }).file, 'src/core/search.ts');
  assert.equal(map('data_find', 1, {}).file, 'src/mcp.ts'); // app code beats scripts
  assert.equal(map('GET', 2, { 'url.path': '/nowhere/at/all' }).file, null);
});
