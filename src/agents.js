// Follows Claude Code sessions on this machine by reading their transcripts in
// ~/.claude/projects: every session, every subagent it spawned (type, task, model, parent),
// every tool call, and where on earth its web requests went.
// The transcript format is internal to Claude Code; everything here degrades quietly.

import { readdirSync, statSync, openSync, readSync, closeSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { locate } from './geo.js';

export const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
// Live sessions announce themselves here: one <pid>.json with id, name, status and message socket.
export const REGISTRY = path.join(os.homedir(), '.claude', 'sessions');
const TEAM_MS = 7 * 86400e3; // sessions shown in the team view
const MSG_MS = 48 * 3600e3; // messages kept for the team view
const SUBAGENT_ID = /^a[0-9a-f]{16}$/;
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Local Cowork sessions keep the same kind of logs, one Claude config per session.
const COWORK = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions');

/** Log roots of local Cowork sessions: <COWORK>/<account>/<space>/local_<id>/.claude/projects */
function coworkRoots(base = COWORK) {
  const out = [];
  const dirs = (p) => { try { return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(p, e.name)); } catch { return []; } };
  for (const account of dirs(base)) {
    for (const space of dirs(account)) {
      for (const local of dirs(space)) {
        if (!path.basename(local).startsWith('local_')) continue;
        const logs = path.join(local, '.claude', 'projects');
        if (existsSync(logs)) out.push({ dir: logs, meta: `${local}.json` });
      }
    }
  }
  return out;
}
const RECENT_MS = 14 * 86400e3; // sessions listed in the picker and the project overview
const HOT_MS = 30 * 60e3; // sessions followed byte by byte
export const ACTIVE_MS = 60e3; // an agent with no line for this long counts as done
const MAX_HOSTS = 5000;
// Harness plumbing: counted, but never shown as what an agent is doing.
const QUIET = /^(SubagentHandback|ToolSearch|ScheduleWakeup|TodoWrite|Task(Create|Update|List|Get|Stop)|mcp__ccd_)/;
const URL_RE = /https?:\/\/[^\s"'`<>)\]\\$|{}]+/g;

export function modelFamily(model) {
  const m = String(model || '').toLowerCase();
  for (const f of ['fable', 'opus', 'sonnet', 'haiku']) if (m.includes(f)) return f;
  return m ? 'other' : 'unknown';
}

function toolKind(name) {
  if (name === 'Agent' || name === 'Task') return 'spawn';
  if (name === 'WebSearch' || /search/i.test(name) && /web|apify|rag/i.test(name)) return 'search';
  if (name === 'WebFetch' || /navigate|fetch|scrape|crawl|browser|call-actor/i.test(name)) return 'fetch';
  if (['Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep', 'NotebookEdit'].includes(name)) return 'file';
  if (name === 'Bash') return 'shell';
  if (name.startsWith('mcp__')) return 'mcp';
  return 'other';
}

const short = (s, n = 90) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const hostOf = (url) => {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(h) ? h : null;
  } catch { return null; }
};

/** What a tool call is about, for the label next to the agent. */
function targetOf(name, input = {}) {
  if (name === 'WebSearch') return short(input.query);
  if (name === 'WebFetch') return input.url;
  if (input.file_path) return input.file_path;
  if (input.pattern) return short(input.pattern, 60);
  if (name === 'Bash') return short(input.description || input.command, 80);
  if (input.url) return input.url;
  if (input.query) return short(input.query);
  if (name === 'Agent' || name === 'Task') return short(input.description);
  return '';
}

/**
 * Where a session works: working folders and file paths from the end of its log, counted.
 * Sessions often start in a parent folder and move into a project later, so the tail tells more.
 */
function peekPlaces(file, size) {
  const places = new Map();
  try {
    const len = Math.min(size, 512 * 1024);
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    closeSync(fd);
    const text = buf.toString('utf8');
    for (const m of text.matchAll(/"(cwd|file_path)":"((?:[^"\\]|\\.){1,400})"/g)) {
      let p;
      try { p = JSON.parse(`"${m[2]}"`); } catch { continue; }
      if (m[1] === 'file_path') p = path.dirname(p);
      places.set(p, (places.get(p) || 0) + (m[1] === 'cwd' ? 1 : 3));
    }
  } catch { /* unreadable */ }
  return places;
}

