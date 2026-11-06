// The project model: every source file with its imports and symbols, aggregated into
// modules, layers, areas and module-to-module edges. Updates file by file.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  SOURCE_EXT, IGNORE_DIRS, LAYERS, CONTAINERS, layerOfFile, areaOf, parseImports, extractSymbols,
} from './lang.js';
import { heuristicMap, loadSavedMap, resolveMap } from './logic.js';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 6000;
const MAX_MODULES = 32;
const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.svelte', '.vue'];

export function langOf(rel) {
  return SOURCE_EXT[path.extname(rel).toLowerCase()] || null;
}

export function isIgnored(rel, extraIgnore = []) {
  const parts = rel.split('/');
  if (parts.some((p) => IGNORE_DIRS.has(p))) return true;
  return extraIgnore.some((pre) => rel === pre || rel.startsWith(pre.replace(/\/?\*\*$/, '') + '/'));
}

function readConfig(root) {
  for (const name of ['.archoverview.json', 'archoverview.json']) {
    const p = path.join(root, name);
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, 'utf8')); } catch { /* broken config, use defaults */ }
    }
  }
  return {};
}

function globPrefix(pattern) {
  return pattern.replace(/\/?\*\*?$/, '');
}

export class Project {
  constructor(root) {
    this.root = path.resolve(root);
    this.name = path.basename(this.root);
    this.config = readConfig(this.root);
    this.files = new Map(); // rel -> { rel, lang, lines, specs, imports, symbols, text, layer }
    this.goMods = []; // [{ dir, module }]
    this.moduleIds = [];
    this.dirCache = new Map();
  }

  // ---------- loading ----------

  listFiles() {
    let rels = null;
    try {
      const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
        cwd: this.root, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      rels = out.split('\0').filter(Boolean);
    } catch {
      rels = [];
      const walk = (dir) => {
        for (const ent of readdirSync(path.join(this.root, dir), { withFileTypes: true })) {
          if (ent.name.startsWith('.') && ent.name !== '.github') continue;
          const rel = dir ? `${dir}/${ent.name}` : ent.name;
          if (ent.isDirectory()) { if (!IGNORE_DIRS.has(ent.name)) walk(rel); } else rels.push(rel);
          if (rels.length > MAX_FILES * 4) return;
        }
      };
      walk('');
    }
    return rels;
  }

  load() {
    this.config = readConfig(this.root);
    this.files.clear();
    const rels = this.listFiles();
    this.goMods = rels.filter((r) => r === 'go.mod' || r.endsWith('/go.mod')).map((r) => {
      const dir = path.posix.dirname(r);
      try {
        const m = readFileSync(path.join(this.root, r), 'utf8').match(/^module\s+(\S+)/m);
        return m ? { dir: dir === '.' ? '' : dir, module: m[1] } : null;
      } catch { return null; }
    }).filter(Boolean);
    this.aliases = this.readAliases(rels);
    for (const rel of rels) {
      if (this.files.size >= MAX_FILES) break;
      if (!langOf(rel) || isIgnored(rel, this.config.ignore)) continue;
      this.readFile(rel);
    }
    this.resolveAll();
  }

