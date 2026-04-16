// @ts-nocheck
/**
 * Claude-iterated POC for a recursive descent parser for Handlebars templates.
 * Drop-in replacement for the Jison-generated parser.
 *
 * Key optimizations over Jison:
 * 1. Index-based scanning (never slices the input string to advance)
 * 2. indexOf('{{') for content scanning instead of regex
 * 3. charCodeAt dispatch instead of testing 40 regexes per token
 * 4. Line/col tracking via indexOf('\n') batching
 * 5. No intermediate token objects — parser reads directly from input
 */

import Exception from './exception.js';
import WhitespaceControl from './whitespace-control.js';

export function parseWithoutProcessing(input, options) {
  return v2ParseWithoutProcessing(input, options);
}

export function parse(input, options) {
  const ast = v2ParseWithoutProcessing(input, options);
  const strip = new WhitespaceControl(options);
  return strip.accept(ast);
}

// Character codes
const CH_NL = 10; // \n
const CH_CR = 13; // \r
const CH_SPACE = 32;
const CH_TAB = 9;
const CH_BANG = 33; // !
const CH_DQUOTE = 34; // "
const CH_HASH = 35; // #
const CH_DOLLAR = 36; // $
const CH_AMP = 38; // &
const CH_SQUOTE = 39; // '
const CH_LPAREN = 40; // (
const CH_RPAREN = 41; // )
const CH_STAR = 42; // *
const CH_DASH = 45; // -
const CH_DOT = 46; // .
const CH_SLASH = 47; // /
const CH_0 = 48;
const CH_9 = 57;
const CH_SEMI = 59; // ;
const CH_EQ = 61; // =
const CH_GT = 62; // >
const CH_AT = 64; // @
const CH_LBRACKET = 91; // [
const CH_BACKSLASH = 92; // \\
const CH_RBRACKET = 93; // ]
const CH_CARET = 94; // ^
const CH_BACKTICK = 96; // `
const CH_LBRACE = 123; // {
const CH_PIPE = 124; // |
const CH_RBRACE = 125; // }
const CH_TILDE = 126; // ~

/**
 * Check if a character code can appear in a Handlebars ID.
 * Based on the ID regex: [^\s!"#%-,\.\/;->@\[-\^`\{-~]+
 */
function isIdChar(c) {
  if (c <= CH_SPACE) return false; // whitespace + control
  if (c === CH_BANG || c === CH_DQUOTE || c === CH_HASH) return false;
  if (c >= 37 && c <= 44) return false; // % & ' ( ) * + ,
  if (c === CH_DOT || c === CH_SLASH) return false;
  if (c >= CH_SEMI && c <= CH_GT) return false; // ; < = >
  if (c === CH_AT) return false;
  if (c >= CH_LBRACKET && c <= CH_CARET) return false; // [ \ ] ^
  if (c === CH_BACKTICK) return false;
  if (c >= CH_LBRACE && c <= CH_TILDE) return false; // { | } ~
  return true;
}

function isWhitespace(c) {
  return c === CH_SPACE || c === CH_TAB || c === CH_NL || c === CH_CR || c === 12; // form feed
}

/**
 * Check if a character is a lookahead character for ID/literal matching.
 * LOOKAHEAD = [=~}\s\/.)\]|]
 */
function isLookahead(c) {
  return (
    c === CH_EQ ||
    c === CH_TILDE ||
    c === CH_RBRACE ||
    isWhitespace(c) ||
    c === CH_SLASH ||
    c === CH_DOT ||
    c === CH_RPAREN ||
    c === CH_RBRACKET ||
    c === CH_PIPE ||
    c !== c // NaN (past end of string)
  );
}

/**
 * LITERAL_LOOKAHEAD = [~}\s)\]]
 */
function isLiteralLookahead(c) {
  return (
    c === CH_TILDE ||
    c === CH_RBRACE ||
    isWhitespace(c) ||
    c === CH_RPAREN ||
    c === CH_RBRACKET ||
    c !== c // NaN
  );
}

/**
 * Strip brackets from an ID token: [foo] → foo
 */
function idFromToken(token) {
  if (token.charCodeAt(0) === CH_LBRACKET && token.charCodeAt(token.length - 1) === CH_RBRACKET) {
    return token.substring(1, token.length - 1);
  }
  return token;
}

function stripComment(comment) {
  return comment.replace(/^\{\{~?!-?-?/, '').replace(/-?-?~?\}\}$/, '');
}

