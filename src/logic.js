// The logic view: product areas instead of folders. A map is a list of sections, each with
// optional children (single providers, sub-features). It comes from, in this order:
// the repo's .archoverview.json "logic", a saved map (written by Claude or the agent prompt),
// or a heuristic built from file names.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { isTestPath } from './lang.js';

const STORE = path.join(os.homedir(), '.linklabs', 'architecture-overview');

const GENERIC = new Set(['index', 'types', 'type', 'routes', 'route', 'pages', 'page', 'util', 'utils',
  'helper', 'helpers', 'http', 'config', 'html', 'layout', 'main', 'app', 'test', 'tests', 'spec',
  'common', 'shared', 'base', 'core', 'lib', 'api', 'web', 'src', 'mod', 'model', 'models', 'service',
  'services', 'store', 'db', 'schema', 'new', 'view', 'views', 'component', 'components', 'icon',
  'icons', 'assets', 'fixture', 'fixtures', 'general', 'server', 'client', 'handler', 'handlers', 'cli',
  'setup', 'init', 'constants', 'const', 'data', 'and', 'the', 'of', 'to', 'for', 'with', 'v1', 'v2',
  'svelte', 'tsx', 'jsx', 'vue', 'layout', 'error', 'created', 'updated', 'deleted', 'collection', 'item']);

export function storePath(root) {
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 8);
  return path.join(STORE, `${path.basename(root)}-${hash}.logic.json`);
}

