/**
 * Cold-build production scenario.
 *
 * Clears .vite, node_modules/.vite, and dist before each run, then invokes
 * `vite build` with the bench config shim. Returns one row per run plus the
 * path to its NDJSON log.
 *
 * "cold" here means the per-run file caches are clean; node_modules is reused
 * (installing fresh every run would dominate the signal and conflate install
 * time with build time).
 */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { execa } from 'execa';

const BENCH_CONFIG = new URL('../bench-vite-config.mjs', import.meta.url).pathname;

async function clearBuildCaches(appDir) {
  await Promise.all([
    rm(join(appDir, '.vite'), { recursive: true, force: true }),
    rm(join(appDir, 'node_modules/.vite'), { recursive: true, force: true }),
    rm(join(appDir, 'dist'), { recursive: true, force: true }),
  ]);
}

export async function runColdProd({ appDir, appConfig, outDir, runId }) {
  if (!existsSync(appConfig)) {
    throw new Error(`cold-prod: app config not found at ${appConfig}`);
  }

  const outFile = join(outDir, `${runId}.ndjson`);

  await clearBuildCaches(appDir);

  const t0 = performance.now();
  const { exitCode, stdout, stderr } = await execa(
    'pnpm',
    ['vite', 'build', '--config', BENCH_CONFIG],
    {
      cwd: appDir,
      env: {
        ...process.env,
        BENCH_APP_CONFIG: appConfig,
        BENCH_OUT_FILE: outFile,
        BENCH_RUN_ID: runId,
      },
      reject: false,
    }
  );
  const wallMs = performance.now() - t0;

  return {
    runId,
    exitCode,
    wallMs,
    outFile,
    stdout: stdout?.slice(-2000),
    stderr: stderr?.slice(-2000),
  };
}
