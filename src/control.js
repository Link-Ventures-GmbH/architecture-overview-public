// The control room: one row per product with its health (each environment checked on its own
// interval) and, where a usage feed runs, the day's numbers from it. Health history survives
// restarts in ~/.linklabs, so the 24-hour strip does not start empty after every reboot.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HISTORY = path.join(os.homedir(), '.linklabs', 'architecture-overview', 'control-history.json');
const DAY = 86400e3;
const BUCKETS = 48; // half hours over the last day
const TIMEOUT = 20_000; // a cold Fly machine needs a few seconds to wake

const key = (p, e) => `${p.id}:${e.name}`;

export class Control {
  constructor({ registry, log = () => {}, file = HISTORY, fetchImpl = fetch }) {
    this.registry = registry;
    this.log = log;
    this.file = file;
    this.fetch = fetchImpl;
    this.timers = new Map();
    this.history = this.read();
    this.saveT = null;
    this.onChange = () => this.schedule();
    registry.on('change', this.onChange);
  }

  read() {
    try {
      const h = JSON.parse(readFileSync(this.file, 'utf8'));
      return new Map(Object.entries(h).map(([k, v]) => [k, Array.isArray(v) ? v : []]));
    } catch { return new Map(); }
  }

  save() {
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => {
      try {
        mkdirSync(path.dirname(this.file), { recursive: true });
        writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.history)));
      } catch (e) { this.log(`  control history: ${e.message}`); }
    }, 5000);
    this.saveT.unref?.();
  }

  /** (Re)plans every environment's next check; the first round is spread over 20 seconds. */
  schedule() {
    const keep = new Set();
    let i = 0;
    for (const p of this.registry.list) {
      for (const e of p.environments) {
        const k = key(p, e);
        keep.add(k);
        if (this.timers.has(k) && this.timers.get(k).every === e.every && this.timers.get(k).url === e.url + e.health) continue;
        clearTimeout(this.timers.get(k)?.t);
        const last = this.history.get(k)?.at(-1)?.[0] || 0;
        const wait = Math.max((i++ % 20) * 1000, last + e.every * 1000 - Date.now());
        this.plan(k, p, e, wait);
      }
    }
    for (const [k, v] of this.timers) if (!keep.has(k)) { clearTimeout(v.t); this.timers.delete(k); }
  }

  plan(k, p, e, wait) {
    const t = setTimeout(async () => {
      await this.check(p, e);
      if (this.timers.get(k)?.t === t) this.plan(k, p, e, e.every * 1000);
    }, wait);
    t.unref?.();
    this.timers.set(k, { t, every: e.every, url: e.url + e.health });
  }

  async check(p, e) {
    const k = key(p, e);
    const started = Date.now();
    let status = 0;
    try {
      const res = await this.fetch(e.url + e.health, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT), headers: { 'user-agent': 'LinkLabs-Leitstand/1 (health check)' } });
      status = res.status;
      res.body?.cancel?.().catch?.(() => {});
    } catch { status = 0; }
    const ok = status > 0 && status < 400;
    const list = this.history.get(k) || [];
    const prev = list.at(-1);
    list.push([started, ok ? 1 : 0, Date.now() - started, status]);
    while (list.length && list[0][0] < Date.now() - DAY) list.shift();
    this.history.set(k, list);
    if (prev && !!prev[1] !== ok) this.log(`  ${p.name} ${e.name}: ${ok ? 'back up' : `down (${status || 'no answer'})`}`);
    this.save();
  }

  env(p, e) {
    const list = this.history.get(key(p, e)) || [];
    const last = list.at(-1) || null;
    const now = Date.now();
    const buckets = Array.from({ length: BUCKETS }, () => [0, 0]); // [checks, up]
    for (const c of list) {
      const b = Math.floor((c[0] - (now - DAY)) / (DAY / BUCKETS));
      if (b < 0) continue;
      const slot = buckets[Math.min(BUCKETS - 1, b)];
      slot[0]++;
      slot[1] += c[1];
    }
    const strip = buckets.map(([n, up]) => (!n ? '-' : up === n ? 'u' : up ? 'p' : 'd')).join('');
    // the last down, so a tile can say "down since" or "was down 3 h ago"
    const lastDown = [...list].reverse().find((c) => !c[1])?.[0] || null;
    return {
      name: e.name, url: e.url, every: e.every, cold: e.cold,
      state: last ? (last[1] ? 'up' : 'down') : 'unknown',
      status: last?.[3] ?? null, ms: last?.[2] ?? null, at: last?.[0] ?? null,
      uptime: list.length ? list.filter((c) => c[1]).length / list.length : null,
      checks: list.length, strip, lastDown,
      feed: e.feed ? (e.feed.error ? { error: e.feed.error } : { ok: true }) : null,
    };
  }

  /** usage: product id → usage snapshot of its project, for those whose feed runs. */
  snapshot(usage = new Map()) {
    return {
      configured: this.registry.configured,
      dir: this.registry.dir,
      products: this.registry.list.map((p) => ({
        id: p.id, name: p.name, group: p.group, error: p.error || null,
        repos: p.repos.map((r) => ({ name: r.name, root: r.root })),
        environments: p.environments.map((e) => this.env(p, e)),
        usage: summarize(usage.get(p.id)),
      })),
    };
  }

  close() {
    this.registry.off('change', this.onChange);
    for (const v of this.timers.values()) clearTimeout(v.t);
    this.timers.clear();
  }
}

/** The day in numbers from a usage snapshot; test accounts never count. */
export function summarize(snap, now = Date.now()) {
  if (!snap?.enabled) return null;
  const users = (snap.users || []).filter((u) => !u.test && u.kind !== 'test');
  const ids = new Set(users.map((u) => u.id));
  const since = (t, ms) => t && Date.parse(String(t).replace(' ', 'T')) >= now - ms;
  const web = snap.outside?.web;
  return {
    status: snap.status?.state || 'off',
    accounts: users.length,
    active: users.filter((u) => since(u.last, DAY)).length,
    calls: (snap.hours || []).filter((h) => ids.has(h.u)).reduce((s, h) => s + h.n, 0),
    strangers: users.filter((u) => u.kind === 'stranger').length,
    strangersActive: users.filter((u) => u.kind === 'stranger' && since(u.last, DAY)).length,
    fresh: users.filter((u) => since(u.joined, 7 * DAY)).length,
    errors: (snap.traces || []).filter((t) => !t.partial && t.outcome === 'error' && since(t.start, DAY)).length,
    visitors: web ? (web.classes || []).reduce((s, c) => s + (c.v || 0), 0) : null,
    refused: web ? (web.kinds || []).filter((k) => k.auth === 'refused').reduce((s, k) => s + k.n, 0) : null,
  };
}
