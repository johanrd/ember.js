/**
 * Microbench for convertToInt in @glimmer/validator/lib/collections/array.ts.
 *
 * The TrackedArray Proxy's get/set traps call convertToInt on every property
 * access. For numeric-index accesses that's a valid conversion; for
 * everything else (.length, .map, .forEach, Symbol.iterator, ARRAY_GETTER_METHODS
 * lookups) the old form pays a Number() call before rejecting.
 *
 * Apps that derive computed values from trackedArray (arr.length, arr.map(...),
 * arr.filter(...).length, etc.) invoke the non-index path per method lookup.
 * Krausest barely exercises this — its consumer reads are mostly the item data,
 * not method traffic.
 *
 * Run:  pnpm bench:convert-to-int
 */

import { bench, do_not_optimize as doNotOptimize, run } from 'mitata';

function convertToIntOld(prop) {
  if (typeof prop === 'symbol') return null;

  const num = Number(prop);
  if (isNaN(num)) return null;
  return num % 1 === 0 ? num : null;
}

function convertToIntNew(prop) {
  if (typeof prop === 'symbol') return null;
  if (typeof prop === 'number') return prop % 1 === 0 ? prop : null;

  const c = prop.charCodeAt(0);
  if (c < 48 || c > 57) return null;

  const num = Number(prop);
  if (isNaN(num)) return null;
  return num % 1 === 0 ? num : null;
}

// Realistic app access pattern on a trackedArray(1000):
// numeric-index access dominates during iteration, but method/property
// lookups interleave heavily with every computed-property re-derivation.
const METHOD_NAMES = [
  'length', 'map', 'filter', 'forEach', 'slice', 'find', 'findIndex',
  'includes', 'indexOf', 'some', 'every', 'reduce', 'concat',
  'constructor', 'toString', 'valueOf',
];

function buildMixedProps(indexCount, methodCount) {
  const out = [];
  for (let i = 0; i < indexCount; i++) out.push(String(i));
  for (let i = 0; i < methodCount; i++) out.push(METHOD_NAMES[i % METHOD_NAMES.length]);
  return out;
}

// Pattern A: pure iteration (mostly numeric indices)
// This matches Krausest's access pattern: the {{#each}} re-reads items by index.
const pureIteration = buildMixedProps(1000, 0);

// Pattern B: method-heavy (80% method names, 20% indices)
// Matches computed-property usage: arr.filter(x).map(y).length
// with some item reads interleaved.
const methodHeavy = buildMixedProps(200, 800);

// Pattern C: only non-index (length/map/etc.)
// Worst case for old form — pays Number() for every call.
const pureMethods = buildMixedProps(0, 1000);

const SCENARIOS = [
  { name: 'pure-iter  1000/0  (index-heavy)', props: pureIteration },
  { name: 'mixed      200/800 (method-heavy)', props: methodHeavy },
  { name: 'pure-meth  0/1000  (all methods)', props: pureMethods },
];

for (const s of SCENARIOS) {
  bench(`convertToInt old ${s.name}`, () => {
    let sum = 0;
    for (let i = 0; i < s.props.length; i++) {
      const r = convertToIntOld(s.props[i]);
      if (r !== null) sum += r;
    }
    return doNotOptimize(sum);
  });

  bench(`convertToInt new ${s.name}`, () => {
    let sum = 0;
    for (let i = 0; i < s.props.length; i++) {
      const r = convertToIntNew(s.props[i]);
      if (r !== null) sum += r;
    }
    return doNotOptimize(sum);
  });
}

await run({ throw: true });