  /** Import aliases from svelte/vite/ts configs: [{ scope, prefix, target }]. */
  readAliases(rels) {
    const out = [];
    const cfgs = rels.filter((r) => /(^|\/)(svelte\.config\.[cm]?js|vite\.config\.[cm]?[jt]s|[tj]sconfig(\.[\w-]+)?\.json)$/.test(r) && !isIgnored(r));
    for (const rel of cfgs) {
      let text;
      try { text = readFileSync(path.join(this.root, rel), 'utf8'); } catch { continue; }
      const scope = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
      for (const block of text.matchAll(/(?:alias|"paths")\s*:\s*\{([^}]*)\}/g)) {
        for (const m of block[1].matchAll(/['"]([^'"]+)['"]\s*:\s*\[?\s*['"]([^'"]+)['"]/g)) {
          const prefix = m[1].replace(/\/\*$/, '');
          const target = path.posix.normalize(path.posix.join(scope, m[2].replace(/\/\*$/, '')));
          if (target.startsWith('..')) continue;
          out.push({ scope, prefix, target: target === '.' ? '' : target });
        }
      }
    }
    return out.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  /** Reads and parses one file. Returns { prev, next } texts, or null if it is not tracked. */
  readFile(rel) {
    const lang = langOf(rel);
    if (!lang) return null;
    const abs = path.join(this.root, rel);
    let text;
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
      text = readFileSync(abs, 'utf8');
    } catch { return null; }
    // Minified bundles say nothing about architecture.
    if (text.length > 20000 && text.split('\n', 20).some((l) => l.length > 2000)) return null;
    const prev = this.files.get(rel)?.text ?? null;
    this.files.set(rel, {
      rel, lang, text,
      lines: text.split('\n').length,
      specs: parseImports(lang, text),
      imports: [],
      symbols: extractSymbols(lang, text),
      layer: this.layerOverride(rel) || layerOfFile(rel),
    });
    return { prev, next: text };
  }

  removeFile(rel) {
    return this.files.delete(rel);
  }

  layerOverride(rel) {
    const map = this.config.layers || {};
    let best = null;
    let bestLen = -1;
    for (const [pattern, layer] of Object.entries(map)) {
      const pre = globPrefix(pattern);
      if ((rel === pre || rel.startsWith(pre + '/') || pre === '') && pre.length > bestLen) {
        best = layer; bestLen = pre.length;
      }
    }
    return best;
  }

  // ---------- import resolution ----------

  resolveAll() {
    for (const f of this.files.values()) f.imports = this.resolveSpecs(f);
  }

  resolveSpecs(f) {
    const out = new Set();
    for (const spec of f.specs) {
      const target = this.resolve(f, spec);
      if (target && target !== f.rel) out.add(target);
    }
    return [...out];
  }

