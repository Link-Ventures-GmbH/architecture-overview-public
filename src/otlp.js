// OTLP/HTTP trace intake without dependencies: decodes ExportTraceServiceRequest from
// protobuf (the SDK default) or JSON into flat span objects.

import { gunzipSync, inflateSync } from 'node:zlib';

export const KIND = { 0: 'unspecified', 1: 'internal', 2: 'server', 3: 'client', 4: 'producer', 5: 'consumer' };

// ---------- protobuf ----------

class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  done() { return this.pos >= this.buf.length; }
  varint() {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const b = this.buf[this.pos++];
      if (b === undefined) throw new Error('truncated varint');
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
    }
  }
  tag() { const t = Number(this.varint()); return [t >>> 3, t & 7]; }
  bytes() { const len = Number(this.varint()); const out = this.buf.subarray(this.pos, this.pos + len); this.pos += len; return out; }
  fixed64() { const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return v; }
  double() { const v = this.buf.readDoubleLE(this.pos); this.pos += 8; return v; }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }
}

function each(buf, fn) {
  const r = new Reader(buf);
  while (!r.done()) {
    const [field, wire] = r.tag();
    if (!fn(field, wire, r)) r.skip(wire);
  }
}

const str = (b) => b.toString('utf8');
const hex = (b) => b.toString('hex');

function anyValue(buf) {
  let v = null;
  each(buf, (f, w, r) => {
    if (f === 1 && w === 2) v = str(r.bytes());
    else if (f === 2 && w === 0) v = r.varint() !== 0n;
    else if (f === 3 && w === 0) v = Number(BigInt.asIntN(64, r.varint()));
    else if (f === 4 && w === 1) v = r.double();
    else if (f === 5 && w === 2) { v = []; each(r.bytes(), (f2, w2, r2) => (f2 === 1 && w2 === 2 ? (v.push(anyValue(r2.bytes())), true) : false)); }
    else if (f === 6 && w === 2) { v = {}; each(r.bytes(), (f2, w2, r2) => (f2 === 1 && w2 === 2 ? (Object.assign(v, keyValue(r2.bytes())), true) : false)); }
    else if (f === 7 && w === 2) v = hex(r.bytes());
    else return false;
    return true;
  });
  return v;
}

function keyValue(buf) {
  let key = '';
  let value = null;
  each(buf, (f, w, r) => {
    if (f === 1 && w === 2) key = str(r.bytes());
    else if (f === 2 && w === 2) value = anyValue(r.bytes());
    else return false;
    return true;
  });
  return { [key]: value };
}

function attrsFrom(list) {
  return Object.assign({}, ...list);
}

function pbSpan(buf) {
  const s = { attrs: [], status: 0 };
  each(buf, (f, w, r) => {
    if (f === 1 && w === 2) s.traceId = hex(r.bytes());
    else if (f === 2 && w === 2) s.spanId = hex(r.bytes());
    else if (f === 4 && w === 2) s.parentId = hex(r.bytes());
    else if (f === 5 && w === 2) s.name = str(r.bytes());
    else if (f === 6 && w === 0) s.kind = Number(r.varint());
    else if (f === 7 && w === 1) s.start = r.fixed64();
    else if (f === 8 && w === 1) s.end = r.fixed64();
    else if (f === 9 && w === 2) s.attrs.push(keyValue(r.bytes()));
    else if (f === 15 && w === 2) {
      each(r.bytes(), (f2, w2, r2) => {
        if (f2 === 3 && w2 === 0) s.status = Number(r2.varint());
        else if (f2 === 2 && w2 === 2) s.statusMessage = str(r2.bytes());
        else return false;
        return true;
      });
    } else return false;
    return true;
  });
  s.attrs = attrsFrom(s.attrs);
  return s;
}

