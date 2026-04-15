# CLAUDE.md

This file provides guidance to Claude Code when working with the ember.js repository.

## Build System

There are **two separate build pipelines**. Getting them confused wastes significant time.

### Library Build (Rollup)

```bash
pnpm build          # runs rollup --config + types
```

- Builds `ember-source` and other publishable packages
- Output goes to `dist/` but this is the **library** output, not the test suite
- Required before running **smoke tests** (they link to the built packages)
- **Expected time: ~20s**

### Test Build (Vite)

```bash
npx vite build --mode development --minify false
```

- Builds the **test suite** into `dist/` (overwrites/augments library output)
- `pnpm test` runs against whatever is in `dist/` — it does NOT rebuild anything
- If you change test files or runtime source, you MUST run the vite build before `pnpm test`
- Config is in `vite.config.mjs` — note `enableLocalDebug: true` (LOCAL_DEBUG=true in tests)
- **Expected time: ~30s**

### The critical workflow for testing source changes:

```bash
npx vite build --mode development --minify false && pnpm test
```

Or use the combined command:

```bash
pnpm test:wip    # vite build + testem ci
```

## Running Tests

**IMPORTANT: Always set timeouts on test commands. Never use the default 2-minute timeout.**

### Main test suite (browser, Chrome via Testem)

```bash
pnpm test                    # runs testem against pre-built dist/
pnpm test:wip                # rebuilds via vite first, then runs testem
```

- **Expected time: ~2 minutes. Use timeout 300000 (5 min).**
- Uses `FailureOnlyReporter` — only failing tests appear in output
- 8700+ tests; if the count doesn't change after adding a test, the build is stale
- To verify a test runs: add a deliberate `assert.strictEqual(1, 2, 'canary')` failure
- To grep results: `pnpm test 2>&1 | grep -i "keyword"`
- `pnpm test` does NOT accept `--filter`. There is no way to run a subset from CLI.

### Smoke tests (published build simulation)

```bash
pnpm build                   # rebuild library first (rollup)
cd smoke-tests/scenarios
pnpm test                    # builds real Ember apps and runs their test suites
```