  resolve(f, spec) {
    const dir = path.posix.dirname(f.rel);
    if (f.lang === 'js' || f.lang === 'ts') {
      let base = null;
      if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(dir, spec));
      else if ((base = this.aliasTarget(f.rel, spec)) !== null) { /* configured alias */ }
      else if (spec.startsWith('$lib/')) {
        const i = f.rel.lastIndexOf('src/');
        base = (i >= 0 ? f.rel.slice(0, i) : '') + 'src/lib/' + spec.slice(5);
      }
      else if (spec.startsWith('@/') || spec.startsWith('~/')) base = 'src/' + spec.slice(2);
      else if (spec.startsWith('/')) base = spec.slice(1);
      else return null;
      return this.findJs(base);
    }
    if (f.lang === 'go') {
      for (const gm of this.goMods) {
        if (spec === gm.module || spec.startsWith(gm.module + '/')) {
          const sub = spec.slice(gm.module.length + 1);
          const target = [gm.dir, sub].filter(Boolean).join('/');
          return this.firstFileIn(target, 'go');
        }
      }
      return null;
    }
    if (f.lang === 'py') {
      let parts;
      let baseDir;
      const dots = spec.match(/^\.*/)[0].length;
      if (dots) {
        baseDir = dir.split('/');
        for (let i = 1; i < dots; i++) baseDir.pop();
        parts = [...baseDir.filter((p) => p && p !== '.'), ...spec.slice(dots).split('.').filter(Boolean)];
        return this.findPy(parts.join('/'));
      }
      parts = spec.split('.');
      for (const prefix of ['', 'src/', 'app/', dir === '.' ? '' : dir + '/']) {
        for (let n = parts.length; n > 0; n--) {
          const hit = this.findPy(prefix + parts.slice(0, n).join('/'));
          if (hit) return hit;
        }
      }
      return null;
    }
    return null;
  }

  aliasTarget(rel, spec) {
    for (const a of this.aliases || []) {
      if (a.scope && !rel.startsWith(a.scope + '/')) continue;
      if (spec === a.prefix) return a.target;
      if (spec.startsWith(a.prefix + '/')) return [a.target, spec.slice(a.prefix.length + 1)].filter(Boolean).join('/');
    }
    return null;
  }

  findJs(base) {
    if (this.files.has(base)) return base;
    const noExt = base.replace(/\.(m?js|cjs|jsx)$/, '');
    for (const ext of JS_EXTS) if (this.files.has(noExt + ext)) return noExt + ext;
    for (const ext of JS_EXTS) if (this.files.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
    return null;
  }

  findPy(base) {
    if (this.files.has(base + '.py')) return base + '.py';
    if (this.files.has(base + '/__init__.py')) return base + '/__init__.py';
    return null;
  }

  firstFileIn(dir, lang) {
    for (const rel of this.files.keys()) {
      if (path.posix.dirname(rel) === (dir || '.') && this.files.get(rel).lang === lang) return rel;
    }
    return null;
  }

  // ---------- modules ----------

  dirOf(rel) {
    return path.posix.dirname(rel);
  }

  /**
   * Splits the tree into readable modules: start with top-level folders, open container
   * folders (src, internal, ...) and keep splitting the biggest module while the map stays
   * under MAX_MODULES. Small folders stay inside their parent.
   */
  partition() {
    const max = this.config.maxModules || MAX_MODULES;
    const groups = new Map(); // module id -> rel[]
    const first = (rel) => { const d = this.dirOf(rel); return d === '.' ? '.' : d.split('/')[0]; };
    for (const rel of this.files.keys()) {
      const id = first(rel);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(rel);
    }
    const children = (id, rels) => {
      const depth = id === '.' ? 0 : id.split('/').length;
      const out = new Map();
      for (const rel of rels) {
        const parts = this.dirOf(rel).split('/');
        const cid = parts.length > depth ? parts.slice(0, depth + 1).join('/') : id;
        if (!out.has(cid)) out.set(cid, []);
        out.get(cid).push(rel);
      }
      return out;
    };
    const split = (id) => {
      const kids = children(id, groups.get(id));
      if (kids.size <= 1 && kids.has(id)) return false;
      groups.delete(id);
      for (const [cid, rels] of kids) groups.set(cid, rels);
      return true;
    };
    const pinned = (this.config.modules || []).map(globPrefix);
    // Containers and configured modules first.
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of [...groups.keys()]) {
        const leaf = id.split('/').pop().toLowerCase();
        const kids = children(id, groups.get(id));
        const wanted = pinned.some((p) => p.startsWith(id + '/'));
        if ((CONTAINERS.has(leaf) || wanted) && kids.size > 1 && groups.size + kids.size - 1 <= max * 1.5) {
          if (split(id)) changed = true;
        }
      }
    }
    // Peel big subfolders off the biggest module; small ones stay merged in their parent.
    const blocked = new Set();
    for (;;) {
      const cands = [...groups].filter(([id, rels]) => !blocked.has(id) && rels.length >= 8 && !pinned.includes(id))
        .sort((a, b) => b[1].length - a[1].length);
      if (!cands.length) break;
      const [id, rels] = cands[0];
      const minSize = Math.max(4, Math.round(this.files.size * 0.015));
      const big = [...children(id, rels)].filter(([cid, r]) => cid !== id && r.length >= minSize)
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, max - groups.size);
      if (!big.length) { blocked.add(id); continue; }
      const moved = new Set();
      for (const [cid, r] of big) { groups.set(cid, r); for (const x of r) moved.add(x); }
      const rest = rels.filter((x) => !moved.has(x));
      if (rest.length) groups.set(id, rest); else groups.delete(id);
      if (groups.size >= max) break;
    }
    this.moduleIds = [...groups.keys()].sort((a, b) => b.length - a.length);
    this.dirCache = new Map();
  }

  moduleOf(rel) {
    const d = this.dirOf(rel);
    if (this.dirCache?.has(d)) return this.dirCache.get(d);
    let hit = '.';
    for (const id of this.moduleIds || []) {
      if (id !== '.' && (d === id || d.startsWith(id + '/'))) { hit = id; break; }
    }
    if (hit === '.' && d !== '.' && !(this.moduleIds || []).includes('.')) hit = d.split('/')[0];
    this.dirCache?.set(d, hit);
    return hit;
  }

  packageManager() {
    const has = (f) => existsSync(path.join(this.root, f));
    if (has('pnpm-lock.yaml')) return 'pnpm';
    if (has('yarn.lock')) return 'yarn';
    if (has('bun.lockb') || has('bun.lock')) return 'bun';
    return has('package.json') ? 'npm' : null;
  }

  /** The logic map in use: repo config, then a saved map, then the heuristic. */
  logicMap() {
    if (this.config.logic?.sections) return { ...this.config.logic, source: 'config' };
    const saved = loadSavedMap(this.root);
    if (saved?.sections) return saved;
    return heuristicMap([...this.files.keys()], (rel) => (this.files.get(rel)?.symbols || []).map((x) => x.name));
  }

  edgesFor(nodeOf) {
    const edgeMap = new Map();
    for (const f of this.files.values()) {
      const from = nodeOf(f.rel);
      for (const t of f.imports) {
        const to = nodeOf(t);
        if (!from || !to || to === from) continue;
        const key = `${from}\u0000${to}`;
        edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
      }
    }
    return [...edgeMap].map(([k, w]) => {
      const [from, to] = k.split('\u0000');
      return { from, to, weight: w };
    });
  }

  /** Full graph for the UI: a shared file index and two views on it. */
  graph() {
    this.partition();
    const files = {};
    for (const f of this.files.values()) {
      files[f.rel] = { lang: f.lang, lines: f.lines, symbols: f.symbols.slice(0, 80).map((s) => [s.name, s.kind, s.line]) };
    }

    // Layers: folders as modules, stacked by layer.
    const mods = new Map();
    for (const f of this.files.values()) {
      const id = this.moduleOf(f.rel);
      let m = mods.get(id);
      if (!m) {
        m = { id, label: id === '.' ? this.name : id.split('/').pop(), path: id, area: areaOf(id), files: [], lines: 0, votes: {} };
        mods.set(id, m);
      }
      m.files.push(f.rel);
      m.lines += f.lines;
      m.votes[f.layer] = (m.votes[f.layer] || 0) + f.lines + 20;
    }
    for (const m of mods.values()) {
      m.group = this.layerOverride(m.path === '.' ? '' : m.path + '/x')
        || Object.entries(m.votes).sort((a, b) => b[1] - a[1])[0][0];
      delete m.votes;
      m.files.sort();
    }
    // Same label in two places: show the parent folder too.
    const byLabel = new Map();
    for (const m of mods.values()) byLabel.set(m.label, (byLabel.get(m.label) || 0) + 1);
    for (const m of mods.values()) {
      if (byLabel.get(m.label) > 1 && m.id.includes('/')) m.label = m.id.split('/').slice(-2).join('/');
    }
    const usedLayers = new Set([...mods.values()].map((m) => m.group));
    const layers = {
      groups: LAYERS.filter((l) => usedLayers.has(l.id)),
      nodes: [...mods.values()].sort((a, b) => a.area.localeCompare(b.area) || a.id.localeCompare(b.id)),
      edges: this.edgesFor((rel) => this.moduleOf(rel)),
    };

    // Logic: product areas from the logic map.
    const map = this.logicMap();
    const resolved = resolveMap(map, [...this.files.keys()]);
    for (const n of resolved.nodes) {
      n.files.sort();
      n.lines = n.files.reduce((sum, r) => sum + (this.files.get(r)?.lines || 0), 0);
      n.path = n.own ? n.label : n.id;
    }
    const logic = {
      source: map.source || 'saved',
      groups: resolved.groups.filter((g) => resolved.nodes.some((n) => n.group === g.id)),
      nodes: resolved.nodes,
      edges: this.edgesFor((rel) => resolved.owner.get(rel)?.id),
    };

    return {
      repo: { name: this.name, root: this.root, pm: this.packageManager() },
      files,
      views: { layers, logic },
      stats: {
        files: this.files.size,
        lines: [...this.files.values()].reduce((s, f) => s + f.lines, 0),
        symbols: [...this.files.values()].reduce((s, f) => s + f.symbols.length, 0),
      },
    };
  }
}
