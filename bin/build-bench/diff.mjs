#!/usr/bin/env node
/**
 * Diff two build-bench summary JSONs produced by run.mjs.
 *
 *   node bin/build-bench/diff.mjs .bench/BASE.json .bench/HEAD.json
 *
 * Prints markdown tables: wall-clock, peak RSS, per-plugin/hook, per-extension.
 * A delta row is flagged (*) when the absolute delta exceeds the width of the
 * base's p5–p95 spread — a crude significance gate to catch "it's in the noise"
 * cases. This is not a statistical test, just a heuristic reviewer aid.
 */
/* eslint-disable no-console */
import { readFile } from 'node:fs/promises';

function fmtMs(ms) {
  if (ms == null) return '-';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(1)}ms`;
}

function fmtBytes(b) {
  if (b == null) return '-';
  const mb = b / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)}GB` : `${mb.toFixed(1)}MB`;
}

function fmtPct(base, head) {
  if (!base) return '-';
  const pct = ((head - base) / base) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function fmtDelta(base, head, isBytes = false) {
  const delta = head - base;
  const sign = delta >= 0 ? '+' : '';
  if (isBytes) return `${sign}${fmtBytes(Math.abs(delta))}`.replace('+-', '+-');
  return `${sign}${fmtMs(Math.abs(delta))}`;
}

async function loadSummary(path) {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

function indexBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) m.set(keyFn(r), r);
  return m;
}

function printWallTable(base, head) {
  const bWall = base.wall;
  const hWall = head.wall;
  const noiseWidth = bWall.p95 - bWall.p5;
  const delta = hWall.median - bWall.median;
  const flag = Math.abs(delta) > noiseWidth ? ' *' : '';

  console.log('## Wall-clock\n');
  console.log('| metric | base | head | delta | % |');
  console.log('|---|---:|---:|---:|---:|');
  console.log(`| median | ${fmtMs(bWall.median)} | ${fmtMs(hWall.median)} | ${fmtDelta(bWall.median, hWall.median)}${flag} | ${fmtPct(bWall.median, hWall.median)} |`);
  console.log(`| p5     | ${fmtMs(bWall.p5)} | ${fmtMs(hWall.p5)} | ${fmtDelta(bWall.p5, hWall.p5)} | ${fmtPct(bWall.p5, hWall.p5)} |`);
  console.log(`| p95    | ${fmtMs(bWall.p95)} | ${fmtMs(hWall.p95)} | ${fmtDelta(bWall.p95, hWall.p95)} | ${fmtPct(bWall.p95, hWall.p95)} |`);
  console.log(`| min    | ${fmtMs(bWall.min)} | ${fmtMs(hWall.min)} | ${fmtDelta(bWall.min, hWall.min)} | ${fmtPct(bWall.min, hWall.min)} |`);
  console.log(`| max    | ${fmtMs(bWall.max)} | ${fmtMs(hWall.max)} | ${fmtDelta(bWall.max, hWall.max)} | ${fmtPct(bWall.max, hWall.max)} |`);
  console.log('');
  console.log(`base runs: ${bWall.n}, head runs: ${hWall.n}. noise width (p95-p5) on base: ${fmtMs(noiseWidth)}. (*) delta exceeds base noise width.\n`);

  if (base.peakRss && head.peakRss) {
    console.log('## Peak RSS\n');
    console.log('| metric | base | head | delta | % |');
    console.log('|---|---:|---:|---:|---:|');
    console.log(`| median | ${fmtBytes(base.peakRss.median)} | ${fmtBytes(head.peakRss.median)} | ${fmtDelta(base.peakRss.median, head.peakRss.median, true)} | ${fmtPct(base.peakRss.median, head.peakRss.median)} |`);
    console.log(`| max    | ${fmtBytes(base.peakRss.max)} | ${fmtBytes(head.peakRss.max)} | ${fmtDelta(base.peakRss.max, head.peakRss.max, true)} | ${fmtPct(base.peakRss.max, head.peakRss.max)} |`);
    console.log('');
  }
}

