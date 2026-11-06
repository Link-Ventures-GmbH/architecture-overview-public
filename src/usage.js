// Usage view: how a running system is used right now. A feed command (only ever from the local
// settings in ~/.linklabs, never from a repo, since it runs on this machine) prints one JSON object
// per line in the schema usage-live/1: the accounts with their totals, the sources, and every step
// of every request as it happens. This module keeps the recent requests as traces (who, which tool,
// which phases, which sources, how long) and passes changes on over SSE.

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { registry } from './products.js';

const STORE = path.join(os.homedir(), '.linklabs', 'architecture-overview');
const KEEP = 600;
const RESTART_MS = 60_000; // one new connection a minute at most: servers with SSH rate limits stay calm

export function usagePath(root) {
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 8);
  return path.join(STORE, `${path.basename(root)}-${hash}.usage.json`);
}

export function loadUsageConfig(root) {
  // a product in the Leitstand repo wins; the old per-project file stays as a fallback
  const fromRegistry = registry.feedFor(root);
  if (fromRegistry) return fromRegistry;
  const p = usagePath(root);
  if (!existsSync(p)) return null;
  try {
    const c = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(c.command) && c.command.length ? c : null;
  } catch { return null; }
}

/** flyctl does not read the token from its own config file when run headless; hand it over. */
function flyEnv() {
  if (process.env.FLY_ACCESS_TOKEN) return {};
  try {
    const m = /^access_token:\s*(\S+)/m.exec(readFileSync(path.join(os.homedir(), '.fly', 'config.yml'), 'utf8'));
    return m ? { FLY_ACCESS_TOKEN: m[1] } : {};
  } catch { return {}; }
}

/** Who an account is to the network owner: owner, team, known, test or stranger. */
export function kindOf(u, cfg, ownerOrg) {
  if (u.role === 'owner') return 'owner';
  // systems without roles name their owner in the settings (mail domains only, never addresses)
  if (u.domain && (cfg?.owners?.domains || []).some((d) => String(u.domain).toLowerCase() === String(d).toLowerCase())) return 'owner';
  if (u.test) return 'test';
  if (ownerOrg && u.org === ownerOrg) return 'team';
  const known = cfg?.known || {};
  const name = String(u.name || '').toLowerCase();
  if ((known.names || []).some((n) => name === String(n).toLowerCase())) return 'known';
  if (u.domain && (known.domains || []).some((d) => String(u.domain).toLowerCase() === String(d).toLowerCase())) return 'known';
  return 'stranger';
}

/** "→ ecb GET data-api.ecb.europa.eu/service/data" → { id, host } */
export function sourceCall(text) {
  const m = /^→\s+(\S+)\s+[A-Z]+\s+([^/\s]+)/.exec(String(text || ''));
  return m ? { id: m[1], host: m[2] } : null;
}

export class Usage {
  constructor(root, { send = () => {}, log = () => {} } = {}) {
    this.root = root;
    this.send = send;
    this.log = log;
    this.cfg = null;
    this.child = null;
    this.timer = null;
    this.closed = false;
    this.reset();
  }

  reset() {
    this.status = { state: 'off', since: null, error: null, system: null };
    this.users = [];
    this.hours = [];
    this.tools7 = [];
    this.outside = null;
    this.web = [];
    this.webPending = [];
    this.sources = new Map();
    this.traces = new Map();
    this.pending = [];
    this.touched = new Set();
  }

  get enabled() { return !!this.cfg; }

  configure() {
    const cfg = loadUsageConfig(this.root);
    const same = JSON.stringify(cfg) === JSON.stringify(this.cfg);
    if (same) return;
    this.stop();
    this.cfg = cfg;
    this.reset();
    this.send('usage-config', { enabled: this.enabled });
    if (cfg) this.start();
  }

  setStatus(state, error = null) {
    this.status = { ...this.status, state, error, since: new Date().toISOString() };
    this.send('usage-status', this.status);
  }

