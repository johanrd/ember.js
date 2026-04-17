/**
 * Cold-dev scenario.
 *
 * Spawns `vite` (dev server) and measures server-startup time: the
 * "ready in Xms" signal Vite logs when the HTTP listener is up.
 *
 * What this does NOT measure: on-demand transform cost. Vite's dev server
 * only runs module transforms when a client requests a module — so a bare
 * "ready" timing under-reports the dev-build cost. Measuring that properly
 * requires either driving a client request and waiting for the module graph
 * to quiesce, or measuring incremental rebuilds after a file change —
 * both are future scenarios. This cold-dev number is still useful as a
 * watchpoint for server-startup regressions (plugin initialization, resolver
 * cache warmup, embroider's app discovery).
 *
 * The harness kills the server after ready (sends SIGTERM, waits briefly,
 * escalates to SIGKILL). The bench plugin's closeBundle hook never fires in
 * dev mode, so we synthesize a `run` row here in the scenario rather than
 * relying on the plugin to write one.
 */
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { execa } from 'execa';

const BENCH_CONFIG = new URL('../bench-vite-config.mjs', import.meta.url).pathname;

const READY_PATTERN = /ready in (\d+)\s*ms/i;
// Strip SGR (CSI m) sequences; Vite's logger inserts these even under NO_COLOR
// in some terminal configurations, which splits "ready in 409 ms" across
// escape codes and breaks a naive regex match.
const ANSI_RE = /\u001b\[[0-9;]*m/g;
const MAX_READY_WAIT_MS = 60_000;
const SIGTERM_GRACE_MS = 2_000;

async function clearDevCaches(appDir) {
  await Promise.all([
    rm(join(appDir, '.vite'), { recursive: true, force: true }),
    rm(join(appDir, 'node_modules/.vite'), { recursive: true, force: true }),
  ]);
}

export async function runColdDev({ appDir, appConfig, outDir, runId }) {
  if (!existsSync(appConfig)) {
    throw new Error(`cold-dev: app config not found at ${appConfig}`);
  }

  const outFile = join(outDir, `${runId}.ndjson`);
  await mkdir(dirname(outFile), { recursive: true });
  // Touch the file so the scenario-emitted run row has somewhere to go.
  await writeFile(outFile, '', 'utf8');

  await clearDevCaches(appDir);

  // Invoke vite's binary directly (skip `pnpm vite`) to avoid pnpm's output
  // buffering masking the "ready in Xms" line — with pnpm in the middle the
  // regex match sometimes never fires within MAX_READY_WAIT_MS.
  const viteBin = join(appDir, 'node_modules/.bin/vite');
  const t0 = performance.now();
  const child = execa(viteBin, ['--config', BENCH_CONFIG, '--port', '0', '--host', '127.0.0.1'], {
    cwd: appDir,
    env: {
      ...process.env,
      BENCH_APP_CONFIG: appConfig,
      BENCH_OUT_FILE: outFile,
      BENCH_RUN_ID: runId,
      FORCE_COLOR: '0',
    },
    reject: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let readyMs = null;
  let resolvedReady;
  const ready = new Promise((resolve) => {
    resolvedReady = resolve;
  });

  const debug = process.env.BENCH_DEBUG === '1';
  const onLine = (chunk) => {
    const text = chunk.toString();
    if (debug) process.stderr.write(`[bench/dev] ${text}`);
    if (readyMs !== null) return;
    const plain = text.replace(ANSI_RE, '');
    const m = plain.match(READY_PATTERN);
    if (m) {
      readyMs = Number(m[1]);
      resolvedReady();
    }
  };
  child.stdout?.on('data', onLine);
  child.stderr?.on('data', onLine);

  const timeoutId = setTimeout(() => {
    if (readyMs === null) {
      resolvedReady(); // fall through; we'll report timeout below
    }
  }, MAX_READY_WAIT_MS);

  await ready;
  clearTimeout(timeoutId);

  const wallToReadyMs = performance.now() - t0;

  // Drain and shut down.
  child.kill('SIGTERM');
  const killDeadline = Date.now() + SIGTERM_GRACE_MS;
  const waitExit = child.then(
    (r) => r,
    (r) => r
  );
  while (Date.now() < killDeadline && !child.killed && child.exitCode === null) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (child.exitCode === null) {
    child.kill('SIGKILL');
  }
  const result = await waitExit;

  // Emit a synthetic run row so run.mjs can consume this scenario the same way
  // it consumes cold-prod outputs.
  const runRow = {
    kind: 'run',
    runId,
    startedAt: Date.now() - wallToReadyMs,
    wallMs: wallToReadyMs,
    readyMs, // vite-self-reported; null if we timed out
    scenario: 'cold-dev',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    peakRssBytes: null, // no in-process sampling in dev scenario
  };
  await appendFile(outFile, JSON.stringify(runRow) + '\n', 'utf8');

  return {
    runId,
    exitCode: readyMs !== null ? 0 : 1,
    wallMs: wallToReadyMs,
    outFile,
    stdout: result?.stdout?.slice(-2000),
    stderr: result?.stderr?.slice(-2000),
    readyMs,
  };
}
