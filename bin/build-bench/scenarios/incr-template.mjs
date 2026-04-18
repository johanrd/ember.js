/**
 * Incremental-template scenario.
 *
 * Starts `vite` (dev server), warms the module graph by requesting `/` and
 * the entry modules, opens a WebSocket to Vite's HMR socket, then for N
 * iterations rewrites a target file with a bumped trailing comment and
 * measures the time from write-completion until Vite emits an `update`
 * message that mentions the target.
 *
 * What this measures: cold-HMR latency for a source-file edit, dominated
 * by (file watcher debounce) + (re-transform of the changed module).
 * Secondary signal: how many files vite thinks need re-processing — if it's
 * ever >1, cache invalidation is wrong.
 *
 * Caveats:
 *   - Chokidar debounce on macOS is ~100ms; that's our noise floor. Numbers
 *     below ~120ms are debounce-floor-limited.
 *   - We subscribe to the HMR WS *before* issuing the write so the update
 *     event is never missed.
 *   - Uses Node's native WebSocket (Node 22+).
 *   - Vite accepts HMR clients with the `vite-hmr` subprotocol.
 */
import { readFile, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';

import { execa } from 'execa';

const BENCH_CONFIG = new URL('../bench-vite-config.mjs', import.meta.url).pathname;
const READY_PATTERN = /ready in (\d+)\s*ms/i;
const ANSI_RE = /\u001b\[[0-9;]*m/g;
const PORT_PATTERN = /(?:Local|localhost):\s*http:\/\/[^:]+:(\d+)/i;
const MAX_READY_WAIT_MS = 60_000;
const POST_READY_WARM_MS = 2500;   // let vite transform the initial graph
const INTER_ITERATION_PAUSE_MS = 250;
const MAX_UPDATE_WAIT_MS = 10_000;

/**
 * Pick a default target file for known apps. Users can override via
 * `--touch-file`. We want a file that's in the eager-loaded graph so an
 * edit actually triggers HMR.
 */
function defaultTouchFile(appDir) {
  const candidates = [
    // large-app: eager-globbed leaf component
    'app/components/generated/leaf/leafComponent-0.gjs',
    // benchmark-app: main application template
    'app/templates/application.gjs',
    // generic fallback
    'app/templates/application.hbs',
  ];
  for (const rel of candidates) {
    const abs = join(appDir, rel);
    if (existsSync(abs)) return abs;
  }
  return null;
}

async function waitForReady(child, debug) {
  let readyMs = null;
  let boundPort = null;
  let resolved;
  const readyP = new Promise((r) => { resolved = r; });

  const onLine = (chunk) => {
    const text = chunk.toString();
    if (debug) process.stderr.write(`[bench/incr] ${text}`);
    const plain = text.replace(ANSI_RE, '');
    if (readyMs === null) {
      const m = plain.match(READY_PATTERN);
      if (m) readyMs = Number(m[1]);
    }
    if (boundPort === null) {
      const m = plain.match(PORT_PATTERN);
      if (m) boundPort = Number(m[1]);
    }
    if (readyMs !== null && boundPort !== null) resolved();
  };
  child.stdout?.on('data', onLine);
  child.stderr?.on('data', onLine);

  const timeoutId = setTimeout(resolved, MAX_READY_WAIT_MS);
  await readyP;
  clearTimeout(timeoutId);

  if (readyMs === null || boundPort === null) {
    throw new Error(`incr-template: vite did not ready within ${MAX_READY_WAIT_MS}ms`);
  }
  return { readyMs, port: boundPort };
}

/**
 * Connect to the vite HMR socket and wait for the `connected` hello so we
 * know the channel is live before starting to touch files.
 */
async function openHmrSocket(port) {
  const url = `ws://127.0.0.1:${port}`;
  const ws = new WebSocket(url, 'vite-hmr');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws open timeout')), 10_000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`ws error: ${e?.message ?? 'unknown'}`));
    }, { once: true });
  });
  // Vite announces `connected` on open; we don't strictly need to wait for
  // it, but flushing one message confirms the channel is alive.
  return ws;
}

async function warmGraph(port, appDir, touchFile) {
  // Hit index.html so vite starts transforming entry modules.
  try { await fetch(`http://127.0.0.1:${port}/`); } catch {}
  // Request the target file directly as a module so it's pulled into the graph.
  const rel = '/' + relative(appDir, touchFile).replace(/\\/g, '/');
  try { await fetch(`http://127.0.0.1:${port}${rel}`); } catch {}
  // Let vite settle.
  await new Promise((r) => setTimeout(r, POST_READY_WARM_MS));
}