export function loadSavedMap(root) {
  const p = storePath(root);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

export function saveMap(root, map) {
  mkdirSync(STORE, { recursive: true });
  writeFileSync(storePath(root), JSON.stringify(map, null, 2));
}

// ---------- heuristic ----------

const singular = (w) => (w.length > 4 && w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
export function tokens(rel) {
  const stem = rel.split('/').pop().replace(/\.[^.]+$/, '').replace(/\.(test|spec)$/, '');
  return stem.split(/[-_.\s+()[\]]+|(?<=[a-z0-9])(?=[A-Z])/).map((t) => singular(t.toLowerCase()))
    .filter((t) => t.length > 1 && !/^\d+$/.test(t) && !GENERIC.has(t));
}

/** First real route segment for files in a routes/pages/app folder (SvelteKit, Next, Nuxt). */
function routeFeature(rel) {
  const m = rel.match(/(?:^|\/)(?:routes|pages|app)\/(.+)\/[^/]+$/);
  if (!m) return null;
  const seg = m[1].split('/').find((x) => !/^\(.*\)$/.test(x) && !/^\[.*\]$/.test(x) && !x.startsWith('+'));
  return seg ? singular(seg.toLowerCase()) : null;
}
const isMigration = (rel) => /(^|\/)(pb_)?migrations?\//.test(rel);
const COLLECTION_WORDS = new Set(['adapters', 'adapter', 'providers', 'provider', 'connectors', 'connector',
  'integrations', 'integration', 'plugins', 'plugin', 'sources', 'source', 'drivers', 'driver', 'channels',
  'strategies', 'importers', 'exporters', 'parsers', 'scrapers', 'crawlers', 'fetchers', 'gateways', 'bridges']);

const title = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const prettyStem = (rel) => {
  const stem = rel.split('/').pop().replace(/\.[^.]+$/, '');
  return stem.length <= 4 && !/[-_]/.test(stem) ? stem.toUpperCase() : title(stem);
};

/**
 * Builds a map from file names alone. `symbolsOf(rel)` (optional) helps to tell a folder of
 * variants (every adapter exports `fetch`) from a folder of different things.
 */
export function heuristicMap(rels, symbolsOf = () => []) {
  const src = rels.filter((r) => !isTestPath(r));
  const byDir = new Map();
  for (const r of src) {
    const d = path.posix.dirname(r);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(r);
  }
  const sections = [];
  const taken = new Set();

  // Collections: a folder full of variants (adapters, providers, connectors, ...).
  for (const [d, files] of byDir) {
    const variants = files.filter((f) => tokens(f).length);
    if (variants.length < 6) continue;
    const counts = new Map();
    for (const f of variants) for (const t of new Set(tokens(f))) counts.set(t, (counts.get(t) || 0) + 1);
    const unique = variants.filter((f) => tokens(f).every((t) => counts.get(t) === 1)).length;
    if (unique / variants.length < 0.6) continue;
    const named = COLLECTION_WORDS.has(d.split('/').pop().toLowerCase());
    if (!named) {
      // Same shape: one exported name that most files share.
      const shared = new Map();
      for (const f of variants) for (const n of new Set(symbolsOf(f))) shared.set(n, (shared.get(n) || 0) + 1);
      const top = Math.max(0, ...shared.values());
      if (top < variants.length * 0.6) continue;
    }
    const name = d === '.' ? 'Root' : title(d.split('/').pop());
    sections.push({
      id: `c-${d}`, label: name, description: `${variants.length} variants in ${d}`,
      files: files.filter((f) => !variants.includes(f)),
      children: variants.map((f) => ({ id: `c-${f}`, label: prettyStem(f), files: [f] })),
    });
    for (const f of files) taken.add(f);
  }

  // Features: name parts shared by files in different places.
  const rest = src.filter((r) => !taken.has(r));
  const df = new Map();
  const keys = (r) => {
    const route = routeFeature(r);
    return route ? [route, ...tokens(r)] : tokens(r);
  };
  for (const r of rest) if (!isMigration(r)) for (const t of new Set(keys(r))) df.set(t, (df.get(t) || 0) + 1);
  const limit = Math.max(3, rest.length * 0.25);
  const features = new Map();
  let leftovers = [];
  for (const r of rest) {
    if (isMigration(r)) { leftovers.push(r); continue; }
    const route = routeFeature(r);
    const cands = keys(r).filter((t) => df.get(t) >= 2 && df.get(t) <= limit);
    if (!cands.length) { leftovers.push(r); continue; }
    const t = route && cands.includes(route) ? route : cands.sort((a, b) => df.get(b) - df.get(a))[0];
    if (!features.has(t)) features.set(t, []);
    features.get(t).push(r);
  }
  // Keep the map readable: the biggest features get a tile, the rest go by folder.
  const ranked = [...features].sort((a, b) => b[1].length - a[1].length);
  for (const [, files] of ranked.slice(24)) leftovers = leftovers.concat(files);
  const featureSection = { id: 'features', label: 'Features', description: 'Grouped by shared file and route names', files: [], children: [] };
  for (const [t, files] of ranked.slice(0, 24)) {
    featureSection.children.push({ id: `f-${t}`, label: title(t), files });
  }
  if (featureSection.children.length) sections.unshift(featureSection);
  // Everything else by folder.
  const other = { id: 'other', label: 'Other', description: 'Not part of a feature yet', files: [], children: [] };
  const byTop = new Map();
  for (const r of leftovers) {
    const d = path.posix.dirname(r);
    if (!byTop.has(d)) byTop.set(d, []);
    byTop.get(d).push(r);
  }
  for (const [d, files] of byTop) other.children.push({ id: `o-${d}`, label: d === '.' ? 'root' : d, files });
  if (other.children.length) sections.push(other);

  // Tests join the part they test, matched by name.
  const children = sections.flatMap((sec) => (sec.children || []).map((c) => ({ c, keys: new Set(c.files.flatMap(tokens).concat(tokens(c.label))) })));
  const looseTests = [];
  for (const r of rels.filter(isTestPath)) {
    const tk = tokens(r);
    const hit = children.find(({ keys: k }) => tk.length && tk.every((t) => k.has(t)))
      || children.find(({ keys: k }) => tk.some((t) => k.has(t)));
    if (hit) hit.c.files.push(r); else looseTests.push(r);
  }
  if (looseTests.length) {
    let o = sections.find((x) => x.id === 'other');
    if (!o) { o = { id: 'other', label: 'Other', description: 'Not part of a feature yet', files: [], children: [] }; sections.push(o); }
    o.children.push({ id: 'o-tests', label: 'Tests', files: looseTests });
  }
  return { source: 'heuristic', sections };
}

// ---------- assigning files ----------

function matches(rel, pattern) {
  if (pattern === rel) return true;
  if (pattern.endsWith('/**')) return rel.startsWith(pattern.slice(0, -3) + '/');
  if (pattern.endsWith('/')) return rel.startsWith(pattern);
  if (pattern.includes('*')) {
    const re = new RegExp('^' + pattern.split('**').map((p) => p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*') + '$');
    return re.test(rel);
  }
  return false;
}

/**
 * Turns a map into view nodes: one node per child, plus one per section for its own files.
 * Files the map does not mention follow their folder neighbours, then fall into "Other".
 */
export function resolveMap(map, rels) {
  const nodes = [];
  const groups = [];
  const owner = new Map();
  const patterns = [];
  for (const s of map.sections || []) {
    groups.push({ id: s.id, label: s.label, description: s.description || '' });
    const own = { id: s.id, label: s.label, group: s.id, area: s.id, description: s.description || '', files: [], own: true };
    nodes.push(own);
    for (const c of s.children || []) {
      const n = { id: `${s.id}/${c.id}`, label: c.label, group: s.id, area: s.id, description: c.description || '', files: [] };
      nodes.push(n);
      for (const p of c.files || []) patterns.push({ p, node: n, exact: !p.includes('*') && !p.endsWith('/') });
    }
    for (const p of s.files || []) patterns.push({ p, node: own, exact: !p.includes('*') && !p.endsWith('/') });
  }
  // Exact paths beat globs, longer globs beat shorter ones.
  patterns.sort((a, b) => (b.exact - a.exact) || b.p.length - a.p.length);
  const unmatched = [];
  for (const r of rels) {
    const hit = patterns.find((x) => matches(r, x.p));
    if (hit) owner.set(r, hit.node); else unmatched.push(r);
  }
  const other = { id: '_unmapped', label: 'Unmapped', group: '_unmapped', area: '_unmapped', description: 'Not in the logic map yet', files: [], own: true };
  for (const r of unmatched) {
    // A new file joins the section most of its folder already belongs to.
    const d = path.posix.dirname(r);
    const votes = new Map();
    for (const [f, n] of owner) if (path.posix.dirname(f) === d) votes.set(n.group, (votes.get(n.group) || 0) + 1);
    const best = [...votes].sort((a, b) => b[1] - a[1])[0];
    const node = (best && nodes.find((n) => n.own && n.group === best[0])) || other;
    owner.set(r, node);
  }
  for (const [r, n] of owner) n.files.push(r);
  if (other.files.length) { groups.push({ id: '_unmapped', label: 'Unmapped', description: other.description }); nodes.push(other); }
  return { groups, nodes: nodes.filter((n) => n.files.length), owner };
}

// ---------- generating with Claude ----------

export function buildPrompt(project) {
  const lines = [];
  for (const f of [...project.files.values()].sort((a, b) => a.rel.localeCompare(b.rel))) {
    const syms = f.symbols.slice(0, 12).map((s) => s.name).join(', ');
    lines.push(`${f.rel} (${f.lines} lines)${syms ? ': ' + syms : ''}`);
  }
  return `You map a code base by product logic, not by folders.

Repository: ${project.name}
Files with their main symbols:
${lines.join('\n')}

Group the code into 4 to 9 sections a product person would name (for example "Investor Room",
"Provider Portal", "Data Sources", "Billing", "Accounts & Auth"). Inside a section, add children
for parts worth seeing on their own. When a folder holds many variants of one thing (adapters,
providers, connectors, integrations), give every variant its own child. A feature that spans
folders (pages + routes + domain logic + data) belongs to one section. Put tests with the feature
they test. Shared plumbing (db, config, http helpers, layout) goes to a section like "Platform".
Every file must be covered, by an exact path or a glob ("src/adapters/**", "src/web/investor-*").
Labels: at most 3 words, English. Descriptions: one short sentence.

Answer with JSON only, no prose, in this shape:
{"sections":[{"id":"investors","label":"Investor Room","description":"...","files":["..."],
"children":[{"id":"nda","label":"NDA Signing","description":"...","files":["..."]}]}]}`;
}

/** Writes the prompt into a file the user can hand to their coding agent. */
export function agentPrompt(project) {
  const target = storePath(project.root);
  return `${buildPrompt(project)}

Write the JSON (add "source": "agent") to this file and nothing else:
${target}`;
}

export function parseMapJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON in the answer');
  const map = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(map.sections) || !map.sections.length) throw new Error('the answer has no sections');
  return map;
}

/** Runs `claude -p` on the user's subscription. Resolves to a map or rejects with a readable reason. */
export function generateWithClaude(project, { timeoutMs = 240000 } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // keep it on the subscription, never silent API billing
    const child = spawn('claude', ['-p', '--output-format', 'json'], { cwd: os.tmpdir(), env });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Claude took too long')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? 'the claude CLI is not installed' : e.message)); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const env = JSON.parse(out);
        if (env.is_error) throw new Error(/auth|OAuth|login/i.test(env.result || '') ? 'the claude CLI is not logged in (run `claude` once and log in)' : env.result || 'Claude returned an error');
        const map = parseMapJson(env.result || '');
        map.source = 'claude';
        resolve(map);
      } catch (e) {
        reject(new Error(e.message || err.trim() || 'Claude gave no usable answer'));
      }
    });
    child.stdin.end(buildPrompt(project));
  });
}
