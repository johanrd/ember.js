# Build-time perf investigation

Running log of the build-time performance work that started 2026-04-18, kicked
off from the plan at `~/.claude/plans/concurrent-swimming-valley.md`.

**Context**: two recent landed wins (#21314 newline-offset cache, #21318 callParts
double-normalization) optimized the **template precompile** path. Template
precompile is only ~15% of a real consumer app's `vite build`. This initiative
builds measurement infrastructure, identifies hot paths in the other ~85%, and
tries optimizations against a realistic fixture.

Work runs on **local branches only** — nothing pushed, no PRs opened, unless
explicitly requested.

---

## Branch map

| Branch | Purpose | Status | Depends on |
|---|---|---|---|
| `perf/build-bench-harness` | PR 1: Vite/Rollup plugin-hook timing wrapper, runner, diff tool, cold-prod scenario | landed (local) | `main` |
| `perf/build-bench-largeapp` | PR 2: ~1000-file deterministic `smoke-tests/large-app` fixture | landed (local) | `perf/build-bench-harness` |
| `perf/build-bench-cold-dev` | PR 3: cold-dev scenario (vite dev startup time) + cpuprof analyzer + fs-trace preload | landed (local) | `perf/build-bench-largeapp` |
| `perf/largeapp-babel-config-pin` | PR candidate: pin `configFile` + `babelrc: false` in fixture vite.config | landed (local, standalone) | `perf/build-bench-largeapp` |
| `perf/largeapp-maybe-babel` | PR candidate: `maybeBabel` pattern (from @NullVoxPopuli / AuditBoard) — skip babel on files that don't need it | landed (local) | `perf/largeapp-babel-config-pin` |

**Critical distinction**: the `-babel-config-pin` and `-maybe-babel` branches are
**fixture changes**, not ember-source changes. They measure what a
well-configured consumer app gains. The corresponding consumer-facing fix
belongs upstream in `@embroider/vite` (recommended — see "Upstream PRs" below),
not in this repo.

---

## Measurement infrastructure

Everything under `bin/build-bench/` on the `perf/build-bench-cold-dev` branch:

- **`wrap-plugins.mjs`** — wraps every Vite/Rollup plugin's hooks
  (resolveId, load, transform, renderChunk, transformIndexHtml, build*,
  generateBundle, writeBundle) with `performance.now()` timing. Emits NDJSON per
  hook invocation + samples peak RSS.
- **`bench-vite-config.mjs`** — vite config shim loaded via `--config`; imports
  the target app's real config and replaces its plugin array with the wrapped
  version. No app-side changes required.
- **`run.mjs`** — orchestrator. Flags: `--scenario`, `--app`, `--runs`, `--out`.
  Aggregates per-plugin/hook, per-extension, per-plugin×extension stats.
- **`diff.mjs`** — markdown diff of two summary JSONs. Flags wall deltas that
  exceed the base p5–p95 noise width.
- **`scenarios/cold-prod.mjs`** — full vite build from clean caches.
- **`scenarios/cold-dev.mjs`** — vite dev-server startup ("ready in Xms").
  Invokes vite's binary directly (bypasses `pnpm vite`'s output buffering) and
  strips ANSI color codes before regex-matching the ready line.
- **`analyze-cpuprof.mjs`** — post-process a `node --cpu-prof` output. Top-N by
  self-time or total-time, optional `--filter` substring over function/url.
- **`trace-fs.cjs`** — preload (`NODE_OPTIONS=--require …`) that monkey-patches
  fs (sync + callback + promises). Records per-op count + summed wall + per-path
  hits. Preserves non-enumerable own props like `fs.realpathSync.native`.

**Fixture**: `smoke-tests/large-app/` — deterministic 1055-file synthetic Ember
app (~2.35 MB source). Generator seeded by `scripts/seed.json` (rngSeed 287645193,
version 1). Distribution: 400 leaf `.gjs`, 120 mid `.gts`, 60 routes/controllers
each (`.ts`), 60 route-template components, 25 admin-template components, 40
services, 200 utility `.js`, 60 helpers + 30 modifiers. All generated files live
under `app/**/generated/` and are `.gitignore`d; only the generator + seed are
tracked. Running the bench requires `pnpm --filter large-app generate` first (or
running it once from the generator directly).

