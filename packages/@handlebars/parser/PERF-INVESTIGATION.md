# @handlebars/parser v2: Performance Investigation & Hand-Written Replacement

## Context

`@glimmer/syntax`'s `preprocess()` is the #1 bottleneck in Glint's per-keystroke pipeline, taking ~2.3ms (56%) of the ~4ms total `rewriteModule` cost. This investigation explored whether the internalized `@handlebars/parser` (PR #21069) could be made faster.

## Findings

### Baseline: Where time is spent in `preprocess()`

For a realistic 1400-char component template (~0.79ms total):

| Phase                                                    | Time   | % of total |
| -------------------------------------------------------- | ------ | ---------- |
| Jison LALR(1) parser (`@handlebars/parser`)              | 0.40ms | 50%        |
| Glimmer conversion (`simple-html-tokenizer` + AST build) | 0.39ms | 50%        |

The Jison parser is slow because:

1. **Regex gauntlet**: Tests up to 40 regexes per token in the `mu` (mustache) state
2. **String slicing**: `this._input.slice(match[0].length)` on every token creates new strings
3. **Per-token regex for newlines**: `/(?:\r\n?|\n).*/g` to track line numbers
4. **Object allocation**: New `yylloc` object per token match

### What is NOT a bottleneck

| Suspected hotspot                   | Actual cost | Verdict                   |
| ----------------------------------- | ----------- | ------------------------- |
| `charPosFor()` line scanning        | 0.19µs/call | Lazy, cached — negligible |
| `SourceSpan.forHbsLoc()`            | 0.1µs/span  | Fast enough               |
| `match()` dispatch in span.ts       | µs-level    | Compiled at init time     |
| Parser constructor `string.split()` | 1.9µs       | Negligible                |
| WhitespaceControl pass              | <0.02ms     | Nearly free               |

### Optimization: Caching in Glint (consumer-side)

A `Map<string, AST>` cache would give **903x speedup** for unchanged templates. Most keystrokes don't change the template portion of a `.gts` file. This is the single highest-impact optimization.

## v2 Parser: Hand-Written Recursive Descent Replacement

A hand-written parser (`v2-parser.js`, ~800 lines) replaces the 2032-line Jison-generated parser. It produces AST-identical output.

### Key optimizations

1. **Index-based scanning** — maintains a `pos` cursor, never slices the input string
2. **`indexOf('{{')` for content scanning** — vs Jison's regex `/^(?:[^\x00]*?(?=(\{\{)))/`
3. **`charCodeAt` dispatch** — classifies `{{#`, `{{/`, `{{^`, `{{!`, etc. with a switch on char codes instead of testing 40 regexes
4. **Batched line/column tracking** — scans for `\n` with `indexOf` between positions rather than per-character

### Performance results

#### HBS parser alone (6-10x faster)

| Template           |   Jison |      v2 |   Speedup |
| ------------------ | ------: | ------: | --------: |
| small (25 chars)   | 0.010ms | 0.002ms |  **6.1x** |
| medium (352 chars) | 0.089ms | 0.012ms |  **7.7x** |
| large (3520 chars) | 0.844ms | 0.080ms | **10.6x** |

#### End-to-end `preprocess()` (2-3x faster)

| Template               |  Before |   After |  Speedup |
| ---------------------- | ------: | ------: | -------: |
| small (25 chars)       | 0.025ms | 0.011ms | **2.3x** |
| medium (352 chars)     | 0.190ms | 0.090ms | **2.1x** |
| realistic (1435 chars) | 0.791ms | 0.280ms | **2.8x** |
| large (3520 chars)     | 1.716ms | 0.901ms | **1.9x** |

The remaining ~50% is Glimmer's `simple-html-tokenizer` + AST conversion, unchanged.

### Test status

- **104/104** `@handlebars/parser` unit tests pass (parser, AST, visitor)
- **8780/8788** Ember test suite tests pass
- 8 remaining edge-case failures:
  - 7 reserved-arg tests (`@`, `@0`, `@@`, etc.) — same parse error, different Error type than expected
  - 1 subtle location mismatch on a deeply nested inverse block

### Architecture

The v2 parser is a single file with the lexer and parser fused:

```
v2-parser.js
├── Character code constants
├── isIdChar() / isWhitespace() / isLookahead() — char classification
├── v2ParseWithoutProcessing(input, options) — entry point
│   ├── Position tracking (pos, line, col, advanceTo, savePos)
│   ├── Scanning primitives (skipWs, scanId, scanString, scanNumber, scanEscapedLiteral)
│   ├── Content scanning (scanContent — uses indexOf('{{'))
│   ├── Mustache classification (consumeOpen — charCodeAt dispatch)
│   ├── Expression parsing (parseExpr, parseHelperName, parsePath, parseSexpr)
│   ├── Hash parsing (parseHash, parseHashPair, isAtHash lookahead)
│   ├── Block parsing (parseBlock, parseInverseBlock, parseInverseChain)
│   ├── Other statements (parsePartial, parsePartialBlock, parseRawBlock, parseComment)
│   └── Program parsing (parseProgram — top-level loop with terminator detection)
└── Helper functions (stripComment, arrayLiteralNode, hashLiteralNode)
```

## Future opportunities

1. **Glint-side caching** — 903x for cache hits, zero risk to parser
2. **Replace `simple-html-tokenizer`** — the other 50% of `preprocess()` time
3. **Rust/Wasm parser** — could combine with `content-tag` for end-to-end `.gts` parsing
4. **Incremental reparsing** — only reparse changed template regions
