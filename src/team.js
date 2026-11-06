// Reads a team file (docs/TEAM.md and friends): which roles exist, their rank, what they do,
// and which session holds which role. Matches sessions to roles by name, loosely.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = ['docs/TEAM.md', 'TEAM.md', '.claude/TEAM.md', 'docs/team.md', 'team.md'];

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const clean = (s) => String(s || '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();

/** Markdown tables as arrays of row objects keyed by the lower-cased header text. */
export function tables(md) {
  const out = [];
  let cur = null;
  for (const line of md.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) { if (cur) { out.push(cur); cur = null; } continue; }
    const cells = t.replace(/^\||\|$/g, '').split('|').map((c) => clean(c));
    if (!cur) { cur = { header: cells.map((c) => c.toLowerCase()), rows: [] }; continue; }
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    cur.rows.push(Object.fromEntries(cur.header.map((h, i) => [h, cells[i] || ''])));
  }
  if (cur) out.push(cur);
  return out;
}

const col = (header, ...words) => header.find((h) => words.some((w) => h.includes(w)));

/** Role name and the session name in brackets, e.g. "Researcher n (z. B. Researcher 1: …)". */
function roleName(cell) {
  const name = clean(cell).replace(/\s*\(.*$/, '').trim();
  const owner = /owner|inhaber|chef/i.test(cell);
  return { name, owner };
}

/** A role name like "Researcher n" or "Researcher <n>" matches "Researcher 1", "Researcher 12". */
function rolePattern(name) {
  const m = name.match(/^(.*?)\s*(?:\bn\b|<n>|#|\bx\b)\s*$/i);
  return m && norm(m[1]) ? new RegExp(`^${norm(m[1])}\\d+$`) : null;
}

export function parseTeam(md) {
  const roles = [];
  const staffing = [];
  for (const tb of tables(md)) {
    const h = tb.header;
    const rank = col(h, 'rang', 'rank', 'level', 'stufe');
    const role = col(h, 'rolle', 'role');
    const task = col(h, 'aufgabe', 'task', 'responsib', 'zuständig');
    const session = col(h, 'sitzung', 'session', 'chat');
    const topic = col(h, 'thema', 'topic', 'focus', 'schwerpunkt');
    if (rank && role) {
      for (const r of tb.rows) {
        const { name, owner } = roleName(r[role]);
        if (!name) continue;
        roles.push({ name, rank: Number(String(r[rank]).match(/\d+/)?.[0] ?? 99), task: clean(r[task] || ''), owner, pattern: rolePattern(name) });
      }
    } else if (session && role) {
      for (const r of tb.rows) staffing.push({ session: r[session], role: r[role], topic: clean(r[topic] || '') });
    }
  }
  roles.sort((a, b) => a.rank - b.rank);
  return { roles, staffing };
}

export function loadTeam(root) {
  for (const rel of CANDIDATES) {
    const p = path.join(root, rel);
    if (!existsSync(p)) continue;
    try {
      const team = parseTeam(readFileSync(p, 'utf8'));
      if (team.roles.length) return { file: rel, ...team };
    } catch { /* unreadable */ }
  }
  return null;
}

/**
 * Finds the role of a session from its names (current title plus earlier ones).
 * Sessions are often named with a project prefix ("DH_Coder"), team files without ("DH-Coder" or "Coder").
 */
export function roleFor(team, names, projectName) {
  if (!team) return null;
  const prefixes = [norm(projectName), norm(projectName.split(/[-_\s]+/).map((w) => w[0]).join(''))].filter((p) => p.length >= 2);
  const variants = new Set();
  for (const n of names) {
    const v = norm(n);
    if (!v) continue;
    variants.add(v);
    for (const p of prefixes) if (v.startsWith(p) && v.length > p.length) variants.add(v.slice(p.length));
  }
  const hits = (label) => {
    const l = norm(label);
    if (!l) return false;
    for (const v of variants) {
      if (v === l) return true;
      // Session names often add a description: "DH_Infrastructure_Data Hub Infrastruktur".
      if (l.length >= 6 && v.startsWith(l)) return true;
      for (const p of prefixes) if (l.startsWith(p) && l.slice(p.length) === v) return true;
    }
    return false;
  };
  // The staffing table names sessions directly; it wins over role names.
  for (const s of team.staffing) {
    if (hits(s.session)) {
      const role = team.roles.find((r) => norm(r.name) === norm(s.role))
        || team.roles.find((r) => r.pattern && r.pattern.test(norm(s.session)))
        || team.roles.find((r) => !r.owner && norm(r.name).startsWith(norm(s.role)))
        || team.roles.find((r) => hits(r.name)) || null;
      return { role: role?.name || s.role, rank: role?.rank ?? 99, task: role?.task || '', topic: s.topic };
    }
  }
  for (const r of team.roles) {
    if (r.owner) continue;
    if (hits(r.name) || (r.pattern && [...variants].some((v) => r.pattern.test(v)))) {
      return { role: r.name, rank: r.rank, task: r.task, topic: '' };
    }
  }
  return null;
}

// ---------- display levels ----------
// How the org chart is drawn: rows ("levels") of groups of members, kept apart from the team
// file, whose ranks carry rights and decisions. Stored next to the saved logic maps.

const STORE = path.join(os.homedir(), '.linklabs', 'architecture-overview');

export function layoutPath(root) {
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 8);
  return path.join(STORE, `${path.basename(root)}-${hash}.team.json`);
}

export function loadLayout(root) {
  const p = layoutPath(root);
  if (!existsSync(p)) return null;
  try {
    const d = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(d.levels) ? d : null;
  } catch { return null; }
}

export function saveLayout(root, layout) {
  mkdirSync(STORE, { recursive: true });
  writeFileSync(layoutPath(root), JSON.stringify(layout, null, 2));
}

/**
 * Places chats into the levels. A member pattern matches a chat whose name (or role) contains it,
 * ignoring case, separators and the project prefix; the longest pattern wins. The owner pattern
 * ("owner": true or the first level's first member when it names nobody) stands for the person.
 */
export function applyLayout(layout, members, projectName) {
  const prefixes = [norm(projectName), norm(projectName.split(/[-_\s]+/).map((w) => w[0]).join(''))].filter((p) => p.length >= 2);
  const strip = (v) => { for (const p of prefixes) if (v.startsWith(p) && v.length > p.length) return v.slice(p.length); return v; };
  const keysOf = (m) => [...new Set([m.title, ...(m.names || []), m.role].filter(Boolean).flatMap((n) => [norm(n), strip(norm(n))]))];
  const patterns = [];
  layout.levels.forEach((lv, li) => (lv.groups || [{ members: lv.members || [] }]).forEach((g, gi) => (g.members || []).forEach((pat) => {
    patterns.push({ li, gi, pat, key: strip(norm(pat)) });
  })));
  patterns.sort((a, b) => b.key.length - a.key.length);
  const placed = new Map(); // member id -> { li, gi }
  for (const m of members) {
    const keys = keysOf(m);
    const hit = patterns.find((p) => p.key && keys.some((k) => k === p.key || k.startsWith(p.key) || k.includes(p.key)));
    if (hit) placed.set(m.id, { li: hit.li, gi: hit.gi });
  }
  const levels = layout.levels.map((lv, li) => ({
    label: lv.label || '',
    groups: (lv.groups || [{ members: lv.members || [] }]).map((g, gi) => ({
      label: g.label || '',
      owner: !!g.owner || (li === 0 && gi === 0 && !!lv.owner),
      members: members.filter((m) => placed.get(m.id)?.li === li && placed.get(m.id)?.gi === gi).map((m) => m.id),
    })),
  }));
  return { levels, unplaced: members.filter((m) => !placed.has(m.id)).map((m) => m.id) };
}

// ---------- roster ----------
// A team also has roles without a running chat: reviewers that run on a schedule, roles on call.
// The project names a status file in .archoverview.json ("team": { "roster": "path" }); this shows
// every role with its last run and what is waiting, so a role that fell asleep stays visible.

const DAY = 86400e3;
const MISSED_MS = 1.5 * DAY; // a daily run that has not been seen for this long was missed
const ASLEEP_MS = 14 * DAY;

export function loadRoster(root) {
  for (const name of ['.archoverview.json', 'archoverview.json']) {
    try {
      const rel = JSON.parse(readFileSync(path.join(root, name), 'utf8')).team?.roster;
      if (typeof rel !== 'string') continue;
      const file = path.resolve(root, rel);
      if (file !== root && !file.startsWith(root + path.sep)) return null; // stays inside the project
      const roster = JSON.parse(readFileSync(file, 'utf8'));
      return Array.isArray(roster.roles) ? roster : null;
    } catch { /* no config or no status yet */ }
  }
  return null;
}

/** One word for a role: what it is doing about its job. */
export function rosterState(r, now = Date.now()) {
  if (r.active === false) return 'waiting';
  if (r.kind === 'onCall') return 'on call';
  const age = r.lastRun ? now - Date.parse(r.lastRun) : Infinity;
  if (r.kind === 'scheduled') return age > MISSED_MS ? 'missed' : 'ok';
  if (r.due?.length) return 'due';
  if (r.kind === 'chat') return 'ready';
  if (!r.lastRun) return 'new';
  return age > ASLEEP_MS ? 'asleep' : 'ok';
}

/**
 * Hangs the roster onto the chats and adds a quiet card for every role without one. Scheduled runs
 * start a new chat each time under the same name, so only the latest of a name stays.
 */
export function withRoster(members, roster, team, now = Date.now()) {
  if (!roster) return members;
  const latest = new Map();
  for (const m of members) {
    const old = latest.get(m.title);
    if (!old || m.last > old.last) latest.set(m.title, m);
  }
  const kept = members.filter((m) => latest.get(m.title) === m);
  const out = [...kept];
  for (const r of roster.roles) {
    const info = { ...r, state: rosterState(r, now) };
    const chat = kept.find((m) => m.role && norm(m.role) === norm(r.role));
    if (chat) { chat.roster = info; continue; }
    const role = team?.roles.find((x) => norm(x.name) === norm(r.role));
    out.push({
      id: `role:${r.role}`, ghost: true, title: r.role, names: [r.role], role: r.role, rank: role?.rank ?? 99, task: role?.task || '', topic: r.schedule || '',
      status: 'idle', live: false, model: '', family: 'unknown', now: null, last: r.lastRun ? Date.parse(r.lastRun) : 0, start: 0,
      prompts24h: 0, lastPrompt: 0, subagents: { total: 0, active: 0, recent: [] }, tools: {}, tokens: { in: 0, out: 0 }, roster: info,
    });
  }
  return out;
}
