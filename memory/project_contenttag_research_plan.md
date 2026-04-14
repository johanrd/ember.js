---
name: Research plan - content-tag perf in preprocess
description: Detailed plan for investigating performance improvements in content-tag (Rust-based <template> parser), which takes 0.9ms (22%) of Glint's per-keystroke rewriteModule cost
type: project
---

## Context

`preprocess` is the #2 cost in Glint's per-keystroke pipeline at 0.9ms (22% of ~4ms total). This is the `content-tag` Rust parser that extracts `<template>` tags from `.gts` files and converts them to tagged template literals.

The code path in Glint:
- `packages/ember-tsc/src/environment-ember-template-imports/-private/environment/preprocess.ts` — calls `p.parse(source, { filename: path })`
- `content-tag` is a Rust-based parser compiled to WASM/native via napi-rs

The `content-tag` repo: https://github.com/embroider-build/content-tag
Glint uses: `content-tag@^3.1.2`

## Research plan

### Step 1: Split the 0.9ms

Add timing inside `preprocess.ts` to separate:
- **A)** `p.parse(source, { filename: path })` — the actual Rust parser call
- **B)** The JavaScript loop that builds `contents` and `templateLocations` — the byte-to-char conversion and string assembly

This tells us whether the cost is in the Rust parser or the JS post-processing.

### Step 2: Profile content-tag parse() directly

```ts
import { Preprocessor } from 'content-tag';
const p = new Preprocessor();

// Use a real .gts file from proapi-webapp
const source = fs.readFileSync('path/to/real/component.gts', 'utf8');

console.time('parse');
for (let i = 0; i < 1000; i++) {
  p.parse(source, { filename: 'test.gts' });
}
console.timeEnd('parse');
```

Things to investigate:
- What fraction of 0.9ms is the `p.parse()` call vs the JS loop?
- Does `content-tag` have a faster API than `parse()`? (e.g., does it have a mode that returns char indices instead of byte indices, eliminating the need for byte-to-char conversion?)
- Check https://github.com/embroider-build/content-tag/issues/45 — this is the byte-index issue that forces all the `byteToCharIndex` calls. Has it been resolved in newer versions?
- Check https://github.com/embroider-build/content-tag/issues/39 — this is the broader issue about content-tag managing indices. Any progress?

### Step 3: Investigate the byte-to-char overhead

If Step 1 shows the JS loop is significant:
- The current code calls `byteToCharIndex()` which does `buf.subarray(0, byteOffset).toString().length` — this creates a new string every call
- There's also `Buffer.from(contents)` called inside the loop for transformed offsets
- Could be improved with a pre-computed byte→char lookup array (we prototyped this — it works and tests pass, but the total preprocess cost is only 0.9ms so the absolute saving is small)

### Step 4: Look for architectural wins

- **content-tag version bump**: Check if `content-tag@4.x` or latest `3.x` has performance improvements or char-index support
- **Preprocessor instance reuse**: Glint already reuses the `Preprocessor` instance (`const p = new Preprocessor()` at module scope). Good.
- **Incremental parsing**: Does content-tag support incremental/partial parsing? If only one character changed, can it avoid re-parsing the entire file? This would be the biggest potential win but likely requires upstream work.
- **Skip preprocess when no `<template>` tags**: If a `.gts` file has no template tags, `p.parse()` still runs. Could do a fast string check first (`source.includes('<template')`) to skip the Rust parser call entirely for plain TS files with a `.gts` extension. This would save 0.9ms for non-template files.

### Step 5: Evaluate whether 0.9ms matters

At 0.9ms out of 4ms total, even a 50% improvement to preprocess saves 0.45ms. That's real but small. The research is worth doing mainly to:
1. Check if content-tag has fixed the byte-index issue (which would simplify Glint's code even if not faster)
2. Find the "skip non-template files" fast path, which would help projects with many `.gts` files that don't use `<template>`
3. Inform upstream content-tag about the IDE hot-path use case

### Expected outcomes
- If `p.parse()` is >0.7ms: the Rust parser dominates; focus on upstream improvements or caching
- If the JS loop is >0.3ms: the byte-to-char conversion and string assembly are significant; the `buildByteToCharMap` optimization would help
- Quick win: `source.includes('<template')` guard could save 0.9ms for non-template `.gts` files
