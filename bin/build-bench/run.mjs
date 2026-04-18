#!/usr/bin/env node
/**
 * Build-bench orchestrator.
 *
 *   node bin/build-bench/run.mjs \
 *     --scenario cold-prod \
 *     --app benchmark-app \
 *     --runs 7 \
 *     --out .bench/HEAD.json
 *
 * Runs the scenario `--runs` times, reads the per-run NDJSON logs, aggregates
 * per-plugin / per-extension / per-hook stats, writes one summary JSON.
 */
/* eslint-disable no-console */
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { cpus, platform, arch, release } from 'node:os';

import { runColdProd } from './scenarios/cold-prod.mjs';
import { runColdDev } from './scenarios/cold-dev.mjs';
import { runIncrTemplate } from './scenarios/incr-template.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCENARIOS = {
  'cold-prod': runColdProd,
  'cold-dev': runColdDev,
  'incr-template': runIncrTemplate,
};

function parseArgs(argv) {
  const out = {
    scenario: 'cold-prod',
    app: 'benchmark-app',
    runs: 3,
    out: null,
    touchFile: null,
    iterations: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--scenario') out.scenario = next();
    else if (a === '--app') out.app = next();
    else if (a === '--runs') out.runs = Number(next());
    else if (a === '--out') out.out = next();
    else if (a === '--touch-file') out.touchFile = next();
    else if (a === '--iterations') out.iterations = Number(next());
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${a}`);
      printHelp();
      process.exit(2);
    }
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node bin/build-bench/run.mjs [options]
  --scenario <name>    cold-prod (default), cold-dev, incr-template
  --app <name>         benchmark-app (default), large-app, app-template, v2-app-template
  --runs <n>           default 3
  --out <path>         summary JSON output path (default: .bench/<scenario>-<ts>.json)
  --touch-file <path>  incr-template only: absolute path to the file to touch.
                       Default: per-app heuristic.
  --iterations <n>     incr-template only: edit/measure cycles per run (default 15).

Scenarios:
  cold-prod       full vite build from clean caches; measures wall + per-plugin
                  attribution + peak RSS.
  cold-dev        vite dev-server startup time ("ready in Xms") from clean caches.
                  Does not measure on-demand transform cost — see HMR scenarios.
  incr-template   dev-server HMR round-trip latency: touch a source file and
                  wait for the update message. Reports per-iteration latencies
                  and flags any HMR event that invalidates >1 file.`);
}

async function readNdjson(filePath) {
  const rows = [];
  if (!existsSync(filePath)) return rows;
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (e) {
      console.warn(`skipping malformed ndjson line in ${filePath}: ${e.message}`);
    }
  }
  return rows;
}

