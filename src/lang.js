// Language table, layer heuristics and symbol extraction. Pure functions, no I/O.

export const SOURCE_EXT = {
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
  '.svelte': 'js', '.vue': 'js',
  '.go': 'go', '.py': 'py', '.rs': 'rs',
  '.java': 'java', '.kt': 'java', '.cs': 'java', '.swift': 'java',
  '.rb': 'rb', '.php': 'php',
};

export const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.svelte-kit', '.nuxt',
  'vendor', '__pycache__', '.venv', 'venv', 'env', 'coverage', 'target', '.turbo',
  '.cache', 'pb_data', '.idea', '.vscode', '.pytest_cache', '.mypy_cache', '_ref',
]);

// Top to bottom, as they are drawn.
export const LAYERS = [
  { id: 'ui', label: 'Interface' },
  { id: 'api', label: 'API & Entry' },
  { id: 'domain', label: 'Domain & Logic' },
  { id: 'data', label: 'Data' },
  { id: 'infra', label: 'Infrastructure' },
  { id: 'test', label: 'Tests' },
];

const WORDS = {
  ui: ['ui', 'web', 'frontend', 'client', 'components', 'component', 'pages', 'views', 'view',
    'templates', 'static', 'public', 'styles', 'css', 'assets', 'screens', 'widgets', 'layouts',
    'layout', 'routes', 'icons', 'theme', 'hooks', 'stores'],
  api: ['api', 'server', 'handlers', 'handler', 'controllers', 'controller', 'router', 'http',
    'rest', 'graphql', 'mcp', 'endpoints', 'cmd', 'cli', 'bin', 'main', 'rpc', 'webhooks',
    'middleware', 'oauth', 'index'],
  domain: ['domain', 'core', 'services', 'service', 'logic', 'usecases', 'engine', 'features',
    'workflows', 'jobs', 'workers', 'agents', 'pipeline', 'reason'],
  data: ['db', 'data', 'database', 'store', 'repository', 'repositories', 'repo', 'models',
    'model', 'schema', 'schemas', 'migrations', 'pb_migrations', 'entities', 'sql', 'persistence',
    'dao', 'cache', 'registry', 'seed', 'seeds'],
  infra: ['infra', 'config', 'configs', 'scripts', 'deploy', 'docker', 'ci', 'tools', 'utils',
    'util', 'helpers', 'shared', 'common', 'auth', 'integrations', 'adapters', 'clients',
    'mail', 'email', 'storage', 'logging', 'log', 'env', 'build'],
  test: ['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'fixtures', 'testdata', 'mocks'],
};
const WORD_LAYER = new Map();
for (const [layer, words] of Object.entries(WORDS)) for (const w of words) WORD_LAYER.set(w, layer);

// Folders that only hold other folders. They never name an area and only weakly hint a layer.
export const CONTAINERS = new Set(['src', 'lib', 'internal', 'pkg', 'packages', 'apps', 'app',
  'modules', 'source', 'sources', 'code']);

export function isTestPath(rel) {
  return /(^|\/)(tests?|__tests__|specs?|e2e|fixtures|testdata)(\/|$)/.test(rel)
    || /\.(test|spec)\.[a-z]+$/.test(rel) || /_test\.go$/.test(rel) || /(^|\/)test_[^/]+\.py$/.test(rel);
}

/** Layer for one file, from its path segments (deepest first) and file stem. */
export function layerOfFile(rel) {
  if (isTestPath(rel)) return 'test';
  const parts = rel.split('/');
  const stem = parts.pop().replace(/\.[^.]+$/, '').toLowerCase().replace(/[-.]/g, '_');
  const segs = parts.map((s) => s.toLowerCase()).reverse();
  for (const s of segs) {
    if (CONTAINERS.has(s)) continue;
    const l = WORD_LAYER.get(s);
    if (l) return l;
  }
  for (const piece of stem.split('_')) {
    const l = WORD_LAYER.get(piece);
    if (l) return l;
  }
  if (segs.includes('app')) return 'ui';
  return 'domain';
}

/** Area = first meaningful folder of a module path, skipping containers. */
export function areaOf(modPath) {
  if (modPath === '.') return '.';
  const parts = modPath.split('/');
  let i = 0;
  while (i < parts.length - 1 && CONTAINERS.has(parts[i].toLowerCase())) i++;
  return parts[i];
}

// ---------- imports ----------

const JS_IMPORT = /(?:^|[^\w$.])(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]|(?:^|[^\w$.])import\s*['"]([^'"]+)['"]|(?:^|[^\w$.])require\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[^\w$.])import\(\s*['"]([^'"]+)['"]\s*\)/g;
const GO_BLOCK = /import\s*\(([\s\S]*?)\)/g;
const GO_SINGLE = /import\s+(?:[\w.]+\s+)?"([^"]+)"/g;
const PY_FROM = /^\s*from\s+(\.*[\w.]*)\s+import\s+([^\n#]+)/gm;
const PY_IMPORT = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;

/** Raw import specifiers of a file. */
export function parseImports(lang, text) {
  const out = [];
  if (lang === 'js' || lang === 'ts') {
    for (const m of text.matchAll(JS_IMPORT)) out.push(m[1] || m[2] || m[3] || m[4]);
  } else if (lang === 'go') {
    for (const m of text.matchAll(GO_BLOCK)) {
      for (const line of m[1].split('\n')) {
        const q = line.match(/"([^"]+)"/);
        if (q) out.push(q[1]);
      }
    }
    for (const m of text.matchAll(GO_SINGLE)) out.push(m[1]);
  } else if (lang === 'py') {
    for (const m of text.matchAll(PY_FROM)) {
      const base = m[1];
      if (/^\.+$/.test(base)) {
        // from . import a, b  -> sibling modules
        for (const name of m[2].replace(/[()]/g, '').split(',')) {
          const n = name.trim().split(/\s+/)[0];
          if (n) out.push(base + n);
        }
      } else out.push(base);
    }
    for (const m of text.matchAll(PY_IMPORT)) for (const n of m[1].split(',')) out.push(n.trim());
  }
  return out;
}

// ---------- symbols ----------

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else',
  'do', 'try', 'with', 'new', 'typeof', 'await', 'constructor', 'super', 'import', 'export']);

