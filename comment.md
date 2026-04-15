## Full compile pipeline benchmark: `preprocess()` → `normalize()` → wire format

I've been looking at the `@glimmer/syntax` perf space from a different angle and wanted to share some data before this goes further.

### Three parsers compared

- **main** — current Jison-generated `@handlebars/parser` + `simple-html-tokenizer`
- **v2-parser** ([`johanrd/ember.js @ perf/handlebars-v2-parser`](https://github.com/johanrd/ember.js/tree/perf/handlebars-v2-parser)) — hand-written recursive descent JS parser replacing only the Jison HBS layer, keeping `simple-html-tokenizer`. Where Jison's generated lexer tests up to 40 regexes per token and slices the input string on every match, the v2-parser uses an index-based cursor with `indexOf('{{')` for content scanning and `charCodeAt` dispatch for mustache classification — no string copies, no regex gauntlet. That's why it's ~1.8x faster at the HBS layer even though it's doing the same parse.
- **rust/wasm** — this PR

Benchmarks run with Node 24, warmed JIT, on the full `ember-template-compiler` `precompile()` path (so this includes `preprocess()` → ASTv2 normalization → opcode encoding → wire format — the whole thing).

### Full pipeline results (ms/call)

| template           | chars | main (Jison) | v2-parser   | rust/wasm | v2 vs Jison | v2 vs rust |
| ------------------ | ----- | ------------ | ----------- | --------- | ----------- | ---------- |
| small              | 25    | 0.047ms      | **0.038ms** | 0.067ms   | 1.24x       | 1.75x      |
| medium             | 352   | 0.492ms      | **0.397ms** | 0.779ms   | 1.24x       | 1.96x      |
| real-world         | 1494  | 1.832ms      | **1.577ms** | 4.947ms   | 1.16x       | 3.14x      |
| large (10x medium) | 3520  | 5.095ms      | **4.667ms** | 27.107ms  | 1.09x       | 5.81x      |

### Parse vs compile split (medium template)

| phase                 | main (Jison)  | v2-parser     | rust/wasm     |
| --------------------- | ------------- | ------------- | ------------- |
| `preprocess()` only   | 0.175ms (40%) | 0.093ms (26%) | 0.480ms (66%) |
| compile only (shared) | 0.262ms (60%) | 0.266ms (74%) | 0.250ms (34%) |
| **total**             | 0.438ms       | **0.358ms**   | 0.730ms       |

The compile step (ASTv2 normalization + opcode encoding) costs the same ~0.25ms in all three — it's identical code. Only the parse phase differs.

### 500-template build projection

- main (Jison): ~916ms
- v2-parser: ~788ms — **1.16x faster**
- rust/wasm: ~2474ms — **3.14x slower than v2**

### What this shows

The compile step (ASTv2 normalization + opcode encoding) costs ~0.25ms in all three — identical code. The gap is entirely in `preprocess()`, and it compounds: rust/wasm's JSON bridge (`serde_json::to_string` → `JSON.parse()` → `convertLocations()` walk) is O(AST size), so the gap widens with template complexity (2x at medium → 5.8x at large).

The single-pass architecture is a real win in theory — the current pipeline genuinely scans HTML twice (`@handlebars/parser` treats it as opaque content, then `simple-html-tokenizer` re-tokenizes it via `tokenizePart()`). But that win is currently eaten by the JSON roundtrip. `lib.rs` acknowledges the tradeoff explicitly: the JSON approach was chosen over a direct wasm-bindgen bridge specifically to keep the binary smaller — the same constraint that's already blocking this PR.

Not raising this to block anything — just wanted the data in the room.
