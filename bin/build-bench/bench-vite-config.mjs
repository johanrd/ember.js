/**
 * Vite config shim used by the build-bench harness.
 * Loaded via `vite build --config <this-file>` with cwd = the target app.
 *
 * Env vars:
 *   BENCH_APP_CONFIG  — absolute path to the target app's real vite config
 *   BENCH_OUT_FILE    — NDJSON output path (plugin-hook timings)
 *   BENCH_RUN_ID      — opaque run identifier
 *
 * We dynamically import the app config, invoke it if it's a factory, clone,
 * and replace its plugin array with an instrumented version.
 */
import { pathToFileURL } from 'node:url';
import { wrapPlugins } from '../../bin/build-bench/wrap-plugins.mjs';

const appConfigPath = process.env.BENCH_APP_CONFIG;
if (!appConfigPath) {
  throw new Error('bench-vite-config: BENCH_APP_CONFIG env var is required');
}

const mod = await import(pathToFileURL(appConfigPath).href);
const raw = mod.default ?? mod;

export default async function benchConfig(env) {
  const resolved = typeof raw === 'function' ? await raw(env) : await raw;
  if (!resolved || typeof resolved !== 'object') {
    throw new Error(`bench-vite-config: app config at ${appConfigPath} did not export an object`);
  }
  return {
    ...resolved,
    plugins: wrapPlugins(resolved.plugins ?? []),
  };
}
