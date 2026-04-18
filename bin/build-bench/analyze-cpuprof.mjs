#!/usr/bin/env node
/**
 * Minimal CPU-profile analyzer for .cpuprofile JSON (Chrome DevTools format,
 * which is what `node --cpu-prof` emits).
 *
 * Aggregates self-time per (function, file) tuple and prints top-N by self-ms.
 * Optional --filter <substring> restricts to nodes whose url or name contains
 * the substring (e.g. `--filter embroider` to see only embroider-resolver
 * internals).
 *
 * Usage:
 *   node bin/build-bench/analyze-cpuprof.mjs <file.cpuprofile> [--filter S] [--top N]
 */
/* eslint-disable no-console */
import { readFile } from 'node:fs/promises';

function parseArgs(argv) {
  const out = { file: null, filter: null, top: 30, byTotal: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--filter') out.filter = argv[++i];
    else if (a === '--top') out.top = Number(argv[++i]);
    else if (a === '--total') out.byTotal = true;
    else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: analyze-cpuprof.mjs <file.cpuprofile> [--filter S] [--top N] [--total]'
      );
      process.exit(0);
    } else if (!out.file && !a.startsWith('--')) out.file = a;
    else {
      console.error('unknown flag:', a);
      process.exit(2);
    }
  }
  if (!out.file) {
    console.error('missing <file.cpuprofile>');
    process.exit(2);
  }
  return out;
}

function shortUrl(url) {
  if (!url) return '(none)';
  // Collapse node_modules/.pnpm/<mangled>/node_modules/<pkg>/... to @pkg/…
  const m = url.match(/node_modules\/\.pnpm\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)\/(.+)/);
  if (m) return `${m[1]}/${m[2]}`;
  // Plain repo path
  return url.replace(/^file:\/\/\/Users\/[^/]+\//, '');
}

async function main() {
  const args = parseArgs(process.argv);
  const raw = JSON.parse(await readFile(args.file, 'utf8'));
  const { nodes, samples, timeDeltas, startTime, endTime } = raw;

  // The profile records timeDeltas per sample. Each sample[i] lands on node
  // samples[i]; its self-time is timeDeltas[i] microseconds (first entry is
  // offset from startTime).
  const selfById = new Map();
  const totalById = new Map();

  // Build child map for total-time rollup.
  const parentById = new Map();
  for (const node of nodes) {
    if (node.children) {
      for (const childId of node.children) parentById.set(childId, node.id);
    }
  }

  for (let i = 0; i < samples.length; i++) {
    const nodeId = samples[i];
    const dt = timeDeltas[i] ?? 0;
    selfById.set(nodeId, (selfById.get(nodeId) ?? 0) + dt);
    // Total-time: walk up the parent chain.
    let cur = nodeId;
    const seen = new Set();
    while (cur != null && !seen.has(cur)) {
      seen.add(cur);
      totalById.set(cur, (totalById.get(cur) ?? 0) + dt);
      cur = parentById.get(cur);
    }
  }

  const totalDurationUs = (endTime ?? 0) - (startTime ?? 0);

  const rows = nodes
    .map((node) => {
      const cf = node.callFrame ?? {};
      const selfUs = selfById.get(node.id) ?? 0;
      const totalUs = totalById.get(node.id) ?? 0;
      return {
        id: node.id,
        name: cf.functionName || '(anonymous)',
        url: cf.url || '',
        line: cf.lineNumber ?? -1,
        selfMs: selfUs / 1000,
        totalMs: totalUs / 1000,
      };
    })
    .filter((r) => {
      if (r.selfMs < 0.1 && !args.byTotal) return false;
      if (args.filter) {
        const needle = args.filter.toLowerCase();
        if (!r.name.toLowerCase().includes(needle) && !r.url.toLowerCase().includes(needle)) {
          return false;
        }
      }
      return true;
    })
    .sort((a, b) => (args.byTotal ? b.totalMs - a.totalMs : b.selfMs - a.selfMs));

  console.log(`# cpuprof ${args.file}`);
  console.log(`total profile duration: ${(totalDurationUs / 1000).toFixed(0)}ms`);
  console.log(`samples: ${samples.length}, distinct nodes: ${nodes.length}`);
  if (args.filter) console.log(`filter: "${args.filter}"`);
  console.log(`sorting by: ${args.byTotal ? 'total time' : 'self time'}`);
  console.log('');
  console.log(`| self ms | total ms | function | location |`);
  console.log(`| ---: | ---: | --- | --- |`);
  for (const r of rows.slice(0, args.top)) {
    const loc = r.line >= 0 ? `${shortUrl(r.url)}:${r.line + 1}` : shortUrl(r.url);
    console.log(
      `| ${r.selfMs.toFixed(1)} | ${r.totalMs.toFixed(1)} | ${r.name} | ${loc} |`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
