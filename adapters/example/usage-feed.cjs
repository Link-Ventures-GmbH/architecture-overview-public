// Example usage feed (schema usage-live/1) with made-up data, to copy for your own system. A feed
// writes one JSON object per line to stdout: hello, sources, users, then ev lines, ready once the
// backlog is out, and from then on new ev lines as they happen and users about once a minute.
// A real feed reads your system's database read-only. Point a command at it to try this one:
//   { "command": ["node", "adapters/example/usage-feed.cjs"] }
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const now = () => new Date().toISOString();

const users = () => out({
  t: 'users', at: now(), hours: [], tools7: [{ tool: 'search', n: 12, bad: 0 }], outside: null,
  users: [
    { id: '1', name: 'Ada Example', domain: 'acme.example', role: 'owner', org: 'Acme', joined: '2026-01-05T09:00:00Z', test: false,
      last: now(), calls: 12, calls7: 12, failed: 0, questions: 4, nothing: 0, answers: 4, clients: ['Example client'] },
  ],
});

let id = 0;
function request() {
  const trace = `t${++id}`;
  const base = { t: 'ev', trace, user: '1', sim: false };
  out({ ...base, id: id * 2, at: now(), stage: 'agent', status: 'start', text: 'search', data: { tool: 'search', client: 'Example client', args: {} } });
  out({ ...base, id: id * 2 + 1, at: now(), stage: 'deliver', status: 'ok', text: 'done', data: { ms: 120, summary: '3 results' } });
}

out({ t: 'hello', schema: 'usage-live/1', system: 'example', at: now() });
out({ t: 'sources', sources: [] });
users();
request();
out({ t: 'ready' });
setInterval(request, 5000);
setInterval(users, 60000);
