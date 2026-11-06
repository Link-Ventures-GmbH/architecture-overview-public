// Where on earth is a host? Three ways, best first:
//   known  - organisations whose seat we know (World Bank, OECD, ...)
//   tld    - the country code of the domain (.de, .fr, .jp)
//   ip     - the country of the server's IP (DB-IP Lite). This is where the server stands,
//            which can be a network node of a hosting or CDN provider, not the organisation.
//   cdn    - the IP belongs to a known CDN, so it is certainly a network node.
// IP geolocation by DB-IP (https://db-ip.com), CC BY 4.0.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { lookup } from 'node:dns/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GEO_DIR = path.join(os.homedir(), '.linklabs', 'architecture-overview', 'geo');
const DBIP_FILE = path.join(GEO_DIR, 'dbip-country-lite.csv.gz');
export const COUNTRIES = JSON.parse(readFileSync(path.join(HERE, 'data', 'countries.json'), 'utf8'));
COUNTRIES.EU = [50.85, 4.35, 'European Union'];

// Country codes that are sold as generic names and say nothing about a place.
const VANITY = new Set(['io', 'co', 'ai', 'tv', 'me', 'ly', 'fm', 'gg', 'to', 'cc', 'ws', 'sh', 'so', 'gl', 'im', 'is', 'la', 'nu', 'vc', 'tk', 'ml', 'ga', 'cf', 'gq', 'ac', 'sc', 'st', 'xyz']);

// Organisations whose seat is better known than their servers.
const KNOWN = {
  'worldbank.org': 'US', 'imf.org': 'US', 'oecd.org': 'FR', 'bis.org': 'CH', 'ilo.org': 'CH', 'who.int': 'CH',
  'un.org': 'US', 'wto.org': 'CH', 'gleif.org': 'CH', 'ecb.europa.eu': 'DE', 'esma.europa.eu': 'FR',
  'europa.eu': 'EU', 'eurostat.ec.europa.eu': 'LU', 'ted.europa.eu': 'LU', 'gbif.org': 'DK', 'openalex.org': 'US',
  'wikipedia.org': 'US', 'github.com': 'US', 'arxiv.org': 'US', 'nature.com': 'GB', 'sciencedirect.com': 'NL',
};

// Published CDN ranges (Cloudflare, Fastly). Hits here are network nodes by definition.
const CDN_V4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22', '151.101.0.0/16', '199.232.0.0/16', '146.75.0.0/17', '23.235.32.0/20', '199.27.72.0/21'];

const ipNum = (ip) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
const CDN_RANGES = CDN_V4.map((cidr) => {
  const [ip, bits] = cidr.split('/');
  const start = ipNum(ip);
  return [start, start + 2 ** (32 - Number(bits)) - 1];
});
const inCdn = (n) => CDN_RANGES.some(([a, b]) => n >= a && n <= b);

let db = null;

/** Loads the DB-IP ranges (IPv4 only), downloading the monthly file once if needed. */
export async function loadDbip({ log = () => {} } = {}) {
  if (db) return db;
  if (!existsSync(DBIP_FILE)) {
    mkdirSync(GEO_DIR, { recursive: true });
    const d = new Date();
    for (let back = 0; back < 3 && !existsSync(DBIP_FILE); back++) {
      const m = new Date(d.getFullYear(), d.getMonth() - back, 1);
      const url = `https://download.db-ip.com/free/dbip-country-lite-${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}.csv.gz`;
      try {
        const res = await fetch(url);
        if (res.ok) { writeFileSync(DBIP_FILE, Buffer.from(await res.arrayBuffer())); log(`  geo: downloaded ${url}`); }
      } catch { /* offline: fall back to known hosts and domain endings */ }
    }
    if (!existsSync(DBIP_FILE)) return null;
  }
  const lines = gunzipSync(readFileSync(DBIP_FILE)).toString('latin1').split('\n');
  const starts = new Float64Array(lines.length);
  const ends = new Float64Array(lines.length);
  const codes = [];
  let n = 0;
  for (const line of lines) {
    if (!line || line.includes(':')) continue; // IPv6 rows
    const [a, b, cc] = line.split(',');
    starts[n] = ipNum(a);
    ends[n] = ipNum(b);
    codes[n] = cc;
    n++;
  }
  db = { starts: starts.subarray(0, n), ends: ends.subarray(0, n), codes, size: n };
  return db;
}

export function countryOfIp(ip) {
  if (!db) return null;
  const x = ipNum(ip);
  let lo = 0;
  let hi = db.size - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (db.starts[mid] > x) hi = mid - 1;
    else if (db.ends[mid] < x) lo = mid + 1;
    else return db.codes[mid] === 'ZZ' ? null : db.codes[mid];
  }
  return null;
}

/** Country from the host name alone: known organisation, then domain ending. */
export function countryOfHost(host) {
  const h = host.toLowerCase().replace(/^www\./, '');
  for (const [domain, cc] of Object.entries(KNOWN)) {
    if (h === domain || h.endsWith('.' + domain)) return { cc, precision: 'known' };
  }
  const tld = h.split('.').pop();
  if (tld === 'uk') return { cc: 'GB', precision: 'tld' };
  if (tld === 'eu') return { cc: 'EU', precision: 'tld' };
  if (tld.length === 2 && !VANITY.has(tld) && COUNTRIES[tld.toUpperCase()]) return { cc: tld.toUpperCase(), precision: 'tld' };
  return null;
}

const cache = new Map();
// A big research run touches thousands of hosts; resolve a few at a time.
const MAX_DNS = 12;
let inFlight = 0;
const waiting = [];
async function resolve4(host) {
  if (inFlight >= MAX_DNS) await new Promise((r) => waiting.push(r));
  inFlight++;
  try { return (await lookup(host, { family: 4 })).address; } finally { inFlight--; waiting.shift()?.(); }
}

/**
 * Locates a host. Resolves to { cc, name, lat, lng, precision } or null.
 * Results are cached; DNS goes through the system resolver as any request would.
 */
export async function locate(host) {
  if (!host) return null;
  if (cache.has(host)) return cache.get(host);
  const job = (async () => {
    let hit = countryOfHost(host);
    if (!hit && db) {
      try {
        const address = await resolve4(host);
        const cc = countryOfIp(address);
        if (cc) hit = { cc, precision: inCdn(ipNum(address)) ? 'cdn' : 'ip' };
      } catch { /* host does not resolve */ }
    }
    if (!hit || !COUNTRIES[hit.cc]) return null;
    const [lat, lng, name] = COUNTRIES[hit.cc];
    return { cc: hit.cc, name, lat, lng, precision: hit.precision };
  })();
  cache.set(host, job);
  return job;
}
