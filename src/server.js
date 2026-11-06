// One server for every project in the workspace: a browser picks a project, the server opens
// it (watcher, git, model) and streams it over SSE. The last few projects stay warm.

import http from 'node:http';
import { readFileSync, statSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProject } from './context.js';
import { decodeTraces } from './otlp.js';
import { AgentWatcher } from './agents.js';
import { loadDbip } from './geo.js';
import { Workspace, normName, inside, worksIn } from './workspace.js';
import { loadTeam, roleFor, loadLayout, applyLayout, layoutPath, loadRoster, withRoster } from './team.js';
import { registry } from './products.js';
import { Control } from './control.js';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const WARM = 3;

// Fonts, styles and images say nothing about the architecture and would drown the real calls,
// and HEAD requests are almost always health checks from monitors and load balancers.
const STATIC = /\.(css|m?js|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|txt|webmanifest)$/i;
const isStaticRequest = (sp) => sp.kind === 2 && ((sp.attrs['http.request.method'] || sp.attrs['http.method']) === 'HEAD'
  || STATIC.test(String(sp.attrs['url.path'] || sp.attrs['http.target'] || sp.attrs['http.route'] || sp.name.split(' ')[1] || '').split('?')[0]));

export async function start({ root, workspace, port, host = '127.0.0.1', otlpPort = 4318, log = console.log }) {
  const home = realpathSync(root);
  const clients = new Set(); // { res, project }
  const contexts = new Map(); // root -> Promise<ctx>
  const telemetry = new Map(); // normName(service) -> last seen
  let otlpListening = false;

  const write = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (event, data) => { for (const c of clients) write(c.res, event, data); };
  const sendTo = (project) => (event, data) => { for (const c of clients) if (c.project === project) write(c.res, event, data); };

  /** Opens (or reuses) a project; closes the least used one beyond WARM that nobody watches. */
  function context(projectRoot) {
    let job = contexts.get(projectRoot);
    if (!job) {
      job = openProject(projectRoot, { send: sendTo(projectRoot), log });
      contexts.set(projectRoot, job);
      job.catch(() => contexts.delete(projectRoot));
    }
    job.then((ctx) => { ctx.lastUsed = Date.now(); evict(); }).catch(() => {});
    return job;
  }

  async function evict() {
    if (contexts.size <= WARM) return;
    const watched = new Set([...clients].map((c) => c.project));
    const open = await Promise.all([...contexts].map(async ([r, j]) => [r, await j.catch(() => null)]));
    const pinned = new Set(registry.feedRoots()); // their usage feeds keep the control room live
    const idle = open.filter(([r, ctx]) => ctx && !watched.has(r) && r !== home && !pinned.has(r)).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (contexts.size > WARM && idle.length) {
      const [r, ctx] = idle.shift();
      ctx.close();
      contexts.delete(r);
      log(`  closed ${ctx.name}`);
    }
  }

  const agents = new AgentWatcher({ log, emit: broadcast });
  const ws = new Workspace(workspace || path.dirname(home), { agents, telemetry });
  // The IP database has to be in memory before hosts get located, or they would be cached as unknown.
  loadDbip({ log }).catch(() => null).finally(() => agents.start());
  setInterval(() => broadcast('agent-sessions', agents.list()), 4000).unref();

  registry.workspace = ws.root;
  registry.load();
  const control = new Control({ registry, log });
  const warmFeeds = () => { for (const r of registry.feedRoots()) if (r === home || ws.allows(r)) context(r).catch(() => {}); };
  registry.on('change', warmFeeds);
  control.schedule();

  await context(home);
  warmFeeds();

  /** Resolves ?project= to an allowed project root (the start project or one inside the workspace). */
  function projectParam(url) {
    const p = url.searchParams.get('project');
    if (!p) return home;
    let real;
    try { real = realpathSync(p); } catch { return null; }
    if (real === home || ws.allows(real)) return real;
    return null;
  }

  // ---------- OpenTelemetry ----------

  /** Spans go to the open project whose folder matches the service name, else to the start project. */
  // Order: the project.dir resource attribute, the "services" list in a project's config,
  // then the service name against the folder name, else the start project.
  const dirRoots = new Map(); // project.dir as sent -> real root or null
  async function byDir(dir) {
    if (!dir) return null;
    if (!dirRoots.has(dir)) {
      let real = null;
      try { real = realpathSync(dir); } catch { /* not on this machine */ }
      dirRoots.set(dir, real && (real === home || ws.allows(real)) ? real : null);
    }
    const root = dirRoots.get(dir);
    return root ? context(root).catch(() => null) : null;
  }

  async function intake(list) {
    const now = Date.now();
    const skip = new Set(list.filter(isStaticRequest).map((sp) => sp.spanId));
    const byProject = new Map();
    const dirs = new Map();
    for (const d of new Set(list.map((sp) => sp.projectDir).filter(Boolean))) dirs.set(d, await byDir(d));
    const open = await Promise.all([...contexts.values()].map((j) => j.catch(() => null)));
    for (const sp of list) {
      if (skip.has(sp.spanId) || (sp.parentId && skip.has(sp.parentId))) continue;
      const svc = normName(sp.service);
      telemetry.set(svc, now);
      const ctx = dirs.get(sp.projectDir)
        || open.find((c) => c && svc && c.services().some((s) => normName(s) === svc))
        || open.find((c) => c && svc && (svc.startsWith(normName(c.name)) || normName(c.name).startsWith(svc)))
        || open.find((c) => c && c.root === home);
      if (!ctx) continue;
      if (!byProject.has(ctx)) byProject.set(ctx, []);
      byProject.get(ctx).push(sp);
    }
    for (const [ctx, spans] of byProject) ctx.addSpans(spans);
  }

  /** OTLP/HTTP endpoints. Returns true when the request was one of them. */
  function handleOtlp(req, res, pathname) {
    if (!pathname.startsWith('/v1/')) return false;
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return true; }
    if (req.method !== 'POST' || !['/v1/traces', '/v1/metrics', '/v1/logs'].includes(pathname)) { res.writeHead(404, cors); res.end(); return true; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const ct = req.headers['content-type'] || '';
      const json = /json/i.test(ct);
      if (pathname === '/v1/traces') {
        try {
          intake(decodeTraces(Buffer.concat(chunks), ct, req.headers['content-encoding'] || ''));
        } catch (e) {
          res.writeHead(400, { ...cors, 'content-type': 'text/plain' });
          res.end(`cannot decode OTLP traces: ${e.message}`);
          return;
        }
      }
      // Metrics and logs are accepted and dropped, so exporters do not keep retrying.
      res.writeHead(200, { ...cors, 'content-type': json ? 'application/json' : 'application/x-protobuf' });
      res.end(json ? '{}' : '');
    });
    return true;
  }

  // ---------- http ----------

  const json = (res, code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (handleOtlp(req, res, url.pathname)) return;
    try {
      if (url.pathname === '/events') {
        const project = projectParam(url);
        if (!project) return json(res, 403, { error: 'project outside the workspace' });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const ctx = await context(project);
        const client = { res, project };
        write(res, 'snapshot', { ...ctx.snapshot({ otel: { port: otlpListening ? otlpPort : null, mainPort: port } }), project: { root: project, home: project === home, workspace: ws.root } });
        clients.add(client);
        req.on('close', () => { clients.delete(client); evict(); });
        return;
      }
      if (url.pathname === '/api/projects') {
        const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 14));
        const list = await ws.list({ days, all: url.searchParams.get('all') === '1' });
        const open = new Set(contexts.keys());
        return json(res, 200, { workspace: ws.root, home, days, projects: list.map((p) => ({ ...p, warm: open.has(p.root) })) });
      }
      if (url.pathname === '/api/logic/generate' && req.method === 'POST') {
        const project = projectParam(url);
        if (!project) return json(res, 403, { error: 'project outside the workspace' });
        (await context(project)).mapLogic();
        return json(res, 202, { ok: true });
      }
      if (url.pathname === '/api/logic/prompt') {
        const project = projectParam(url);
        if (!project) return json(res, 403, { error: 'project outside the workspace' });
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end((await context(project)).agentPrompt());
      }
      if (url.pathname === '/api/agents/sessions') return json(res, 200, agents.list());
      if (url.pathname === '/api/agents/team') {
        const project = projectParam(url);
        if (!project) return json(res, 403, { error: 'project outside the workspace' });
        const team = loadTeam(project);
        const name = path.basename(project);
        const chats = new Map(agents.list().map((c) => [c.id, c]));
        const roleOf = (names) => roleFor(team, names, name);
        // Sessions with a role belong to the team; others only when this project is where they mostly work.
        const inProject = (s) => {
          const c = chats.get(s.id);
          if (!c || !worksIn(c, project)) return false;
          return !!roleOf([...s.names, s.title]) || inside(c.places?.[0], project);
        };
        const owner = team?.roles.find((r) => r.owner || r.rank === 0) || null;
        const snap = agents.team({ inProject, roleOf, owner: owner && { name: owner.name, task: owner.task } });
        const roster = loadRoster(project);
        snap.members = withRoster(snap.members, roster, team);
        const layout = loadLayout(project);
        const placed = layout ? applyLayout(layout, snap.members, name) : null;
        return json(res, 200, { file: team?.file || null, roles: team?.roles.map(({ pattern, ...r }) => r) || [], ...snap,
          layout: placed, layoutFile: layout ? layoutPath(project) : null,
          roster: roster && { updated: roster.updated, lastDaily: roster.lastDaily, pulse: roster.pulse, findings: roster.findings || [], openFindings: roster.openFindings || 0 } });
      }
      if (url.pathname === '/api/agents/session') {
        const snap = agents.snapshot(url.searchParams.get('id') || '');
        return json(res, snap ? 200 : 404, snap || { error: 'no such session' });
      }
      if (url.pathname.startsWith('/api/evals/')) {
        const project = projectParam(url);
        if (!project) return json(res, 403, { error: 'project outside the workspace' });
        const ev = (await context(project)).evals;
        const id = url.searchParams.get('id') || '';
        if (url.pathname === '/api/evals/runs') return json(res, 200, { enabled: ev.enabled, live: ev.live, runs: ev.runs(), ledger: ev.ledger() });
        if (url.pathname === '/api/evals/run') { const r = ev.run(id); return json(res, r ? 200 : 404, r || { error: 'no such run' }); }
        if (url.pathname === '/api/evals/trace') return json(res, 200, ev.trace(id, url.searchParams.get('run')));
        if (url.pathname === '/api/evals/overview') return json(res, 200, ev.overview((url.searchParams.get('runs') || '').split(',').filter(Boolean)));
        if (url.pathname === '/api/evals/compares') return json(res, 200, ev.compares());
        if (url.pathname === '/api/evals/compare') { const c = ev.compare(id); return json(res, c ? 200 : 404, c || { error: 'no such comparison' }); }
        if (url.pathname === '/api/evals/ledger') return json(res, 200, ev.ledger());
        if (url.pathname === '/api/evals/needs') { res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' }); return res.end(ev.needs() || ''); }
        return json(res, 404, { error: 'unknown evals endpoint' });
      }
      if (url.pathname === '/api/usage/trace') {
        const project = projectParam(url);
        if (!project) return json(res, 403, { error: 'project outside the workspace' });
        const t = (await context(project)).usage.trace(url.searchParams.get('id') || '');
        return json(res, t ? 200 : 404, t || { error: 'no such request' });
      }
      if (url.pathname === '/api/control') {
        const usage = new Map();
        for (const p of registry.list) {
          const root = p.repos[0]?.root;
          const job = root && contexts.get(root);
          const ctx = job && await job.catch(() => null);
          if (ctx) usage.set(p.id, ctx.usage.peek());
        }
        return json(res, 200, control.snapshot(usage));
      }
      if (url.pathname === '/api/state') {
        const project = projectParam(url);
        if (!project) return json(res, 403, { error: 'project outside the workspace' });
        return json(res, 200, (await context(project)).snapshot());
      }
    } catch (e) {
      log(`  ${url.pathname}: ${e.message}`);
      if (!res.headersSent) return json(res, 500, { error: e.message });
      return res.end();
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const abs = path.join(WEB, path.normalize(file));
    if (!abs.startsWith(WEB) || !existsSync(abs) || !statSync(abs).isFile()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(abs));
  });

  setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 20000).unref();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  // The standard OTLP/HTTP port, so apps only need OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318.
  // Node resolves "localhost" to ::1 first, so listen on both loopback addresses.
  if (otlpPort) {
    const onRequest = (req, res) => {
      if (!handleOtlp(req, res, new URL(req.url, 'http://x').pathname)) { res.writeHead(404); res.end(); }
    };
    const hosts = host === '127.0.0.1' ? ['127.0.0.1', '::1'] : [host];
    for (const h of hosts) {
      await new Promise((resolve) => {
        const srv = http.createServer(onRequest);
        srv.once('error', (e) => {
          if (h === hosts[0]) log(`  OTLP port ${otlpPort} not available (${e.code}); spans still work on ${port}/v1/traces`);
          resolve();
        });
        srv.listen(otlpPort, h, () => { otlpListening = true; resolve(); });
      });
    }
    if (otlpListening) log(`  OpenTelemetry: send OTLP/HTTP to http://localhost:${otlpPort}`);
  }
  log(`  workspace ${ws.root}`);

  return {
    server,
    url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`,
    async close() {
      agents.stop();
      control.close();
      registry.off('change', warmFeeds);
      registry.close();
      for (const j of contexts.values()) (await j.catch(() => null))?.close();
      server.close();
    },
  };
}
