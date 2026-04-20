/**
 * Microbench for MonomorphicTagImpl[COMPUTE] Math.max → manual compare
 * (@glimmer/validator/lib/validators.ts).
 *
 * A combinator tag with N subtags walks the array and reduces their
 * revisions to a max. The old form calls Math.max on each iteration; the
 * new form uses inline > / !== comparison. In isolation, N scales the
 * per-call cost; the question is whether the manual comparison wins
 * enough per iteration to beat Math.max intrinsic.
 *
 * Run:  pnpm bench:monomorphic-tag-compute
 */

import { bench, do_not_optimize as doNotOptimize, run } from 'mitata';

// Minimal subtag stub — each has a revision and a compute function.
function makeSubtag(rev) {
  const t = { rev };
  t[COMPUTE] = () => t.rev;
  return t;
}

const COMPUTE = Symbol('COMPUTE');

class OldCombinator {
  constructor(subtags) {
    this.subtag = subtags;
    this.revision = 1;
    this.lastChecked = 0;
    this.lastValue = 1;
    this.isUpdating = false;
  }

  [COMPUTE]() {
    if (this.isUpdating) {
      return this.lastValue;
    }

    this.isUpdating = true;
    this.lastChecked = 1;

    try {
      let { subtag, revision } = this;
      for (const tag of subtag) {
        let value = tag[COMPUTE]();
        revision = Math.max(value, revision);
      }
      this.lastValue = revision;
      return revision;
    } finally {
      this.isUpdating = false;
    }
  }
}

class NewCombinator {
  constructor(subtags) {
    this.subtag = subtags;
    this.revision = 1;
    this.lastChecked = 0;
    this.lastValue = 1;
    this.isUpdating = false;
  }

  [COMPUTE]() {
    if (this.isUpdating) {
      return this.lastValue;
    }

    this.isUpdating = true;
    this.lastChecked = 1;

    try {
      let { subtag, revision } = this;
      for (let i = 0; i < subtag.length; i++) {
        let value = subtag[i][COMPUTE]();
        if (value > revision || value !== value) revision = value;
      }
      this.lastValue = revision;
      return revision;
    } finally {
      this.isUpdating = false;
    }
  }
}

// Representative subtag-array sizes:
// - 4   — small component tree (~ Krausest single-row scope)
// - 32  — medium render (medium template)
// - 256 — deep component tree with many child refs
const SIZES = [4, 32, 256];

for (const n of SIZES) {
  const subtagsFlat = Array.from({ length: n }, (_, i) => makeSubtag(i + 1));

  bench(`COMPUTE old Math.max  N=${n}`, () => {
    const c = new OldCombinator(subtagsFlat);
    return doNotOptimize(c[COMPUTE]());
  });

  bench(`COMPUTE new manual    N=${n}`, () => {
    const c = new NewCombinator(subtagsFlat);
    return doNotOptimize(c[COMPUTE]());
  });
}

// Volatile tag (revision = NaN) scenarios — exercise the !== branch
const volatileSubtags = [
  makeSubtag(1),
  makeSubtag(2),
  makeSubtag(NaN),
  makeSubtag(3),
  makeSubtag(4),
];
bench('COMPUTE old Math.max  N=5 w/ volatile', () => {
  const c = new OldCombinator(volatileSubtags);
  return doNotOptimize(c[COMPUTE]());
});

bench('COMPUTE new manual    N=5 w/ volatile', () => {
  const c = new NewCombinator(volatileSubtags);
  return doNotOptimize(c[COMPUTE]());
});

await run({ throw: true });
