// Evals overview: what a set of runs says about the project as a whole. Coverage map (one tile
// per field: how much the project covers), the funnel covered → found → used → answered, and
// the comparison of variants (e.g. tools only, web only, both) per field and criterion.

const COV = ['full', 'gateway', 'partial', 'none'];
const COV_NAME = { full: 'Full', gateway: 'Gateway', partial: 'Partial', none: 'None' };
const ARM_ORDER = ['kn', 'kn+web', 'web', 'tie'];
const CRITERIA = ['correctness', 'verifiability', 'licence_clarity', 'honesty', 'usefulness'];
const CRIT_NAME = { correctness: 'Correct', verifiability: 'Verifiable', licence_clarity: 'Licence', honesty: 'Honest', usefulness: 'Useful' };
const STATUS = ['answered', 'partial', 'unbacked', 'honest_gap', 'wrong', 'platform_error', 'model_error'];
const STATUS_NAME = { answered: 'Answered', partial: 'Partial', unbacked: 'Unbacked', honest_gap: 'Honest gap', wrong: 'Wrong', platform_error: 'Platform error', model_error: 'Model error' };
const BACKING = ['receipted', 'cited', 'mixed', 'unbacked', 'none'];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const short = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const armClass = (a) => String(a).replace('+', 'p');

/** A stacked bar from { key: count } in a fixed key order, widths set after insertion via data-w. */
function stack(counts, keys, cls, names) {
  const total = keys.reduce((s, k) => s + num(counts?.[k]), 0);
  if (!total) return '<span class="ev-stack empty"></span>';
  return `<span class="ev-stack">${keys.filter((k) => num(counts[k])).map((k) => `<i class="${cls}-${armClass(k)}" data-w="${((num(counts[k]) / total) * 100).toFixed(2)}" title="${esc(names?.[k] || k)} ${counts[k]} (${pct(counts[k], total)} %)"></i>`).join('')}</span>`;
}
const legend = (keys, cls, names) => `<div class="ev-legend">${keys.map((k) => `<span><i class="${cls}-${armClass(k)}"></i>${esc(names?.[k] || k)}</span>`).join('')}</div>`;

