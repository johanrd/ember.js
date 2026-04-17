# large-app generator

Deterministic build-time fixture for Ember's `bin/build-bench` harness.

## Usage

```bash
pnpm --filter large-app generate        # regenerate app/**/generated/
pnpm --filter large-app build           # vite build (runs against generated files)
pnpm --filter large-app build:clean     # generate then build
```

## Reproducibility

Generation is seeded by `scripts/seed.json`. Two runs with the same seed produce
byte-identical output. `scripts/last-generation.json` (gitignored) holds the
manifest of produced paths + content hashes for verification.

**Before/after perf comparisons MUST pin:**

1. The same `seed.json` (counts, size ranges, rngSeed, version).
2. The same generator commit (`git log scripts/generate.mjs`).

If either changes, regenerate on both the base and head branches before
comparing — otherwise the comparison is apples-to-oranges.

## Tuning

Edit `seed.json`, then bump `version` and optionally `rngSeed` if the change
should produce visibly different output. Leaving both untouched but changing
counts will silently change the fixture — reviewer aid only, not a foot-gun.

## Non-goals

This app does not run correctly in a browser. Components reference missing
services, routes aren't wired through `Router.map`, service/helper/modifier
classes aren't semantically meaningful. The only contract is "vite build
succeeds"; anything beyond that is out of scope.