const RULES = {
  js: [
    [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function'],
    [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
    [/^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, 'interface'],
    [/^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/, 'type'],
    [/^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, 'enum'],
    [/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, 'function'],
    [/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?function/, 'function'],
    [/^(?:export\s+)?(?:const|let)\s+([A-Z][A-Za-z0-9_$]*)\s*=/, 'const'],
    [/^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/, 'method'],
  ],
  go: [
    [/^func\s+\(\s*\w*\s*\*?(\w+)[^)]*\)\s*(\w+)/, 'method', (m) => `${m[1]}.${m[2]}`],
    [/^func\s+(\w+)/, 'function'],
    [/^type\s+(\w+)\s+struct/, 'struct'],
    [/^type\s+(\w+)\s+interface/, 'interface'],
    [/^type\s+(\w+)\s/, 'type'],
  ],
  py: [
    [/^\s*class\s+(\w+)/, 'class'],
    [/^(\s*)(?:async\s+)?def\s+(\w+)/, 'function', (m) => m[2], (m) => (m[1].length ? 'method' : 'function')],
  ],
  rs: [
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/, 'function'],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)/, 'struct'],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+(\w+)/, 'enum'],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+(\w+)/, 'interface'],
    [/^\s*impl(?:<[^>]*>)?\s+(?:\w+\s+for\s+)?(\w+)/, 'impl'],
  ],
  java: [
    [/^\s*(?:public|private|protected|internal|open|abstract|final|sealed|data|static|\s)*(?:class|interface|enum|record|struct|object)\s+(\w+)/, 'class'],
    [/^\s*(?:public|private|protected|internal|static|final|override|suspend|async|\s)+[\w<>[\],.? ]*?\s(\w+)\s*\([^;]*$/, 'method'],
    [/^\s*(?:override\s+|private\s+|public\s+)?(?:func|fun)\s+(\w+)/, 'function'],
  ],
  rb: [
    [/^\s*class\s+([\w:]+)/, 'class'],
    [/^\s*module\s+([\w:]+)/, 'module'],
    [/^\s*def\s+(?:self\.)?(\w+[?!]?)/, 'method'],
  ],
  php: [
    [/^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/, 'class'],
    [/^\s*(?:public|private|protected|static|\s)*function\s+(\w+)/, 'function'],
  ],
};
RULES.ts = RULES.js;

/** Declarations with 1-based line numbers. */
export function extractSymbols(lang, text, cap = 400) {
  const rules = RULES[lang];
  if (!rules) return [];
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < cap; i++) {
    const line = lines[i];
    if (line.length > 400) continue;
    for (const [re, kind, nameFn, kindFn] of rules) {
      const m = line.match(re);
      if (!m) continue;
      const name = nameFn ? nameFn(m) : m[1];
      if (!name || KEYWORDS.has(name)) continue;
      out.push({ name, kind: kindFn ? kindFn(m) : kind, line: i + 1 });
      break;
    }
  }
  return out;
}

/** Symbols touched by line ranges: the nearest declaration at or above each range, plus any declared inside it. */
export function symbolsInRanges(symbols, ranges) {
  const hit = new Map();
  for (const [a, b] of ranges) {
    let above = null;
    for (const s of symbols) {
      if (s.line <= a) above = s;
      else if (s.line <= b) hit.set(s.name, s);
      else break;
    }
    if (above) hit.set(above.name, above);
  }
  return [...hit.values()];
}

/** Changed line range in `next` compared to `prev` (prefix/suffix trim). Null if equal. */
export function changedRange(prev, next) {
  const a = prev.split('\n');
  const b = next.split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  if (s === a.length && s === b.length) return null;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= s && eb >= s && a[ea] === b[eb]) { ea--; eb--; }
  const added = Math.max(0, eb - s + 1);
  const removed = Math.max(0, ea - s + 1);
  return { from: s + 1, to: Math.max(s + 1, eb + 1), added, removed };
}
