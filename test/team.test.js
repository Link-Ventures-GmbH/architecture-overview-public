import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTeam, roleFor, applyLayout, loadRoster, rosterState, withRoster } from '../src/team.js';
import { AgentWatcher } from '../src/agents.js';

const TEAM = `# Team

| Rang | Rolle (Sitzungsname) | Aufgabe | Darf |
|---|---|---|---|
| 0 | **Alex** (Owner) | Richtung | alles |
| 1 | **DH-Coder** (Haupt-Coder) | Architektur | ausrollen |
| 2 | **DH Adapter Coder** | baut Adapter | committen |
| 3 | **Researcher n** (z. B. **Researcher 1**: Thema) | recherchiert | lesen |

| Sitzung | Rolle | Thema |
|---|---|---|
| DH-Coder | Haupt-Coder | Plattform |
| Researcher 1 | Researcher | Publikationen |
`;

test('team file: ranks, owner, staffing', () => {
  const t = parseTeam(TEAM);
  assert.deepEqual(t.roles.map((r) => [r.rank, r.name, r.owner]), [[0, 'Alex', true], [1, 'DH-Coder', false], [2, 'DH Adapter Coder', false], [3, 'Researcher n', false]]);
  assert.equal(t.staffing.length, 2);
});

test('sessions find their role despite prefixes, underscores and numbers', () => {
  const t = parseTeam(TEAM);
  const r = (n) => roleFor(t, [n], 'data_hub');
  assert.equal(r('DH_Coder').rank, 1);
  assert.equal(r('DH_Coder').topic, 'Plattform');
  assert.equal(r('DH_Adapter_Coder').rank, 2);
  assert.equal(r('DH_Researcher1').rank, 3);
  assert.equal(r('DH_Researcher1').topic, 'Publikationen');
  assert.equal(r('DH_Researcher7').rank, 3);
  assert.equal(r('DH_Backlog'), null);
  assert.equal(r('Alex'), null, 'the owner is a person, not a session');
});

test('messages between sessions resolve by name, earlier name and socket', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ao-team-'));
  const proj = path.join(root, 'projects', '-work');
  const reg = path.join(root, 'sessions');
  mkdirSync(proj, { recursive: true });
  mkdirSync(reg, { recursive: true });
  const ts = (s) => new Date(Date.now() - 60000 + s * 1000).toISOString();
  const line = (o) => JSON.stringify(o) + '\n';
  const send = (id, to, summary, s) => line({ type: 'assistant', timestamp: ts(s), message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'SendMessage', input: { to, summary, message: '…' } }] } });
  writeFileSync(path.join(proj, 'coder.jsonl'), line({ type: 'user', timestamp: ts(0), cwd: '/work/kn', message: { role: 'user', content: 'hi' } })
    + line({ type: 'custom-title', customTitle: 'DH_Coder', timestamp: ts(0) })
    + send('m1', 'Old Adapter Name', 'please adapt', 1)
    + send('m2', 'uds:/tmp/socks/2.sock', 'pushed', 2)
    + send('m3', 'ab12cd34ef56ab78c', 'to my own subagent', 3));
  writeFileSync(path.join(proj, 'adapter.jsonl'), line({ type: 'user', timestamp: ts(0), cwd: '/work/kn', message: { role: 'user', content: 'go' } })
    + line({ type: 'custom-title', customTitle: 'Old Adapter Name', timestamp: ts(0) })
    + line({ type: 'custom-title', customTitle: 'DH_Adapter_Coder', timestamp: ts(1) })
    + send('m4', 'DH_Coder', 'done', 4));
  writeFileSync(path.join(reg, '2.json'), JSON.stringify({ sessionId: 'adapter', name: 'DH_Adapter_Coder', status: 'busy', messagingSocketPath: '/tmp/socks/2.sock' }));
  const w = new AgentWatcher({ root: path.join(root, 'projects'), cowork: null, registry: reg });
  w.scan();
  w.tick();
  const team = w.team({ inProject: () => true, roleOf: (names) => roleFor(parseTeam(TEAM), names, 'kn') });
  const byTitle = Object.fromEntries(team.members.map((m) => [m.title, m]));
  assert.equal(byTitle.DH_Coder.rank, 1);
  assert.equal(byTitle.DH_Adapter_Coder.status, 'busy');
  const pairs = team.messages.map((m) => `${m.from}>${m.toId}:${m.summary}`);
  // What the person typed into each chat counts as "owner → chat".
  assert.deepEqual(pairs.filter((p) => !p.startsWith('owner>')), ['coder>adapter:please adapt', 'coder>adapter:pushed', 'adapter>coder:done']);
  assert.deepEqual(pairs.filter((p) => p.startsWith('owner>')).sort(), ['owner>adapter:go', 'owner>coder:hi']);
});

