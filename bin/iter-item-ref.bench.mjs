/**
 * Microbench for the iterTag fast path on ReferenceImpl
 * (@glimmer/reference/lib/reference.ts) + createIteratorItemRef.
 *
 * Each iterator item in a {{#each}} gets its own reference. The old form
 * opens a track() frame on every valueForRef() call (allocate Tracker,
 * push OPEN_TRACK_FRAMES, consume a single tag, close, combine()) just
 * to return the one tag back. The new form stores the tag directly on
 * the ref (iterTag field) and skips the track machinery entirely.
 *
 * Isolated cost measured here by simulating the two code paths with
 * minimal stubs (no real tag validator, no real tracking global state).
 *
 * Run:  pnpm bench:iter-item-ref
 */

import { bench, do_not_optimize as doNotOptimize, run } from 'mitata';

// Minimal tag stubs
function createTag() {
  return { rev: 1 };
}
function validateTag(tag, snap) {
  return snap >= tag.rev;
}
function valueForTag(tag) {
  return tag.rev;
}
function consumeTag(tag) {
  // real impl pushes to CURRENT_TRACKER.tags
  if (CURRENT_TRACKER !== null) CURRENT_TRACKER.add(tag);
}

// --- OLD path: Tracker + OPEN_TRACK_FRAMES ---
class Tracker {
  tags = new Set();
  last = null;

  add(tag) {
    this.tags.add(tag);
    this.last = tag;
  }

  combine() {
    if (this.tags.size === 0) return CONSTANT_TAG;
    if (this.tags.size === 1) return this.last;
    return { rev: 1 }; // would-be combinator; irrelevant for single-tag case
  }
}
const CONSTANT_TAG = { rev: 0 };
let CURRENT_TRACKER = null;
const OPEN_TRACK_FRAMES = [];

function track(fn) {
  OPEN_TRACK_FRAMES.push(CURRENT_TRACKER);
  CURRENT_TRACKER = new Tracker();
  try {
    fn();
  } finally {
    const current = CURRENT_TRACKER;
    CURRENT_TRACKER = OPEN_TRACK_FRAMES.pop() ?? null;
    return current.combine();
  }
}

// Old iterator-item ref factory + valueForRef path
function makeOldRef(value) {
  let currentValue = value;
  let tag = createTag();
  return {
    tag: null,
    lastRevision: 1,
    lastValue: undefined,
    compute: () => {
      consumeTag(tag);
      return currentValue;
    },
    update: (newValue) => {
      if (currentValue !== newValue) {
        currentValue = newValue;
        tag.rev++;
      }
    },
  };
}

function valueForRefOld(ref) {
  let { tag } = ref;
  if (tag === null || !validateTag(tag, ref.lastRevision)) {
    const newTag = track(() => {
      ref.lastValue = ref.compute();
    });
    tag = ref.tag = newTag;
    ref.lastRevision = valueForTag(newTag);
  }
  consumeTag(tag);
  return ref.lastValue;
}

// --- NEW path: iterTag direct ---
function makeNewRef(value) {
  return {
    tag: null,
    lastRevision: 1,
    lastValue: value,
    iterTag: createTag(),
  };
}

function valueForRefNew(ref) {
  let { tag } = ref;
  if (tag === null || !validateTag(tag, ref.lastRevision)) {
    const iterTag = ref.iterTag;
    if (iterTag !== null) {
      tag = ref.tag = iterTag;
      ref.lastRevision = valueForTag(iterTag);
    } else {
      // would do track() — not exercised for iterator-item refs
    }
  }
  consumeTag(tag);
  return ref.lastValue;
}

// Simulate a {{#each}} with N items, re-read by outer render pass.
// valueForRef on each item-ref is called many times — once per render,
// plus every time a downstream consumer re-validates.
const N = 1000;
const ITEMS = Array.from({ length: N }, (_, i) => ({ id: i, label: `Row ${i}` }));

const oldRefs = ITEMS.map((v) => makeOldRef(v));
const newRefs = ITEMS.map((v) => makeNewRef(v));

// Warm a tracking frame so consumeTag isn't a no-op
function withFrame(fn) {
  OPEN_TRACK_FRAMES.push(CURRENT_TRACKER);
  CURRENT_TRACKER = new Tracker();
  try {
    fn();
  } finally {
    CURRENT_TRACKER = OPEN_TRACK_FRAMES.pop() ?? null;
  }
}

bench(`valueForRef old (track frame) ${N}× in outer frame`, () => {
  let sum = 0;
  withFrame(() => {
    for (let i = 0; i < N; i++) {
      const v = valueForRefOld(oldRefs[i]);
      sum += v.id;
    }
  });
  return doNotOptimize(sum);
});

bench(`valueForRef new (iterTag direct) ${N}× in outer frame`, () => {
  let sum = 0;
  withFrame(() => {
    for (let i = 0; i < N; i++) {
      const v = valueForRefNew(newRefs[i]);
      sum += v.id;
    }
  });
  return doNotOptimize(sum);
});

// Second pass: revisiting cached refs (tag !== null, validateTag true).
// Tests the hot-path cost difference after the first valueForRef has populated.
const oldRefsWarm = ITEMS.map((v) => {
  const r = makeOldRef(v);
  withFrame(() => valueForRefOld(r));
  return r;
});
const newRefsWarm = ITEMS.map((v) => {
  const r = makeNewRef(v);
  withFrame(() => valueForRefNew(r));
  return r;
});

bench(`valueForRef old (warm cache) ${N}× in outer frame`, () => {
  let sum = 0;
  withFrame(() => {
    for (let i = 0; i < N; i++) {
      const v = valueForRefOld(oldRefsWarm[i]);
      sum += v.id;
    }
  });
  return doNotOptimize(sum);
});

bench(`valueForRef new (warm cache) ${N}× in outer frame`, () => {
  let sum = 0;
  withFrame(() => {
    for (let i = 0; i < N; i++) {
      const v = valueForRefNew(newRefsWarm[i]);
      sum += v.id;
    }
  });
  return doNotOptimize(sum);
});

await run({ throw: true });