function readMeta(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

function newAgent(id, extra = {}) {
  return { id, parent: null, type: null, desc: '', model: null, start: 0, last: 0, depth: 0, ended: 0,
    tokensIn: 0, tokensOut: 0, cacheRead: 0, tools: {}, calls: 0, now: null, ...extra };
}

const topPlace = (s) => [...(s.places || [])].sort((a, b) => b[1] - a[1])[0]?.[0];

export class AgentWatcher {
  constructor({ log = () => {}, emit = () => {}, root = PROJECTS, cowork = COWORK, registry = REGISTRY } = {}) {
    this.root = root;
    this.registryDir = registry;
    this.registry = { byId: new Map(), bySocket: new Map(), byHost: new Map() };
    this.cowork = cowork;
    this.log = log;
    this.emit = emit; // (event, data)
    this.sessions = new Map();
  }

  start() {
    this.scan();
    this.tick();
    this.scanTimer = setInterval(() => this.scan(), 5000);
    this.tickTimer = setInterval(() => this.tick(), 1000);
    this.scanTimer.unref?.();
    this.tickTimer.unref?.();
  }

  stop() { clearInterval(this.scanTimer); clearInterval(this.tickTimer); }

  /** Finds recent session transcripts in every project folder. */
  /** Live sessions from ~/.claude/sessions: status, name and how to reach them. */
  readRegistry() {
    const reg = { byId: new Map(), bySocket: new Map(), byHost: new Map() };
    let names = [];
    try { names = readdirSync(this.registryDir).filter((n) => n.endsWith('.json')); } catch { /* no registry */ }
    for (const n of names) {
      const r = readMeta(path.join(this.registryDir, n));
      if (!r.sessionId) continue;
      const entry = { id: r.sessionId, name: r.name || '', status: r.status || '', socket: r.messagingSocketPath || '', host: r.hostSessionId || '', updatedAt: Number(r.updatedAt || 0) };
      reg.byId.set(entry.id, entry);
      if (entry.socket) reg.bySocket.set(entry.socket, entry.id);
      if (entry.host) reg.byHost.set(entry.host, entry.id);
    }
    this.registry = reg;
    for (const [id, e] of reg.byId) { const s = this.sessions.get(id); if (s && e.name) s.names.add(e.name); }
  }

  /** Which session a SendMessage went to: a socket, a desktop session id or a name. */
  resolveRecipient(to) {
    const raw = String(to || '');
    if (raw.startsWith('uds:')) return this.registry.bySocket.get(raw.slice(4)) || null;
    if (raw.startsWith('local_')) return this.registry.byHost.get(raw) || null;
    const n = normName(raw);
    if (!n) return null;
    for (const s of this.sessions.values()) if ([...s.names].some((x) => normName(x) === n)) return s.id;
    for (const e of this.registry.byId.values()) if (normName(e.name) === n) return e.id;
    return null;
  }

  scan() {
    const now = Date.now();
    this.readRegistry();
    const roots = [{ dir: this.root, source: 'code' }, ...(this.cowork ? coworkRoots(this.cowork).map((r) => ({ ...r, source: 'cowork' })) : [])];
    for (const root of roots) this.scanRoot(root, now);
    for (const [id, s] of this.sessions) if (now - s.mtime > RECENT_MS) this.sessions.delete(id);
  }

  scanRoot(root, now) {
    if (!existsSync(root.dir)) return;
    for (const proj of readdirSync(root.dir, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const dir = path.join(root.dir, proj.name);
      let names;
      try { names = readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const file = path.join(dir, name);
        let st;
        try { st = statSync(file); } catch { continue; }
        if (now - st.mtimeMs > RECENT_MS) continue;
        const id = name.slice(0, -6);
        let s = this.sessions.get(id);
        if (!s) {
          s = { id, dir: path.join(dir, id), file, source: root.source, title: '', names: new Set(), msgs: [], prompts: [], said: [], cwd: '', model: null, start: 0, last: st.mtimeMs, mtime: st.mtimeMs,
            agents: new Map([['main', newAgent('main')]]), hosts: new Map(), fetches: 0, found: 0, tools: {}, toolOwner: new Map(), pending: new Map(),
            files: new Map(), loaded: false };
          this.sessions.set(id, s);
        }
        if (st.mtimeMs !== s.peeked) { s.places = peekPlaces(file, st.size); s.peeked = st.mtimeMs; }
        s.mtime = Math.max(s.mtime, st.mtimeMs);
        const t = readMeta(path.join(s.dir, 'custom-title.json')).customTitle || (root.meta && readMeta(root.meta).title);
        if (t) { s.title = t; s.names.add(t); }
      }
    }
  }

  /** Reads new lines of hot sessions; the first read of a session builds state without animating. */
  tick() {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (!s.loaded && now - s.mtime > HOT_MS) continue;
      const live = s.loaded;
      this.follow(s, s.file, 'main', live);
      const subDir = path.join(s.dir, 'subagents');
      if (existsSync(subDir)) {
        let names = [];
        try { names = readdirSync(subDir); } catch { /* gone */ }
        for (const name of names) {
          if (!name.endsWith('.jsonl')) continue;
          const id = name.slice(0, -6);
          if (!s.agents.has(id)) {
            const meta = readMeta(path.join(subDir, `${id}.meta.json`));
            const a = newAgent(id, { type: meta.agentType || 'agent', desc: meta.description || '', model: meta.model || null,
              depth: meta.spawnDepth || 1, spawnTool: meta.toolUseId || null, background: meta.requestShape === 'background' });
            s.agents.set(id, a);
            if (live) this.emit('agent-spawn', { s: s.id, agent: this.publicAgent(s, a) });
          }
          this.follow(s, path.join(subDir, name), id, live);
        }
      }
      if (!s.loaded) { s.loaded = true; this.resolveParents(s); }
    }
  }

  follow(s, file, agentId, live) {
    let st;
    try { st = statSync(file); } catch { return; }
    const pos = s.files.get(file) || 0;
    if (st.size <= pos) return;
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(st.size - pos);
    readSync(fd, buf, 0, buf.length, pos);
    closeSync(fd);
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) return; // half a line; wait for the rest
    s.files.set(file, pos + Buffer.byteLength(text.slice(0, lastNl + 1)));
    for (const line of text.slice(0, lastNl).split('\n')) {
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      this.line(s, agentId, o, live);
    }
  }

  line(s, agentId, o, live) {
    const a = s.agents.get(agentId);
    const t = o.timestamp ? Date.parse(o.timestamp) : 0;
    if (t) {
      if (!a.start) a.start = t;
      a.last = Math.max(a.last, t);
      if (!s.start || t < s.start) s.start = t;
      s.last = Math.max(s.last, t);
    }
    if (o.cwd && !s.cwd) s.cwd = o.cwd;
    if (o.customTitle) { s.title = o.customTitle; s.names.add(o.customTitle); }
    // A prompt typed by the person (not a tool result, not an injected reminder).
    if (agentId === 'main' && o.type === 'user' && !o.isMeta && t) {
      const c = o.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b?.type === 'text')?.text || '') : '';
      const isResult = Array.isArray(c) && c.some((b) => b?.type === 'tool_result');
      if (text && !isResult && !/^\s*</.test(text) && !/<cross-session-message|<task-notification|<side-sessions-event/.test(text)) {
        s.prompts.push(t);
        if (s.prompts.length > 400) s.prompts.splice(0, s.prompts.length - 400);
        // What the person said, so the team view can show "you → this chat".
        s.said.push({ t, summary: short(text.replace(/\s+/g, ' '), 120) });
        if (s.said.length > 200) s.said.splice(0, s.said.length - 200);
        if (live) this.emit('agent-msg', { s: s.id, msg: { t, from: 'owner', to: s.title, toId: s.id, summary: s.said[s.said.length - 1].summary } });
      }
    }
    const m = o.message;
    if (!m || !Array.isArray(m.content)) return;
    if (o.type === 'assistant') {
      if (m.model && m.model !== '<synthetic>') { a.model = m.model; if (agentId === 'main') s.model = m.model; }
      const u = m.usage;
      if (u) {
        a.tokensIn += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        a.cacheRead += u.cache_read_input_tokens || 0;
        a.tokensOut += u.output_tokens || 0;
      }
      for (const b of m.content) {
        if (b?.type !== 'tool_use') continue;
        const name = b.name;
        const kind = toolKind(name);
        a.tools[name] = (a.tools[name] || 0) + 1;
        a.calls++;
        s.tools[name] = (s.tools[name] || 0) + 1;
        s.toolOwner.set(b.id, agentId);
        s.pending.set(b.id, { name, agent: agentId });
        // A subagent handing its report back is done, also when it ran in the background.
        if (name === 'SubagentHandback' && agentId !== 'main' && !a.ended) {
          a.ended = t || Date.now();
          if (live) this.emit('agent-end', { s: s.id, a: agentId, t: a.ended });
        }
        if (name === 'SendMessage') {
          const to = b.input?.to || b.input?.recipient;
          if (to && !SUBAGENT_ID.test(String(to))) {
            const msg = { t, from: s.id, to: String(to), summary: short(b.input?.summary || b.input?.message || b.input?.content, 120) };
            s.msgs.push(msg);
            if (s.msgs.length > 600) s.msgs.splice(0, s.msgs.length - 600);
            if (live) this.emit('agent-msg', { s: s.id, msg: { ...msg, toId: this.resolveRecipient(msg.to) } });
          }
        }
        if (QUIET.test(name)) continue;
        const target = targetOf(name, b.input);
        a.now = { tool: name, kind, target, t };
        if (live) this.emit('agent-tool', { s: s.id, a: agentId, tool: name, kind, target, t });
        // Web requests: every URL in the input is a place the agent goes.
        // A URL in a shell command only counts when the command actually fetches something.
        const fetching = kind !== 'shell' || /\b(curl|wget|http(ie)?|fetch\(|requests\.get|urllib|lynx|aria2c)\b/.test(String(b.input?.command || ''));
        if (fetching && (kind === 'fetch' || kind === 'shell' || kind === 'mcp' || kind === 'other')) {
          const urls = (JSON.stringify(b.input || {}).match(URL_RE) || []).slice(0, 4);
          for (const url of urls) this.hit(s, agentId, url, 'fetch', t, live);
        }
      }
    } else if (o.type === 'user') {
      for (const b of m.content) {
        if (b?.type !== 'tool_result') continue;
        const p = s.pending.get(b.tool_use_id);
        s.pending.delete(b.tool_use_id);
        if (!p) continue;
        if (p.name === 'Agent' || p.name === 'Task') {
          // A foreground subagent is done when its result comes back.
          for (const sub of s.agents.values()) {
            if (sub.spawnTool === b.tool_use_id && !sub.background && !sub.ended) {
              sub.ended = t || Date.now();
              if (live) this.emit('agent-end', { s: s.id, a: sub.id, t: sub.ended });
            }
          }
        }
        if (toolKind(p.name) === 'search') {
          const raw = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
          const urls = [...new Set(raw.match(URL_RE) || [])].slice(0, 10);
          for (const url of urls) this.hit(s, p.agent, url, 'found', t, live);
        }
      }
    }
  }

  /** Counts a visit to a host; the first one also locates it. Live visits animate once located. */
  async hit(s, agentId, url, kind, t, live) {
    const host = hostOf(url.replace(/[.,;]+$/, ''));
    if (!host || host === 'localhost' || /^[\d.]+$/.test(host) || host.endsWith('.local')) return;
    let h = s.hosts.get(host);
    if (!h) {
      if (s.hosts.size >= MAX_HOSTS) return;
      h = { host, fetch: 0, found: 0, agents: new Set(), first: t, last: t, geo: undefined };
      s.hosts.set(host, h);
      h.located = locate(host).then((geo) => { h.geo = geo || null; });
    }
    h[kind]++;
    if (kind === 'fetch') s.fetches++; else s.found++;
    h.agents.add(agentId);
    h.last = Math.max(h.last, t);
    if (!live) return;
    await h.located;
    this.emit('agent-hit', { s: s.id, hit: { a: agentId, t, kind, ...this.publicHost(h) } });
  }

  publicHost(h) {
    return { host: h.host, fetch: h.fetch, found: h.found, agents: [...h.agents].slice(0, 24), first: h.first, last: h.last, ...(h.geo || {}) };
  }

  resolveParents(s) {
    for (const a of s.agents.values()) {
      if (a.id === 'main' || a.parent) continue;
      a.parent = (a.spawnTool && s.toolOwner.get(a.spawnTool)) || 'main';
    }
  }

  isActive(a, now = Date.now()) {
    if (a.ended) return false;
    return now - (a.last || a.start) < ACTIVE_MS;
  }

  publicAgent(s, a) {
    if (a.id !== 'main' && !a.parent) a.parent = (a.spawnTool && s.toolOwner.get(a.spawnTool)) || 'main';
    return {
      id: a.id, parent: a.parent, type: a.id === 'main' ? 'session' : a.type, desc: a.id === 'main' ? s.title : a.desc,
      model: a.model, family: modelFamily(a.model), start: a.start, last: a.last, ended: a.ended, depth: a.depth,
      active: this.isActive(a), tokensIn: a.tokensIn, tokensOut: a.tokensOut, cacheRead: a.cacheRead,
      calls: a.calls, tools: a.tools, now: a.now,
    };
  }

  /** Highest number of agents at work at the same time. */
  peak(s) {
    const marks = [];
    for (const a of s.agents.values()) {
      if (!a.start) continue;
      // The session itself is alive as long as anything in it is.
      const end = a.id === 'main' ? Math.max(s.last, a.last) : a.ended || Math.max(a.last, a.start);
      marks.push([a.start, 1], [end + 1, -1]);
    }
    marks.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    let cur = 0;
    let max = 0;
    for (const [, d] of marks) { cur += d; max = Math.max(max, cur); }
    return max;
  }

  list() {
    const now = Date.now();
    return [...this.sessions.values()].sort((a, b) => b.mtime - a.mtime).map((s) => ({
      id: s.id, cwd: s.cwd, source: s.source,
      title: s.title || `Chat in ${path.basename(topPlace(s) || s.cwd || '') || 'home'} · ${new Date(s.last || s.mtime).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`,
      places: [...(s.places || [])].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([p]) => p),
      last: s.last || s.mtime, active: now - (s.last || s.mtime) < 2 * ACTIVE_MS,
      agents: s.loaded ? s.agents.size - 1 : null, loaded: s.loaded,
      activeAgents: s.loaded ? [...s.agents.values()].filter((a) => a.id !== 'main' && this.isActive(a, now)).length : 0,
    }));
  }

  /** Loads a session that is not followed live yet (older than HOT_MS). */
  ensureLoaded(s) {
    if (s.loaded) return;
    const before = s.mtime;
    s.mtime = Date.now();
    this.tick();
    s.mtime = before;
  }

  /**
   * The sessions working in a project, with their subagents and the messages between them.
   * `roleOf(names)` maps a session's names to its role from the team file.
   */
  team({ inProject, roleOf = () => null, owner = null }) {
    const now = Date.now();
    const members = [];
    for (const s of this.sessions.values()) {
      const reg = this.registry.byId.get(s.id);
      if (!inProject(s) || (now - s.mtime > TEAM_MS && !reg)) continue;
      this.ensureLoaded(s);
      this.resolveParents(s);
      const main = s.agents.get('main');
      const subs = [...s.agents.values()].filter((a) => a.id !== 'main');
      const tools = {};
      for (const a of s.agents.values()) for (const [k, n] of Object.entries(a.tools)) tools[k] = (tools[k] || 0) + n;
      const names = [...s.names, s.title].filter(Boolean);
      const role = roleOf(names);
      members.push({
        id: s.id, title: reg?.name || s.title || `Chat ${s.id.slice(0, 6)}`, names: [...new Set(names)],
        role: role?.role || null, rank: role?.rank ?? null, task: role?.task || '', topic: role?.topic || '',
        status: reg?.status || (now - s.last < ACTIVE_MS ? 'busy' : 'idle'), live: !!reg,
        model: main.model, family: modelFamily(main.model), now: main.now, last: s.last, start: s.start,
        prompts24h: s.prompts.filter((t) => now - t < 86400e3).length, lastPrompt: s.prompts[s.prompts.length - 1] || 0,
        subagents: {
          total: subs.length,
          active: subs.filter((a) => this.isActive(a, now)).length,
          recent: subs.sort((a, b) => (b.last || 0) - (a.last || 0)).slice(0, 30).map((a) => ({ id: a.id, family: modelFamily(a.model), active: this.isActive(a, now), desc: a.desc, now: a.now })),
        },
        tools,
        tokens: [...s.agents.values()].reduce((acc, a) => ({ in: acc.in + a.tokensIn, out: acc.out + a.tokensOut }), { in: 0, out: 0 }),
      });
    }
    const ids = new Set(members.map((m) => m.id));
    const messages = [];
    for (const m of members) {
      const s = this.sessions.get(m.id);
      for (const msg of s.msgs) {
        if (now - msg.t > MSG_MS) continue;
        const toId = this.resolveRecipient(msg.to);
        messages.push({ ...msg, toId: ids.has(toId) ? toId : null });
      }
      for (const p of s.said) if (now - p.t <= MSG_MS) messages.push({ t: p.t, from: 'owner', to: m.title, toId: m.id, summary: p.summary });
    }
    messages.sort((a, b) => a.t - b.t);
    members.sort((a, b) => (a.rank ?? 50) - (b.rank ?? 50) || b.last - a.last);
    return { owner, members, messages };
  }

  snapshot(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    this.ensureLoaded(s);
    this.resolveParents(s);
    const agents = [...s.agents.values()].map((a) => this.publicAgent(s, a));
    const tok = agents.reduce((acc, a) => ({ in: acc.in + a.tokensIn, out: acc.out + a.tokensOut, cache: acc.cache + a.cacheRead }), { in: 0, out: 0, cache: 0 });
    return {
      id: s.id, title: s.title, cwd: s.cwd, source: s.source, model: s.model, start: s.start, last: s.last,
      active: Date.now() - s.last < 2 * ACTIVE_MS, peak: this.peak(s), agents, tools: s.tools, tokens: tok,
      fetches: s.fetches, found: s.found, hosts: [...s.hosts.values()].map((h) => this.publicHost(h)),
    };
  }
}