**Key usage recipe**:
```bash
# Baseline on main
pnpm --filter large-app generate
pnpm build:js     # ember-source must be built for fixture to resolve it
node bin/build-bench/run.mjs --scenario cold-prod --app large-app --runs 3 \
  --out .bench/BASE.json

# Experiment
git checkout <feature-branch>
pnpm build:js
node bin/build-bench/run.mjs --scenario cold-prod --app large-app --runs 3 \
  --out .bench/HEAD.json

# Diff
node bin/build-bench/diff.mjs .bench/BASE.json .bench/HEAD.json
```

For attribution questions the plugin-wrapper can't answer (e.g. what's INSIDE a
hot plugin), add `NODE_OPTIONS="--cpu-prof --cpu-prof-dir=.bench/profiles"` and
feed the `.cpuprofile` to `analyze-cpuprof.mjs`.

---

## Findings, scored

Scoring legend (1–10, higher = better):
- **Measurability**: how confidently can we attach numbers to the change?
- **Improvement**: observed or expected wall-clock gain, ms per build.
- **Complexity**: *inverse* of how hard the change is. 10 = one line, no risk.
  1 = large refactor with correctness risk.

### Landed wins

#### `perf/largeapp-babel-config-pin` — pin `configFile` in babel
- **Measurability**: **9/10**. Clean before/after on a deterministic fixture,
  3 runs × 2 configs, noise floor ~90–300ms on an 11s build. Delta 395ms
  exceeds noise width comfortably. Also confirmed via fs-trace
  (64,515 → 16,473 syscalls, −74%) and cpu-prof (idle time 4051ms → 3682ms).
- **Improvement**: **4/10**. 395ms median wall, −3.5% on large-app cold-prod.
  Real but modest on SSD + warm caches. Likely larger on WSL / Docker / CI
  (cold caches, slower fs). The syscall-count reduction is dramatic even
  where wall-time is not.
- **Complexity**: **9/10**. 10-line change in one file. Safe for any Ember v2
  app that keeps its babel config at root (the standard layout). Disabling
  `babelrc` is mildly riskier (breaks per-directory `.babelrc` overrides) but
  those are rare in v2 Ember. `configFile`-only is strictly safe.