function decodeProtobuf(buf) {
  const out = [];
  each(buf, (f, w, r) => {
    if (f !== 1 || w !== 2) return false;
    let resource = {};
    const scopes = [];
    each(r.bytes(), (f2, w2, r2) => {
      if (f2 === 1 && w2 === 2) {
        const list = [];
        each(r2.bytes(), (f3, w3, r3) => (f3 === 1 && w3 === 2 ? (list.push(keyValue(r3.bytes())), true) : false));
        resource = attrsFrom(list);
      } else if (f2 === 2 && w2 === 2) {
        const scope = { name: '', spans: [] };
        each(r2.bytes(), (f3, w3, r3) => {
          if (f3 === 1 && w3 === 2) each(r3.bytes(), (f4, w4, r4) => (f4 === 1 && w4 === 2 ? ((scope.name = str(r4.bytes())), true) : false));
          else if (f3 === 2 && w3 === 2) scope.spans.push(pbSpan(r3.bytes()));
          else return false;
          return true;
        });
        scopes.push(scope);
      } else return false;
      return true;
    });
    for (const sc of scopes) for (const s of sc.spans) out.push(finish(s, resource, sc.name));
    return true;
  });
  return out;
}

// ---------- JSON ----------

function jsonValue(v) {
  if (!v || typeof v !== 'object') return v ?? null;
  if ('stringValue' in v) return v.stringValue;
  if ('boolValue' in v) return v.boolValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(jsonValue);
  if ('kvlistValue' in v) return jsonAttrs(v.kvlistValue.values);
  if ('bytesValue' in v) return v.bytesValue;
  return null;
}
const jsonAttrs = (list = []) => Object.fromEntries(list.map((kv) => [kv.key, jsonValue(kv.value)]));
const KIND_NAMES = { SPAN_KIND_INTERNAL: 1, SPAN_KIND_SERVER: 2, SPAN_KIND_CLIENT: 3, SPAN_KIND_PRODUCER: 4, SPAN_KIND_CONSUMER: 5 };
// JSON ids are hex by spec, but some exporters send base64.
const jsonId = (id) => (!id ? undefined : /^[0-9a-f]+$/i.test(id) ? id.toLowerCase() : Buffer.from(id, 'base64').toString('hex'));

function decodeJson(text) {
  const body = JSON.parse(text);
  const out = [];
  for (const rs of body.resourceSpans || []) {
    const resource = jsonAttrs(rs.resource?.attributes);
    for (const ss of rs.scopeSpans || rs.instrumentationLibrarySpans || []) {
      for (const sp of ss.spans || []) {
        out.push(finish({
          traceId: jsonId(sp.traceId), spanId: jsonId(sp.spanId), parentId: jsonId(sp.parentSpanId),
          name: sp.name, kind: typeof sp.kind === 'string' ? KIND_NAMES[sp.kind] || 0 : sp.kind || 0,
          start: BigInt(sp.startTimeUnixNano || 0), end: BigInt(sp.endTimeUnixNano || 0),
          attrs: jsonAttrs(sp.attributes),
          status: typeof sp.status?.code === 'string' ? (sp.status.code.endsWith('ERROR') ? 2 : sp.status.code.endsWith('OK') ? 1 : 0) : sp.status?.code || 0,
          statusMessage: sp.status?.message,
        }, resource, ss.scope?.name || ''));
      }
    }
  }
  return out;
}

// ---------- shared ----------

function finish(s, resource, scope) {
  const start = Number(s.start || 0n) / 1e6;
  const end = Number(s.end || 0n) / 1e6;
  const status = Number(s.attrs['http.response.status_code'] ?? s.attrs['http.status_code'] ?? 0);
  return {
    traceId: s.traceId || '',
    spanId: s.spanId || '',
    parentId: s.parentId && !/^0*$/.test(s.parentId) ? s.parentId : null,
    name: s.name || '',
    kind: s.kind || 0,
    start,
    dur: Math.max(0, end - start),
    error: s.status === 2 || (s.kind === 2 && status >= 500),
    statusMessage: s.statusMessage || '',
    attrs: s.attrs,
    service: resource['service.name'] || 'unknown',
    projectDir: resource['project.dir'] || null,
    scope,
  };
}

/** Decodes a request body. Throws on garbage so the caller can answer 400. */
export function decodeTraces(body, contentType = '', encoding = '') {
  let buf = body;
  if (/gzip/i.test(encoding)) buf = gunzipSync(buf);
  else if (/deflate/i.test(encoding)) buf = inflateSync(buf);
  if (/json/i.test(contentType)) return decodeJson(buf.toString('utf8'));
  return decodeProtobuf(buf);
}
