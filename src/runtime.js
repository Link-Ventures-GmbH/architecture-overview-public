// Maps OpenTelemetry spans onto source files, so the map can show the running system.
// Order of trust: code.* attributes, the HTTP route, the host of an outgoing call,
// the database driver, then the span name as a function name. Spans that still have no
// file inherit their parent's on the client.

import { isTestPath } from './lang.js';

const ROUTE_CALL = /\.(?:get|post|put|patch|delete|all|options|head|route|on)\(\s*['"`](\/[^'"`\s]*)['"`]/g;
const URL_LITERAL = /['"`](https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?[^'"`\s]*)/gi;
const BORING_HOSTS = /(^|\.)(localhost|example\.(com|org)|w3\.org|schema\.org|googleapis\.com|gstatic\.com|github\.com|npmjs\.(com|org)|unpkg\.com|jsdelivr\.net|cdnjs\.cloudflare\.com|mozilla\.org|wikipedia\.org)$/i;
const DB_PACKAGES = /^(better-sqlite3|sqlite3|node:sqlite|bun:sqlite|pg|postgres|mysql2?|mongodb|mongoose|redis|ioredis|@prisma\/client|drizzle-orm.*|knex|kysely|pocketbase|typeorm|sequelize|@libsql\/client|database\/sql|github\.com\/mattn\/go-sqlite3|github\.com\/jackc\/pgx.*|gorm\.io\/.*|sqlite3|psycopg2?|sqlalchemy.*|asyncpg)$/;

/** Turns a route pattern from Hono/Express/Fastify or a file-based route into a regex. */
export function routeRegex(pattern) {
  const parts = pattern.split('/').filter(Boolean).filter((p) => !/^\(.*\)$/.test(p));
  let statics = 0;
  const re = parts.map((p) => {
    if (p === '*' || p === '**' || /^\[\.\.\..*\]$/.test(p) || /^\[\[\.\.\..*\]\]$/.test(p)) return '.*';
    if (/^:/.test(p) || /^\[.*\]$/.test(p) || /^\{.*\}$/.test(p)) return '[^/]+';
    statics++;
    return p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  });
  return { re: new RegExp(`^/${re.join('/')}/?$`), statics, segments: parts.length };
}

/** Route of a file-based router (SvelteKit, Next, Nuxt), or null. */
export function fileRoute(rel) {
  const m = rel.match(/(?:^|\/)(?:routes|pages|app)\/(.*?)(?:\/)?(\+page(?:\.server)?|\+server|page|route|index)?\.[a-z.]+$/);
  if (!m || (!m[2] && !/(^|\/)pages\//.test(rel))) return null;
  const route = '/' + m[1].split('/').filter((s) => s && !/^\+/.test(s)).join('/');
  return route.replace(/\/index$/, '') || '/';
}

export class SpanMapper {
  constructor(project) {
    this.project = project;
    this.rebuild();
  }

  rebuild() {
    this.routes = [];
    this.hosts = new Map();
    this.symbols = new Map();
    this.dbFiles = [];
    for (const f of this.project.files.values()) {
      if (isTestPath(f.rel)) continue;
      for (const m of f.text.matchAll(ROUTE_CALL)) {
        const raw = m[1].replace(/\{[^}]*\}/g, '');
        if (raw.length > 1 || raw === '/') this.routes.push({ raw, file: f.rel, ...routeRegex(raw) });
      }
      const fr = fileRoute(f.rel);
      if (fr) this.routes.push({ raw: fr, file: f.rel, ...routeRegex(fr) });
      for (const m of f.text.matchAll(URL_LITERAL)) {
        const host = m[2].toLowerCase();
        if (BORING_HOSTS.test(host)) continue;
        if (!this.hosts.has(host)) this.hosts.set(host, new Map());
        const counts = this.hosts.get(host);
        counts.set(f.rel, (counts.get(f.rel) || 0) + 1);
      }
      for (const s of f.symbols) {
        const key = s.name.includes('.') ? s.name.split('.').pop() : s.name;
        if (!this.symbols.has(key)) this.symbols.set(key, []);
        this.symbols.get(key).push(f.rel);
      }
      if (f.specs.some((spec) => DB_PACKAGES.test(spec))) this.dbFiles.push(f.rel);
    }
    // Most specific first: more static segments, then longer patterns.
    this.routes.sort((a, b) => b.statics - a.statics || b.segments - a.segments || b.raw.length - a.raw.length);
    this.cache = new Map();
  }

  byPath(p) {
    if (!p) return null;
    let rel = String(p).replace(/^file:\/\//, '');
    if (rel.startsWith(this.project.root + '/')) rel = rel.slice(this.project.root.length + 1);
    rel = rel.replace(/^\.\//, '');
    if (this.project.files.has(rel)) return rel;
    // Compiled output: dist/x.js -> src/x.ts and the like, matched by the tail of the path.
    const tail = rel.replace(/\.(m?js|cjs)$/, '').split('/').slice(-2).join('/');
    for (const f of this.project.files.keys()) if (f.replace(/\.[^.]+$/, '').endsWith(tail)) return f;
    return null;
  }

  byRoute(route) {
    if (!route) return null;
    const p = route.split('?')[0];
    const exact = this.routes.find((r) => r.raw === p);
    if (exact) return exact.file;
    const hit = this.routes.find((r) => r.re.test(p));
    return hit ? hit.file : null;
  }

  byHost(host) {
    if (!host) return null;
    host = host.toLowerCase();
    let counts = this.hosts.get(host);
    if (!counts) {
      // api.example.org may appear in code as example.org and the other way round.
      for (const [h, c] of this.hosts) if (h.endsWith('.' + host) || host.endsWith('.' + h)) { counts = c; break; }
    }
    if (!counts) return null;
    return [...counts].sort((a, b) => b[1] - a[1])[0][0];
  }

  bySymbol(name) {
    if (!name) return null;
    const key = String(name).split(/[.#:]/).pop();
    const files = this.symbols.get(key);
    return files?.length ? files[0] : null;
  }

  /** File that spells the name as a string literal, e.g. where a tool or job is registered. */
  byLiteral(name) {
    if (!name || name.length < 4 || /\s/.test(name)) return null;
    const needles = [`'${name}'`, `"${name}"`, `\`${name}\``];
    // App code beats scripts; more mentions beat fewer.
    const tooling = (rel) => /(^|\/)(scripts?|tools|bin|examples?|docs?)\//.test(rel);
    let best = null;
    for (const f of this.project.files.values()) {
      if (isTestPath(f.rel)) continue;
      const hits = needles.reduce((n, x) => n + f.text.split(x).length - 1, 0);
      if (!hits) continue;
      const score = [tooling(f.rel) ? 0 : 1, hits];
      if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && score[1] > best.score[1])) best = { rel: f.rel, score };
    }
    return best ? best.rel : null;
  }

  /** Returns { file, via, label } for a span. `label` is what the UI shows as the target. */
  map(span) {
    const a = span.attrs;
    const route = a['http.route'] || a['url.template'] || null;
    const urlPath = a['url.path'] || (typeof a['http.target'] === 'string' ? a['http.target'] : null);
    const nameRoute = (span.name.match(/^[A-Z]+ (\/\S*)$/) || [])[1] || null;
    let host = a['server.address'] || a['net.peer.name'] || a['http.host'] || null;
    const full = a['url.full'] || a['http.url'];
    if (!host && typeof full === 'string') { try { host = new URL(full).hostname; } catch { /* not a url */ } }
    const key = [span.kind, span.name, route, urlPath, host, a['code.file.path'] || a['code.filepath'], a['code.function.name'] || a['code.function'], a['db.system'] || a['db.system.name']].join('|');
    if (this.cache.has(key)) return this.cache.get(key);

    let res = null;
    const file = this.byPath(a['code.file.path'] || a['code.filepath']);
    if (file) res = { file, via: 'code' };
    if (!res) {
      const fn = this.bySymbol(a['code.function.name'] || a['code.function']);
      if (fn) res = { file: fn, via: 'code' };
    }
    if (!res && span.kind !== 3) {
      const r = this.byRoute(route) || this.byRoute(urlPath) || this.byRoute(nameRoute);
      if (r) res = { file: r, via: 'route' };
    }
    if (!res && host && span.kind === 3) {
      const h = this.byHost(host);
      if (h) res = { file: h, via: 'host' };
    }
    if (!res && (a['db.system'] || a['db.system.name']) && this.dbFiles.length) res = { file: this.dbFiles[0], via: 'db' };
    if (!res) {
      const s = this.bySymbol(span.name) || this.byLiteral(span.name);
      if (s) res = { file: s, via: 'name' };
    }
    // Outgoing calls are named by where they go, incoming ones by their route.
    const label = span.kind === 3 && host ? host : route || nameRoute || urlPath || span.name;
    res = { file: res?.file || null, via: res?.via || null, label };
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(key, res);
    return res;
  }
}

/** The compact span the browser receives. */
export function wireSpan(span, mapped) {
  return {
    tr: span.traceId.slice(0, 16),
    id: span.spanId,
    p: span.parentId,
    n: span.name,
    k: span.kind,
    st: Math.round(span.start * 1000) / 1000,
    d: Math.round(span.dur * 100) / 100,
    e: span.error ? 1 : 0,
    em: span.error ? span.statusMessage || String(span.attrs['http.response.status_code'] ?? span.attrs['http.status_code'] ?? '') : undefined,
    svc: span.service,
    f: mapped.file,
    v: mapped.via,
    l: mapped.label,
  };
}

