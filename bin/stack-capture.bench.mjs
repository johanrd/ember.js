/**
 * Microbench for EvaluationStack.capture(items) fast-path
 * (@glimmer/runtime/lib/vm/stack.ts).
 *
 * Old form always does stack.slice(start, end) — even when items===0,
 * which slices an empty range. New form branches out early on items===0.
 *
 * Question: is the branch cost worth it? Depends on how often items===0
 * happens in practice.
 *
 * Run:  pnpm bench:stack-capture
 */

import { bench, do_not_optimize as doNotOptimize, run } from 'mitata';

function captureOld(stack, sp, items) {
  const end = sp + 1;
  const start = end - items;
  return stack.slice(start, end);
}

function captureNew(stack, sp, items) {
  if (items === 0) return [];
  const end = sp + 1;
  const start = end - items;
  return stack.slice(start, end);
}

// Simulate a reasonable-sized evaluation stack
const STACK = Array.from({ length: 1000 }, (_, i) => ({ op: i }));
const SP = 999;

// Pattern A: always items=0 (worst case for old form if it happens a lot)
bench('capture old items=0   1000×', () => {
  let result = null;
  for (let i = 0; i < 1000; i++) {
    result = captureOld(STACK, SP, 0);
  }
  return doNotOptimize(result);
});

bench('capture new items=0   1000×', () => {
  let result = null;
  for (let i = 0; i < 1000; i++) {
    result = captureNew(STACK, SP, 0);
  }
  return doNotOptimize(result);
});

// Pattern B: always items>0 (Krausest-typical — small capture)
bench('capture old items=3   1000×', () => {
  let result = null;
  for (let i = 0; i < 1000; i++) {
    result = captureOld(STACK, SP, 3);
  }
  return doNotOptimize(result);
});

bench('capture new items=3   1000×', () => {
  let result = null;
  for (let i = 0; i < 1000; i++) {
    result = captureNew(STACK, SP, 3);
  }
  return doNotOptimize(result);
});

// Pattern C: mixed — occasional items=0, mostly items>0 (realistic?)
const MIXED = Array.from({ length: 1000 }, (_, i) => (i % 10 === 0 ? 0 : 3));

bench('capture old mixed 10% items=0, 1000×', () => {
  let result = null;
  for (let i = 0; i < 1000; i++) {
    result = captureOld(STACK, SP, MIXED[i]);
  }
  return doNotOptimize(result);
});

bench('capture new mixed 10% items=0, 1000×', () => {
  let result = null;
  for (let i = 0; i < 1000; i++) {
    result = captureNew(STACK, SP, MIXED[i]);
  }
  return doNotOptimize(result);
});

await run({ throw: true });
