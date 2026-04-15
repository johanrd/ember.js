## Summary

Remove dead code, dead files, and unused dependencies across the codebase. 25 files changed, 218 lines deleted.

Every removal was verified: zero imports/references in the codebase, tests pass (8788/8788), docs coverage passes, build succeeds. No behavior or API changes.

## What's removed

### Dead files (6)

All genuinely orphaned — none are development scaffolds.

| File                      | Orphaned since | Cause                                                                               |
| ------------------------- | -------------- | ----------------------------------------------------------------------------------- |
| `modifiers/internal.ts`   | Oct 2021       | Legacy built-in components removed (`3e6c348e`)                                     |
| `templates/empty.ts`      | Oct 2021       | Legacy built-in components removed (`3e6c348e`)                                     |
| `debug-render-message.ts` | Jul 2020       | VM tracking refactor removed sole consumer (`ba16712b`)                             |
| `syntax/utils.ts`         | Oct 2020       | Glimmer VM 0.67.0 upgrade deleted sole consumer (`0c2f1f89`)                        |
| `dependent_keys.ts`       | ~2019          | Pre-Octane computed system replaced by autotracking; file contains only `export {}` |
| `public-types.ts`         | Never used     | Created Oct 2024 (`f528512c`) but never imported or wired up                        |

### Unused exports removed (15 symbols across 10 files)

These symbols are still used within their own files — only the unnecessary `export` keyword is removed. None are part of the public API or re-exported through any barrel file.

- **glimmer/component-managers:** `rerenderInstrumentDetails`, `CURLY_CAPABILITIES`, `ROOT_CAPABILITIES`
- **glimmer/helper.ts:** `RECOMPUTE_TAG`, `SIMPLE_CLASSIC_HELPER_MANAGER`
- **glimmer/renderer.ts:** `RendererState`, `BaseRenderer`
- **glimmer/resolver.ts:** `BUILTIN_KEYWORD_HELPERS`, `BUILTIN_HELPERS`
- **glimmer/utils/bindings.ts:** `createColonClassNameBindingRef`
- **metal/alias.ts:** `AliasedProperty`
- **metal/decorator.ts:** `COMPUTED_GETTERS`
- **metal/each_proxy_events.ts:** `EACH_PROXIES`
- **metal/observer.ts:** `deactivateObserver`, `destroyObservers`
- **views/system/utils.ts:** `initChildViews`, `collectChildViews`, `getViewRange`

### Dead imports and dead code removed (5 files)

- **`@glimmer/debug/lib/debug.ts`:** Removed entire `@glimmer/constants` import (5 symbols), entire `@glimmer/vm` import (9 symbols), and `ProgramConstants` type — none used in the file. (The `$fp` in template literal `{$fp+${value}}` is a string literal, not the imported `$fp` constant.)
- **`@glimmer/program/lib/program.ts`:** Removed `private handle = 0` — a private field that is initialized but never read.
- **`destroyables-test.ts`:** Removed unused `GlobalContext` type import.
- **`iterable-test.ts`:** Removed unused `GlobalContext`, `unwrap`, `testOverrideGlobalContext` imports.
- **`template.test.ts`:** Removed unused `EmberPrecompileOptions` type import.

### Unused dependencies removed (9 packages)

All have clear removal timelines — the code that used them was already deleted in prior PRs.

| Dependency                     | Added    | Became unused | Cause                                                                                                   |
| ------------------------------ | -------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `@ember/edition-utils`         | Sep 2019 | Mar 2025      | Octane edition detection code cleaned up (`faffa242`)                                                   |
| `ember-cli-is-package-missing` | Jul 2017 | Sep 2025      | Blueprint `afterInstall` hooks removed (`eb2600fd`, `71fbed3f`)                                         |
| `ember-cli-version-checker`    | Dec 2016 | Mar 2025      | `test-framework-detector.js` deleted (`c2992503`)                                                       |
| `brotli`                       | Jun 2025 | Mar 2026      | `bin/minify-assets.mjs` replaced by `compressed-size-action` (`d15c7971`)                               |
| `filesize`                     | Jun 2025 | Mar 2026      | Same — `bin/minify-assets.mjs` deleted                                                                  |
| `node-gzip`                    | Jun 2025 | Mar 2026      | Same — `bin/minify-assets.mjs` deleted                                                                  |
| `table`                        | Jun 2025 | Mar 2026      | Same — `bin/minify-assets.mjs` deleted                                                                  |
| `git-repo-info` (smoke-tests)  | Mar 2026 | Never used    | Dead-on-arrival — included during node test migration but the test stayed in `tests/node/` (`42e19eea`) |
| `semver` (smoke-tests)         | Mar 2026 | Never used    | Same — dead-on-arrival                                                                                  |

## Published package size impact

The dead imports removed from `@glimmer/debug/lib/debug.ts` (14 symbols from `@glimmer/constants` and `@glimmer/vm`) were pulling those modules into a shared chunk in `dist/packages/`. With the imports removed, Rollup tree-shakes them out, shrinking that chunk by ~67%.

The overall published package (`ember-source` on npm) is ~0.04% smaller. The prod bundle (`ember.prod.js`) is unchanged in raw size; a 0.02% gzip variance is compression noise, not new code.

No API changes — the shared-chunk hash changes (expected when content changes), but consumers never reference chunk hashes directly. Embroider resolves through barrel files, which are updated automatically by Rollup.

## How this was found

- **Unused exports / dead files:** [knip](https://knip.dev) static analysis, then manually verified each finding against the codebase.
- **Dead imports / dead field:** Temporarily enabled `noUnusedLocals: true` in tsconfig, fixed genuine dead code, reverted the flag.
- **Unused dependencies:** `knip` dependency analysis cross-referenced with `git log -S` to confirm when each became unused.

## Test plan

- [x] `vite build` succeeds
- [x] `pnpm test` — 8788 tests pass, 0 failures
- [x] `pnpm lint:docs` — 6/6 pass (no docs regressions)
- [x] TypeScript compiles without errors