  start() {
    if (!this.cfg || this.closed || this.child) return;
    const [cmd, ...args] = this.cfg.command;
    this.setStatus('connecting');
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: this.cfg.flyToken ? { ...process.env, ...flyEnv() } : process.env });
    } catch (e) {
      this.setStatus('error', e.message);
      this.later();
      return;
    }
    this.child = child;
    if (this.cfg.stdin) {
      const file = path.resolve(path.dirname(usagePath(this.root)), this.cfg.stdin);
      createReadStream(file).on('error', (e) => { this.log(`usage feed script: ${e.message}`); child.stdin.end(); }).pipe(child.stdin);
    } else child.stdin.end();
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) { try { this.onLine(JSON.parse(line)); } catch { /* a partial or foreign line */ } }
      }
    });
    let err = '';
    child.stderr.on('data', (c) => { err = (err + c).slice(-400); });
    child.on('error', (e) => { err = e.message; });
    child.on('close', (code) => {
      this.child = null;
      if (this.closed) return;
      this.setStatus('offline', err.trim().split('\n').pop() || `feed ended (${code})`);
      this.later();
    });
  }

  later() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.start(); }, RESTART_MS);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.child) { const c = this.child; this.child = null; c.kill(); }
  }

  close() {
    this.closed = true;
    this.stop();
  }

  onLine(o) {
    if (o.t === 'hello') { this.status.system = o.system || null; this.status.labels = o.labels || null; this.traces.clear(); this.web = []; this.setStatus('loading'); return; }
    if (o.t === 'ready') { this.setStatus('live'); this.send('usage-snapshot', this.snapshot()); return; }
    if (o.t === 'sources') { this.sources = new Map((o.sources || []).map((s) => [s.id, s])); return; }
    if (o.t === 'users') {
      this.users = o.users || [];
      this.hours = o.hours || [];
      this.tools7 = o.tools7 || [];
      this.outside = o.outside || null;
      if (this.status.state === 'live') this.send('usage-users', { users: this.people(), hours: this.hours, tools7: this.tools7, outside: this.outside });
      return;
    }
    if (o.t === 'ev') this.addEvent(o);
    if (o.t === 'web') this.addWeb(o);
  }

  people() {
    const ownerOrg = this.users.find((u) => u.role === 'owner')?.org || null;
    return this.users.map((u) => ({ ...u, kind: kindOf(u, this.cfg, ownerOrg) }));
  }

  addEvent(e) {
    if (e.sim) return; // demo simulations are no use
    let t = this.traces.get(e.trace);
    if (!t) {
      t = { trace: e.trace, user: e.user, start: e.at, end: e.at, tool: null, client: null, question: null, outcome: 'running',
        ms: null, summary: null, unit: null, steps: [], sources: [], open: [],
        // the oldest requests may have lost their start to the size of the server's ring
        partial: e.stage !== 'agent' };
      this.traces.set(e.trace, t);
      if (this.traces.size > KEEP) this.traces.delete(this.traces.keys().next().value);
    }
    t.end = e.at;
    t.user ||= e.user;
    t.steps.push({ at: e.at, stage: e.stage, status: e.status, text: e.text });
    // a request that touched a private source keeps only stage and status (the system drops the rest)
    if (/^private source/.test(e.text || '')) t.private = true;
    const d = e.data || {};
    if (e.stage === 'agent' && e.status === 'start') { t.tool = d.tool || t.tool; t.client = d.client || t.client; t.question ||= d.args?.question || d.args?.name || null; }
    if (e.stage === 'find' && d.question) t.question = d.question;
    if (e.stage === 'check' && d.unit) t.unit = d.unit;
    if ((e.stage === 'check' || e.stage === 'fetch') && d.source_id && !t.sources.some((s) => s.id === d.source_id && !s.host)) t.sources.push({ id: d.source_id, at: e.at, logical: true });
    if (e.stage === 'source') {
      const call = e.status === 'start' && sourceCall(e.text);
      if (call) {
        const s = { id: call.id, host: call.host, at: e.at, status: 'open', ms: null };
        t.sources.push(s);
        t.open.push(s);
      } else if (['ok', 'refused', 'error'].includes(e.status)) {
        const s = t.open.shift();
        if (s) { s.status = e.status; s.ms = Date.parse(e.at) - Date.parse(s.at); }
      }
    }
    if (e.stage === 'fetch' && e.status === 'refused' && t.outcome === 'running') t.outcome = 'nothing';
    if (e.stage === 'price' && e.status === 'wait') t.withheld = true;
    if (e.stage === 'deliver') {
      t.outcome = e.status === 'ok' ? (t.outcome === 'nothing' ? 'nothing' : 'ok') : 'error';
      t.ms = Number.isFinite(d.ms) ? d.ms : Date.parse(e.at) - Date.parse(t.start);
      t.summary = d.summary || null;
    }
    this.pending.push({ trace: e.trace, at: e.at, stage: e.stage, status: e.status, user: t.user, tool: t.tool,
      source: e.stage === 'source' && e.status === 'start' ? sourceCall(e.text)?.id : (e.stage === 'fetch' && e.status === 'start' ? d.source_id : undefined) });
    this.touched.add(e.trace);
    if (this.status.state === 'live' && !this.flushT) this.flushT = setTimeout(() => this.flush(), 250);
  }

  /** A request from outside (no account, or refused): kept for the live list, never with an address. */
  addWeb(r) {
    const { t: _t, ...row } = r;
    this.web.push(row);
    if (this.web.length > 300) this.web.splice(0, this.web.length - 300);
    this.webPending.push(row);
    if (this.status.state === 'live' && !this.flushT) this.flushT = setTimeout(() => this.flush(), 250);
  }

  flush() {
    this.flushT = null;
    const web = this.webPending.splice(0);
    if (web.length) this.send('usage-web', web);
    const evs = this.pending.splice(0);
    const traces = [...this.touched].map((id) => this.traces.get(id)).filter(Boolean).map(brief);
    this.touched.clear();
    if (evs.length) this.send('usage-ev', { events: evs, traces });
  }

  trace(id) {
    const t = this.traces.get(id);
    return t ? { ...brief(t), steps: t.steps } : null;
  }

  snapshot() {
    if (!this.cfg) return { enabled: false };
    this.pending = [];
    this.webPending = [];
    this.touched.clear();
    return this.peek();
  }

  /** The same picture without resetting what still has to go out over SSE (for the control room). */
  peek() {
    if (!this.cfg) return { enabled: false };
    return {
      enabled: true,
      status: this.status,
      users: this.people(),
      hours: this.hours,
      tools7: this.tools7,
      outside: this.outside,
      web: this.web,
      sources: [...this.sources.values()],
      own: { tools: this.cfg.own_tools || [], sources: this.cfg.own_sources || [] },
      traces: [...this.traces.values()].map(brief),
    };
  }
}

/** A trace without its raw steps: enough for lists, stats and the light points. */
function brief(t) {
  const phases = {};
  for (const s of t.steps) {
    const p = (phases[s.stage] ||= { first: s.at, last: s.at, status: s.status });
    p.last = s.at;
    if (s.status === 'error' || s.status === 'refused' || (s.status === 'wait' && p.status !== 'error')) p.status = s.status;
    else if (p.status === 'start') p.status = s.status;
  }
  return { trace: t.trace, user: t.user, start: t.start, end: t.end, tool: t.tool, client: t.client, question: t.question,
    unit: t.unit, outcome: t.outcome, ms: t.ms, summary: t.summary, withheld: !!t.withheld, partial: !!t.partial, private: !!t.private, phases,
    sources: t.sources.map(({ id, host, ms, status, logical }) => ({ id, host, ms, status, logical })) };
}