#### `perf/largeapp-maybe-babel` — skip babel on files that don't need it
- **Measurability**: **9/10**. Same setup as above. Caught a bug during
  bring-up (id-regex overlap double-babel'd .gjs → 15% *slower*), which
  validates the harness.
- **Improvement**: **5/10**. Additional 247ms on top of the pin (10.76s →
  10.52s). Total 642ms vs unpinned baseline (−5.8%). Almost all CPU savings
  (only ~500 fewer syscalls vs pin-only). The fixture **under-represents**
  realistic gains because every generated `.ts` controller/service/modifier
  has `@tracked`/`@action`, so they all keep going through babel. A real app
  with more plain utility modules would see larger savings.
- **Complexity**: **5/10**. Needs two mutually-exclusive filtered plugins
  (fix vs the original snippet). Still in-repo ≤ 50 LOC, but needs care to
  keep the list of "babel-required imports" accurate for consumers (they'd
  get surprising behavior if they added a new such import and forgot to
  update the list).

### Rejected hypotheses (don't revisit without new evidence)

#### `visitNode` double-`JSON.stringify` in `packages/@glimmer/syntax/lib/traversal/traverse.ts:116`
- Plausible on paper — runs on every `visitNode` where the handler returned a
  non-null result, double-serializes a deep AST subtree.
- Prototyped a `result === node` fast path + JSON.stringify fallback. Built
  ember-source, ran `pnpm bench:precompile` on 3 fixture sizes. **All
  numbers within noise (+0.3–+2.0%, ranges overlap).**
- Cross-checked via cpu-prof: `JSON.stringify` total self-time across a 12s
  build is **1.2 ms**. The 700ms of `visitNode` self-time is dispatch,
  destructure, and call overhead — not the stringify.
- Branch deleted. Memory written (`feedback_bench_attribution.md`) so this
  class of over-attribution (plugin-wrapper over-reports async hook cost vs
  actual CPU by 100–1000×) doesn't trip us up again.

### Not attempted

- **Bumping `UV_THREADPOOL_SIZE`**: tested via env var, no wall-clock
  improvement (within noise). 4s of "idle" in the cpu-profile is real disk
  throughput, not pool starvation. Not worth a change.
- **`UV_THREADPOOL_SIZE` documentation**: no-op for this workload; skipping.
- **External package fixes** (`@rollup/plugin-babel` default walk,
  `babel-plugin-ember-template-compilation` internals,
  `decorator-transforms`): out of scope for in-repo PRs.

---

## Open leads (next to investigate)

### Incremental scenarios (HMR)
- **Measurability**: **7/10** (est). HMR latency is debounce-floor-limited
  (~100ms chokidar), so small deltas hide. Need high run counts.
- **Improvement**: unknown. Incremental rebuilds dominate dev-time user
  experience; even modest per-change savings compound across a day of edits.
  If any plugin re-runs on >1 file after a one-file touch, that's a
  cache-invalidation bug — worth catching.
- **Complexity**: **5/10**. WS client to subscribe to vite HMR events, fs
  `utimes` to touch a file, measure time-to-update. One-off scaffolding,
  nothing deeply tricky.
- Status: about to tackle.

### Repeated `realpathSync` on `@babel/runtime/package.json` (1,211× on large-app)
- **Measurability**: **8/10** (fs-trace is directly attributable).
- **Improvement**: likely small in ms (3.5ms summed) but the pattern repeats
  in other packages too. A per-process memoization of `@babel/runtime`
  resolution inside `@babel/plugin-transform-runtime` could remove it
  entirely.
- **Complexity**: **3/10** (if fixed in `@babel/plugin-transform-runtime`;
  external repo) or **6/10** (if worked around in `@embroider/vite`'s babel
  wrapper via `absoluteRuntime`).
- Status: not started.

### Real-world-app calibration
- **Measurability**: **5/10**. Real apps have stable call graphs but noisy
  deps and we can't modify them — pure calibration signal.
- **Improvement**: N/A (no change). Validates that large-app's findings port
  to a real consumer.
- **Complexity**: **4/10**. Pin a public Ember app (Ghost admin / Discourse
  fork), script a one-shot bench, record numbers. Re-run on a cadence.
- Status: not started. Would be a good sanity-check before filing upstream
  PRs.

---

## Upstream PRs recommended (do not file until user says)

### PR A: `@embroider/vite` exports `emberBabel(options)` helper
- Pre-resolves the user's babel config file path once at vite-config time,
  passes it as `configFile` to `@rollup/plugin-babel`. Avoids the per-file
  walk.
- Opt-in: users import `emberBabel` instead of `babel`.
- Doesn't touch `babelrc` — safer default.
- Measured benefit (large-app): −395ms / −3.5% on cold prod builds; −47k
  syscalls.

### PR B: Ember v2 app blueprint uses `emberBabel`
- One-line swap in the generated `vite.config.mjs`. Flows the benefit to new
  apps automatically; existing apps opt in at their own pace.
- Depends on PR A landing first.

### **Not** recommended upstream
- PR to change `@rollup/plugin-babel`'s default config-discovery behavior —
  too broad a blast radius.
- Shipping `babelrc: false` as a default anywhere until we survey the
  addon ecosystem for `.babelrc` usage.
- `maybeBabel` as a default in `@embroider/vite` — the list of
  "babel-required imports" is Ember-specific, opt-in via a named helper is
  fine but needs careful wording so consumers understand the filter
  semantics.

---

## How to use this document

- **Before starting a new investigation**: read the "Findings, scored" and
  "Rejected hypotheses" sections. Don't re-try rejected paths without new
  measurement evidence.
- **After landing a branch**: add a scorecard entry.
- **Before filing upstream**: reconcile against "Upstream PRs recommended" —
  make sure the PR shape matches what was measured.
- **Branch hygiene**: keep branches local unless filing. Re-run benches
  whenever rebasing onto new `main` — noise floors shift with ember-source
  build changes.
