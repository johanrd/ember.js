---
name: Research plan - @glimmer/syntax perf in templateConversion
description: Detailed plan for investigating performance improvements in @glimmer/syntax parsing, which takes 2.3ms (56%) of Glint's per-keystroke rewriteModule cost
type: project
---

## Context

`templateConversion` is the #1 bottleneck in Glint's per-keystroke pipeline at 2.3ms (56% of ~4ms total). This is `calculateTaggedTemplateSpans` → `templateToTypescript` → `mapTemplateContents` → `@glimmer/syntax`.

The code path in Glint:
- `packages/ember-tsc/src/transform/template/inlining/tagged-strings.ts` — entry point
- `packages/ember-tsc/src/transform/template/template-to-typescript.ts` — orchestrates codegen (~1400 lines)
- `packages/ember-tsc/src/transform/template/map-template-contents.ts` — calls `@glimmer/syntax` parser

The `@glimmer/syntax` repo: https://github.com/glimmerjs/glimmer-vm (it's inside the glimmer-vm monorepo)
Glint uses: `@glimmer/syntax@^0.95.0`

## Research plan

### Step 1: Split the 2.3ms

Add `performance.now()` timing inside `mapTemplateContents` to separate:
- **A)** `@glimmer/syntax` `preprocess()` call (the Handlebars parser) — how much of 2.3ms is just parsing?
- **B)** The AST walk + TypeScript code generation in `template-to-typescript.ts` — how much is codegen?

This tells us whether to focus on the parser or the codegen.

### Step 2: Profile @glimmer/syntax itself

Clone `glimmerjs/glimmer-vm`. The parser lives in `packages/@glimmer/syntax/`.

Benchmark approach:
```ts
import { preprocess } from '@glimmer/syntax';

// Use a real-world template from the Ember app (copy one from proapi-webapp)
const template = `<div>{{this.title}}{{#each this.items as |item|}}<span>{{item.name}}</span>{{/each}}</div>`;

// Benchmark raw parse time
console.time('parse');
for (let i = 0; i < 1000; i++) {
  preprocess(template);
}
console.timeEnd('parse');
```

Things to investigate:
- Does `preprocess()` do work that Glint doesn't need? (e.g., it returns a full AST with source locations — Glint uses all of this, but are there options to skip unused features?)
- Is there a lighter parse mode? Check the `preprocess` options parameter
- How does parse time scale with template size? Linear? Worse?
- Is there an incremental parse option? (If only one `{{item.name}}` changed, can we reparse just that?)
- Compare with `@glimmer/syntax` latest vs the version Glint pins — has parsing speed improved?

### Step 3: Profile the codegen walk

If Step 1 shows codegen is significant, profile inside `template-to-typescript.ts`:
- The `ScopeStack` operations (we already know these are cheap)
- String concatenation via `mapper.text()` — is the mapper building strings efficiently?
- The `forNode()` calls that build the `GlimmerASTMappingTree`
- How many AST nodes are visited vs how many produce output?

Benchmark: run `templateToTypescript()` directly on templates of varying complexity.

### Step 4: Look for architectural wins

- **AST caching**: If the template hasn't changed but surrounding TS has, can we cache the `@glimmer/syntax` AST? (Glint currently re-parses on every keystroke even if the edit was outside `<template>` tags.) This would require checking whether the template portion of the source changed.
- **Lazy codegen**: Vue language-tools uses `computed()` signals to avoid regenerating code for unchanged template blocks. Could Glint do something similar?
- **Lighter AST**: Does Glint use all the information `@glimmer/syntax` produces? If not, could a custom lighter parser be faster?

### Expected outcomes
- If `@glimmer/syntax` parse is >1.5ms of the 2.3ms: focus on parser options, caching parsed AST, or contributing upstream improvements
- If codegen is >1.5ms: focus on the string building / mapping tree construction in Glint's own code
- If both are ~1ms each: the individual gains from optimizing either are limited; focus on caching
