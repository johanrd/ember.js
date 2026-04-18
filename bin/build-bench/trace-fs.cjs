/**
 * fs tracer — a preload that wraps node:fs, node:fs/promises, and the
 * sync/callback variants. Records call count + summed wall time per op,
 * plus per-path counts so we can see who's reading the same file many
 * times. Dumps a summary on process exit (write to BENCH_FS_OUT or
 * stderr).
 *
 * Caveats:
 *   - Wall time for async ops is "time until the promise/callback
 *     settles" — includes thread-pool queue + disk latency. Not CPU.
 *   - Sync ops block the main thread, so their wall time is also CPU.
 *   - Path is the first argument where it's a string/Buffer/URL;
 *     we don't attempt to resolve fd-based ops (fchmod etc).
 *
 * Usage:
 *   NODE_OPTIONS="--require /abs/path/to/trace-fs.cjs" <vite build command>
 *   BENCH_FS_OUT=/abs/path/trace.json  (optional; default stderr summary)
 */
'use strict';

const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const { performance } = require('node:perf_hooks');

const counters = new Map(); // op -> { count, wallMs, errors }
const pathHits = new Map(); // pathKey -> { count, wallMs }
const outFile = process.env.BENCH_FS_OUT || null;

function bucket(arg) {
  if (!arg) return '(fd)';
  let p;
  if (typeof arg === 'string') p = arg;
  else if (arg instanceof URL) p = arg.pathname;
  else if (Buffer.isBuffer(arg)) p = arg.toString();
  else if (arg && typeof arg.toString === 'function') p = String(arg);
  else return '(unknown)';

  // Collapse pnpm store paths so many mangled hashes don't spray the top-N.
  const pnpm = p.match(/node_modules\/\.pnpm\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)(?:\/(.+))?/);
  if (pnpm) {
    return pnpm[2] ? `${pnpm[1]}/${pnpm[2]}` : `${pnpm[1]}`;
  }
  return p;
}

function record(op, arg, t0, err) {
  const dt = performance.now() - t0;
  let c = counters.get(op);
  if (!c) {
    c = { count: 0, wallMs: 0, errors: 0 };
    counters.set(op, c);
  }
  c.count++;
  c.wallMs += dt;
  if (err) c.errors++;

  const pk = `${op}|${bucket(arg)}`;
  let pc = pathHits.get(pk);
  if (!pc) {
    pc = { count: 0, wallMs: 0 };
    pathHits.set(pk, pc);
  }
  pc.count++;
  pc.wallMs += dt;
}

function preserveOwnProps(target, source) {
  // Copy non-enumerable own props like fs.realpathSync.native that some
  // consumers (Vite's safeRealpathSync) load by name. Skip keys the new
  // wrapper already defines (length/name/prototype).
  for (const key of Object.getOwnPropertyNames(source)) {
    if (key in target) continue;
    try {
      Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key));
    } catch {
      // Some props are read-only; ignore.
    }
  }
}

function wrapSync(obj, name) {
  const orig = obj[name];
  if (typeof orig !== 'function') return;
  function wrapped(...args) {
    const t0 = performance.now();
    let err = null;
    try {
      return orig.apply(this, args);
    } catch (e) {
      err = e;
      throw e;
    } finally {
      record(name, args[0], t0, err);
    }
  }
  preserveOwnProps(wrapped, orig);
  obj[name] = wrapped;
}

function wrapCb(obj, name) {
  const orig = obj[name];
  if (typeof orig !== 'function') return;
  function wrapped(...args) {
    const cb = args[args.length - 1];
    if (typeof cb !== 'function') return orig.apply(this, args);
    const arg0 = args[0];
    const t0 = performance.now();
    args[args.length - 1] = function wrappedCb(err, ...rest) {
      record(name, arg0, t0, err);
      return cb(err, ...rest);
    };
    return orig.apply(this, args);
  }
  preserveOwnProps(wrapped, orig);
  obj[name] = wrapped;
}

