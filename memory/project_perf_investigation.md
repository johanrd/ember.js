---
name: Glint pipeline profiling results
description: Real-world profiling of rewriteModule pipeline in a production Ember app, showing where time is spent per keystroke
type: project
---

Profiled Glint's `rewriteModule` pipeline in a real Ember project (proapi-webapp) via instrumented language server. Steady-state per-keystroke breakdown (~4ms total):

| Stage | Time | % | Code location |
|---|---|---|---|
| templateConversion | 2.3ms | 56% | `calculateTaggedTemplateSpans` → `templateToTypescript` → `@glimmer/syntax` |
| preprocess | 0.9ms | 22% | `content-tag` Rust parser in `preprocess.ts` |
| createSourceFile | 0.6ms | 15% | `ts.createSourceFile()` |
| ts.transform (env) | 0.2ms | 5% | TS AST transform for content-tag |
| walk overhead | 0.1ms | 2% | `ts.visitEachChild` traversal |

**Key findings:**
- `transform` (Glimmer mapping assembly) and `assemble` (TransformedModule construction) are 0.0ms — not bottlenecks
- Cold start is 35-66ms (JIT warmup), steady state is ~4ms
- Content-skip memoization in `update()` had 0% hit rate — Volar already deduplicates upstream
- `ScriptSnapshot.getChangeRange()` is never called in Language Server mode
- The two biggest costs are external deps (`@glimmer/syntax` and `content-tag`) not optimizable from Glint

**Why:** Investigated whether vue-language-tools patterns (alien-signals, WeakMap caches, incremental snapshots) could improve Glint perf. Answer: no, the bottleneck is in upstream parsers.

**How to apply:** Future perf work should target `@glimmer/syntax` and `content-tag` directly, not Glint's own code.
