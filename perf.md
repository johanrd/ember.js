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
| `perf/build-bench-cold-dev` | PR 3: cold-dev scenario (vite dev startup time) + cpuprof analyzer + fs-trace preload + this perf.md | landed (local) | `perf/build-bench-largeapp` |
| `perf/build-bench-incremental` | PR 4: `incr-template` HMR-latency scenario (WS client to vite HMR socket) | landed (local) | `perf/build-bench-cold-dev` |
| `perf/largeapp-babel-config-pin` | PR candidate: pin `configFile` + `babelrc: false` in fixture vite.config | landed (local, standalone) | `perf/build-bench-largeapp` |
| `perf/largeapp-maybe-babel` | PR candidate: `maybeBabel` pattern (from @NullVoxPopuli / AuditBoard) — skip babel on files that don't need it | landed (local) | `perf/largeapp-babel-config-pin` |
| `perf/pr-pathexpression-original-getter` | **filed as [#21](https://github.com/johanrd/ember.js/pull/21) on johanrd/ember.js (draft)** — compile-time getter fix | pushed | `main` |
| `perf/destroyable-remove-swap-pop` | **filed as [#23](https://github.com/johanrd/ember.js/pull/23) on johanrd/ember.js (draft)** — runtime destroyable splice→swap+pop | pushed | `main` |
| ~~`perf/whitespace-trim-native`~~ | ~~was PR candidate: regex → `trim*`~~ | **retracted** (was PR 22, closed; null under interleaved A/B) | — |

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
- **`scenarios/incr-template.mjs`** — HMR round-trip latency. Starts vite dev,
  warms the module graph, opens a WebSocket to the HMR socket (`vite-hmr`
  subprotocol), rewrites a target file with a bumped comment, waits for the
  next `update`/`full-reload` message. Reports per-iteration latencies, reload
  kind, and update counts.
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

#### `perf/destroyable-remove-swap-pop` → **PR 23 (draft)** — splice → swap-and-pop

- **What**: `packages/@glimmer/destroyable/index.ts:58` replaces `collection.splice(index, 1)` with swap-with-last + `collection.pop()`. Avoids the O(n) element shift `splice` does. `indexOf` lookup unchanged.
- **Why spec-identical**: element order is not observable. Only consumer of the collection is `iterate()` → `Array.prototype.forEach`. No caller asserts a particular order among destroyable siblings. Parent-side removal is batched via `scheduleDestroyed`, so a child is never spliced out while the parent is iterating.
- **Measurability**: **10/10**. TracerBench 20-fidelity compare vs origin/main:
  - `clearManyItems1End`: **−43 ms / −21.3 %** (90 % CI [−46, −40])
  - `clearManyItems2End`: **−40 ms / −39.5 %** (90 % CI [−46, −36])
  - `render1000Items1End`: −2.9 % (small)
  - all other 17 phases: no difference
- **Improvement**: **6/10**. Concentrated, huge on clear-5000. No regressions anywhere.
- **Complexity**: **10/10**. 5-line diff, one file.

#### `perf/pr-pathexpression-original-getter` → **PR 21 (draft)** — array-spread → direct concat

- See earlier scorecard entry. Shipped as a 2-line diff with a ≤ 5 % precompile-size gain on the narrow mitata bench (−1 % to −1.6 % on `precompile` sizes).

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

### Runtime investigation (non-compile-path, 2026-04-18/19)

Captured a runtime CPU profile via `bin/build-bench/capture-runtime-profile.mjs` (puppeteer-free; uses `chrome-debugging-client` from tracerbench's transitive deps) while benchmark-app ran the full Krausest sequence. Analyzed ember-source-internal frames aggregated by function name. Concentrated self-time in prod-unminified build (debug code stripped, names preserved):

- `remove` (destroyable): 80 ms → **addressed by PR 23**
- `getDestroyableMeta`: 45 ms — inspected; WeakMap lookup + object allocation on miss, already minimal
- `evaluate` / `next` / `_execute` (Glimmer VM): 25–36 ms each — too core to touch
- `getValue` / `valueForRef` (cache / reference reads): 17–22 ms — already tight
- `add` (Tracker): 18.5 ms — can't touch (Set is the right data structure, see §Rejected)
- `setCustomTagFor` / `tagMetaFor` / `tagFor`: 5–13 ms each — simple Map ops

**Conclusion**: Glimmer runtime is heavily tuned. Remaining self-time is spread thinly across many tiny frames (5–20 ms each); no concentrated anti-pattern. The one clean win (destroyable `remove`) has shipped as PR 23.

**Rejected runtime experiments (all tracerbench-validated)**:

1. *Destroyable children Array→Set on top of PR 23* — 20-fidelity tracerbench: clearManyItems1 slightly better (−48 vs −43), clearManyItems2 **worse** (−30 vs −40), +1 ms regression on clearItems4. Net not clearly better than PR 23 alone. Set iteration / allocation overhead offsets the O(1) delete benefit for the typical sizes.
2. *Tracker instance pool (cap 16)* — duration −2.3 %, clearManyItems2 −43 % (!), but several sharp regressions: clearItems4 +22.7 %, swapRows1 +13.4 %, append1000Items2 +10.8 %.
3. *Tracker instance pool (cap 4)* — most regressions gone but net-neutral (duration phase: no difference). Not worth shipping.
4. *Tracker Set → Array (earlier session)* — **+20 % duration regression**. Set is the right data structure for tag accumulation. See `feedback_runtime_perf_rules.md`.
5. *ArrayIterator: pool the `{ key, value, memo }` iteration item* — looked like a clean allocation-reduction (5000 alloc/sync for a 5000-row `{{#each}}`). Tracerbench: **+51 ms / +2.2 % duration regression**, render5000Items1/2 +3–3.5 %, render1000Items3 +6.7 %. V8's escape analysis was already eliding the per-iteration allocation entirely; manually pooling it into a persistent field turns free short-lived object literals into real property writes and disables the optimization.
6. *List block bulk DOM clear via `Range.deleteContents`* — for the "all old items deleted" case in `ListBlockOpcode.sync()`, replaced the per-item `clear(opcode)` loop (5000× `removeChild`) with a single `Range.deleteContents` + a per-item `destroy()` for destructor teardown. Tracerbench: **no difference on any phase**. The per-call `removeChild` cost was only ~78 ms self across the entire 45 s benchmark (not per-phase), well under tracerbench's noise floor on any one phase. Browsers already batch mutation-triggered reflows across a sync microtask, so 5000 `removeChild` calls don't cost 5000× a single Range removal.
7. *Destroyable bulk teardown (`destroyChildrenAtomic`)* — added a new destroyable API that nulls `parent.children` upfront, making the per-child scheduled `removeChildFromParent` short-circuit instead of doing an O(n) `indexOf` scan. For clear-5000 this moves the total cost from O(n²) to O(n) — the one remaining algorithmic improvement in the destroyable path after PR 23 landed. Wired it into `ListBlockOpcode.sync()` for the all-items-deleted case. Tracerbench results were **inconsistent between two identical 20-fidelity runs**: run 1 showed "no difference" on every phase (with wide CIs [−54, +37] ms on duration); run 2 showed **+19 % regression on clearManyItems2End** (the phase this was supposed to optimize!) and +9 % on render1000Items3. CPU profile suggested a −177 ms idle reduction end-to-end, but `remove` self-time went *up* 17 ms on the atomic branch — a counterintuitive signal. Hypothesis: reordering destruction so all `destroy()` calls happen before any `clear()` (instead of the original interleaved `destroy→clear` per item) may leave opcodes' `bounds.firstNode`/`lastNode` in a state where subsequent `clear(opcode)` mis-walks the DOM. Not chased further because the run-to-run inconsistency alone disqualified it from shipping.

### HMR investigation (large-app)

Data from `incr-template` scenario, 10 iterations each, 250ms pause between.

| target file | touch → update latency (median) | kinds | update count/iter |
|---|---:|---|---:|
| `leafComponent-0.gjs` | 113 ms | all full-reload | 1 |
| `controller-0.ts` | 114 ms | all full-reload | 1 |

**The headline isn't the latency** — it's the reload kind. **100% of Ember
source-file edits trigger `full-reload`, not granular HMR.** Every edit forces
the whole page to reload; component state is not preserved; Vite's HMR core
benefit isn't being realized.

Root cause: the compiled template output from
`babel-plugin-ember-template-compilation` doesn't declare
`import.meta.hot.accept()` boundaries. When any module in the graph changes and
no ancestor accepts hot updates, Vite falls back to a full reload.

- **Measurability**: **8/10**. Latency numbers stable (noise ±25ms off the
  ~100ms debounce floor). Reload-kind distribution is binary and deterministic.
- **Improvement**: **N/A for latency** (near the chokidar floor, not easily
  moved). **But potentially huge for dev-UX** if granular HMR could be wired
  up — preserving component state across edits is a category-of-one win, not a
  wall-clock one.
- **Complexity**: **2/10** for the fix. This is an upstream concern in
  `babel-plugin-ember-template-compilation` and/or `@embroider/vite`. Ember
  Glimmer components would need a runtime path for accepting their new
  compiled template on hot update. Non-trivial — probably not a small PR.

Other observations:
- After a `full-reload`, Vite's server assumes the browser reloaded the page.
  A non-browser client (like this scenario) must re-fetch the target URL,
  otherwise the next edit fires no event. The scenario handles this with a
  post-iteration `fetch`.
- No cache-invalidation bugs: each event reports exactly 1 file.

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

### Granular HMR for Ember templates (NEW — investigate upstream)
Moved from "open leads" to "next-steps" after the HMR data landed. See
"HMR investigation (large-app)" above.
- Potential dev-UX win: preserve state across edits, no more full reload.
- Belongs in `babel-plugin-ember-template-compilation` (emit hot-accept
  wrapper) and/or Ember runtime (accept the hot-updated template module).
- Not a wall-clock win — a category-change in dev UX.

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

### Upstream *discussion* worth starting
- **HMR boundaries for Ember templates**. Current behaviour (100%
  full-reload on any .gjs/.ts edit) is a dev-UX gap. Not a quick PR — likely
  needs runtime + template-compilation co-design — but worth raising with
  the Ember/embroider team. Probably a design-doc or issue first.

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
