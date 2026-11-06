// Read-only git queries. Every call degrades to an empty answer outside a repo.

import { execFile } from 'node:child_process';

function git(root, args) {
  return new Promise((resolve) => {
    // No optional locks: a plain `git status` would otherwise rewrite .git/index, which our
    // own watcher sees as a change and answers with another `git status`.
    execFile('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout) => {
      resolve(err ? null : stdout.toString());
    });
  });
}

export async function isRepo(root) {
  return (await git(root, ['rev-parse', '--is-inside-work-tree']))?.trim() === 'true';
}

export async function branch(root) {
  return (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() || null;
}

/** Working tree changes: [{ path, status }] with status M, A, D, R or ?. */
export async function status(root) {
  const out = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!out) return [];
  const items = out.split('\0');
  const res = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it) continue;
    const xy = it.slice(0, 2);
    const file = it.slice(3);
    let st = xy.includes('?') ? '?' : xy.includes('D') ? 'D' : xy.includes('A') ? 'A' : xy.includes('R') ? 'R' : 'M';
    if (xy[0] === 'R') i++; // rename carries the old path as the next item
    res.push({ path: file, status: st });
  }
  return res;
}

/** Recent commits with the files they touched. */
export async function log(root, n = 40) {
  const out = await git(root, ['log', `-n${n}`, '--no-merges', '--format=%x1e%H%x1f%h%x1f%an%x1f%at%x1f%s', '--name-only']);
  if (!out) return [];
  return out.split('\x1e').filter((s) => s.trim()).map((chunk) => {
    const [head, ...rest] = chunk.split('\n');
    const [hash, short, author, at, subject] = head.split('\x1f');
    return { hash, short, author, time: Number(at) * 1000, subject, files: rest.map((s) => s.trim()).filter(Boolean) };
  });
}

/** Line ranges per file from a unified diff with zero context. */
export function parseHunks(diff) {
  const map = new Map();
  let file = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice(6) : null;
      if (file && !map.has(file)) map.set(file, []);
    } else if (file && line.startsWith('@@')) {
      const m = line.match(/\+(\d+)(?:,(\d+))?/);
      if (m) {
        const start = Number(m[1]);
        const len = m[2] === undefined ? 1 : Number(m[2]);
        map.get(file).push([start, start + Math.max(len, 1) - 1]);
      }
    }
  }
  return map;
}

/** Uncommitted line ranges against HEAD. */
export async function workingHunks(root) {
  const out = await git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', 'HEAD']);
  return out ? parseHunks(out) : new Map();
}

/** Line ranges a commit touched (in the commit's version of each file). */
export async function commitHunks(root, hash) {
  const out = await git(root, ['show', '-U0', '--no-color', '--no-ext-diff', '--format=', hash]);
  return out ? parseHunks(out) : new Map();
}