function wrapPromise(obj, name) {
  const orig = obj[name];
  if (typeof orig !== 'function') return;
  function wrapped(...args) {
    const arg0 = args[0];
    const t0 = performance.now();
    return orig.apply(this, args).then(
      (v) => {
        record(name, arg0, t0, null);
        return v;
      },
      (err) => {
        record(name, arg0, t0, err);
        throw err;
      }
    );
  }
  preserveOwnProps(wrapped, orig);
  obj[name] = wrapped;
}

const SYNC_OPS = [
  'readFileSync',
  'statSync',
  'lstatSync',
  'existsSync',
  'accessSync',
  'realpathSync',
  'readdirSync',
  'openSync',
  'closeSync',
  'readSync',
  'writeFileSync',
  'mkdirSync',
];
const CB_OPS = [
  'readFile',
  'stat',
  'lstat',
  'access',
  'realpath',
  'readdir',
  'open',
  'close',
  'read',
  'writeFile',
  'mkdir',
];
const PROMISE_OPS = [
  'readFile',
  'stat',
  'lstat',
  'access',
  'realpath',
  'readdir',
  'open',
  'writeFile',
  'mkdir',
];

for (const op of SYNC_OPS) wrapSync(fs, op);
for (const op of CB_OPS) wrapCb(fs, op);
for (const op of PROMISE_OPS) wrapPromise(fsPromises, op);

// Promise-based realpath on the plain fs.realpath.native and .native promise form.
if (fs.realpath && typeof fs.realpath.native === 'function') {
  wrapCb(fs.realpath, 'native');
}

function dumpSummary() {
  const rows = [...counters.entries()]
    .map(([op, v]) => ({ op, ...v }))
    .sort((a, b) => b.wallMs - a.wallMs);

  const paths = [...pathHits.entries()]
    .map(([key, v]) => {
      const [op, p] = key.split('|');
      return { op, path: p, ...v };
    })
    .sort((a, b) => b.wallMs - a.wallMs)
    .slice(0, 500);

  const pathsByCount = [...pathHits.entries()]
    .map(([key, v]) => {
      const [op, p] = key.split('|');
      return { op, path: p, ...v };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 500);

  const totalCalls = rows.reduce((a, b) => a + b.count, 0);
  const totalMs = rows.reduce((a, b) => a + b.wallMs, 0);

  const summary = { totalCalls, totalWallMs: totalMs, perOp: rows, topPathsByWall: paths, topPathsByCount: pathsByCount };

  if (outFile) {
    fs.writeFileSync(outFile, JSON.stringify(summary, null, 2) + '\n', 'utf8');
    process.stderr.write(`[trace-fs] wrote ${outFile} (${totalCalls} calls / ${totalMs.toFixed(0)}ms total wall)\n`);
    return;
  }

  process.stderr.write(`\n[trace-fs] total: ${totalCalls} calls / ${totalMs.toFixed(0)}ms wall\n`);
  process.stderr.write('[trace-fs] per op:\n');
  for (const r of rows) {
    process.stderr.write(`  ${r.op.padEnd(16)} ${String(r.count).padStart(7)}x  ${r.wallMs.toFixed(1).padStart(8)}ms\n`);
  }
  process.stderr.write('[trace-fs] top 10 paths by wall:\n');
  for (const p of paths.slice(0, 10)) {
    process.stderr.write(`  ${p.op.padEnd(12)} ${p.count.toString().padStart(6)}x ${p.wallMs.toFixed(1).padStart(8)}ms  ${p.path}\n`);
  }
  process.stderr.write('[trace-fs] top 10 paths by count:\n');
  for (const p of pathsByCount.slice(0, 10)) {
    process.stderr.write(`  ${p.op.padEnd(12)} ${p.count.toString().padStart(6)}x ${p.wallMs.toFixed(1).padStart(8)}ms  ${p.path}\n`);
  }
}

process.on('exit', dumpSummary);
// Ensure we also dump on signals that would otherwise skip 'exit'.
process.on('SIGINT', () => { dumpSummary(); process.exit(130); });
process.on('SIGTERM', () => { dumpSummary(); process.exit(143); });