function printDeltaTable(title, baseRows, headRows, keyFn, cols, opts = {}) {
  const baseIdx = indexBy(baseRows, keyFn);
  const headIdx = indexBy(headRows, keyFn);
  const keys = new Set([...baseIdx.keys(), ...headIdx.keys()]);

  // Normalize per-run (per-runs count) so "sum" is an average per-build figure.
  const baseRuns = opts.baseRuns ?? 1;
  const headRuns = opts.headRuns ?? 1;
  const scale = (v, runs) => (v == null ? null : v / runs);

  const rows = [...keys]
    .map((k) => {
      const b = baseIdx.get(k);
      const h = headIdx.get(k);
      const bSum = scale(b?.sum, baseRuns);
      const hSum = scale(h?.sum, headRuns);
      const delta = (hSum ?? 0) - (bSum ?? 0);
      return { key: k, b, h, bSum, hSum, delta };
    })
    .sort((a, b) => Math.max(b.hSum ?? 0, b.bSum ?? 0) - Math.max(a.hSum ?? 0, a.bSum ?? 0));

  console.log(`## ${title}\n`);
  console.log(`| ${cols.join(' | ')} | base ms/build | head ms/build | delta | % | calls (base→head) |`);
  console.log(`| ${cols.map(() => '---').join(' | ')} | ---: | ---: | ---: | ---: | ---: |`);
  const top = opts.top ?? 20;
  for (const row of rows.slice(0, top)) {
    const { b, h, bSum, hSum, delta, key } = row;
    const keyCells = opts.splitKey ? opts.splitKey(key, b, h) : [key];
    const bCount = b?.count ?? 0;
    const hCount = h?.count ?? 0;
    const pct = bSum ? ` ${fmtPct(bSum, hSum ?? 0)}` : '';
    const sign = delta >= 0 ? '+' : '';
    console.log(`| ${keyCells.join(' | ')} | ${fmtMs(bSum)} | ${fmtMs(hSum)} | ${sign}${fmtMs(Math.abs(delta))} |${pct} | ${bCount}→${hCount} |`);
  }
  if (rows.length > top) console.log(`\n_…and ${rows.length - top} more rows omitted (top ${top} shown, sorted by max of base/head)._`);
  console.log('');
}

function printAttributionTables(base, head) {
  const baseRuns = base.runs;
  const headRuns = head.runs;

  printDeltaTable(
    'Per plugin/hook',
    base.aggregated.perPluginHook,
    head.aggregated.perPluginHook,
    (r) => `${r.plugin}|${r.hook}`,
    ['plugin', 'hook'],
    { baseRuns, headRuns, top: 25, splitKey: (_k, b, h) => [(b ?? h).plugin, (b ?? h).hook] }
  );

  printDeltaTable(
    'Per extension',
    base.aggregated.perExt,
    head.aggregated.perExt,
    (r) => r.ext,
    ['ext'],
    { baseRuns, headRuns, top: 15 }
  );

  printDeltaTable(
    'Per plugin × extension (top interactions)',
    base.aggregated.perPluginExt,
    head.aggregated.perPluginExt,
    (r) => `${r.plugin}|${r.ext}`,
    ['plugin', 'ext'],
    { baseRuns, headRuns, top: 20, splitKey: (_k, b, h) => [(b ?? h).plugin, (b ?? h).ext] }
  );
}

async function main() {
  const [basePath, headPath] = process.argv.slice(2);
  if (!basePath || !headPath) {
    console.error('Usage: node bin/build-bench/diff.mjs <base.json> <head.json>');
    process.exit(2);
  }
  const [base, head] = await Promise.all([loadSummary(basePath), loadSummary(headPath)]);

  if (base.scenario !== head.scenario) {
    console.error(`WARN: scenario mismatch (base=${base.scenario}, head=${head.scenario})`);
  }
  if (base.app !== head.app) {
    console.error(`WARN: app mismatch (base=${base.app}, head=${head.app})`);
  }

  console.log(`# Build-bench diff\n`);
  console.log(`scenario=\`${head.scenario}\` app=\`${head.app}\``);
  console.log(`base=\`${basePath}\` (${base.runs} runs)`);
  console.log(`head=\`${headPath}\` (${head.runs} runs)`);
  console.log(`env: ${head.env?.cpu} / ${head.env?.platform}-${head.env?.arch} / node ${head.env?.node}\n`);

  printWallTable(base, head);
  printAttributionTables(base, head);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