- **Expected time: ~2-3 minutes total. Use timeout 600000 (10 min).**
- Creates actual Ember applications using `scenario-tester`
- Links to workspace ember-source (the built output from `pnpm build`)
- **LOCAL_DEBUG=false, DEBUG=true** — matches real user dev environments
- Tests are defined inline in `basic-test.ts` via `project.mergeFiles()`
- Only the `embroiderVite` scenario is relevant for current work (v1 has pre-existing failures)
- **To skip v1 failures**: comment out `basicTest(v1AppScenarios, 'ember-test-app');` in `smoke-tests/scenarios/basic-test.ts` before running (don't commit this change)

### Node tests

```bash
pnpm test:node               # QUnit tests in tests/node/
```

- **Expected time: ~30s. Use timeout 120000 (2 min).**
- Currently has pre-existing failures on main (ember 7.0 deprecation removals)

### Linting

```bash
npx prettier --check .       # check formatting
npx prettier --write .       # fix formatting
pnpm lint                    # eslint (smoke-tests/ is excluded from eslint config)
```

- **Expected time: ~10s each. Use timeout 60000 (1 min).**

### Expected times summary

| Command          | Expected | Timeout to use | Notes                         |
| ---------------- | -------- | -------------- | ----------------------------- |
| `pnpm build`     | ~20s     | 120000         | Library only, not tests       |
| `vite build`     | ~30s     | 120000         | Test suite build              |
| `pnpm test`      | ~2 min   | 300000         | Does NOT rebuild              |
| `pnpm test:wip`  | ~2.5 min | 300000         | Rebuilds + runs               |
| smoke tests      | ~2-3 min | 600000         | Needs `pnpm build` first      |
| `pnpm test:node` | ~30s     | 120000         | Pre-existing failures on main |
| `pnpm lint`      | ~10s     | 60000          |                               |
| `prettier`       | ~10s     | 60000          |                               |

**If any command takes more than 2x the expected time, something is wrong. Stop and investigate — do not retry in a loop.**

## Debug Flags

Understanding these flags is critical for writing correct validation code:

| Flag          | Where it's true                       | Guard mechanism              |
| ------------- | ------------------------------------- | ---------------------------- |
| `LOCAL_DEBUG` | Inside this repo's test suite only    | `@glimmer/local-debug-flags` |
| `DEBUG`       | User app dev mode + this repo's tests | `@glimmer/env`               |

- `check()` from `@glimmer/debug` — **no-op when LOCAL_DEBUG=false**. Returns value as-is.
- `localAssert()` from `@glimmer/debug-util` — **no-op when LOCAL_DEBUG=false**.
- `if (DEBUG) { ... }` — runs in user dev mode. Use this for user-facing validation.

### Common bug pattern

Using `check()` or `localAssert()` for user-facing validation means errors are only caught inside this repo's tests, not in user apps. Use `if (DEBUG)` instead:

```typescript
// BAD: stripped in published builds, users get unhelpful TypeError
localAssert(typeof callback === 'function', 'Must pass a function');

// GOOD: works in user dev mode
if (DEBUG && typeof callback !== 'function') {
  throw new Error('Must pass a function');
}
```

## Test File Discovery

Tests are discovered via `import.meta.glob` in `index.html`:

```javascript
// packages/@ember/-internals/*/tests/**/*.{js,ts,gjs,gts}
// packages/*/*/tests/**/*.{js,ts,gjs,gts}
// packages/*/tests/**/*.{js,ts,gjs,gts}
```

Test files matching these globs are auto-discovered — no explicit imports needed.

## Smoke Test Patterns

### Testing error messages (setupOnerror)

For errors thrown during Ember's render loop, use `setupOnerror`/`resetOnerror`:

```javascript
import { render, setupOnerror, resetOnerror } from '@ember/test-helpers';

hooks.afterEach(function () {
  resetOnerror();
});

test('throws helpful error', async function (assert) {
  assert.expect(1);
  setupOnerror((error) => {
    assert.true(/expected pattern/.test(error.message));
  });
  await render(<template>...</template>);
});
```

For errors that throw synchronously from render (not caught by Ember's error handler), use try/catch:

```javascript
test('throws helpful error', async function (assert) {
  assert.expect(1);
  try {
    await render(<template>...</template>);
    assert.true(false, 'Expected render to throw');
  } catch (error) {
    assert.true(/expected pattern/.test(error.message));
  }
});
```

### Available imports in smoke test .gjs files

```javascript
import { fn } from '@ember/helper';
import { on } from '@ember/modifier';
import { render, click, setupOnerror, resetOnerror } from '@ember/test-helpers';
import { setupRenderingTest } from 'ember-qunit';
```

## Performance investigation: @glimmer/syntax

### Goal

Investigate whether `@glimmer/syntax`'s `preprocess()` function can be made faster for the IDE hot-path use case. This parser is the #1 bottleneck in Glint's per-keystroke pipeline, taking **2.3ms (56%)** of the ~4ms total `rewriteModule` cost. Profiled in a real Ember project (proapi-webapp) via instrumented Glint language server.

### Background

Glint is a TypeScript language server for Ember/Glimmer templates. On every keystroke in a `.gts` file, Glint calls `@glimmer/syntax`'s `preprocess()` to parse the Handlebars template, then generates TypeScript from the resulting AST. The 2.3ms includes both the parse and Glint's codegen — we need to split them.

The `@glimmer/syntax` package lives at `packages/@glimmer/syntax/` in this repo.
Glint uses `@glimmer/syntax@^0.95.0`.

### Investigation steps

#### 1. Benchmark the parser in isolation

Create a benchmark script (e.g., `packages/@glimmer/syntax/bench.mjs`):

```js
import { preprocess } from './lib/index.js'; // adjust path as needed

const small = `<div>{{this.title}}</div>`;

const medium = `
<div class="container">
  <h1>{{this.title}}</h1>
  {{#each this.items as |item index|}}
    <div class="item {{if item.active "active"}}">
      <span>{{item.name}}</span>
      <button {{on "click" (fn this.handleClick item)}}>Delete</button>
    </div>
  {{/each}}
  {{#if this.showFooter}}
    <footer>{{this.footerText}}</footer>
  {{/if}}
</div>`;

const large = medium.repeat(10);

for (const [name, tpl] of [
  ['small', small],
  ['medium', medium],
  ['large', large],
]) {
  const start = performance.now();
  const N = 1000;
  for (let i = 0; i < N; i++) preprocess(tpl);
  const elapsed = performance.now() - start;
  console.log(`${name}: ${(elapsed / N).toFixed(3)}ms per parse (${tpl.length} chars)`);
}
```

#### 2. Profile what preprocess() does internally

Read the source in `packages/@glimmer/syntax/lib/` to understand:

- What parser is used? (hand-written? PEG?)
- What phases: tokenize → parse → AST transform?
- Does it do work an IDE consumer doesn't need? (source printing, validation, normalization)
- Add `performance.now()` timing between phases to get a breakdown

#### 3. Check preprocess() options

Look at the function signature for options to:

- Skip AST plugins or transforms
- Use a lighter/partial mode
- Return a simpler AST

#### 4. Look for low-hanging fruit

- Unnecessary string allocations during tokenization
- Regex-heavy parsing that could use indexOf/charCodeAt
- AST node fields that Glint never reads
- Normalization passes that don't affect structure

#### 5. Check if incremental parsing is feasible

If only `{{item.name}}` changed to `{{item.label}}`, could we reparse just that node? Is there anything in the parser architecture that supports this?

#### 6. Compare versions

Check git log for perf-related changes. Run benchmark on the version Glint uses vs latest.

### What Glint needs from the AST

- All node types (ElementNode, MustacheStatement, BlockStatement, etc.)
- Source locations (loc.start, loc.end) for every node
- Full tree structure
- PathExpression head/tail for scope resolution

Glint does NOT need:

- Pretty-printing / source generation
- AST transforms (Glint does its own)

### Deliverables

1. Per-parse benchmark: small/medium/large templates
2. Breakdown of time inside `preprocess()` (tokenize vs parse vs post-process)
3. Concrete optimization opportunities with estimated impact
4. If quick wins exist, implement them and show before/after numbers
