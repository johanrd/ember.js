/**
 * Wraps every hook on every Vite/Rollup plugin with performance.now() timing.
 * Each invocation emits one NDJSON row; a trailing "run" row summarizes totals.
 *
 * Hooks wrapped: resolveId, load, transform, renderChunk, transformIndexHtml,
 * buildStart, buildEnd, generateBundle, writeBundle.
 *
 * Not wrapped (no per-file attribution value, and some are sync-only):
 *   config, configResolved, configureServer, options, outputOptions, closeBundle.
 *
 * Output goes to the file at env.BENCH_OUT_FILE (NDJSON, append-only).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

const HOOKS = [
  'resolveId',
  'load',
  'transform',
  'renderChunk',
  'transformIndexHtml',
  'buildStart',
  'buildEnd',
  'generateBundle',
  'writeBundle',
];

export function wrapPlugins(plugins, { outFile, runId } = {}) {
  const out = outFile ?? process.env.BENCH_OUT_FILE;
  const rid = runId ?? process.env.BENCH_RUN_ID ?? 'default';

  if (!out) {
    throw new Error('wrapPlugins: BENCH_OUT_FILE env var or outFile option required');
  }

  mkdirSync(dirname(out), { recursive: true });

  const writer = new BatchedWriter(out);
  const runStart = performance.now();
  let peakRssBytes = 0;
  const rssInterval = setInterval(() => {
    const rss = process.memoryUsage.rss();
    if (rss > peakRssBytes) peakRssBytes = rss;
  }, 200).unref();

  const flat = flattenPlugins(plugins);
  const wrapped = flat.map((plugin, idx) => wrapOne(plugin, idx, writer, rid));

  const recordRunEnd = () => {
    clearInterval(rssInterval);
    const end = performance.now();
    writer.write({
      kind: 'run',
      runId: rid,
      startedAt: Date.now() - (end - runStart),
      wallMs: end - runStart,
      peakRssBytes,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    });
    writer.flush();
  };

  wrapped.push({
    name: 'bench:run-recorder',
    buildEnd(error) {
      if (error) {
        writer.write({ kind: 'error', runId: rid, message: String(error?.message ?? error) });
      }
    },
    closeBundle() {
      recordRunEnd();
    },
  });

  process.on('beforeExit', () => {
    writer.flush();
  });

  return wrapped;
}

function flattenPlugins(input) {
  const out = [];
  const walk = (x) => {
    if (!x) return;
    if (Array.isArray(x)) {
      for (const item of x) walk(item);
    } else if (typeof x === 'object') {
      out.push(x);
    }
  };
  walk(input);
  return out;
}

function wrapOne(plugin, idx, writer, runId) {
  const name = plugin?.name ?? `anonymous#${idx}`;
  const wrapped = { ...plugin };

  for (const hook of HOOKS) {
    const original = plugin?.[hook];
    if (original == null) continue;

    // Rollup allows hook to be { handler, order, sequential } as object form.
    if (typeof original === 'object' && typeof original.handler === 'function') {
      const inner = original.handler;
      wrapped[hook] = { ...original, handler: instrument(inner, hook, name, writer, runId) };
    } else if (typeof original === 'function') {
      wrapped[hook] = instrument(original, hook, name, writer, runId);
    }
  }

  return wrapped;
}

function instrument(fn, hook, plugin, writer, runId) {
  return function instrumented(...args) {
    const id = extractId(hook, args);
    const t0 = performance.now();
    let result;
    try {
      result = fn.apply(this, args);
    } catch (err) {
      const dt = performance.now() - t0;
      writer.write({ kind: 'call', runId, plugin, hook, id, ms: dt, threw: true });
      throw err;
    }
    if (result && typeof result.then === 'function') {
      return result.then(
        (v) => {
          const dt = performance.now() - t0;
          writer.write({ kind: 'call', runId, plugin, hook, id, ms: dt });
          return v;
        },
        (err) => {
          const dt = performance.now() - t0;
          writer.write({ kind: 'call', runId, plugin, hook, id, ms: dt, threw: true });
          throw err;
        }
      );
    }
    const dt = performance.now() - t0;
    writer.write({ kind: 'call', runId, plugin, hook, id, ms: dt });
    return result;
  };
}

// Pull the relevant id/path off the hook arguments for attribution.
// Shape varies by hook — we grab whatever identifies the unit of work.
// - resolveId(source, importer, options)   → source
// - load(id, options)                      → id
// - transform(code, id, options)           → id
// - renderChunk(code, chunk, options)      → chunk.fileName
// - transformIndexHtml(html, ctx)          → ctx.path
function extractId(hook, args) {
  switch (hook) {
    case 'resolveId':
    case 'load':
      return typeof args[0] === 'string' ? args[0] : null;
    case 'transform':
      return typeof args[1] === 'string' ? args[1] : null;
    case 'renderChunk':
      return args[1]?.fileName ?? null;
    case 'transformIndexHtml':
      return args[1]?.path ?? null;
    default:
      return null;
  }
}

class BatchedWriter {
  #file;
  #buf = [];
  #limit = 256;

  constructor(file) {
    this.#file = file;
  }

  write(row) {
    this.#buf.push(JSON.stringify(row));
    if (this.#buf.length >= this.#limit) this.flush();
  }

  flush() {
    if (this.#buf.length === 0) return;
    appendFileSync(this.#file, this.#buf.join('\n') + '\n');
    this.#buf.length = 0;
  }
}
