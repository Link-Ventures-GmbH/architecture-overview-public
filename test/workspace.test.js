import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRepos, normName, worksIn, Workspace } from '../src/workspace.js';

test('finds git repos one and two levels down, skips the rest', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ao-ws-')));
  for (const d of ['alpha/.git', 'group/beta/.git', 'node_modules/x/.git', 'plain/src', '.hidden/.git']) mkdirSync(path.join(root, d), { recursive: true });
  const repos = findRepos(root).map((r) => path.relative(root, r)).sort();
  assert.deepEqual(repos, ['alpha', 'group/beta']);
  const ws = new Workspace(root);
  assert.ok(ws.allows(path.join(root, 'alpha')));
  assert.ok(!ws.allows(os.homedir()));
});

test('chats belong where they recently worked', () => {
  const chat = { cwd: '/work', places: ['/work/data_hub/src', '/work/notes'] };
  assert.ok(worksIn(chat, '/work/data_hub'));
  assert.ok(!worksIn(chat, '/work/knowledge'));
  assert.ok(worksIn({ cwd: '/work/vinio', places: [] }, '/work/vinio'));
});

test('service names match folders loosely', () => {
  assert.equal(normName('data_hub'), normName('data-hub'));
  assert.equal(normName('Fast Feedback'), 'fastfeedback');
});