function bucketByExt(id) {
  if (!id || typeof id !== 'string') return '(none)';
  // strip vite query strings, virtual-module prefixes
  const clean = id.split('?')[0].split('\0').pop();
  const ext = extname(clean).toLowerCase();
  return ext || '(none)';
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function summarizeRuns(runs) {
  const walls = runs.map((r) => r.wallMs).sort((a, b) => a - b);
  return {
    n: runs.length,
    median: quantile(walls, 0.5),
    p5: quantile(walls, 0.05),
    p95: quantile(walls, 0.95),
    min: walls[0],
    max: walls[walls.length - 1],
  };
}

function aggregateCalls(allRows) {
  const perPluginHook = new Map(); // key: plugin|hook -> { count, sum, max, ids:Set, msList:[] }
  const perExt = new Map(); // key: ext -> { count, sum, max }
  const perPluginExt = new Map(); // key: plugin|ext -> { count, sum }

  for (const row of allRows) {
    if (row.kind !== 'call') continue;
    const { plugin, hook, id, ms } = row;
    const phKey = `${plugin}|${hook}`;
    let ph = perPluginHook.get(phKey);
    if (!ph) {
      ph = { plugin, hook, count: 0, sum: 0, max: 0 };
      perPluginHook.set(phKey, ph);
    }
    ph.count++;
    ph.sum += ms;
    if (ms > ph.max) ph.max = ms;

    const ext = bucketByExt(id);
    let pe = perExt.get(ext);
    if (!pe) {
      pe = { ext, count: 0, sum: 0, max: 0 };
      perExt.set(ext, pe);
    }
    pe.count++;
    pe.sum += ms;
    if (ms > pe.max) pe.max = ms;

    const pExt = `${plugin}|${ext}`;
    let px = perPluginExt.get(pExt);
    if (!px) {
      px = { plugin, ext, count: 0, sum: 0 };
      perPluginExt.set(pExt, px);
    }
    px.count++;
    px.sum += ms;
  }

  const sortBySum = (a, b) => b.sum - a.sum;
  return {
    perPluginHook: [...perPluginHook.values()].sort(sortBySum),
    perExt: [...perExt.values()].sort(sortBySum),
    perPluginExt: [...perPluginExt.values()].sort(sortBySum),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!SCENARIOS[args.scenario]) {
    console.error(`Unknown scenario: ${args.scenario}. Available: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(2);
  }

  const appDir = resolve(REPO_ROOT, 'smoke-tests', args.app);
  if (!existsSync(appDir)) {
    console.error(`App dir not found: ${appDir}`);
    process.exit(2);
  }
  const appConfig = join(appDir, 'vite.config.mjs');
  if (!existsSync(appConfig)) {
    console.error(`App config not found: ${appConfig}`);
    process.exit(2);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = args.out
    ? resolve(REPO_ROOT, args.out)
    : resolve(REPO_ROOT, `.bench/${args.scenario}-${ts}.json`);
  const runDir = resolve(REPO_ROOT, `.bench/runs/${args.scenario}-${ts}`);
  await mkdir(runDir, { recursive: true });

  const scenario = SCENARIOS[args.scenario];
  console.log(`[build-bench] scenario=${args.scenario} app=${args.app} runs=${args.runs}`);
  console.log(`[build-bench] per-run ndjson: ${runDir}`);

  const runs = [];
  for (let i = 0; i < args.runs; i++) {
    const runId = `${args.scenario}-${i + 1}`;
    process.stdout.write(`[build-bench] run ${i + 1}/${args.runs} ... `);
    const result = await scenario({
      appDir,
      appConfig,
      outDir: runDir,
      runId,
      touchFile: args.touchFile,
      iterations: args.iterations,
    });
    if (result.exitCode !== 0) {
      console.error(`FAILED (exit ${result.exitCode})`);
      if (result.stderr) console.error(result.stderr);
      process.exit(1);
    }
    console.log(`${result.wallMs.toFixed(0)}ms`);
    runs.push(result);
  }

  const allRows = (
    await Promise.all(runs.map((r) => readNdjson(r.outFile)))
  ).flat();

  const runRows = allRows.filter((r) => r.kind === 'run');
  const wallStats = summarizeRuns(runs);
  const aggregated = aggregateCalls(allRows);

  const peakRssSorted = runRows
    .map((r) => r.peakRssBytes)
    .filter((n) => typeof n === 'number')
    .sort((a, b) => a - b);

  const summary = {
    scenario: args.scenario,
    app: args.app,
    runs: args.runs,
    createdAt: new Date().toISOString(),
    env: {
      node: process.version,
      platform: platform(),
      arch: arch(),
      osRelease: release(),
      cpu: cpus()[0]?.model ?? 'unknown',
      cpuCount: cpus().length,
    },
    wall: wallStats,
    peakRss: peakRssSorted.length
      ? { median: quantile(peakRssSorted, 0.5), max: peakRssSorted[peakRssSorted.length - 1] }
      : null,
    perRun: runs.map((r) => ({ runId: r.runId, wallMs: r.wallMs })),
    aggregated,
  };

  await mkdir(resolve(outFile, '..'), { recursive: true });
  await writeFile(outFile, JSON.stringify(summary, null, 2) + '\n', 'utf8');

  console.log('');
  console.log(`[build-bench] wall median=${wallStats.median.toFixed(0)}ms p5=${wallStats.p5.toFixed(0)}ms p95=${wallStats.p95.toFixed(0)}ms`);
  console.log(`[build-bench] summary: ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