async function measureOne(ws, touchFile, originalContent, iter) {
  const targetBase = basename(touchFile);
  const debug = process.env.BENCH_DEBUG === '1';
  let updates = null;
  let reloadKind = null; // 'hot' | 'full-reload'
  const gotUpdate = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      reject(new Error(`update timeout for ${targetBase}`));
    }, MAX_UPDATE_WAIT_MS);
    const onMessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (debug) process.stderr.write(`[bench/incr] ws<- type=${msg?.type} ${JSON.stringify(msg).slice(0, 200)}\n`);
      if (msg?.type === 'update') {
        const matched = msg.updates?.filter((u) =>
          (u.path && u.path.endsWith(targetBase)) ||
          (u.acceptedPath && u.acceptedPath.endsWith(targetBase))
        );
        if (matched && matched.length > 0) {
          clearTimeout(timer);
          ws.removeEventListener('message', onMessage);
          updates = msg.updates;
          reloadKind = 'hot';
          resolve();
        }
      } else if (msg?.type === 'full-reload') {
        // Coarser than hot-update: Vite reloads the whole page. Still a
        // valid "change was noticed" signal. triggeredBy is an abs path.
        if (!msg.triggeredBy || msg.triggeredBy.endsWith(targetBase)) {
          clearTimeout(timer);
          ws.removeEventListener('message', onMessage);
          updates = [{ path: msg.triggeredBy ?? '*' }];
          reloadKind = 'full-reload';
          resolve();
        }
      }
    };
    ws.addEventListener('message', onMessage);
  });

  // Bump a trailing comment to produce a real content change every iteration.
  // Vite short-circuits HMR if content hash is unchanged.
  const bumped = `${originalContent.trimEnd()}\n// bench-touch-${iter}\n`;
  const t0 = performance.now();
  await writeFile(touchFile, bumped, 'utf8');
  // Also touch mtime in case chokidar's polling fallback prefers mtime.
  await utimes(touchFile, new Date(), new Date()).catch(() => {});

  await gotUpdate;
  const latencyMs = performance.now() - t0;
  return { latencyMs, updateCount: updates?.length ?? 0, reloadKind };
}

export async function runIncrTemplate({ appDir, appConfig, outDir, runId, touchFile, iterations }) {
  if (!existsSync(appConfig)) {
    throw new Error(`incr-template: app config not found at ${appConfig}`);
  }
  const target = touchFile ?? defaultTouchFile(appDir);
  if (!target || !existsSync(target)) {
    throw new Error(
      `incr-template: no touch target. Pass --touch-file <abs path>. Tried defaults relative to ${appDir}.`
    );
  }
  const iters = iterations ?? 15;

  const outFile = join(outDir, `${runId}.ndjson`);
  await writeFile(outFile, '', 'utf8').catch(() => {});

  const viteBin = join(appDir, 'node_modules/.bin/vite');
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

  const t0 = performance.now();
  let ws;
  const latencies = [];
  const updateCounts = [];
  const reloadKinds = [];
  let readyMs = null;
  let port = null;
  let originalContent = null;
  try {
    ({ readyMs, port } = await waitForReady(child, process.env.BENCH_DEBUG === '1'));
    originalContent = await readFile(target, 'utf8');
    await warmGraph(port, appDir, target);
    ws = await openHmrSocket(port);

    for (let i = 0; i < iters; i++) {
      const { latencyMs, updateCount, reloadKind } = await measureOne(
        ws, target, originalContent, i
      );
      latencies.push(latencyMs);
      updateCounts.push(updateCount);
      reloadKinds.push(reloadKind);
      await new Promise((r) => setTimeout(r, INTER_ITERATION_PAUSE_MS));
      // After a full-reload Vite expects the browser to reload and re-fetch
      // the module; since our pseudo-client doesn't, re-request the target
      // URL to pull the module back into Vite's graph. Without this, the
      // next edit fires no HMR event.
      if (reloadKind === 'full-reload') {
        const rel = '/' + relative(appDir, target).replace(/\\/g, '/');
        try { await fetch(`http://127.0.0.1:${port}${rel}`); } catch {}
        try { await fetch(`http://127.0.0.1:${port}/`); } catch {}
      }
    }
  } finally {
    try { if (ws) ws.close(); } catch {}
    if (originalContent != null) {
      await writeFile(target, originalContent, 'utf8').catch(() => {});
    }
    child.kill('SIGTERM');
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && child.exitCode === null && !child.killed) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.catch(() => null);
  }

  const wallMs = performance.now() - t0;

  // Emit a summary row so run.mjs' aggregation works uniformly.
  const sorted = [...latencies].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const run = {
    kind: 'run',
    runId,
    scenario: 'incr-template',
    startedAt: Date.now() - wallMs,
    wallMs,
    readyMs,
    port,
    touchFile: target,
    iterations: iters,
    latenciesMs: latencies,
    updateCountsPerIter: updateCounts,
    reloadKindsPerIter: reloadKinds,
    fullReloadShare: reloadKinds.filter((k) => k === 'full-reload').length / reloadKinds.length,
    latencyMedianMs: median,
    peakRssBytes: null,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
  const { appendFile } = await import('node:fs/promises');
  await appendFile(outFile, JSON.stringify(run) + '\n', 'utf8');

  // Warn on cache-invalidation smells.
  const oversized = updateCounts.filter((n) => n > 1).length;
  if (oversized > 0) {
    process.stderr.write(
      `[incr-template] NOTE: ${oversized}/${updateCounts.length} HMR events included >1 file. ` +
      `May indicate over-broad invalidation.\n`
    );
  }

  return {
    runId,
    exitCode: 0,
    wallMs: median, // surface median HMR latency as the run's "wallMs" for aggregation
    outFile,
    latencies,
    updateCounts,
    readyMs,
  };
}
