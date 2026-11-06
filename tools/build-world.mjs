// Builds the two small geo files the Agents view ships with:
//   src/data/countries.json  ISO alpha-2 -> [lat, lng, name]   (from world-countries, ODbL)
//   web/world-dots.json      land dots for the dot-matrix map  (from Natural Earth via world-atlas, public domain)
//
// node tools/build-world.mjs <countries.json> <land-110m.json>
// Sources: https://cdn.jsdelivr.net/npm/world-countries@5.1.0/countries.json
//          https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [countriesFile, landFile] = process.argv.slice(2);
if (!countriesFile || !landFile) {
  console.error('usage: node tools/build-world.mjs <countries.json> <land-110m.json>');
  process.exit(1);
}

// ---- countries ----
const countries = {};
for (const c of JSON.parse(readFileSync(countriesFile, 'utf8'))) {
  if (!c.cca2 || !c.latlng?.length) continue;
  countries[c.cca2] = [c.latlng[0], c.latlng[1], c.name.common];
}
mkdirSync(path.join(ROOT, 'src/data'), { recursive: true });
writeFileSync(path.join(ROOT, 'src/data/countries.json'), JSON.stringify(countries));

// ---- land polygons from TopoJSON ----
const topo = JSON.parse(readFileSync(landFile, 'utf8'));
const { scale, translate } = topo.transform;
const arcs = topo.arcs.map((arc) => {
  let x = 0;
  let y = 0;
  return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * scale[0] + translate[0], y * scale[1] + translate[1]]; });
});
const ring = (ids) => ids.flatMap((i, n) => {
  const pts = i >= 0 ? arcs[i] : [...arcs[~i]].reverse();
  return n ? pts.slice(1) : pts;
});
const polygons = [];
const collect = (g) => {
  if (g.type === 'GeometryCollection') g.geometries.forEach(collect);
  else if (g.type === 'Polygon') polygons.push(g.arcs.map(ring));
  else if (g.type === 'MultiPolygon') g.arcs.forEach((p) => polygons.push(p.map(ring)));
};
collect(topo.objects.land);

const inRing = (lng, lat, r) => {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i];
    const [xj, yj] = r[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const onLand = (lng, lat) => polygons.some(([outer, ...holes]) => inRing(lng, lat, outer) && !holes.some((h) => inRing(lng, lat, h)));

// Equirectangular grid, Antarctica cut off. Dots store grid indices to stay small.
const STEP = 2;
const LAT_MAX = 80;
const LAT_MIN = -58;
const dots = [];
for (let lat = LAT_MAX - STEP / 2; lat > LAT_MIN; lat -= STEP) {
  for (let lng = -180 + STEP / 2; lng < 180; lng += STEP) {
    if (onLand(lng, lat)) dots.push([Math.round((lng + 180) / STEP - 0.5), Math.round((LAT_MAX - lat) / STEP - 0.5)]);
  }
}
writeFileSync(path.join(ROOT, 'web/world-dots.json'), JSON.stringify({ step: STEP, latMax: LAT_MAX, latMin: LAT_MIN, dots }));
console.log(`${Object.keys(countries).length} countries, ${dots.length} land dots`);
