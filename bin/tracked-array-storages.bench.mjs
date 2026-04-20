/**
 * Microbench for the TrackedArray #storages Map → Array change
 * (@glimmer/validator/lib/collections/array.ts).
 *
 * Per-index tag storage backs the fine-grained autotracking of individual
 * TrackedArray cells. The old form uses a Map<number, Tag>; NVP's change
 * replaces it with a flat Array (plus a threshold cap at 10k we're
 * intentionally not applying, to preserve semantics).
 *
 * Map.get/set has hash + collision overhead. Array[i] is a direct slot
 * read. For sequential iteration this should be a meaningful win.
 *
 * Risk: sparse-array de-opt. V8 transitions an array with holes to
 * dictionary mode, which is slower than Map. A pattern like reading
 * storage[500] before any other access creates 500 holes.
 *
 * Run:  pnpm bench:tracked-storages
 */

import { bench, do_not_optimize as doNotOptimize, run } from 'mitata';

function createTag() {
  return { rev: 1 };
}

class MapStorage {
  storages = new Map();

  read(index) {
    let s = this.storages.get(index);
    if (s === undefined) {
      s = createTag();
      this.storages.set(index, s);
    }
    return s.rev;
  }

  dirtyOne(index) {
    const s = this.storages.get(index);
    if (s) s.rev++;
  }

  dirtyAll() {
    this.storages.clear();
  }
}

class ArrayStorage {
  storages = [];

  read(index) {
    let s = this.storages[index];
    if (s === undefined) {
      s = createTag();
      this.storages[index] = s;
    }
    return s.rev;
  }

  dirtyOne(index) {
    const s = this.storages[index];
    if (s) s.rev++;
  }

  dirtyAll() {
    this.storages.length = 0;
  }
}

const SIZES = [100, 1000, 5000];

for (const size of SIZES) {
  // Pattern 1: pure sequential read (Krausest-like)
  bench(`Map   storage sequential-read  n=${size}`, () => {
    const s = new MapStorage();
    let sum = 0;
    for (let i = 0; i < size; i++) sum += s.read(i);
    return doNotOptimize(sum);
  });

  bench(`Array storage sequential-read  n=${size}`, () => {
    const s = new ArrayStorage();
    let sum = 0;
    for (let i = 0; i < size; i++) sum += s.read(i);
    return doNotOptimize(sum);
  });

  // Pattern 2: write-then-read cycle, dirtying entries in between.
  // Simulates a list that gets updated once per iteration.
  bench(`Map   storage write-read-cycle n=${size}`, () => {
    const s = new MapStorage();
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < size; i++) s.read(i);
      for (let i = 0; i < size; i += 10) s.dirtyOne(i);
    }
    return doNotOptimize(s);
  });

  bench(`Array storage write-read-cycle n=${size}`, () => {
    const s = new ArrayStorage();
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < size; i++) s.read(i);
      for (let i = 0; i < size; i += 10) s.dirtyOne(i);
    }
    return doNotOptimize(s);
  });
}

// Pattern 3: sparse — hole-creating access pattern.
// Read a large index first, then fill in. The Array variant may hit
// V8's dictionary-mode de-opt.
bench('Map   storage sparse-hole-then-fill n=1000', () => {
  const s = new MapStorage();
  let sum = s.read(999); // creates one entry at index 999 first
  for (let i = 0; i < 1000; i++) sum += s.read(i);
  return doNotOptimize(sum);
});

bench('Array storage sparse-hole-then-fill n=1000', () => {
  const s = new ArrayStorage();
  let sum = s.read(999);
  for (let i = 0; i < 1000; i++) sum += s.read(i);
  return doNotOptimize(sum);
});

bench('Map   storage sparse-random-access n=1000', () => {
  const s = new MapStorage();
  let sum = 0;
  // Semi-random access that V8 can't easily pattern-match.
  for (let i = 0; i < 1000; i++) sum += s.read((i * 7919) % 1000);
  return doNotOptimize(sum);
});

bench('Array storage sparse-random-access n=1000', () => {
  const s = new ArrayStorage();
  let sum = 0;
  for (let i = 0; i < 1000; i++) sum += s.read((i * 7919) % 1000);
  return doNotOptimize(sum);
});

await run({ throw: true });