export function v2ParseWithoutProcessing(input, options) {
  if (typeof input !== 'string') {
    // Pass through already-compiled AST
    if (input.type === 'Program') return input;
    throw new Error('Expected string or Program AST');
  }

  // === State ===
  let pos = 0;
  let line = 1;
  let col = 0;
  const len = input.length;
  const srcName = options?.srcName ?? undefined;

  // Syntax options
  let squareSyntax;
  if (typeof options?.syntax?.square === 'function') {
    squareSyntax = options.syntax.square;
  } else if (options?.syntax?.square === 'node') {
    squareSyntax = arrayLiteralNode;
  } else {
    squareSyntax = 'string';
  }

  let hashSyntax;
  if (typeof options?.syntax?.hash === 'function') {
    hashSyntax = options.syntax.hash;
  } else {
    hashSyntax = hashLiteralNode;
  }

  // yy-like context for helper callbacks
  const yy = { preparePath, id: idFromToken, locInfo: makeLoc };

  // === Position tracking ===

  function advanceTo(target) {
    while (pos < target) {
      const nl = input.indexOf('\n', pos);
      if (nl === -1 || nl >= target) {
        col += target - pos;
        pos = target;
        return;
      }
      // Count the newline
      line++;
      col = 0;
      pos = nl + 1;
    }
  }

  function cc(offset) {
    return input.charCodeAt(pos + (offset || 0));
  }

  function startsWith(str, offset) {
    return input.startsWith(str, pos + (offset || 0));
  }

  function makeLoc(sl, sc, el, ec) {
    return {
      source: srcName,
      start: { line: sl, column: sc },
      end: { line: el || line, column: ec !== undefined ? ec : col },
    };
  }

  function savePos() {
    return { line, col };
  }

  function locFrom(start) {
    return makeLoc(start.line, start.col, line, col);
  }

  function error(msg) {
    throw new Exception(
      'Parse error on line ' + line + ':\n' + input.slice(pos, pos + 20) + '\n' + msg,
      {
        loc: makeLoc(line, col),
      }
    );
  }

  // === Scanning primitives ===

  function skipWs() {
    while (pos < len && isWhitespace(cc())) {
      if (cc() === CH_NL) {
        line++;
        col = 0;
        pos++;
      } else if (cc() === CH_CR) {
        line++;
        col = 0;
        pos++;
        if (pos < len && cc() === CH_NL) pos++; // \r\n
      } else {
        col++;
        pos++;
      }
    }
  }

  function scanId() {
    const start = pos;
    while (pos < len && isIdChar(cc())) {
      col++;
      pos++;
    }
    if (pos === start) return null;
    return input.substring(start, pos);
  }

  function scanEscapedLiteral() {
    // We're at '[', scan to matching ']' with backslash escaping
    if (cc() !== CH_LBRACKET) return null;
    const start = pos;
    col++;
    pos++; // skip [
    while (pos < len) {
      const c = cc();
      if (c === CH_BACKSLASH && pos + 1 < len) {
        col += 2;
        pos += 2; // skip escaped char
      } else if (c === CH_RBRACKET) {
        col++;
        pos++; // skip ]
        const raw = input.substring(start, pos);
        return raw.replace(/\\([\\\]])/g, '$1');
      } else if (c === CH_NL) {
        line++;
        col = 0;
        pos++;
      } else {
        col++;
        pos++;
      }
    }
    error('Unterminated escaped literal');
  }

  function scanString() {
    const quote = cc();
    if (quote !== CH_DQUOTE && quote !== CH_SQUOTE) return null;
    const startPos = pos;
    const startP = savePos();
    col++;
    pos++; // skip opening quote
    let result = '';
    let segStart = pos;
    while (pos < len) {
      const c = cc();
      if (c === CH_BACKSLASH && pos + 1 < len && cc(1) === quote) {
        result += input.substring(segStart, pos);
        col += 2;
        pos += 2;
        result += String.fromCharCode(quote);
        segStart = pos;
      } else if (c === quote) {
        result += input.substring(segStart, pos);
        col++;
        pos++; // skip closing quote
        return { value: result, original: result, loc: locFrom(startP) };
      } else if (c === CH_NL) {
        line++;
        col = 0;
        pos++;
      } else {
        col++;
        pos++;
      }
    }
    error('Unterminated string');
  }

  function scanNumber() {
    const start = pos;
    if (cc() === CH_DASH) {
      col++;
      pos++;
    }
    if (pos >= len || cc() < CH_0 || cc() > CH_9) {
      // Not a number, restore
      advanceTo(start); // no-op if no dash
      pos = start;
      col = col - (pos - start); // crude restore
      return null;
    }
    // Actually, let me just save/restore properly
    const savedLine = line;
    const savedCol = col;

    // Reset to start for proper scanning
    pos = start;
    line = savedLine;
    col = savedCol - (pos === start ? 0 : 1);

    if (cc() === CH_DASH) {
      col++;
      pos++;
    }
    while (pos < len && cc() >= CH_0 && cc() <= CH_9) {
      col++;
      pos++;
    }
    if (pos < len && cc() === CH_DOT) {
      col++;
      pos++;
      while (pos < len && cc() >= CH_0 && cc() <= CH_9) {
        col++;
        pos++;
      }
    }
    // Check literal lookahead
    if (pos < len && !isLiteralLookahead(cc())) {
      // Not a valid number, restore
      pos = start;
      line = savedLine;
      col = savedCol - (pos - start);
      return null;
    }
    return input.substring(start, pos);
  }

  // === Content scanning ===

  function scanContent() {
    if (pos >= len) return null;
    const startP = savePos();
    const start = pos;
    let result = '';
    let segStart = pos;

    while (pos < len) {
      const idx = input.indexOf('{{', pos);
      if (idx === -1) {
        // Rest is content
        advanceTo(len);
        result += input.substring(segStart, len);
        if (result.length === 0) return null;
        return {
          type: 'ContentStatement',
          original: result,
          value: result,
          loc: locFrom(startP),
        };
      }

      // Check for escaped mustache — only if the backslash is within our scan range
      if (idx > pos && input.charCodeAt(idx - 1) === CH_BACKSLASH) {
        if (idx > pos + 1 && input.charCodeAt(idx - 2) === CH_BACKSLASH) {
          // \\{{ — the \\ is a literal backslash, {{ is a real mustache
          // Content includes everything up to \\{{ with one backslash stripped
          result += input.substring(segStart, idx - 1); // strip one backslash
          advanceTo(idx); // advance to the real {{ (not past it)
          if (result.length === 0) return null;
          return {
            type: 'ContentStatement',
            original: result,
            value: result,
            loc: locFrom(startP),
          };
        }
        // \{{ — escaped mustache. Jison handles this by:
        // 1. Emitting content up to the \ (stripping it) as CONTENT
        // 2. Entering emu state which scans to next {{/\{{/\\{{/EOF
        // 3. Emitting that chunk as another CONTENT
        //
        // We match this by: emit what we have so far (up to the \, stripped),
        // then advance past \{{ and let the emu scan produce the next content.

        // First: emit content accumulated so far (before the backslash)
        advanceTo(idx - 1);
        result += input.substring(segStart, idx - 1);
        if (result.length > 0) {
          return {
            type: 'ContentStatement',
            original: result,
            value: result,
            loc: locFrom(startP),
          };
        }

        // If no content before the \, advance past the \{{ and scan emu content
        advanceTo(idx + 2); // past \{{
        const emuStartP = savePos();
        const emuStart = pos;
        const nextMu = findNextMustacheOrEnd(pos);
        advanceTo(nextMu);
        const emuContent = '{{' + input.substring(emuStart, nextMu);
        return {
          type: 'ContentStatement',
          original: emuContent,
          value: emuContent,
          loc: makeLoc(startP.line, startP.col, line, col),
        };
      }

      // Normal {{ — stop here
      advanceTo(idx);
      result += input.substring(segStart, idx);
      if (result.length === 0) return null;
      return {
        type: 'ContentStatement',
        original: result,
        value: result,
        loc: locFrom(startP),
      };
    }

    result += input.substring(segStart, len);
    advanceTo(len);
    if (result.length === 0) return null;
    return {
      type: 'ContentStatement',
      original: result,
      value: result,
      loc: locFrom(startP),
    };
  }

  function findNextMustacheOrEnd(from) {
    // Emu state: scan for next {{ (escaped or not) or EOF.
    // Returns position to stop content at. The main scanContent loop
    // will then handle escape detection on the next iteration.
    const idx = input.indexOf('{{', from);
    if (idx === -1) return len;
    // If preceded by backslash, stop before the backslash
    if (idx > from && input.charCodeAt(idx - 1) === CH_BACKSLASH) {
      return idx - 1;
    }
    return idx;
  }

  // === Mustache classification ===
  // After seeing '{{', classify what kind of statement this is.

  function consumeOpen() {
    // We're at '{{', consume it and return info about the opener
    const openStart = savePos();
    const startPos = pos;

    // Check for {{{{ (raw block)
    if (startsWith('{{{{')) {
      advanceTo(pos + 4);
      // Check if it's a close raw block {{{{/
      if (cc() === CH_SLASH) {
        // This shouldn't happen at statement level — it's handled in raw block parsing
        error('Unexpected raw block close');
      }
      return { kind: 'raw', start: openStart, raw: input.substring(startPos, pos) };
    }

    advanceTo(pos + 2); // skip {{

    // Check for ~ (left strip)
    let leftStrip = false;
    if (cc() === CH_TILDE) {
      leftStrip = true;
      col++;
      pos++;
    }

    // Check optional leading whitespace before 'else'
    const afterStripPos = pos;
    const afterStripLine = line;
    const afterStripCol = col;
    skipWs();
    const wsSkipped = pos > afterStripPos;

    const c = cc();

    // Check for else keyword
    if (startsWith('else')) {
      const afterElse = pos + 4;
      const charAfterElse = input.charCodeAt(afterElse);

      // Check if it's standalone {{else}} or {{else~}}
      if (
        isWhitespace(charAfterElse) ||
        charAfterElse === CH_TILDE ||
        charAfterElse === CH_RBRACE
      ) {
        // Scan past 'else' and whitespace
        advanceTo(afterElse);
        skipWs();

        // Check for ~?}}
        let rightStrip = false;
        if (cc() === CH_TILDE) {
          rightStrip = true;
          col++;
          pos++;
        }
        if (cc() === CH_RBRACE && cc(1) === CH_RBRACE) {
          // Standalone inverse: {{else}}
          advanceTo(pos + 2);
          const raw = input.substring(startPos, pos);
          return {
            kind: 'inverse',
            start: openStart,
            strip: { open: leftStrip, close: rightStrip },
            raw,
          };
        }

        // It's {{else something}} — openInverseChain
        // We already advanced to afterElse on line 482, and may have
        // scanned past whitespace/~ looking for }}. Reset to afterElse
        // and re-skip whitespace to position correctly.
        // Note: line/col were correctly tracked by advanceTo(afterElse),
        // we just need to reset pos and re-advance if we overshot.
        if (pos !== afterElse) {
          // We overshot — need to recompute. Save the correct state from
          // when we were at afterElse. Since advanceTo already tracked
          // line/col to afterElse, and then we only moved forward through
          // whitespace/~, we need to go back. Recompute from scratch:
          pos = afterStripPos;
          line = afterStripLine;
          col = afterStripCol;
          advanceTo(afterElse);
        }
        skipWs();
        const raw = input.substring(startPos, pos);
        return {
          kind: 'inverseChain',
          start: openStart,
          leftStrip,
          raw,
        };
      }

      // Not followed by appropriate char — it's an identifier starting with 'else'
      // Restore position
      pos = afterStripPos;
      line = afterStripLine;
      col = afterStripCol;
    } else if (wsSkipped) {
      // Restore whitespace if we didn't match 'else'
      pos = afterStripPos;
      line = afterStripLine;
      col = afterStripCol;
    }

    switch (c) {
      case CH_BANG: {
        // Comment: {{! or {{!--
        // We need to match Jison's behavior exactly.
        //
        // Jison has two comment rules (longest-match semantics):
        // 1. Short: {{~?![\s\S]*?}} — matches any {{!...}} up to first }}
        // 2. Long: {{~?!-- enters com state, then [\s\S]*?--~?}} matches body
        //
        // When both match, Jison picks the LONGER match. So:
        // - {{!--}} → short wins (7 chars beats 5 chars for long start)
        // - {{!-- hello --}} → long wins (the short would only match {{!-- hello --}},
        //   but the long matches the full thing)
        //
        // Strategy: try short first. If starts with --, also try long.
        // Pick the longer match.

        // Don't advance past ! yet — we'll compute raw text from startPos
        col++;
        pos++;
        const afterBang = pos;

        // Try short comment: {{! up to first ~?}}
        const shortEnd = input.indexOf('}}', afterBang);
        if (shortEnd === -1) error('Unterminated comment');
        let shortRStrip = false;
        if (shortEnd > 0 && input.charCodeAt(shortEnd - 1) === CH_TILDE) {
          shortRStrip = true;
        }
        const shortMatchEnd = shortEnd + 2; // past }}

        // Check if this might be a long comment (starts with --)
        const startsWithDashDash =
          input.charCodeAt(afterBang) === CH_DASH && input.charCodeAt(afterBang + 1) === CH_DASH;

        if (startsWithDashDash) {
          // Try long comment: find --~?}} after the initial --
          const longSearchStart = afterBang + 2;
          let longMatchEnd = -1;
          let longRStrip = false;
          let searchFrom = longSearchStart;

          while (searchFrom < len) {
            const dashIdx = input.indexOf('--', searchFrom);
            if (dashIdx === -1) break;
            let afterDash = dashIdx + 2;
            let thisRStrip = false;
            if (afterDash < len && input.charCodeAt(afterDash) === CH_TILDE) {
              thisRStrip = true;
              afterDash++;
            }
            if (
              afterDash + 1 < len &&
              input.charCodeAt(afterDash) === CH_RBRACE &&
              input.charCodeAt(afterDash + 1) === CH_RBRACE
            ) {
              longMatchEnd = afterDash + 2;
              longRStrip = thisRStrip;
              break;
            }
            searchFrom = dashIdx + 1;
          }

          // Pick the longer match
          if (longMatchEnd > shortMatchEnd) {
            // Long comment wins
            const rawText = input.substring(startPos, longMatchEnd);
            advanceTo(longMatchEnd);
            return {
              kind: 'comment',
              start: openStart,
              value: stripComment(rawText),
              strip: { open: leftStrip, close: longRStrip },
              loc: locFrom(openStart),
            };
          }
        }

        // Short comment wins (or no long comment match)
        const rawText = input.substring(startPos, shortMatchEnd);
        advanceTo(shortMatchEnd);
        return {
          kind: 'comment',
          start: openStart,
          value: stripComment(rawText),
          strip: { open: leftStrip, close: shortRStrip },
          loc: locFrom(openStart),
        };
      }

      case CH_GT: {
        // Partial: {{>
        col++;
        pos++;
        return {
          kind: 'partial',
          start: openStart,
          leftStrip,
          raw: input.substring(startPos, pos),
        };
      }

      case CH_HASH: {
        col++;
        pos++;
        // Check for {{#>  (partial block)
        if (cc() === CH_GT) {
          col++;
          pos++;
          return {
            kind: 'partialBlock',
            start: openStart,
            leftStrip,
            raw: input.substring(startPos, pos),
          };
        }
        // Check for {{#*  (decorator block)
        let isDecorator = false;
        if (cc() === CH_STAR) {
          isDecorator = true;
          col++;
          pos++;
        }
        return {
          kind: 'block',
          start: openStart,
          leftStrip,
          isDecorator,
          raw: input.substring(startPos, pos),
        };
      }

      case CH_SLASH: {
        // Close block: {{/
        col++;
        pos++;
        return { kind: 'close', start: openStart, leftStrip, raw: input.substring(startPos, pos) };
      }

      case CH_CARET: {
        // ^ — could be standalone inverse {{^}} or open inverse {{^foo}}
        col++;
        pos++;
        skipWs();
        // Check for ~?}}
        let rightStrip = false;
        if (cc() === CH_TILDE) {
          const savedP = pos;
          const savedL = line;
          const savedC = col;
          rightStrip = true;
          col++;
          pos++;
          if (cc() === CH_RBRACE && cc(1) === CH_RBRACE) {
            advanceTo(pos + 2);
            return {
              kind: 'inverse',
              start: openStart,
              strip: { open: leftStrip, close: rightStrip },
              raw: input.substring(startPos, pos),
            };
          }
          // Not }}, restore
          pos = savedP;
          line = savedL;
          col = savedC;
          rightStrip = false;
        }
        if (cc() === CH_RBRACE && cc(1) === CH_RBRACE) {
          advanceTo(pos + 2);
          return {
            kind: 'inverse',
            start: openStart,
            strip: { open: leftStrip, close: false },
            raw: input.substring(startPos, pos),
          };
        }
        // It's an open inverse block
        return {
          kind: 'openInverse',
          start: openStart,
          leftStrip,
          raw: input.substring(startPos, pos),
        };
      }

      case CH_LBRACE: {
        // Triple stache {{{ (unescaped)
        col++;
        pos++;
        return {
          kind: 'unescaped',
          start: openStart,
          leftStrip,
          raw: input.substring(startPos, pos),
        };
      }

      case CH_AMP: {
        // Unescaped {{&
        col++;
        pos++;
        return {
          kind: 'mustache',
          start: openStart,
          leftStrip,
          unescaped: true,
          raw: input.substring(startPos, pos),
        };
      }

      case CH_STAR: {
        // Decorator {{*
        col++;
        pos++;
        return {
          kind: 'mustache',
          start: openStart,
          leftStrip,
          isDecorator: true,
          raw: input.substring(startPos, pos),
        };
      }

      default: {
        // Regular mustache {{
        return {
          kind: 'mustache',
          start: openStart,
          leftStrip,
          raw: input.substring(startPos, pos),
        };
      }
    }
  }

  function consumeClose() {
    // Expect }} or ~}}
    skipWs();
    let rightStrip = false;
    if (cc() === CH_TILDE) {
      rightStrip = true;
      col++;
      pos++;
    }
    if (cc() !== CH_RBRACE || cc(1) !== CH_RBRACE) {
      error("Expected '}}'");
    }
    advanceTo(pos + 2);
    return rightStrip;
  }

  function consumeUnescapedClose() {
    // Expect }}} or ~}}}
    skipWs();
    let rightStrip = false;
    if (cc() === CH_TILDE) {
      rightStrip = true;
      col++;
      pos++;
    }
    if (cc() !== CH_RBRACE || cc(1) !== CH_RBRACE || cc(2) !== CH_RBRACE) {
      error("Expected '}}}'");
    }
    advanceTo(pos + 3);
    return rightStrip;
  }

  // === Expression parsing ===

  function parseExpr() {
    skipWs();
    const c = cc();

    // Sub-expression
    if (c === CH_LPAREN) return parseSexprOrPath();

    // Array literal
    if (c === CH_LBRACKET && squareSyntax !== 'string') return parseArrayLiteralOrPath();

    return parseHelperName();
  }

  function parseSexprOrPath() {
    const startP = savePos(); // save pos BEFORE sub-expression
    const sexpr = parseSexpr();
    // Peek for separator WITHOUT consuming whitespace — the caller
    // owns trailing whitespace (affects loc of containing HashPair etc.)
    const savedPos = pos,
      savedLine = line,
      savedCol = col;
    skipWs();
    if (cc() === CH_DOT || cc() === CH_SLASH) {
      return parsePath(false, sexpr, startP);
    }
    // Restore — don't consume trailing whitespace
    pos = savedPos;
    line = savedLine;
    col = savedCol;
    return sexpr;
  }

  function parseArrayLiteralOrPath() {
    const startP = savePos(); // save pos BEFORE array literal
    const arr = parseArrayLiteral();
    const savedPos = pos,
      savedLine = line,
      savedCol = col;
    skipWs();
    if (cc() === CH_DOT || cc() === CH_SLASH) {
      return parsePath(false, arr, startP);
    }
    pos = savedPos;
    line = savedLine;
    col = savedCol;
    return arr;
  }

  function parseHelperName() {
    skipWs();
    const c = cc();
    const startP = savePos();

    // String literal
    if (c === CH_DQUOTE || c === CH_SQUOTE) {
      const s = scanString();
      return { type: 'StringLiteral', value: s.value, original: s.value, loc: s.loc };
    }

    // Number literal
    if (c === CH_DASH || (c >= CH_0 && c <= CH_9)) {
      const savedPos = pos;
      const savedLine = line;
      const savedCol = col;
      const numStr = scanNumber();
      if (numStr !== null && (pos >= len || isLiteralLookahead(cc()))) {
        return {
          type: 'NumberLiteral',
          value: Number(numStr),
          original: Number(numStr),
          loc: locFrom(startP),
        };
      }
      // Restore — might be a negative path or ID starting with dash
      pos = savedPos;
      line = savedLine;
      col = savedCol;
    }

    // Boolean
    if (startsWith('true') && isLiteralLookahead(input.charCodeAt(pos + 4))) {
      advanceTo(pos + 4);
      return { type: 'BooleanLiteral', value: true, original: true, loc: locFrom(startP) };
    }
    if (startsWith('false') && isLiteralLookahead(input.charCodeAt(pos + 5))) {
      advanceTo(pos + 5);
      return { type: 'BooleanLiteral', value: false, original: false, loc: locFrom(startP) };
    }

    // Undefined
    if (startsWith('undefined') && isLiteralLookahead(input.charCodeAt(pos + 9))) {
      advanceTo(pos + 9);
      return {
        type: 'UndefinedLiteral',
        original: undefined,
        value: undefined,
        loc: locFrom(startP),
      };
    }

    // Null
    if (startsWith('null') && isLiteralLookahead(input.charCodeAt(pos + 4))) {
      advanceTo(pos + 4);
      return { type: 'NullLiteral', original: null, value: null, loc: locFrom(startP) };
    }

    // Data path (@...)
    if (c === CH_AT) {
      col++;
      pos++;
      return parseDataName(startP);
    }

    // Path (starting with ID, .., ., or escaped [literal])
    return parsePath(false, false);
  }

  function parseDataName(startP) {
    // After @, only path segments (IDs) are valid, not numbers.
    // In Jison, @ is DATA token, then pathSegments expects ID (not NUMBER).
    // Digits are valid ID chars but the Jison lexer matches them as NUMBER first.
    // So @0, @1, etc. are parse errors in Jison.
    const c = cc();
    if (c >= CH_0 && c <= CH_9) {
      error('Expected path identifier after @');
    }
    const segments = parsePathSegments();
    return preparePath(true, false, segments, locFrom(startP));
  }

  function parsePath(data, exprHead, exprHeadStartP) {
    const startP = exprHeadStartP || savePos();

    if (exprHead) {
      // exprHead sep pathSegments
      const sep = scanSep();
      if (!sep) error('Expected separator after sub-expression in path');
      const segments = parsePathSegments();
      return preparePath(false, exprHead, segments, locFrom(startP));
    }

    // pathSegments: ID (sep ID)*
    const segments = parsePathSegments();
    return preparePath(data, false, segments, locFrom(startP));
  }

  function parsePathSegments() {
    const segments = [];
    const first = scanIdOrEscaped();
    if (first === null) error('Expected path identifier');
    segments.push({ part: idFromToken(first), original: first });

    while (pos < len) {
      const savedPos = pos;
      const savedLine = line;
      const savedCol = col;
      const sep = scanSep();
      if (!sep) break;
      const id = scanIdOrEscaped();
      if (id === null) {
        // Trailing separator (e.g. "foo." or "foo/") — restore and stop
        // Let downstream (Glimmer) handle the error
        pos = savedPos;
        line = savedLine;
        col = savedCol;
        break;
      }
      segments.push({ part: idFromToken(id), original: id, separator: sep });
    }

    return segments;
  }

  function scanIdOrEscaped() {
    if (cc() === CH_LBRACKET) {
      return scanEscapedLiteral();
    }
    // Handle '..' and '.' as valid ID tokens (per Jison lexer rules)
    if (cc() === CH_DOT && cc(1) === CH_DOT) {
      col += 2;
      pos += 2;
      return '..';
    }
    if (cc() === CH_DOT && isLookahead(cc(1))) {
      col++;
      pos++;
      return '.';
    }
    return scanId();
  }

  function scanSep() {
    if (cc() === CH_DOT && cc(1) === CH_HASH) {
      col += 2;
      pos += 2;
      return '.#';
    }
    if (cc() === CH_DOT || cc() === CH_SLASH) {
      const c = input[pos];
      col++;
      pos++;
      return c;
    }
    return null;
  }

  function preparePath(data, sexpr, parts, loc) {
    let original;
    if (data) {
      original = '@';
    } else if (sexpr) {
      original = sexpr.original + '.';
    } else {
      original = '';
    }

    const tail = [];
    let depth = 0;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].part;
      const isLiteral = parts[i].original !== part;
      const separator = parts[i].separator;
      const partPrefix = separator === '.#' ? '#' : '';

      original += (separator || '') + part;

      if (!isLiteral && (part === '..' || part === '.' || part === 'this')) {
        if (tail.length > 0) {
          throw new Exception('Invalid path: ' + original, { loc });
        } else if (part === '..') {
          depth++;
        }
      } else {
        tail.push(`${partPrefix}${part}`);
      }
    }

    const head = sexpr || tail.shift();

    return {
      type: 'PathExpression',
      this: original.startsWith('this.'),
      data: !!data,
      depth,
      head,
      tail,
      parts: head ? [head, ...tail] : tail,
      original,
      loc,
    };
  }

  // === Hash parsing ===

  function isAtHash() {
    // Look ahead: current token is ID followed by =
    if (!isIdChar(cc()) && cc() !== CH_LBRACKET) return false;
    // Scan forward past the ID
    let p = pos;
    if (input.charCodeAt(p) === CH_LBRACKET) {
      // Escaped literal — find closing ]
      p++;
      while (p < len && input.charCodeAt(p) !== CH_RBRACKET) {
        if (input.charCodeAt(p) === CH_BACKSLASH) p++;
        p++;
      }
      p++; // skip ]
    } else {
      while (p < len && isIdChar(input.charCodeAt(p))) p++;
    }
    // Skip whitespace
    while (p < len && isWhitespace(input.charCodeAt(p))) p++;
    return p < len && input.charCodeAt(p) === CH_EQ;
  }

  function parseHash() {
    const startP = savePos();
    const pairs = [];
    let endP;
    while (pos < len && isAtHash()) {
      pairs.push(parseHashPair());
      endP = savePos(); // capture end BEFORE skipping whitespace
      skipWs();
    }
    if (pairs.length === 0) return undefined;
    return { type: 'Hash', pairs, loc: makeLoc(startP.line, startP.col, endP.line, endP.col) };
  }

  function parseHashPair() {
    skipWs();
    const startP = savePos();
    const key = scanIdOrEscaped();
    if (key === null) error('Expected hash key');
    skipWs();
    if (cc() !== CH_EQ) error("Expected '=' in hash");
    col++;
    pos++; // skip =
    skipWs();
    const value = parseExpr();
    return { type: 'HashPair', key: idFromToken(key), value, loc: locFrom(startP) };
  }

  // === Sub-expression parsing ===

  function parseSexpr() {
    const startP = savePos();
    if (cc() !== CH_LPAREN) error("Expected '('");
    col++;
    pos++; // skip (
    skipWs();

    // Check for hash-only sexpr: (key=val)
    if (isAtHash()) {
      const hash = parseHash();
      skipWs();
      if (cc() !== CH_RPAREN) error("Expected ')'");
      col++;
      pos++;
      const loc = locFrom(startP);
      return hashSyntax(hash, loc, { yy, syntax: 'expr' });
    }

    const path = parseExpr();
    const params = [];
    let hash = undefined;

    skipWs();
    while (cc() !== CH_RPAREN && pos < len) {
      if (isAtHash()) {
        hash = parseHash();
        break;
      }
      params.push(parseExpr());
      skipWs();
    }

    skipWs();
    if (cc() !== CH_RPAREN) error("Expected ')'");
    col++;
    pos++;

    return { type: 'SubExpression', path, params, hash, loc: locFrom(startP) };
  }

  // === Array literal ===

  function parseArrayLiteral() {
    const startP = savePos();
    if (cc() !== CH_LBRACKET) error("Expected '['");
    col++;
    pos++; // skip [
    const items = [];
    skipWs();
    while (cc() !== CH_RBRACKET && pos < len) {
      items.push(parseExpr());
      skipWs();
    }
    if (cc() !== CH_RBRACKET) error("Expected ']'");
    col++;
    pos++;
    const loc = locFrom(startP);
    return squareSyntax(items, loc, { yy, syntax: 'expr' });
  }

  // === Block params ===

  function parseBlockParams() {
    skipWs();
    // Look for 'as |'
    if (!startsWith('as')) return null;
    const afterAs = pos + 2;
    if (afterAs >= len || !isWhitespace(input.charCodeAt(afterAs))) return null;

    // Scan past 'as' + whitespace
    let p = afterAs;
    while (p < len && isWhitespace(input.charCodeAt(p))) p++;
    if (p >= len || input.charCodeAt(p) !== CH_PIPE) return null;

    // It's block params
    advanceTo(p + 1); // past 'as' + ws + |
    const ids = [];
    skipWs();
    while (cc() !== CH_PIPE && pos < len) {
      const id = scanId();
      if (id === null) error('Expected block param identifier');
      ids.push(idFromToken(id));
      skipWs();
    }
    if (cc() !== CH_PIPE) error("Expected '|' to close block params");
    col++;
    pos++;
    return ids;
  }

  // === Statement parsers ===

  function parseProgram(terminators) {
    const stmts = [];
    while (pos < len) {
      // Check if we're at a terminator
      if (startsWith('{{')) {
        if (isTerminator(terminators)) break;
      }

      const content = scanContent();
      if (content) {
        stmts.push(content);
        continue;
      }

      if (pos >= len) break;

      // We're at a {{
      if (isTerminator(terminators)) break;
      const stmt = parseOpenStatement();
      if (stmt) stmts.push(stmt);
    }

    return prepareProgram(stmts);
  }

  function isTerminator(terminators) {
    if (!terminators) return false;
    // Save position
    const savedPos = pos;
    const savedLine = line;
    const savedCol = col;

    // Check what's after {{
    if (!startsWith('{{')) return false;

    // Peek at the opener type
    let p = pos + 2;

    // Skip ~
    if (p < len && input.charCodeAt(p) === CH_TILDE) p++;

    // Skip whitespace (for else detection)
    let pw = p;
    while (pw < len && isWhitespace(input.charCodeAt(pw))) pw++;

    const c = input.charCodeAt(p);

    for (const t of terminators) {
      switch (t) {
        case 'close':
          if (c === CH_SLASH) return true;
          break;
        case 'inverse':
          // {{^}} or {{^foo
          if (c === CH_CARET) return true;
          // {{else}} or {{else foo
          if (input.startsWith('else', pw)) return true;
          break;
      }
    }

    return false;
  }

  function parseOpenStatement() {
    const open = consumeOpen();

    switch (open.kind) {
      case 'comment':
        return {
          type: 'CommentStatement',
          value: open.value,
          strip: open.strip,
          loc: open.loc,
        };

      case 'mustache':
        return parseMustache(open);

      case 'unescaped':
        return parseUnescapedMustache(open);

      case 'block':
        return parseBlock(open);

      case 'openInverse':
        return parseInverseBlock(open);

      case 'partial':
        return parsePartial(open);

      case 'partialBlock':
        return parsePartialBlock(open);

      case 'raw':
        return parseRawBlock(open);

      case 'inverse':
        // Standalone inverse at statement level — this is an error
        // The Jison parser would fail here too
        error('Unexpected inverse');
        break;

      case 'close':
        error('Unexpected close block');
        break;

      case 'inverseChain':
        error('Unexpected inverse chain');
        break;

      default:
        error('Unexpected token: ' + open.kind);
    }
  }

  function parseMustache(open) {
    skipWs();

    // Check for hash-only mustache: {{key=val}}
    if (isAtHash()) {
      const hash = parseHash();
      const rightStrip = consumeClose();
      const loc = locFrom(open.start);
      const strip = { open: open.leftStrip || false, close: rightStrip };
      const wrappedPath = hashSyntax(hash, loc, { yy, syntax: 'expr' });
      return {
        type: open.isDecorator ? 'Decorator' : 'MustacheStatement',
        path: wrappedPath,
        params: [],
        hash: undefined,
        escaped: determineEscaped(open),
        strip,
        loc,
      };
    }

    const path = parseExpr();
    const params = [];
    let hash = undefined;

    skipWs();
    while (pos < len && cc() !== CH_RBRACE && !(cc() === CH_TILDE && cc(1) === CH_RBRACE)) {
      if (isAtHash()) {
        hash = parseHash();
        break;
      }
      params.push(parseExpr());
      skipWs();
    }

    const rightStrip = consumeClose();
    const loc = locFrom(open.start);
    const strip = { open: open.leftStrip || false, close: rightStrip };

    return {
      type: open.isDecorator ? 'Decorator' : 'MustacheStatement',
      path,
      params,
      hash,
      escaped: determineEscaped(open),
      strip,
      loc,
    };
  }

  function determineEscaped(open) {
    if (open.unescaped) return false;
    if (open.kind === 'unescaped') return false;
    const raw = open.raw || '';
    // Check for {{{ or {{& — both are unescaped
    const c3 = raw.charAt(2);
    const c4 = raw.charAt(3);
    if (c3 === '{' || c3 === '&') return false;
    if (c3 === '~' && (c4 === '{' || c4 === '&')) return false;
    return true;
  }

  function parseUnescapedMustache(open) {
    skipWs();
    const path = parseExpr();
    const params = [];
    let hash = undefined;

    skipWs();
    while (
      pos < len &&
      !(cc() === CH_RBRACE && cc(1) === CH_RBRACE && cc(2) === CH_RBRACE) &&
      !(cc() === CH_TILDE && cc(1) === CH_RBRACE)
    ) {
      if (isAtHash()) {
        hash = parseHash();
        break;
      }
      params.push(parseExpr());
      skipWs();
    }

    const rightStrip = consumeUnescapedClose();
    const loc = locFrom(open.start);

    return {
      type: 'MustacheStatement',
      path,
      params,
      hash,
      escaped: false,
      strip: { open: open.leftStrip || false, close: rightStrip },
      loc,
    };
  }

  // === Block parsing ===

  function parseBlock(open) {
    skipWs();
    const path = parseExpr();
    const params = [];
    let hash = undefined;
    let blockParams = undefined;

    skipWs();
    while (pos < len && cc() !== CH_RBRACE && !(cc() === CH_TILDE && cc(1) === CH_RBRACE)) {
      // Check for block params (as |...|)
      if (startsWith('as') && isWhitespace(input.charCodeAt(pos + 2))) {
        const bp = parseBlockParams();
        if (bp) {
          blockParams = bp;
          break;
        }
      }
      if (isAtHash()) {
        hash = parseHash();
        skipWs();
        // Still check for block params after hash
        if (startsWith('as') && isWhitespace(input.charCodeAt(pos + 2))) {
          blockParams = parseBlockParams();
        }
        break;
      }
      params.push(parseExpr());
      skipWs();
    }

    const rightStrip = consumeClose();
    const openInfo = {
      open: open.raw,
      path,
      params,
      hash,
      blockParams,
      strip: { open: open.leftStrip || false, close: rightStrip },
    };

    // Parse the block body
    const program = parseProgram(['close', 'inverse']);

    // Check for inverse
    let inverseAndProgram = undefined;
    if (pos < len && startsWith('{{')) {
      const savedPos = pos;
      const savedLine = line;
      const savedCol = col;
      const nextOpen = consumeOpen();

      if (nextOpen.kind === 'inverse') {
        const inverseProgram = parseProgram(['close']);
        inverseAndProgram = { strip: nextOpen.strip, program: inverseProgram };
      } else if (nextOpen.kind === 'inverseChain') {
        inverseAndProgram = parseInverseChain(nextOpen);
      } else if (nextOpen.kind === 'close') {
        // Restore — close will be parsed below
        pos = savedPos;
        line = savedLine;
        col = savedCol;
      } else {
        pos = savedPos;
        line = savedLine;
        col = savedCol;
      }
    }

    // Parse close block
    const close = parseCloseBlock(path);

    return buildBlock(openInfo, program, inverseAndProgram, close, false, open.start);
  }

  function parseInverseBlock(open) {
    // Same as parseBlock but with inverted=true
    skipWs();
    const path = parseExpr();
    const params = [];
    let hash = undefined;
    let blockParams = undefined;

    skipWs();
    while (pos < len && cc() !== CH_RBRACE && !(cc() === CH_TILDE && cc(1) === CH_RBRACE)) {
      if (startsWith('as') && isWhitespace(input.charCodeAt(pos + 2))) {
        const bp = parseBlockParams();
        if (bp) {
          blockParams = bp;
          break;
        }
      }
      if (isAtHash()) {
        hash = parseHash();
        skipWs();
        if (startsWith('as') && isWhitespace(input.charCodeAt(pos + 2))) {
          blockParams = parseBlockParams();
        }
        break;
      }
      params.push(parseExpr());
      skipWs();
    }

    const rightStrip = consumeClose();
    const openInfo = {
      path,
      params,
      hash,
      blockParams,
      strip: { open: open.leftStrip || false, close: rightStrip },
    };

    const program = parseProgram(['close', 'inverse']);

    let inverseAndProgram = undefined;
    if (pos < len && startsWith('{{')) {
      const savedPos = pos;
      const savedLine = line;
      const savedCol = col;
      const nextOpen = consumeOpen();

      if (nextOpen.kind === 'inverse') {
        const inverseProgram = parseProgram(['close']);
        inverseAndProgram = { strip: nextOpen.strip, program: inverseProgram };
      } else if (nextOpen.kind === 'inverseChain') {
        inverseAndProgram = parseInverseChain(nextOpen);
      } else {
        pos = savedPos;
        line = savedLine;
        col = savedCol;
      }
    }

    const close = parseCloseBlock(path);

    return buildBlock(openInfo, program, inverseAndProgram, close, true, open.start);
  }

  function parseInverseChain(chainOpen) {
    // chainOpen is an inverseChain opener ({{else if ...}})
    skipWs();
    const path = parseExpr();
    const params = [];
    let hash = undefined;
    let blockParams = undefined;

    skipWs();
    while (pos < len && cc() !== CH_RBRACE && !(cc() === CH_TILDE && cc(1) === CH_RBRACE)) {
      if (startsWith('as') && isWhitespace(input.charCodeAt(pos + 2))) {
        const bp = parseBlockParams();
        if (bp) {
          blockParams = bp;
          break;
        }
      }
      if (isAtHash()) {
        hash = parseHash();
        skipWs();
        if (startsWith('as') && isWhitespace(input.charCodeAt(pos + 2))) {
          blockParams = parseBlockParams();
        }
        break;
      }
      params.push(parseExpr());
      skipWs();
    }

    const rightStrip = consumeClose();
    const openInfo = {
      open: chainOpen.raw,
      path,
      params,
      hash,
      blockParams,
      strip: { open: chainOpen.leftStrip || false, close: rightStrip },
    };

    const program = parseProgram(['close', 'inverse']);

    let nestedInverse = undefined;
    if (pos < len && startsWith('{{')) {
      const savedPos = pos;
      const savedLine = line;
      const savedCol = col;
      const nextOpen = consumeOpen();

      if (nextOpen.kind === 'inverse') {
        const inverseProgram = parseProgram(['close']);
        nestedInverse = { strip: nextOpen.strip, program: inverseProgram };
      } else if (nextOpen.kind === 'inverseChain') {
        nestedInverse = parseInverseChain(nextOpen);
      } else {
        pos = savedPos;
        line = savedLine;
        col = savedCol;
      }
    }

    // Build the inner block (using close = nestedInverse's last close or the parent's)
    // The close strip for chained blocks comes from the parent's close block
    const innerBlock = buildBlock(
      openInfo,
      program,
      nestedInverse,
      nestedInverse,
      false,
      chainOpen.start
    );

    const wrapperProgram = prepareProgram([innerBlock], program.loc);
    wrapperProgram.chained = true;

    return { strip: openInfo.strip, program: wrapperProgram, chain: true };
  }

  function parseCloseBlock(openPath) {
    if (!startsWith('{{')) error('Expected close block');
    const open = consumeOpen();
    if (open.kind !== 'close') error('Expected close block');

    skipWs();
    const closePath = parseExpr();
    const rightStrip = consumeClose();

    // Validate close matches open
    const openName = openPath.original || openPath.parts?.join?.('/') || '';
    const closeName = closePath.original || closePath.parts?.join?.('/') || '';
    if (openName !== closeName) {
      throw new Exception(openName + " doesn't match " + closeName, { loc: openPath.loc });
    }

    return { path: closePath, strip: { open: open.leftStrip || false, close: rightStrip } };
  }

  function buildBlock(openInfo, program, inverseAndProgram, close, inverted, startPos) {
    const isDecorator = openInfo.open ? /\*/.test(openInfo.open) : false;

    program.blockParams = openInfo.blockParams;

    let inverse, inverseStrip;

    if (inverseAndProgram) {
      if (isDecorator) {
        throw new Exception('Unexpected inverse block on decorator', inverseAndProgram);
      }

      if (inverseAndProgram.chain) {
        inverseAndProgram.program.body[0].closeStrip = close && close.strip;
      }

      inverseStrip = inverseAndProgram.strip;
      inverse = inverseAndProgram.program;
    }

    if (inverted) {
      const tmp = inverse;
      inverse = program;
      program = tmp;
    }

    return {
      type: isDecorator ? 'DecoratorBlock' : 'BlockStatement',
      path: openInfo.path,
      params: openInfo.params,
      hash: openInfo.hash,
      program,
      inverse,
      openStrip: openInfo.strip,
      inverseStrip,
      closeStrip: close && close.strip,
      loc: locFrom(startPos),
    };
  }

  // === Raw block ===

  function parseRawBlock(open) {
    skipWs();
    const path = parseExpr();
    const params = [];
    let hash = undefined;

    skipWs();
    while (
      pos < len &&
      !(cc() === CH_RBRACE && cc(1) === CH_RBRACE && cc(2) === CH_RBRACE && cc(3) === CH_RBRACE)
    ) {
      if (isAtHash()) {
        hash = parseHash();
        break;
      }
      params.push(parseExpr());
      skipWs();
    }

    // Consume }}}}
    if (!startsWith('}}}}')) error("Expected '}}}}' to close raw block");
    advanceTo(pos + 4);

    // Scan raw content until {{{{/openName}}}}
    // In the Jison 'raw' state, EVERYTHING is content except {{{{/name}}}}.
    // Nested {{{{ (not followed by /) is also content.
    // We track a nesting depth: {{{{ pushes, {{{{/name}}}} pops.
    const openName = path.original || path.parts?.join?.('/') || '';
    const contents = [];
    let rawDepth = 1; // we're inside one raw block

    while (pos < len) {
      const idx = input.indexOf('{{{{', pos);
      if (idx === -1) error('Unterminated raw block');

      // Content before {{{{
      if (idx > pos) {
        const contentStart = savePos();
        const text = input.substring(pos, idx);
        advanceTo(idx);
        contents.push({
          type: 'ContentStatement',
          original: text,
          value: text,
          loc: locFrom(contentStart),
        });
      }

      // Check if it's {{{{/ (potential close)
      if (input.charCodeAt(idx + 4) === CH_SLASH) {
        // Try to match {{{{/openName}}}}
        const closeStart = idx + 5;
        let closeEnd = closeStart;
        while (closeEnd < len && isIdChar(input.charCodeAt(closeEnd))) closeEnd++;
        const closeId = input.substring(closeStart, closeEnd);

        if (input.startsWith('}}}}', closeEnd)) {
          if (rawDepth === 1) {
            if (closeId === openName) {
              // This is our close tag
              advanceTo(closeEnd + 4);

              // Build the raw block — Jison uses the overall block loc for program too
              const loc = locFrom(open.start);
              const program = {
                type: 'Program',
                body: contents,
                strip: {},
                loc,
              };

              return {
                type: 'BlockStatement',
                path,
                params,
                hash,
                program,
                openStrip: {},
                inverseStrip: {},
                closeStrip: {},
                loc,
              };
            }
            // Mismatch: close tag doesn't match open
            throw new Exception(openName + " doesn't match " + closeId, { loc: path.loc });
          }

          if (closeId) {
            // It's a close for a nested raw block — just decrement depth and treat as content
            rawDepth--;
          }
        }

        // Not our close — treat {{{{/...}}}} as content
        const contentStart = savePos();
        const endOfTag = closeEnd + (input.startsWith('}}}}', closeEnd) ? 4 : 0);
        const text = input.substring(idx, endOfTag || idx + 5);
        advanceTo(endOfTag || idx + 5);
        contents.push({
          type: 'ContentStatement',
          original: text,
          value: text,
          loc: locFrom(contentStart),
        });
      } else {
        // {{{{ not followed by / — nested raw block opener, treat as content
        rawDepth++;
        const contentStart = savePos();
        advanceTo(idx + 4);
        const text = '{{{{';
        contents.push({
          type: 'ContentStatement',
          original: text,
          value: text,
          loc: locFrom(contentStart),
        });
      }
    }

    error('Unterminated raw block');
  }

  // === Partial ===

  function parsePartial(open) {
    skipWs();
    const name = parseExpr();
    const params = [];
    let hash = undefined;

    skipWs();
    while (pos < len && cc() !== CH_RBRACE && !(cc() === CH_TILDE && cc(1) === CH_RBRACE)) {
      if (isAtHash()) {
        hash = parseHash();
        break;
      }
      params.push(parseExpr());
      skipWs();
    }

    const rightStrip = consumeClose();

    return {
      type: 'PartialStatement',
      name,
      params,
      hash,
      indent: '',
      strip: { open: open.leftStrip || false, close: rightStrip },
      loc: locFrom(open.start),
    };
  }

  function parsePartialBlock(open) {
    skipWs();
    const name = parseExpr();
    const params = [];
    let hash = undefined;

    skipWs();
    while (pos < len && cc() !== CH_RBRACE && !(cc() === CH_TILDE && cc(1) === CH_RBRACE)) {
      if (isAtHash()) {
        hash = parseHash();
        break;
      }
      params.push(parseExpr());
      skipWs();
    }

    const rightStrip = consumeClose();

    const openInfo = {
      path: name,
      params,
      hash,
      strip: { open: open.leftStrip || false, close: rightStrip },
    };

    const program = parseProgram(['close']);
    const close = parseCloseBlock(name);

    return {
      type: 'PartialBlockStatement',
      name: openInfo.path,
      params: openInfo.params,
      hash: openInfo.hash,
      program,
      openStrip: openInfo.strip,
      closeStrip: close && close.strip,
      loc: locFrom(open.start),
    };
  }

  // === Program / root ===

  function prepareProgram(statements, loc) {
    if (!loc && statements.length) {
      const firstLoc = statements[0].loc;
      const lastLoc = statements[statements.length - 1].loc;
      if (firstLoc && lastLoc) {
        loc = {
          source: firstLoc.source,
          start: { line: firstLoc.start.line, column: firstLoc.start.column },
          end: { line: lastLoc.end.line, column: lastLoc.end.column },
        };
      }
    }
    return { type: 'Program', body: statements, strip: {}, loc: loc || undefined };
  }

  // === Entry point ===
  const result = parseProgram(null);

  if (pos < len) {
    error('Unexpected content after end of template');
  }

  return result;
}

function arrayLiteralNode(array, loc) {
  return { type: 'ArrayLiteral', items: array, loc };
}

function hashLiteralNode(hash, loc) {
  return { type: 'HashLiteral', pairs: hash.pairs, loc };
}
