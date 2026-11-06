// The product registry: which systems we run, where, and how to read their usage. The products live
// in a folder of their own (the Leitstand repo, one JSON file per product); which folder, which hosts a
// feed may reach and where your own adapters are, only in the local ~/.linklabs/architecture-overview/control.json. A product
// names an adapter type and its parameters, never a command, so editing the repo runs nothing here.

import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync, existsSync, watch, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

export const CONTROL = path.join(os.homedir(), '.linklabs', 'architecture-overview', 'control.json');
const ADAPTERS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'adapters');
const SAFE = /^[\w./-]+$/; // goes into a remote shell line: no spaces, quotes or ; | $ `
const SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3'];

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

const settings = (usage) => ({ known: usage?.known || {}, owners: usage?.owners || {}, own_tools: usage?.own_tools || [], own_sources: usage?.own_sources || [] });

/** Builds the usage feed (command, script, settings) for an environment, or says why it cannot. */
export function buildFeed(feed, usage, hosts, adapters = ADAPTERS) {
  if (!feed?.type) return { error: 'no feed' };
  if (feed.type === 'ssh-docker-sqlite') {
    if (!hosts.includes(feed.host)) return { error: `host ${feed.host} is not allowed in control.json` };
    for (const k of ['container', 'db']) if (!SAFE.test(String(feed[k] || ''))) return { error: `feed.${k} is missing or has unsafe characters` };
    if (!/^[a-z0-9-]+$/.test(String(feed.script || ''))) return { error: 'feed.script must be an adapter name' };
    const script = path.join(adapters, feed.script, 'usage-feed.cjs');
    if (!existsSync(script)) return { error: `no adapter ${feed.script}` };
    const backlog = Math.min(5000, Math.max(0, Number(feed.backlog) || 1500));
    return {
      command: [...SSH, feed.host, `docker exec -i -w /app ${feed.container} node - ${feed.db} ${backlog}`],
      stdin: script,
      ...settings(usage),
    };
  }
  if (feed.type === 'fly-sqlite') {
    // a Fly app, reached with the local flyctl login; the adapter script brings its own interpreter
    if (!hosts.includes(`fly:${feed.app}`)) return { error: `fly:${feed.app} is not allowed in control.json` };
    if (!/^[a-z0-9-]+$/.test(String(feed.app || ''))) return { error: 'feed.app must be a Fly app name' };
    if (!SAFE.test(String(feed.db || ''))) return { error: 'feed.db is missing or has unsafe characters' };
    if (!/^[a-z0-9-]+$/.test(String(feed.script || ''))) return { error: 'feed.script must be an adapter name' };
    const py = path.join(adapters, feed.script, 'usage-feed.py');
    const js = path.join(adapters, feed.script, 'usage-feed.cjs');
    const script = existsSync(py) ? py : existsSync(js) ? js : null;
    if (!script) return { error: `no adapter ${feed.script}` };
    const backlog = Math.min(5000, Math.max(0, Number(feed.backlog) || 1500));
    return {
      command: ['fly', 'ssh', 'console', '-a', feed.app, '-C', `${script === py ? 'python3' : 'node'} - ${feed.db} ${backlog}`],
      stdin: script,
      flyToken: true,
      ...settings(usage),
    };
  }
  return { error: `adapter type ${feed.type} is not built yet` };
}

export class Products extends EventEmitter {
  constructor({ workspace = null, file = CONTROL } = {}) {
    super();
    this.file = file;
    this.workspace = workspace;
    this.dir = null;
    this.hosts = [];
    this.adapters = ADAPTERS;
    this.list = [];
    this.watcher = null;
    this.timer = null;
  }

  get configured() { return !!this.dir; }

  load() {
    const ctl = readJson(this.file) || {};
    this.hosts = Array.isArray(ctl.hosts) ? ctl.hosts.map(String) : [];
    this.adapters = typeof ctl.adapters === 'string' && ctl.adapters ? ctl.adapters : ADAPTERS;
    const dir = ctl.products && existsSync(path.join(ctl.products, 'products')) ? ctl.products : null;
    if (dir !== this.dir) { this.dir = dir; this.watchDir(); }
    const list = [];
    if (dir) {
      let files = [];
      try { files = readdirSync(path.join(dir, 'products')).filter((f) => f.endsWith('.json')).sort(); } catch { /* gone */ }
      for (const f of files) {
        const p = readJson(path.join(dir, 'products', f));
        const id = f.replace(/\.json$/, '');
        if (!p?.name) { list.push({ id, name: id, group: 'Products', repos: [], environments: [], error: 'cannot read this file' }); continue; }
        list.push(this.resolve(id, p));
      }
    }
    this.list = list;
    this.emit('change');
    return this;
  }

  resolve(id, p) {
    const repos = (Array.isArray(p.repos) ? p.repos : []).map((r) => {
      let root = null;
      try { root = this.workspace ? realpathSync(path.resolve(this.workspace, String(r))) : null; } catch { /* not on this Mac */ }
      return { name: String(r), root };
    });
    const environments = (Array.isArray(p.environments) ? p.environments : []).filter((e) => /^https?:\/\//.test(e?.url || '')).map((e) => ({
      name: String(e.name || 'prod'),
      url: e.url.replace(/\/+$/, ''),
      health: String(e.health || '/'),
      every: Math.max(30, Number(e.every) || 300),
      cold: !!e.cold,
      feed: e.feed ? buildFeed(e.feed, p.usage, this.hosts, this.adapters) : null,
    }));
    return { id, name: String(p.name), group: String(p.group || 'Products'), repos, environments };
  }

  watchDir() {
    this.watcher?.close();
    this.watcher = null;
    if (!this.dir) return;
    try {
      this.watcher = watch(path.join(this.dir, 'products'), () => {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.load(), 300);
      });
    } catch { /* folder vanished */ }
  }

  /** The usage feed for a project folder: the first product with that repo and a working feed. */
  feedFor(root) {
    for (const p of this.list) {
      if (!p.repos.some((r) => r.root === root)) continue;
      const env = p.environments.find((e) => e.feed && !e.feed.error);
      if (env) return env.feed;
    }
    return null;
  }

  /** Project folders whose usage feed must keep running while nobody watches them. */
  feedRoots() {
    return this.list.filter((p) => p.environments.some((e) => e.feed && !e.feed.error)).map((p) => p.repos[0]?.root).filter(Boolean);
  }

  close() {
    this.watcher?.close();
    clearTimeout(this.timer);
  }
}

export const registry = new Products();
