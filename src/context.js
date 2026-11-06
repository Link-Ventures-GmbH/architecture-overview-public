// Everything the tool keeps for one open project: the code model, the file watcher, git,
// the activity feed, the logic map and the spans that belong to it.

import { watch, watchFile, unwatchFile, statSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { Project, langOf, isIgnored } from './project.js';
import { changedRange, symbolsInRanges } from './lang.js';
import * as git from './git.js';
import { generateWithClaude, agentPrompt, saveMap, storePath } from './logic.js';
import { SpanMapper, wireSpan } from './runtime.js';
import { Evals } from './evals.js';
import { Usage, usagePath } from './usage.js';
import { registry } from './products.js';

const MAX_ACTIVITY = 200;
const MAX_SPANS = 3000;

/** Opens a project. `send(event, data)` reaches every browser looking at it. */
export async function openProject(root, { send, log = () => {} }) {
  const project = new Project(root);
  const t0 = Date.now();
  project.load();
  let graph = project.graph();
  log(`  ${project.name}: ${graph.stats.files} files, ${graph.views.layers.nodes.length} modules, ${graph.views.logic.nodes.length} logic parts in ${Date.now() - t0} ms`);

  const inRepo = await git.isRepo(project.root);
  const state = { branch: null, head: null, commits: [], changed: [], live: [] };
  const activity = [];
  const timers = new Set();
  let seq = 0;
  let lastGitJson = '';
  let closed = false;

  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); if (!closed) fn(); }, ms); timers.add(t); return t; };
  const cancel = (t) => { clearTimeout(t); timers.delete(t); };

  const pushActivity = (item) => {
    item.id = ++seq;
    activity.unshift(item);
    if (activity.length > MAX_ACTIVITY) activity.length = MAX_ACTIVITY;
    send('activity', item);
  };

  const symbolNames = (rel, ranges) => {
    const f = project.files.get(rel);
    if (!f || !ranges?.length) return [];
    return symbolsInRanges(f.symbols, ranges).slice(0, 6).map((s) => ({ name: s.name, kind: s.kind }));
  };

  // ---------- git ----------

  async function refreshGit({ initial = false } = {}) {
    if (!inRepo || closed) return;
    const [br, changed, commits, hunks] = await Promise.all([
      git.branch(project.root), git.status(project.root), git.log(project.root, 40), git.workingHunks(project.root),
    ]);
    const prevHead = state.head;
    state.branch = br;
    state.changed = changed;
    state.commits = commits.map((c) => ({ ...c, modules: [...new Set(c.files.filter((f) => project.files.has(f)).map((f) => project.moduleOf(f)))] }));
    state.live = changed.filter((c) => langOf(c.path)).map((c) => ({
      path: c.path,
      status: c.status,
      module: project.moduleOf(c.path),
      symbols: c.status === '?' || c.status === 'A' ? [] : symbolNames(c.path, hunks.get(c.path)),
    }));
    const head = commits[0]?.hash || null;
    if (!initial && head && head !== prevHead) {
      const fresh = [];
      for (const c of state.commits) { if (c.hash === prevHead) break; fresh.push(c); }
      for (const c of fresh.reverse()) await announceCommit(c);
    }
    state.head = head;
    if (state.commits[0] && !state.commits[0].touched) state.commits[0].touched = await commitTouch(state.commits[0]);
    const json = JSON.stringify(publicGit());
    if (json !== lastGitJson) { lastGitJson = json; send('git', JSON.parse(json)); }
  }

  async function commitTouch(c) {
    const hunks = await git.commitHunks(project.root, c.hash);
    return c.files.filter((f) => project.files.has(f)).slice(0, 30).map((f) => ({
      path: f, module: project.moduleOf(f), symbols: symbolNames(f, hunks.get(f)),
    }));
  }

  async function announceCommit(c) {
    c.touched = await commitTouch(c);
    pushActivity({ t: c.time || Date.now(), kind: 'commit', subject: c.subject, short: c.short, author: c.author, modules: c.modules, files: c.files, touched: c.touched });
  }

  const publicGit = () => ({ enabled: inRepo, branch: state.branch, commits: state.commits, changed: state.changed, live: state.live });

  // ---------- file events ----------

  let gitTimer = null;
  const scheduleGit = (ms = 400) => { cancel(gitTimer); gitTimer = later(() => refreshGit().catch(() => {}), ms); };

  let graphTimer = null;
  const scheduleGraph = () => {
    cancel(graphTimer);
    graphTimer = later(() => { graph = project.graph(); mapper.rebuild(); send('graph', graph); }, 250);
  };

  const pending = new Map();
  const onFsEvent = (rel) => {
    if (!rel || closed) return;
    rel = rel.split(path.sep).join('/');
    if (rel.startsWith('.git/')) {
      if (/^\.git\/(HEAD|index|logs\/HEAD|refs\/heads\/)/.test(rel)) scheduleGit(250);
      return;
    }
    if (rel === '.archoverview.json') { project.load(); evals.configure(project.config.evals); scheduleGraph(); return; }
    if (!langOf(rel) || isIgnored(rel, project.config.ignore)) return;
    cancel(pending.get(rel));
    pending.set(rel, later(() => { pending.delete(rel); handleFile(rel).catch(() => {}); }, 120));
  };

  const gitIgnored = (rel) => new Promise((resolve) => {
    if (!inRepo) return resolve(false);
    execFile('git', ['check-ignore', '-q', rel], { cwd: project.root }, (err) => resolve(!err));
  });

  async function handleFile(rel) {
    const abs = path.join(project.root, rel);
    const known = project.files.has(rel);
    if (!existsSync(abs)) {
      if (!known) return;
      const module = project.moduleOf(rel);
      project.removeFile(rel);
      project.resolveAll();
      pushActivity({ t: Date.now(), kind: 'delete', file: rel, module, symbols: [] });
      scheduleGraph(); scheduleGit();
      return;
    }
    if (!known && await gitIgnored(rel)) return;
    const before = project.files.get(rel);
    const beforeImports = before ? before.specs.join('|') : null;
    const beforeSymbols = before ? before.symbols.map((s) => s.name).join('|') : null;
    const res = project.readFile(rel);
    if (!res) return;
    const f = project.files.get(rel);
    if (!known) {
      project.resolveAll();
      pushActivity({ t: Date.now(), kind: 'add', file: rel, module: project.moduleOf(rel), symbols: f.symbols.slice(0, 4).map((s) => ({ name: s.name, kind: s.kind })), added: f.lines, removed: 0 });
      scheduleGraph(); scheduleGit();
      return;
    }
    const range = changedRange(res.prev ?? '', res.next);
    if (!range) return;
    if (f.specs.join('|') !== beforeImports) { f.imports = project.resolveSpecs(f); scheduleGraph(); }
    else if (f.symbols.map((s) => s.name).join('|') !== beforeSymbols) scheduleGraph();
    pushActivity({
      t: Date.now(), kind: 'edit', file: rel, module: project.moduleOf(rel),
      symbols: symbolNames(rel, [[range.from, range.to]]),
      added: range.added, removed: range.removed, line: range.from,
    });
    scheduleGit();
  }

  // ---------- seed ----------

  await refreshGit({ initial: true });
  // Uncommitted files, newest first, so the map starts warm.
  const seeded = state.live.map((l) => {
    let t = 0;
    try { t = statSync(path.join(project.root, l.path)).mtimeMs; } catch { /* deleted */ }
    return { ...l, t };
  }).sort((a, b) => a.t - b.t).slice(-20);
  for (const c of state.commits.slice(0, 6).reverse()) {
    pushActivity({ t: c.time, kind: 'commit', subject: c.subject, short: c.short, author: c.author, modules: c.modules, files: c.files, touched: c.touched || [] });
  }
  for (const l of seeded) pushActivity({ t: l.t, kind: l.status === '?' ? 'add' : 'edit', file: l.path, module: l.module, symbols: l.symbols, seeded: true });
  activity.sort((a, b) => b.t - a.t);

  const evals = new Evals(project.root, { send, log });
  evals.configure(project.config.evals);

  // The usage feed runs a command, so it is built from the product registry (adapter types only) or
  // read from ~/.linklabs, never from the repo.
  const usage = new Usage(project.root, { send, log });
  usage.configure();
  const onUsageFile = () => usage.configure();
  watchFile(usagePath(project.root), { interval: 2000 }, onUsageFile);
  registry.on('change', onUsageFile);

  const watcher = watch(project.root, { recursive: true }, (_ev, name) => onFsEvent(name));
  watcher.on('error', (e) => log(`  watcher error in ${project.name}: ${e.message}`));

  // ---------- spans ----------

  const mapper = new SpanMapper(project);
  const spans = [];
  let spanBatch = [];
  const otel = { received: 0, services: new Set() };
  const flushTimer = setInterval(() => {
    if (!spanBatch.length) return;
    send('spans', { spans: spanBatch, received: otel.received, services: [...otel.services] });
    spanBatch = [];
  }, 250);

  function addSpans(list) {
    otel.received += list.length;
    for (const sp of list) {
      otel.services.add(sp.service);
      const w = wireSpan(sp, mapper.map(sp));
      spans.push(w);
      spanBatch.push(w);
    }
    if (spans.length > MAX_SPANS) spans.splice(0, spans.length - MAX_SPANS);
    evals.addSpans(list);
  }

  // ---------- logic map ----------

  const mapping = { running: false, error: null };
  const sendMapping = () => send('mapping', { ...mapping, source: graph.views.logic.source, store: storePath(project.root) });
  // The agent prompt writes the map outside the repo, so watch that file on its own.
  const onMapFile = () => { scheduleGraph(); later(sendMapping, 400); };
  watchFile(storePath(project.root), { interval: 1500 }, onMapFile);

  async function mapLogic() {
    if (mapping.running) return;
    mapping.running = true; mapping.error = null; sendMapping();
    try {
      const map = await generateWithClaude(project);
      saveMap(project.root, map);
      graph = project.graph();
      send('graph', graph);
      log(`  logic map for ${project.name}: ${map.sections.length} sections from Claude`);
    } catch (e) {
      mapping.error = e.message;
    }
    mapping.running = false;
    sendMapping();
  }

  return {
    root: project.root,
    name: project.name,
    lastUsed: Date.now(),
    snapshot: (extra = {}) => ({
      graph, git: publicGit(), activity, now: Date.now(),
      mapping: { ...mapping, source: graph.views.logic.source },
      otel: { spans: spans.slice(-1500), received: otel.received, services: [...otel.services], ...extra.otel },
      evals: evals.snapshot(),
      usage: usage.snapshot(),
    }),
    evals,
    usage,
    /** Service names the project config claims, for spans that carry no project.dir. */
    services: () => (Array.isArray(project.config.services) ? project.config.services : []),
    addSpans,
    mapLogic,
    agentPrompt: () => agentPrompt(project),
    close() {
      closed = true;
      watcher.close();
      evals.close();
      usage.close();
      unwatchFile(usagePath(project.root), onUsageFile);
      registry.off('change', onUsageFile);
      clearInterval(flushTimer);
      for (const t of timers) clearTimeout(t);
      unwatchFile(storePath(project.root), onMapFile);
    },
  };
}