test('display levels: chats land in their group by name, longest pattern first', () => {
  const members = [
    { id: 'c', title: 'DH_Coder', names: [] },
    { id: 'a', title: 'DH_Adapter_Coder', names: [] },
    { id: 'i', title: 'DH_Infrastructure_Data Hub Infrastruktur', names: [] },
    { id: 'r', title: 'DH_Researcher1', names: [] },
    { id: 'x', title: 'Something else', names: [] },
  ];
  const layout = { levels: [
    { label: 'Build', groups: [{ members: ['DH-Coder', 'DH Adapter Coder'] }] },
    { label: 'Ops', groups: [{ members: ['DH_Infrastructure'] }, { label: 'Support', members: ['Researcher'] }] },
  ] };
  const { levels, unplaced } = applyLayout(layout, members, 'data_hub');
  assert.deepEqual(levels[0].groups[0].members.sort(), ['a', 'c']);
  assert.deepEqual(levels[1].groups[0].members, ['i']);
  assert.deepEqual(levels[1].groups[1].members, ['r']);
  assert.deepEqual(unplaced, ['x']);
  assert.equal(roleFor(parseTeam('| Rang | Rolle | Aufgabe |\n|---|---|---|\n| 1 | **DH_Infrastructure** | Server |\n'), ['DH_Infrastructure_Data Hub Infrastruktur'], 'data_hub').role, 'DH_Infrastructure');
});

const NOW = Date.parse('2026-11-04T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400e3).toISOString();

test('roster: a role says what it is doing about its job', () => {
  const st = (r) => rosterState(r, NOW);
  assert.equal(st({ kind: 'checker', active: false, due: ['x'] }), 'waiting');
  assert.equal(st({ kind: 'onCall' }), 'on call');
  assert.equal(st({ kind: 'checker', due: ['5 commits'], lastRun: daysAgo(1) }), 'due');
  assert.equal(st({ kind: 'checker', due: [], lastRun: daysAgo(1) }), 'ok');
  assert.equal(st({ kind: 'checker', due: [] }), 'new');
  assert.equal(st({ kind: 'checker', due: [], lastRun: daysAgo(30) }), 'asleep', 'a role that stopped running shows it');
  assert.equal(st({ kind: 'chat', due: [] }), 'ready');
  assert.equal(st({ kind: 'scheduled', lastRun: daysAgo(1) }), 'ok');
  assert.equal(st({ kind: 'scheduled', lastRun: daysAgo(3) }), 'missed');
});

test('roster: roles without a chat stay on the chart, daily runs collapse to the latest', () => {
  const team = parseTeam(`| Rang | Rolle | Aufgabe |
|---|---|---|
| 1 | **VC_Coder** | baut |
| 3 | **VC_CISO** | prüft |
| 3 | **VC_Tageslauf** | startet |
`);
  const chat = (id, title, role, last) => ({ id, title, role, last, rank: 1 });
  const members = [chat('a', 'VC_Coder', 'VC_Coder', 5), chat('b', 'VC_Tageslauf', 'VC_Tageslauf', 1), chat('c', 'VC_Tageslauf', 'VC_Tageslauf', 9)];
  const roster = { roles: [{ role: 'VC_Coder', kind: 'chat', due: [] }, { role: 'VC_CISO', kind: 'checker', due: ['neu'], schedule: 'wöchentlich' }, { role: 'VC_Tageslauf', kind: 'scheduled', lastRun: daysAgo(0) }] };
  const out = withRoster(members, roster, team, NOW);
  assert.deepEqual(out.map((m) => m.id), ['a', 'c', 'role:VC_CISO']);
  assert.equal(out[0].roster.state, 'ready');
  assert.equal(out[2].ghost, true);
  assert.equal(out[2].rank, 3);
  assert.equal(out[2].roster.state, 'due');
  assert.deepEqual(withRoster(members, null, team, NOW), members, 'no roster, nothing changes');
});

test('roster: status file comes from the project config and stays inside the project', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ao-roster-'));
  const root = path.join(base, 'project');
  mkdirSync(root);
  assert.equal(loadRoster(root), null);
  writeFileSync(path.join(root, '.archoverview.json'), JSON.stringify({ team: { roster: 's.json' } }));
  assert.equal(loadRoster(root), null, 'no status written yet');
  writeFileSync(path.join(root, 's.json'), JSON.stringify({ roles: [{ role: 'X' }] }));
  assert.equal(loadRoster(root).roles[0].role, 'X');
  writeFileSync(path.join(root, '.archoverview.json'), JSON.stringify({ team: { roster: '../secret.json' } }));
  writeFileSync(path.join(base, 'secret.json'), JSON.stringify({ roles: [] }));
  assert.equal(loadRoster(root), null, 'a path out of the project is refused');
});
