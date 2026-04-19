#!/usr/bin/env node
/**
 * Capture a Chrome CPU profile while the benchmark-app runs through its full
 * Krausest-style sequence. Intended to identify runtime-side hotspots (in
 * ember-source / @glimmer runtime code) that a build-time profile can't see.
 *
 * Requires a vite-preview of benchmark-app already running on `--url`.
 *
 * Usage:
 *   pnpm --filter benchmark-app vite preview --port 4173 --host 127.0.0.1 &
 *   node bin/build-bench/capture-runtime-profile.mjs \
 *     --url http://127.0.0.1:4173/ --out .bench/profiles/runtime.cpuprofile
 */
/* eslint-disable no-console */
import { writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
// chrome-debugging-client is a transitive dep of tracerbench (not hoisted);
// resolve it via its pnpm store path.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cdcPath = require.resolve('chrome-debugging-client', {
  paths: [require.resolve('tracerbench/package.json')],
});
const { spawnChrome } = await import(cdcPath);

function parseArgs(argv) {
  const out = {
    url: 'http://127.0.0.1:4173/',
    out: '.bench/profiles/runtime.cpuprofile',
    wait: 60_000,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--url') out.url = next();
    else if (a === '--out') out.out = next();
    else if (a === '--wait') out.wait = Number(next());
    else if (a === '-h' || a === '--help') {
      console.log('Usage: capture-runtime-profile.mjs [--url URL] [--out PATH] [--wait MS]');
      process.exit(0);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  await mkdir(dirname(args.out), { recursive: true });

  console.log(`[capture] url=${args.url} wait=${args.wait}ms`);

  const chrome = spawnChrome({ headless: true });
  try {
    const browser = chrome.connection;

    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const page = await browser.attachToTarget(targetId);

    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Profiler.enable');

    // Start profiling before navigation so module evaluation + app boot are
    // captured too. Downstream analysis can filter to the benchmark window.
    await page.send('Profiler.start');

    // Forward browser console messages so we can see benchmark progress.
    page.on('Runtime.consoleAPICalled', (event) => {
      const msg = event.args.map((a) => a.value ?? a.description ?? '').join(' ');
      console.log(`[browser] ${event.type}: ${msg}`);
    });

    console.log('[capture] navigating...');
    await Promise.all([
      page.until('Page.loadEventFired'),
      page.send('Page.navigate', { url: args.url }),
    ]);

    // benchmark-app's runBenchmark auto-runs on page load. The last op it
    // performs is clearItems4. We wait long enough for the full sequence,
    // then stop the profile.
    console.log(`[capture] benchmark running; waiting ${args.wait}ms...`);
    await new Promise((resolve) => setTimeout(resolve, args.wait));

    console.log('[capture] stopping profiler...');
    const { profile } = await page.send('Profiler.stop');

    writeFileSync(args.out, JSON.stringify(profile));
    console.log(`[capture] wrote ${args.out} (${(JSON.stringify(profile).length / 1024 / 1024).toFixed(1)} MB)`);

    await chrome.close();
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await chrome.dispose();
  }
}

main();