/** Just enough Markdown for reports: headings, lists, tables, bold, code, links. */
export function markdown(md) {
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let list = false;
  let table = null;
  const flush = () => {
    if (list) { out.push('</ul>'); list = false; }
    if (table) {
      const rows = table.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r)).map((r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim())));
      out.push(`<table class="ev-md-table">${rows.map((r, i) => `<tr>${r.map((c) => (i ? `<td>${c}</td>` : `<th>${c}</th>`)).join('')}</tr>`).join('')}</table>`);
      table = null;
    }
  };
  for (const line of String(md || '').split('\n')) {
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (line.trim().startsWith('|')) { if (list) { out.push('</ul>'); list = false; } (table ??= []).push(line); continue; }
    if (table) flush();
    if (h) { flush(); out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`); continue; }
    const li = line.match(/^\s*[-*]\s+(.*)/);
    if (li) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    flush();
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  flush();
  return out.join('');
}

export function createEvalsOverview({ projectQuery = () => '', openPanel }) {
  const st = { runs: [], set: null, data: null, compares: [], cmp: null, cmpName: null };
  const api = (p, q = '') => fetch(`/api/evals/${p}${projectQuery()}${q ? (projectQuery() ? '&' : '?') + q : ''}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const widths = (root) => { for (const i of root.querySelectorAll('[data-w]')) i.style.width = `${i.dataset.w}%`; };

  // ---------- run sets ----------

  /** Blocks (runs sharing a prefix) first, then single runs; only runs with coverage or a funnel. */
  function sets() {
    const usable = st.runs.filter((r) => r.funnel || r.coverage);
    const groups = new Map();
    for (const r of usable) if (r.group) (groups.get(r.group) || groups.set(r.group, []).get(r.group)).push(r);
    const out = [];
    for (const [g, rs] of groups) if (rs.length > 1) out.push({ key: `group:${g}`, label: `Block ${g}`, sub: `${rs.length} runs`, ids: rs.map((r) => r.id).sort() });
    for (const r of usable) out.push({ key: r.id, label: r.id, sub: r.state || '', ids: [r.id] });
    return out;
  }

  async function showCoverage(runs) {
    st.runs = runs || st.runs;
    const all = sets();
    if (!st.set || !all.some((s) => s.key === st.set)) st.set = all[0]?.key || null;
    $('ev-sets').innerHTML = all.map((s) => `<button class="ev-set${s.key === st.set ? ' on' : ''}" data-set="${esc(s.key)}"><b>${esc(s.label)}</b><small>${esc(s.sub)}</small></button>`).join('')
      || '<span class="ev-none">No run with coverage data yet (coverage.jsonl, funnel.json)</span>';
    const cur = all.find((s) => s.key === st.set);
    if (!cur) { $('ev-funnel').innerHTML = ''; $('ev-covbars').innerHTML = ''; $('ev-map').innerHTML = ''; return; }
    st.data = await api('overview', `runs=${encodeURIComponent(cur.ids.join(','))}`);
    renderCoverage(cur);
  }

  function renderCoverage(cur) {
    const d = st.data;
    if (!d) return;
    const t = d.total;
    const fields = Object.keys(d.by_field).sort((a, b) => a.localeCompare(b));
    $('ev-cov-meta').textContent = `${d.runs.length} run${d.runs.length === 1 ? '' : 's'} · ${d.questions} questions · ${fields.length} fields · ${t.runs} answers`;

    const stage = (label, v, base, extra = '', note = '') => `<div class="ev-fn-row"><span class="ev-fn-label">${label}</span>`
      + `<span class="ev-fn-track"><i class="ev-fn-bar" data-w="${base ? ((v / base) * 100).toFixed(1) : 0}"></i>${extra}</span>`
      + `<span class="ev-fn-n"><b>${v}</b> ${pct(v, base)} %</span>${note ? `<span class="ev-fn-note">${note}</span>` : ''}</div>`;
    const ans = t.answered + t.partial;
    $('ev-funnel').innerHTML = `<span class="eyebrow">Funnel · of ${t.runs} answers</span>`
      + stage('Covered', t.covered, t.runs, '', 'the project has the data')
      + stage('Found', t.found, t.runs, '', 'the model found it')
      + stage('Used', t.used, t.runs, '', 'and fetched it')
      + `<div class="ev-fn-row"><span class="ev-fn-label">Answered</span><span class="ev-fn-track"><i class="ev-fn-bar ans" data-w="${pct(t.answered, t.runs)}"></i><i class="ev-fn-bar part" data-w="${pct(t.partial, t.runs)}"></i></span>`
      + `<span class="ev-fn-n"><b>${ans}</b> ${pct(ans, t.runs)} %</span><span class="ev-fn-note">${t.answered} full · ${t.partial} partial</span></div>`;

    const c = d.coverage;
    const best = Object.entries(c.best_category || {}).map(([k, v]) => `${k.replace('_', ' ')} ${v}`).join(' · ');
    $('ev-covbars').innerHTML = `<div class="ev-cb"><span class="eyebrow">Coverage · ${d.questions} questions</span>${stack(c, COV, 'c', COV_NAME)}${legend(COV, 'c', COV_NAME)}`
      + `<div class="ag-note">${best ? `Best place: ${esc(best)}` : ''}${c.none_paid_likely ? ` · ${c.none_paid_likely} of the uncovered likely paid data` : ''}</div></div>`
      + `<div class="ev-cb"><span class="eyebrow">Outcome · answers</span>${stack(d.status, STATUS, 'o', STATUS_NAME)}${legend(STATUS.filter((k) => d.status[k]), 'o', STATUS_NAME)}</div>`
      + `<div class="ev-cb"><span class="eyebrow">Backing</span>${stack(d.axes.backing, BACKING, 'b')}${legend(BACKING.filter((k) => d.axes.backing[k]), 'b')}</div>`;

    // one tile per field, tinted by how much is covered
    $('ev-map').innerHTML = fields.map((f) => {
      const fd = d.by_field[f];
      const n = COV.reduce((s, k) => s + fd.cov[k], 0);
      const score = n ? (fd.cov.full + fd.cov.gateway * 0.6 + fd.cov.partial * 0.4) / n : 0;
      const fn = fd.funnel;
      return `<button class="ev-tile" data-field="${esc(f)}" data-score="${score.toFixed(2)}" title="${esc(f)}">`
        + `<span class="ev-tile-name">${esc(short(f, 44))}</span>`
        + `<span class="ev-tile-n">${n ? `${fd.cov.full + fd.cov.gateway + fd.cov.partial}/${n} covered` : 'no coverage data'}</span>`
        + `${stack(fd.cov, COV, 'c', COV_NAME)}`
        + `<span class="ev-tile-fn">${fn.runs ? `found ${fn.found} · used ${fn.used} · answered ${fn.answered + fn.partial} of ${fn.runs}` : ''}</span></button>`;
    }).join('') || '<span class="ev-none">No fields</span>';
    for (const tile of $('ev-map').querySelectorAll('.ev-tile')) {
      const s = Number(tile.dataset.score);
      // none → coral, gateway-ish → amber, full → mint
      const hue = s < 0.5 ? 350 + s * 2 * 50 : 40 + (s - 0.5) * 2 * 115;
      tile.style.setProperty('--tint', `hsl(${hue % 360} 85% 62%)`);
    }
    widths($('ev-cov'));
  }

  function openField(name) {
    const fd = st.data?.by_field[name];
    if (!fd) return;
    const order = { none: 0, partial: 1, gateway: 2, full: 3 };
    const qs = [...fd.questions].sort((a, b) => order[a.coverage] - order[b.coverage]);
    openPanel(`<span class="eyebrow">Field</span><h3>${esc(name)}</h3>`
      + `<div class="ev-trace-sub">${qs.length} questions · ${COV.map((k) => `${COV_NAME[k]} ${fd.cov[k]}`).join(' · ')}</div>`
      + `<ol class="ev-fq">${qs.map((q) => `<li><span class="ev-cov-chip c-${q.coverage}">${COV_NAME[q.coverage]}</span><div>`
        + `<b>${esc(q.question || q.question_id)}</b>`
        + (q.missing ? `<p><span class="ev-k">Missing</span>${esc(q.missing)}</p>` : '')
        + (q.why ? `<p class="dim"><span class="ev-k">Why</span>${esc(q.why)}</p>` : '')
        + `<small>${esc(q.question_id)}${q.type ? ` · ${esc(q.type)}` : ''}${q.best_category ? ` · ${esc(q.best_category.replace('_', ' '))}` : ''}${q.paid_likely ? ' · likely paid data' : ''} · ${esc(q.run)}</small></div></li>`).join('')}</ol>`);
  }

  $('ev-sets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-set]');
    if (!b) return;
    st.set = b.dataset.set;
    showCoverage();
  });
  $('ev-map').addEventListener('click', (e) => {
    const t = e.target.closest('[data-field]');
    if (t) openField(t.dataset.field);
  });

  // ---------- variants ----------

  async function showCompare() {
    st.compares = (await api('compares')) || [];
    if (!st.cmpName || !st.compares.some((c) => c.name === st.cmpName)) st.cmpName = st.compares[0]?.name || null;
    $('ev-cmp-pick').innerHTML = st.compares.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('') || '<option>No comparison yet</option>';
    $('ev-cmp-pick').value = st.cmpName || '';
    st.cmp = st.cmpName ? await api('compare', `id=${encodeURIComponent(st.cmpName)}`) : null;
    renderCompare();
  }

  function summarize(rows) {
    const arms = [...new Set(rows.flatMap((r) => Object.keys(r.scores || r.arms || {})))].sort((a, b) => ARM_ORDER.indexOf(a) - ARM_ORDER.indexOf(b));
    const wins = {};
    const scores = {};
    const extra = {};
    for (const r of rows) {
      wins[r.best] = (wins[r.best] || 0) + 1;
      for (const a of arms) {
        for (const k of CRITERIA) {
          const v = r.scores?.[a]?.[k];
          if (v == null) continue;
          const s = ((scores[a] ??= {})[k] ??= { sum: 0, n: 0 });
          s.sum += num(v); s.n++;
        }
        const ar = r.arms?.[a];
        if (ar) { const e = (extra[a] ??= { cost: 0, lat: 0, n: 0 }); e.cost += num(ar.cost_usd); e.lat += num(ar.latency_ms); e.n++; }
      }
    }
    const avg = (a, k) => (scores[a]?.[k]?.n ? scores[a][k].sum / scores[a][k].n : null);
    return { arms, wins, avg, extra, n: rows.length };
  }

  function criteriaChart(sum, big = false) {
    return `<div class="ev-crit${big ? ' big' : ''}">${CRITERIA.map((k) => `<div class="ev-crit-g"><div class="ev-crit-bars">${sum.arms.map((a) => {
      const v = sum.avg(a, k);
      return `<i class="a-${armClass(a)}" data-h="${v == null ? 0 : (v / 5) * 100}" title="${esc(a)} · ${CRIT_NAME[k]} ${v == null ? '–' : v.toFixed(1)} / 5"></i>`;
    }).join('')}</div><span>${CRIT_NAME[k]}</span></div>`).join('')}</div>`;
  }

  function renderCompare() {
    const rows = st.cmp?.rows || [];
    $('ev-cmp-report').hidden = !st.cmp?.report;
    if (!rows.length) { $('ev-cmp-sum').innerHTML = '<span class="ev-none">No comparison data yet (compare/&lt;name&gt;.jsonl)</span>'; $('ev-cmp-fields').innerHTML = ''; return; }
    const sum = summarize(rows);
    const armsAndTie = [...sum.arms, 'tie'];
    $('ev-cmp-meta').textContent = `${rows.length} questions · ${new Set(rows.map((r) => r.field)).size} fields · variants ${sum.arms.join(', ')}`;
    $('ev-cmp-sum').innerHTML = `<div class="ev-cmp-wins"><span class="eyebrow">Win rate</span>`
      + armsAndTie.map((a) => `<div class="ev-win-row"><span class="ev-arm a-${armClass(a)}">${esc(a)}</span><span class="ev-fn-track"><i class="ev-fn-bar a-${armClass(a)}" data-w="${pct(sum.wins[a] || 0, sum.n)}"></i></span><span class="ev-fn-n"><b>${sum.wins[a] || 0}</b> ${pct(sum.wins[a] || 0, sum.n)} %</span>`
        + (sum.extra[a] ? `<span class="ev-fn-note">⌀ $${(sum.extra[a].cost / sum.extra[a].n).toFixed(3)} · ${Math.round(sum.extra[a].lat / sum.extra[a].n / 1000)} s</span>` : '<span></span>') + '</div>').join('')
      + `</div><div class="ev-cmp-crit"><span class="eyebrow">Grades per criterion · 1–5</span>${criteriaChart(sum, true)}${legend(sum.arms, 'a')}</div>`;
    const byField = new Map();
    for (const r of rows) (byField.get(r.field) || byField.set(r.field, []).get(r.field)).push(r);
    $('ev-cmp-fields').innerHTML = [...byField].sort((a, b) => a[0].localeCompare(b[0])).map(([f, rs]) => {
      const s = summarize(rs);
      return `<div class="ev-cmp-card" data-field="${esc(f)}"><div class="ev-cmp-card-head"><b title="${esc(f)}">${esc(short(f, 40))}</b><small>${rs.length} q</small></div>`
        + stack(s.wins, armsAndTie, 'a') + criteriaChart(s) + '</div>';
    }).join('');
    widths($('ev-cmp'));
    for (const i of $('ev-cmp').querySelectorAll('[data-h]')) i.style.height = `${Math.max(2, Number(i.dataset.h))}%`;
  }

  function openCompareField(name) {
    const rows = (st.cmp?.rows || []).filter((r) => r.field === name);
    openPanel(`<span class="eyebrow">Variants · ${esc(st.cmpName)}</span><h3>${esc(name)}</h3>`
      + `<ol class="ev-fq">${rows.map((r) => `<li><span class="ev-arm a-${armClass(r.best)}">${esc(r.best)}</span><div><b>${esc(r.question || r.question_id)}</b>`
        + `<p>${esc(r.why || '')}</p><small>${Object.entries(r.arms || {}).map(([a, v]) => `${esc(a)}: ${esc(v.status)} · ${esc(v.backing || '')} · $${num(v.cost_usd).toFixed(3)}`).join('  |  ')}</small></div></li>`).join('')}</ol>`);
  }

  $('ev-cmp-pick').addEventListener('change', async (e) => {
    st.cmpName = e.target.value;
    st.cmp = await api('compare', `id=${encodeURIComponent(st.cmpName)}`);
    renderCompare();
  });
  $('ev-cmp-fields').addEventListener('click', (e) => {
    const c = e.target.closest('[data-field]');
    if (c) openCompareField(c.dataset.field);
  });
  $('ev-cmp-report').addEventListener('click', () => {
    if (st.cmp?.report) openPanel(`<div class="ev-md">${markdown(st.cmp.report)}</div>`);
  });

  return { showCoverage, showCompare };
}
