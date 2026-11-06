// The projects in a workspace folder and how busy each one is: git, open files,
// Claude chats working in it and whether it sends telemetry.

import { readdirSync, statSync, existsSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { IGNORE_DIRS } from './lang.js';

const DAY = 86400e3;
const CACHE_MS = 15000;

function git(root, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: root, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, out) => resolve(err ? '' : out.toString()));
  });
}

/** Git repositories directly in the workspace or one level below. */
export function findRepos(workspace) {
  const out = [];
  const visit = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (existsSync(path.join(p, '.git'))) out.push(p);
      else if (depth < 2) visit(p, depth + 1);
    }
  };
  visit(workspace, 1);
  return out;
}

/** Normalised name for matching folders to service names: data_hub ~ data-hub. */
export const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export const inside = (child, parent) => !!child && (child === parent || child.startsWith(parent + path.sep));

/** A chat belongs to every project it recently worked in. */
export const worksIn = (chat, root) => (chat.places || []).some((p) => inside(p, root)) || inside(chat.cwd, root);

async function repoStats(root, days) {
  const since = `--since=${days}.days`;
  const [branch, log, last, status] = await Promise.all([
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(root, ['log', since, '--format=%ct']),
    git(root, ['log', '-1', '--format=%ct%x1f%s']),
    git(root, ['status', '--porcelain=v1', '--untracked-files=normal']),
  ]);
  const commits = log.split('\n').filter(Boolean).map((t) => Number(t) * 1000);
  const [lastT, subject] = last.trim().split('\x1f');
  const dirty = status.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop());
  let lastChange = 0;
  for (const f of dirty.slice(0, 60)) {
    try { lastChange = Math.max(lastChange, statSync(path.join(root, f)).mtimeMs); } catch { /* deleted */ }
  }
  return { branch: branch.trim() || null, commits, lastCommit: Number(lastT || 0) * 1000, subject: subject || '', dirty: dirty.length, lastChange };
}

export class Workspace {
  constructor(root, { agents, telemetry } = {}) {
    this.root = realpathSync(root);
    this.agents = agents; // AgentWatcher
    this.telemetry = telemetry; // Map normName(service) -> last seen
    this.cache = null;
  }

  allows(p) {
    try { return inside(realpathSync(p), this.root); } catch { return false; }
  }

  async list({ days = 14, all = false } = {}) {
    if (!this.cache || Date.now() - this.cache.t > CACHE_MS || this.cache.days !== days) {
      const repos = findRepos(this.root);
      const stats = await Promise.all(repos.map((r) => repoStats(r, days).then((s) => [r, s])));
      this.cache = { t: Date.now(), days, stats };
    }
    const now = Date.now();
    const start = now - days * DAY;
    const sessions = this.agents ? this.agents.list() : [];
    const projects = this.cache.stats.map(([root, s]) => {
      const name = path.relative(this.root, root);
      const chats = sessions.filter((c) => c.last >= start && worksIn(c, root));
      const perDay = new Array(days).fill(0);
      const bump = (t) => { const i = days - 1 - Math.floor((now - t) / DAY); if (i >= 0 && i < days) perDay[i]++; };
      s.commits.forEach(bump);
      chats.forEach((c) => bump(c.last));
      const key = normName(path.basename(root));
      let telemetryAt = 0;
      for (const [svc, t] of this.telemetry || []) {
        if (svc && key && (svc.startsWith(key) || key.startsWith(svc))) telemetryAt = Math.max(telemetryAt, t);
      }
      const lastChat = Math.max(0, ...chats.map((c) => c.last));
      return {
        root, name, folder: path.basename(root), branch: s.branch, subject: s.subject,
        lastCommit: s.lastCommit, lastChange: s.lastChange, dirty: s.dirty,
        lastActivity: Math.max(s.lastCommit, s.lastChange, lastChat),
        perDay, commits: s.commits.length,
        chats: chats.length, activeChats: chats.filter((c) => c.active).length,
        agentsWorking: chats.reduce((n, c) => n + (c.activeAgents || 0), 0),
        chatTitles: chats.slice(0, 4).map((c) => ({ title: c.title, active: c.active })),
        telemetry: now - telemetryAt < 60e3,
      };
    });
    return projects
      .filter((p) => all || p.lastActivity >= start)
      .sort((a, b) => b.lastActivity - a.lastActivity);
  }
}
