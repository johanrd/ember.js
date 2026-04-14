/**
 * Unified single-pass scanner for Glimmer templates.
 *
 * Replaces the two-pass pipeline:
 *   pass 1 – @handlebars/parser  (HBS structure, treating HTML as opaque ContentStatements)
 *   pass 2 – simple-html-tokenizer (char-by-char HTML re-tokenization via tokenizePart())
 *
 * This scanner handles both HBS and HTML in ONE left-to-right pass, building
 * ASTv1 nodes directly via SourceSpan.forCharPositions() and the `b` builder API.
 */

import type { PresentArray } from '@glimmer/interfaces';
import type * as ASTv1 from '../v1/api';
import type { PreprocessOptions } from './tokenizer-event-handlers';

import * as srcApi from '../source/api';
import { SourceSpan } from '../source/loc/span';
import b from '../v1/parser-builders';
import { voidMap } from '../generation/printer';
import { generateSyntaxError } from '../syntax-error';

// ── Character constants ────────────────────────────────────────────────────────
const CH_NL = 10;
const CH_CR = 13;
const CH_SPACE = 32;
const CH_TAB = 9;
const CH_BANG = 33;
const CH_DQUOTE = 34;
const CH_HASH = 35;
const CH_AMP = 38;
const CH_SQUOTE = 39;
const CH_LPAREN = 40;
const CH_RPAREN = 41;
const CH_COLON = 58;
const CH_DASH = 45;
const CH_DOT = 46;
const CH_SLASH = 47;
const CH_0 = 48;
const CH_9 = 57;
const CH_EQ = 61;
const CH_GT = 62;
const CH_AT = 64;
const CH_LBRACKET = 91;
const CH_BACKSLASH = 92;
const CH_RBRACKET = 93;
const CH_CARET = 94;
const CH_BACKTICK = 96;
const CH_LBRACE = 123;
const CH_PIPE = 124;
const CH_RBRACE = 125;
const CH_TILDE = 126;

// ── HTML entity decoding ───────────────────────────────────────────────────────

function decodeHtmlEntity(name: string): string {
  switch (name) {
    case 'amp':
      return '&';
    case 'lt':
      return '<';
    case 'gt':
      return '>';
    case 'quot':
      return '"';
    case 'apos':
      return "'";
    case 'nbsp':
      return '\u00A0';
    case 'copy':
      return '©';
    case 'reg':
      return '®';
    case 'trade':
      return '™';
    case 'mdash':
      return '—';
    case 'ndash':
      return '–';
    case 'hellip':
      return '…';
    case 'laquo':
      return '«';
    case 'raquo':
      return '»';
    default: {
      const c0 = name.charCodeAt(0);
      if (c0 === 35 /* # */) {
        const c1 = name.charCodeAt(1);
        if (c1 === 120 || c1 === 88) {
          // x or X
          const n = parseInt(name.slice(2), 16);
          if (!isNaN(n)) return String.fromCharCode(n);
        } else {
          const n = parseInt(name.slice(1), 10);
          if (!isNaN(n)) return String.fromCharCode(n);
        }
      }
      return '&' + name + ';';
    }
  }
}

// ── Predicates ─────────────────────────────────────────────────────────────────

function isIdChar(c: number): boolean {
  if (c <= CH_SPACE) return false;
  if (c === CH_BANG || c === CH_DQUOTE || c === CH_HASH) return false;
  if (c >= 37 && c <= 44) return false; // % & ' ( ) * + ,
  if (c === CH_DOT || c === CH_SLASH) return false;
  if (c >= 59 && c <= CH_GT) return false; // ; < = >
  if (c === CH_AT) return false;
  if (c >= CH_LBRACKET && c <= CH_CARET) return false;
  if (c === CH_BACKTICK) return false;
  if (c >= CH_LBRACE && c <= CH_TILDE) return false;
  return true;
}

function isWhitespace(c: number): boolean {
  return c === CH_SPACE || c === CH_TAB || c === CH_NL || c === CH_CR || c === 12;
}

function isLookahead(c: number): boolean {
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
    c !== c // NaN
  );
}

function isLiteralLookahead(c: number): boolean {
  return (
    c === CH_TILDE ||
    c === CH_RBRACE ||
    isWhitespace(c) ||
    c === CH_RPAREN ||
    c === CH_RBRACKET ||
    c !== c
  );
}

function idFromToken(t: string): string {
  return t.charCodeAt(0) === CH_LBRACKET && t.charCodeAt(t.length - 1) === CH_RBRACKET
    ? t.substring(1, t.length - 1)
    : t;
}

function pathOriginal(p: ASTv1.PathExpression | ASTv1.SubExpression): string {
  if (p.type === 'PathExpression') return p.original;
  return '';
}

// ── Whitespace stripping helpers ───────────────────────────────────────────────

function stripTrailingWS(chars: string): string {
  let i = chars.length;
  while (i > 0 && isWhitespace(chars.charCodeAt(i - 1))) i--;
  return chars.slice(0, i);
}

function stripLeadingWS(chars: string): string {
  let i = 0;
  while (i < chars.length && isWhitespace(chars.charCodeAt(i))) i++;
  return chars.slice(i);
}

// ── Apply tilde stripping (~ flags on mustaches and blocks) ────────────────────
//
// Iterates through body and applies strip.open / strip.close / openStrip / closeStrip
// whitespace trimming on adjacent TextNode siblings.

function applyTildeStripping(body: ASTv1.Statement[]): ASTv1.Statement[] {
  for (let i = 0; i < body.length; i++) {
    const node = body[i];
    if (!node) continue;

    if (node.type === 'MustacheStatement') {
      const m = node;
      if (m.strip.open) {
        const prev = i > 0 ? body[i - 1] : null;
        if (prev?.type === 'TextNode') prev.chars = stripTrailingWS(prev.chars);
      }
      if (m.strip.close) {
        const next = i < body.length - 1 ? body[i + 1] : null;
        if (next?.type === 'TextNode') next.chars = stripLeadingWS(next.chars);
      }
    }

    if (node.type === 'MustacheCommentStatement') {
      const m = node;
      const strip = (m as unknown as Record<string, unknown>)['__strip'] as
        | { open: boolean; close: boolean }
        | undefined;
      if (strip?.open) {
        const prev = i > 0 ? body[i - 1] : null;
        if (prev?.type === 'TextNode') prev.chars = stripTrailingWS(prev.chars);
      }
      if (strip?.close) {
        const next = i < body.length - 1 ? body[i + 1] : null;
        if (next?.type === 'TextNode') next.chars = stripLeadingWS(next.chars);
      }
    }

    if (node.type === 'BlockStatement') {
      const bs = node;
      // openStrip.open: strip trailing WS from text before this block
      if (bs.openStrip.open) {
        const prev = i > 0 ? body[i - 1] : null;
        if (prev?.type === 'TextNode') prev.chars = stripTrailingWS(prev.chars);
      }
      // openStrip.close: strip leading WS from first child of program
      if (bs.openStrip.close) {
        const first = bs.program.body[0];
        if (first?.type === 'TextNode') first.chars = stripLeadingWS(first.chars);
      }
      // inverseStrip.open: strip trailing WS from last child of program (before {{else}})
      if (bs.inverseStrip.open) {
        const prog = bs.program.body;
        const last = prog[prog.length - 1];
        if (last?.type === 'TextNode') last.chars = stripTrailingWS(last.chars);
      }
      // inverseStrip.close: strip leading WS from first child of inverse (after {{else}})
      if (bs.inverseStrip.close && bs.inverse) {
        const first = bs.inverse.body[0];
        if (first?.type === 'TextNode') first.chars = stripLeadingWS(first.chars);
      }
      // closeStrip.open: strip trailing WS from last child of program/inverse
      if (bs.closeStrip.open) {
        const prog = bs.inverse ?? bs.program;
        const last = prog.body[prog.body.length - 1];
        if (last?.type === 'TextNode') last.chars = stripTrailingWS(last.chars);
      }
      // closeStrip.close: strip leading WS from text after this block
      if (bs.closeStrip.close) {
        const next = i < body.length - 1 ? body[i + 1] : null;
        if (next?.type === 'TextNode') next.chars = stripLeadingWS(next.chars);
      }
    }
  }

  // Remove empty text nodes
  const result = body.filter((n) => !(n.type === 'TextNode' && n.chars === ''));

  // Recurse
  for (const n of result) {
    if (n.type === 'BlockStatement') {
      const bs = n;
      bs.program.body = applyTildeStripping(bs.program.body);
      if (bs.inverse) bs.inverse.body = applyTildeStripping(bs.inverse.body);
    } else if (n.type === 'ElementNode') {
      n.children = applyTildeStripping(n.children);
    }
  }

  return result;
}

// ── Standalone-line whitespace stripping ───────────────────────────────────────
//
// Mirrors Handlebars' WhitespaceControl post-pass.
// A BlockStatement or MustacheCommentStatement is "standalone" when the text
// immediately before it (from the last \n to the node) contains only spaces/tabs,
// AND the text immediately after it (up to and including the first \n) contains
// only spaces/tabs.  If so, strip that surrounding whitespace and the leading/
// trailing whitespace inside the block's program/inverse bodies.
//
// IMPORTANT: we also check that the char immediately after the opening tag's }}
// is a newline (openTagEnd check). This prevents incorrectly marking
// `{{#if foo}}Foo{{/if}}` as standalone when there's content on the same line.

function isOnlySpacesAndTabs(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function applyStandaloneStripping(
  body: ASTv1.Statement[],
  input: string,
  source: srcApi.Source
): ASTv1.Statement[] {
  const len = input.length;

  // Helper: update the loc of a TextNode after stripping chars from its front
  function trimLocStart(t: ASTv1.TextNode, stripped: number): void {
    if (stripped <= 0) return;
    const s = t.loc.getStart().offset;
    const e = t.loc.getEnd().offset;
    if (s !== null && e !== null) t.loc = SourceSpan.forCharPositions(source, s + stripped, e);
  }

  // Helper: update the loc of a TextNode after stripping chars from its end
  function trimLocEnd(t: ASTv1.TextNode, stripped: number): void {
    if (stripped <= 0) return;
    const s = t.loc.getStart().offset;
    const e = t.loc.getEnd().offset;
    if (s !== null && e !== null) t.loc = SourceSpan.forCharPositions(source, s, e - stripped);
  }

  for (let i = 0; i < body.length; i++) {
    const node = body[i];
    if (!node) continue;
    if (node.type !== 'BlockStatement' && node.type !== 'MustacheCommentStatement') continue;

    // Chained blocks ({{else if}}) are not standalone on their own.
    if ((node as unknown as Record<string, unknown>)['__chained']) continue;

    const prevNode = i > 0 ? (body[i - 1] ?? null) : null;
    const nextNode = i < body.length - 1 ? (body[i + 1] ?? null) : null;
    const prev = prevNode?.type === 'TextNode' ? prevNode : null;
    const next = nextNode?.type === 'TextNode' ? nextNode : null;

    // A non-text node immediately before/after means something is on the same line → not standalone.
    if (prevNode !== null && prev === null) continue;
    if (nextNode !== null && next === null) continue;

    // Get the openTagEnd position (char right after the opening }})
    const openTagEnd = (node as unknown as Record<string, unknown>)['__openTagEnd'] as
      | number
      | undefined;

    // Check that everything from the opening }} to the end of the line is whitespace.
    // This prevents treating `{{#wat}} foo {{/wat}}` as standalone.
    if (openTagEnd !== undefined) {
      let afterOpenOk = true;
      let p = openTagEnd;
      while (p < len && input.charCodeAt(p) !== CH_NL && input.charCodeAt(p) !== CH_CR) {
        if (!isWhitespace(input.charCodeAt(p))) {
          afterOpenOk = false;
          break;
        }
        p++;
      }
      if (!afterOpenOk) continue;
    }

    // prev OK: everything from the last \n (exclusive) to end must be spaces/tabs only
    const prevStr = prev ? prev.chars : '';
    const prevLastNL = prevStr.lastIndexOf('\n');
    const prevAfterNL = prevLastNL === -1 ? prevStr : prevStr.slice(prevLastNL + 1);
    let prevOk = !prev || isOnlySpacesAndTabs(prevAfterNL);

    // If there's no newline in prevStr (or no prevStr at all), scan the source backward
    // from before the prev text to verify there really is a newline or start-of-input there.
    // This catches `<ul>{{#each}}` (no prev text node) and `foo {{#each}}` (prev with no newline).
    if (prevOk && prevLastNL === -1) {
      const blockStartOff = node.loc.getStart().offset;
      if (blockStartOff !== null) {
        const prevLen = prev ? prevStr.length : 0;
        let p = blockStartOff - prevLen - 1;
        while (p >= 0 && (input.charCodeAt(p) === CH_SPACE || input.charCodeAt(p) === CH_TAB)) p--;
        if (p >= 0 && input.charCodeAt(p) !== CH_NL && input.charCodeAt(p) !== CH_CR) {
          prevOk = false;
        }
      }
    }

    // next OK: everything from start to first \n (exclusive) must be spaces/tabs only
    const nextStr = next ? next.chars : '';
    const nextFirstNL = nextStr.indexOf('\n');
    const nextBeforeNL = nextFirstNL === -1 ? nextStr : nextStr.slice(0, nextFirstNL);
    let nextOk = !next || isOnlySpacesAndTabs(nextBeforeNL);

    // If the next text has no newline AND there's a non-text node right after it,
    // that node is on the same line as this block's closing tag → not standalone.
    if (nextOk && nextFirstNL === -1 && next !== null) {
      const nodeAfterText = i + 2 < body.length ? body[i + 2] : null;
      if (nodeAfterText !== null) nextOk = false;
    }

    if (!prevOk || !nextOk) continue;

    // Strip prev: drop everything after the last \n
    if (prev) {
      const origLen = prevStr.length;
      prev.chars = prevLastNL === -1 ? '' : prevStr.slice(0, prevLastNL + 1);
      trimLocEnd(prev, origLen - prev.chars.length);
    }

    // Strip next: drop everything up to and including the first \n
    if (next) {
      const stripped = nextFirstNL === -1 ? nextStr.length : nextFirstNL + 1;
      next.chars = nextFirstNL === -1 ? '' : nextStr.slice(nextFirstNL + 1);
      trimLocStart(next, stripped);
    }

    // Strip first/last children inside the block's program and inverse bodies
    if (node.type === 'BlockStatement') {
      const bs = node;
      for (const prog of [bs.program, bs.inverse]) {
        if (!prog || prog.body.length === 0) continue;

        // Strip leading \n from first child (for the open-tag line being standalone)
        const first = prog.body[0];
        if (first && first.type === 'TextNode') {
          const t = first;
          const nl = t.chars.indexOf('\n');
          const stripped = nl === -1 ? t.chars.length : nl + 1;
          t.chars = nl === -1 ? '' : t.chars.slice(nl + 1);
          trimLocStart(t, stripped);
        }

        // Strip trailing spaces/tabs from last child (for the close-tag line being standalone)
        const last = prog.body[prog.body.length - 1];
        if (last && last.type === 'TextNode') {
          const t = last;
          const nl = t.chars.lastIndexOf('\n');
          const origLen = t.chars.length;
          t.chars = nl === -1 ? '' : t.chars.slice(0, nl + 1);
          trimLocEnd(t, origLen - t.chars.length);
        }
      }

      // For chained inverses ({{else if}}), also strip the first child of each chained block's program body.
      if (bs.inverse?.chained) {
        let inv: ASTv1.Block | null | undefined = bs.inverse;
        while (inv?.chained) {
          const chainedBlock = inv.body[0] as ASTv1.BlockStatement | undefined;
          if (!chainedBlock) break;
          const chainedFirst = chainedBlock.program.body[0];
          if (chainedFirst?.type === 'TextNode') {
            const t = chainedFirst;
            const nl = t.chars.indexOf('\n');
            const stripped = nl === -1 ? t.chars.length : nl + 1;
            t.chars = nl === -1 ? '' : t.chars.slice(nl + 1);
            trimLocStart(t, stripped);
          }
          inv = chainedBlock.inverse ?? null;
        }
      }
    }
  }

  // Remove now-empty text nodes
  const result = body.filter((n) => !(n.type === 'TextNode' && n.chars === ''));

  // Recurse into element children and block bodies
  for (const n of result) {
    if (n.type === 'BlockStatement') {
      const bs = n;
      bs.program.body = applyStandaloneStripping(bs.program.body, input, source);
      if (bs.inverse) bs.inverse.body = applyStandaloneStripping(bs.inverse.body, input, source);
    } else if (n.type === 'ElementNode') {
      n.children = applyStandaloneStripping(n.children, input, source);
    }
  }

  return result;
}

// ── Main export ────────────────────────────────────────────────────────────────

export function unifiedPreprocess(input: string, options: PreprocessOptions = {}): ASTv1.Template {
  const source = new srcApi.Source(input, options.meta?.moduleName);
  const len = input.length;
  const codemod = options.mode === 'codemod';

  let pos = 0,
    line = 1,
    col = 0;

  // ── Span ───────────────────────────────────────────────────────────────────────
  function sp(s: number, e: number): SourceSpan {
    return SourceSpan.forCharPositions(source, s, e);
  }

  // ── Position tracking ─────────────────────────────────────────────────────────
  function advanceTo(t: number): void {
    while (pos < t) {
      const nl = input.indexOf('\n', pos);
      if (nl === -1 || nl >= t) {
        col += t - pos;
        pos = t;
        return;
      }
      line++;
      col = 0;
      pos = nl + 1;
    }
  }

  function cc(o = 0): number {
    return input.charCodeAt(pos + o);
  }
  function sw(s: string, o = 0): boolean {
    return input.startsWith(s, pos + o);
  }

  interface Sv {
    pos: number;
    line: number;
    col: number;
  }
  function save(): Sv {
    return { pos, line, col };
  }
  function restore(s: Sv): void {
    pos = s.pos;
    line = s.line;
    col = s.col;
  }

  function skipWs(): void {
    while (pos < len) {
      const c = cc();
      if (c === CH_NL) {
        line++;
        col = 0;
        pos++;
      } else if (c === CH_CR) {
        line++;
        col = 0;
        pos++;
        if (pos < len && cc() === CH_NL) pos++;
      } else if (c === CH_SPACE || c === CH_TAB || c === 12) {
        col++;
        pos++;
      } else break;
    }
  }

  function err(msg: string): never {
    throw new Error(
      `Parse error on line ${line}: ${msg} (near: ${JSON.stringify(input.slice(pos, pos + 20))})`
    );
  }

  // ── Low-level scanning ────────────────────────────────────────────────────────
  function scanId(): string | null {
    const s = pos;
    while (pos < len && isIdChar(cc())) {
      col++;
      pos++;
    }
    return pos > s ? input.substring(s, pos) : null;
  }

  function scanIdOrEscaped(): string | null {
    if (cc() === CH_LBRACKET) {
      const s = pos;
      col++;
      pos++;
      while (pos < len) {
        const c = cc();
        if (c === CH_BACKSLASH && pos + 1 < len) {
          col += 2;
          pos += 2;
        } else if (c === CH_RBRACKET) {
          col++;
          pos++;
          return input.substring(s, pos);
        } else if (c === CH_NL) {
          line++;
          col = 0;
          pos++;
        } else {
          col++;
          pos++;
        }
      }
      err('Unterminated [...]');
    }
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

  function scanString(): { value: string; s: number; e: number } | null {
    const q = cc();
    if (q !== CH_DQUOTE && q !== CH_SQUOTE) return null;
    const s = pos;
    col++;
    pos++;
    let result = '',
      seg = pos;
    while (pos < len) {
      const c = cc();
      if (c === CH_BACKSLASH && pos + 1 < len && cc(1) === q) {
        result += input.substring(seg, pos);
        col += 2;
        pos += 2;
        result += String.fromCharCode(q);
        seg = pos;
      } else if (c === q) {
        result += input.substring(seg, pos);
        col++;
        pos++;
        return { value: result, s, e: pos };
      } else if (c === CH_NL) {
        line++;
        col = 0;
        pos++;
      } else {
        col++;
        pos++;
      }
    }
    err('Unterminated string');
  }

  function scanNumber(): string | null {
    const sv = save();
    if (cc() === CH_DASH) {
      col++;
      pos++;
    }
    if (pos >= len || cc() < CH_0 || cc() > CH_9) {
      restore(sv);
      return null;
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
    if (pos < len && !isLiteralLookahead(cc())) {
      restore(sv);
      return null;
    }
    return input.substring(sv.pos, pos);
  }

  function scanSep(): string | null {
    if (cc() === CH_DOT && cc(1) === CH_HASH) {
      col += 2;
      pos += 2;
      return '.#';
    }
    if (cc() === CH_DOT || cc() === CH_SLASH) {
      const c = input[pos] ?? null;
      col++;
      pos++;
      return c;
    }
    return null;
  }

  // ── ASTv1 path building ───────────────────────────────────────────────────────
  function buildPath(
    data: boolean,
    segs: Array<{ part: string; original: string; separator?: string }>,
    s: number,
    e: number
  ): ASTv1.PathExpression {
    const fullSp = sp(s, e);
    let orig = data ? '@' : '';
    const tail: string[] = [];

    for (const { part, original, separator } of segs) {
      const esc = original !== part;
      const pfx = separator === '.#' ? '#' : '';
      orig += (separator ?? '') + part;
      if (!esc && (part === '..' || part === '.' || part === 'this')) {
        // depth tracking
      } else {
        tail.push(`${pfx}${part}`);
      }
    }

    // Detect ...attributes (illegal spread)
    if (orig === '...attributes') {
      throw generateSyntaxError('Illegal use of ...attributes', fullSp);
    }

    // Glimmer validations
    if (orig.includes('/')) {
      if (orig.startsWith('./'))
        throw generateSyntaxError(`Using "./" is not supported in Glimmer and unnecessary`, fullSp);
      if (orig.startsWith('../'))
        throw generateSyntaxError(
          `Changing context using "../" is not supported in Glimmer`,
          fullSp
        );
      if (orig.includes('.'))
        throw generateSyntaxError(
          `Mixing '.' and '/' in paths is not supported in Glimmer; use only '.' to separate property paths`,
          fullSp
        );
      return b.path({ head: b.var({ name: orig, loc: fullSp }), tail: [], loc: fullSp });
    }
    if (orig === '.')
      throw generateSyntaxError(
        `'.' is not a supported path in Glimmer; check for a path with a trailing '.'`,
        fullSp
      );

    const tailCopy = [...tail];
    let head: ASTv1.PathHead;

    if (orig === 'this' || orig.startsWith('this.')) {
      head = b.this({ loc: sp(s, s + 4) });
    } else if (data) {
      if (!tailCopy.length)
        throw generateSyntaxError(
          `Attempted to parse a path expression, but it was not valid. Paths beginning with @ must start with a-z.`,
          fullSp
        );
      const hname = tailCopy.shift() ?? err('Expected path segment');
      head = b.atName({ name: `@${hname}`, loc: sp(s, s + 1 + hname.length) });
    } else {
      if (!tailCopy.length)
        throw generateSyntaxError(
          `Attempted to parse a path expression, but it was not valid. Paths must start with a-z or A-Z.`,
          fullSp
        );
      const hname = tailCopy.shift() ?? err('Expected path segment');
      head = b.var({ name: hname, loc: sp(s, s + hname.length) });
    }

    return b.path({ head, tail: tailCopy, loc: fullSp });
  }

  function parsePath(data: boolean, s: number): ASTv1.PathExpression {
    const segs: Array<{ part: string; original: string; separator?: string }> = [];
    const first = scanIdOrEscaped();
    if (!first) err('Expected path identifier');
    segs.push({ part: idFromToken(first), original: first });
    while (pos < len) {
      const sv = save();
      const sep = scanSep();
      if (!sep) break;
      const id = scanIdOrEscaped();
      if (!id) {
        restore(sv);
        break;
      }
      segs.push({ part: idFromToken(id), original: id, separator: sep });
    }
    return buildPath(data, segs, s, pos);
  }

  // ── Build a PathExpression from an HTML tag name string ───────────────────────
  // Handles: Foo, Foo.bar.baz, this, this.foo.bar, @Foo, @Foo.bar.baz, :foo
  function buildTagPath(tag: string, ns: number, ne: number): ASTv1.PathExpression {
    const fullSpan = sp(ns, ne);

    // Named block: :foo
    if (tag.startsWith(':')) {
      const head = b.var({ name: tag, loc: fullSpan });
      return b.path({ head, tail: [], loc: fullSpan });
    }

    // @-argument: @Foo or @Foo.bar.baz
    if (tag.startsWith('@')) {
      const dotIdx = tag.indexOf('.');
      const headStr = dotIdx === -1 ? tag : tag.slice(0, dotIdx);
      const tailParts = dotIdx === -1 ? [] : tag.slice(dotIdx + 1).split('.');
      const head = b.atName({ name: headStr, loc: sp(ns, ns + headStr.length) });
      return b.path({ head, tail: tailParts, loc: fullSpan });
    }

    // this or this.foo.bar
    if (tag === 'this' || tag.startsWith('this.')) {
      const tailParts = tag === 'this' ? [] : tag.slice(5).split('.');
      const head = b.this({ loc: sp(ns, ns + 4) });
      return b.path({ head, tail: tailParts, loc: fullSpan });
    }

    // Regular: Foo or Foo.bar.baz
    const dotIdx = tag.indexOf('.');
    const headName = dotIdx === -1 ? tag : tag.slice(0, dotIdx);
    const tailParts = dotIdx === -1 ? [] : tag.slice(dotIdx + 1).split('.');
    const head = b.var({ name: headName, loc: sp(ns, ns + headName.length) });
    return b.path({ head, tail: tailParts, loc: fullSpan });
  }

  // ── Expressions ───────────────────────────────────────────────────────────────
  function parseExpr(): ASTv1.Expression {
    skipWs();
    const s = pos;
    const c = cc();

    if (c === CH_LPAREN) return parseSexpr();

    if (c === CH_DQUOTE || c === CH_SQUOTE) {
      const str = scanString() ?? err('Expected string literal');
      return b.literal({ type: 'StringLiteral', value: str.value, loc: sp(str.s, str.e) });
    }

    if (c === CH_DASH || (c >= CH_0 && c <= CH_9)) {
      const sv = save();
      const num = scanNumber();
      if (num !== null)
        return b.literal({ type: 'NumberLiteral', value: Number(num), loc: sp(s, pos) });
      restore(sv);
    }

    if (sw('true') && isLiteralLookahead(cc(4))) {
      advanceTo(pos + 4);
      return b.literal({ type: 'BooleanLiteral', value: true, loc: sp(s, pos) });
    }
    if (sw('false') && isLiteralLookahead(cc(5))) {
      advanceTo(pos + 5);
      return b.literal({ type: 'BooleanLiteral', value: false, loc: sp(s, pos) });
    }
    if (sw('undefined') && isLiteralLookahead(cc(9))) {
      advanceTo(pos + 9);
      return b.literal({ type: 'UndefinedLiteral', value: undefined, loc: sp(s, pos) });
    }
    if (sw('null') && isLiteralLookahead(cc(4))) {
      advanceTo(pos + 4);
      return b.literal({ type: 'NullLiteral', value: null, loc: sp(s, pos) });
    }

    if (c === CH_AT) {
      col++;
      pos++;
      // After @, must have a valid non-digit identifier start (allow '.' to fall through to parsePath
      // so it can produce the "Attempted to parse a path expression" error via buildPath)
      const nc = cc();
      if (nc >= CH_0 && nc <= CH_9) err("Expecting 'ID'");
      if (!isIdChar(nc) && nc !== CH_DOT) err("Expecting 'ID'");
      return parsePath(true, s);
    }
    return parsePath(false, s);
  }

  function literalError(lit: ASTv1.Literal): never {
    let rawValue: string;
    let display: string;
    if (lit.type === 'StringLiteral') {
      rawValue = lit.value;
      display = JSON.stringify(rawValue);
    } else if (lit.type === 'BooleanLiteral') {
      rawValue = String(lit.value);
      display = rawValue;
    } else if (lit.type === 'NumberLiteral') {
      rawValue = String(lit.value);
      display = rawValue;
    } else if (lit.type === 'UndefinedLiteral') {
      rawValue = 'undefined';
      display = 'undefined';
    } else {
      rawValue = 'null';
      display = 'null';
    }
    throw generateSyntaxError(
      `${lit.type} "${rawValue}" cannot be called as a sub-expression, replace (${display}) with ${display}`,
      lit.loc
    );
  }

  function parseSexpr(): ASTv1.SubExpression {
    const s = pos;
    col++;
    pos++; // skip (
    skipWs();
    const head = parseExpr();
    // Literals cannot be sub-expression heads
    if (head.type !== 'PathExpression' && head.type !== 'SubExpression') {
      literalError(head as ASTv1.Literal);
    }
    const path = head;
    const params: ASTv1.Expression[] = [];
    let hash: ASTv1.Hash | undefined;
    skipWs();
    while (cc() !== CH_RPAREN && pos < len) {
      if (isAtHash()) {
        hash = parseHash();
        break;
      }
      params.push(parseExpr());
      skipWs();
    }
    if (cc() !== CH_RPAREN) err("Expected ')'");
    col++;
    pos++;
    if (!hash) hash = b.hash({ pairs: [], loc: sp(pos, pos) });
    return b.sexpr({ path, params, hash, loc: sp(s, pos) });
  }

  function isAtHash(): boolean {
    if (!isIdChar(cc()) && cc() !== CH_LBRACKET) return false;
    let p = pos;
    if (input.charCodeAt(p) === CH_LBRACKET) {
      p++;
      while (p < len && input.charCodeAt(p) !== CH_RBRACKET) {
        if (input.charCodeAt(p) === CH_BACKSLASH) p++;
        p++;
      }
      p++;
    } else {
      while (p < len && isIdChar(input.charCodeAt(p))) p++;
    }
    while (p < len && isWhitespace(input.charCodeAt(p))) p++;
    return p < len && input.charCodeAt(p) === CH_EQ;
  }

  function parseHash(): ASTv1.Hash {
    const s = pos;
    const pairs: ASTv1.HashPair[] = [];
    let lastEnd = pos;
    while (pos < len && isAtHash()) {
      skipWs();
      const ps = pos;
      const key = scanIdOrEscaped();
      if (!key) err('Expected hash key');
      skipWs();
      if (cc() !== CH_EQ) err("Expected '='");
      col++;
      pos++;
      const value = parseExpr();
      lastEnd = pos;
      pairs.push(b.pair({ key: idFromToken(key), value, loc: sp(ps, pos) }));
      const sv = save();
      skipWs();
      if (!isAtHash()) {
        restore(sv);
        break;
      }
    }
    return b.hash({ pairs, loc: sp(s, lastEnd) });
  }

  function consumeClose(): boolean {
    skipWs();
    let rs = false;
    if (cc() === CH_TILDE) {
      rs = true;
      col++;
      pos++;
    }
    if (cc() !== CH_RBRACE || cc(1) !== CH_RBRACE) err("Expected '}}'");
    advanceTo(pos + 2);
    return rs;
  }

  // Returns array of {name, s, e} with absolute char positions
  interface BlockParam {
    name: string;
    s: number;
    e: number;
  }

  function parseHbsBlockParams(): BlockParam[] | null {
    skipWs();
    if (!sw('as')) return null;
    const afterAs = pos + 2;
    if (afterAs >= len || !isWhitespace(input.charCodeAt(afterAs))) return null;
    let p = afterAs;
    while (p < len && isWhitespace(input.charCodeAt(p))) p++;
    if (p >= len || input.charCodeAt(p) !== CH_PIPE) return null;
    advanceTo(p + 1);
    const params: BlockParam[] = [];
    skipWs();
    while (cc() !== CH_PIPE && pos < len) {
      const ps = pos;
      const id = scanId();
      if (!id) err('Expected block param identifier');
      params.push({ name: id, s: ps, e: pos });
      skipWs();
    }
    if (cc() !== CH_PIPE) err("Expected '|'");
    col++;
    pos++;
    return params;
  }

  // Parse path+params+hash inside a mustache, return guts
  // openPos: absolute char position of the opening {{ (for error reporting)
  function parseMustacheGuts(leftStrip: boolean, wantBlockParams: boolean, openPos?: number) {
    skipWs();

    // Detect ...attributes early (for proper span in errors)
    if (cc() === CH_DOT && cc(1) === CH_DOT && cc(2) === CH_DOT) {
      // Consume to end of mustache to get full span
      let p = pos;
      while (
        p < len &&
        !(input.charCodeAt(p) === CH_RBRACE && input.charCodeAt(p + 1) === CH_RBRACE)
      )
        p++;
      const endPos = p + 2;
      advanceTo(endPos);
      const errStart = openPos !== undefined ? openPos : pos - 2;
      throw generateSyntaxError('Illegal use of ...attributes', sp(errStart, pos));
    }

    const path = parseExpr() as ASTv1.PathExpression | ASTv1.SubExpression;
    const params: ASTv1.Expression[] = [];
    let hash: ASTv1.Hash | undefined;
    let blockParams: BlockParam[] = [];

    skipWs();
    while (pos < len && cc() !== CH_RBRACE && !(cc() === CH_TILDE && cc(1) === CH_RBRACE)) {
      if (wantBlockParams && sw('as') && isWhitespace(input.charCodeAt(pos + 2))) {
        const bp = parseHbsBlockParams();
        if (bp) {
          blockParams = bp;
          break;
        }
      }
      if (isAtHash()) {
        hash = parseHash();
        skipWs();
        if (wantBlockParams && sw('as') && isWhitespace(input.charCodeAt(pos + 2))) {
          blockParams = parseHbsBlockParams() ?? [];
        }
        break;
      }
      params.push(parseExpr());
      skipWs();
    }
    const rightStrip = consumeClose();
    if (!hash) hash = b.hash({ pairs: [], loc: sp(pos, pos) });
    return { path, params, hash, blockParams, strip: { open: leftStrip, close: rightStrip } };
  }

  // ── Open classifier ───────────────────────────────────────────────────────────
  interface Open {
    kind: string;
    s: number;
    leftStrip: boolean;
    rightStrip?: boolean; // for inverse/inverse-chain
    value?: string; // for comment
    unescaped?: boolean; // for & or {{{
    isDecorator?: boolean;
    commentStrip?: { open: boolean; close: boolean }; // for comments with tilde
  }

  function classifyOpen(): Open {
    const s = pos;
    if (sw('{{{{')) err('Raw blocks not supported');
    advanceTo(pos + 2); // skip {{
    let ls = false;
    if (cc() === CH_TILDE) {
      ls = true;
      col++;
      pos++;
    }
    const afterStrip = save();
    skipWs();
    const wsSkipped = pos > afterStrip.pos;

    // 'else' check
    if (sw('else')) {
      const afterElse = pos + 4;
      const cae = input.charCodeAt(afterElse);
      if (isWhitespace(cae) || cae === CH_TILDE || cae === CH_RBRACE) {
        advanceTo(afterElse);
        skipWs();
        let rs = false;
        if (cc() === CH_TILDE) {
          rs = true;
          col++;
          pos++;
        }
        if (cc() === CH_RBRACE && cc(1) === CH_RBRACE) {
          advanceTo(pos + 2);
          return { kind: 'inverse', s, leftStrip: ls, rightStrip: rs };
        }
        // {{else X ...}} — inverseChain
        if (pos !== afterElse) {
          restore(afterStrip);
          advanceTo(afterElse);
        }
        skipWs();
        return { kind: 'inverseChain', s, leftStrip: ls };
      }
      restore(afterStrip);
    } else if (wsSkipped) restore(afterStrip);

    const c = cc();
    switch (c) {
      case CH_BANG: {
        col++;
        pos++;
        const ab = pos;
        const sdd = input.charCodeAt(ab) === CH_DASH && input.charCodeAt(ab + 1) === CH_DASH;
        if (sdd) {
          let sf = ab + 2;
          while (sf < len) {
            const di = input.indexOf('--', sf);
            if (di === -1) break;
            let ad = di + 2;
            let tr = false;
            if (ad < len && input.charCodeAt(ad) === CH_TILDE) {
              tr = true;
              ad++;
            }
            if (
              ad + 1 < len &&
              input.charCodeAt(ad) === CH_RBRACE &&
              input.charCodeAt(ad + 1) === CH_RBRACE
            ) {
              const lme = ad + 2;
              const lrs = tr;
              const raw = input.substring(s, lme);
              advanceTo(lme);
              const val = raw.replace(/^\{\{~?!-?-?/, '').replace(/-?-?~?\}\}$/, '');
              return {
                kind: 'comment',
                s,
                leftStrip: ls,
                value: val,
                commentStrip: { open: ls, close: lrs },
              };
            }
            sf = di + 1;
          }
        }
        // Single-line comment or non-long-form
        const se = input.indexOf('}}', ab);
        if (se === -1) err('Unterminated comment');
        let srs = false;
        if (se > 0 && input.charCodeAt(se - 1) === CH_TILDE) srs = true;
        const sme = se + 2;
        const raw = input.substring(s, sme);
        advanceTo(sme);
        const val = raw.replace(/^\{\{~?!-?-?/, '').replace(/-?-?~?\}\}$/, '');
        return {
          kind: 'comment',
          s,
          leftStrip: ls,
          value: val,
          commentStrip: { open: ls, close: srs },
        };
      }
      case 35: {
        /* # */ col++;
        pos++; // CH_HASH
        if (cc() === CH_GT) {
          // Partial block: {{#> name}}...{{/name}} - consume all and throw
          col++;
          pos++; // skip >
          const pbNameEnd = input.indexOf('}}', pos);
          const pbName = pbNameEnd !== -1 ? input.substring(pos, pbNameEnd).trim() : '';
          if (pbNameEnd !== -1) advanceTo(pbNameEnd + 2);
          // Find and consume matching close block
          const pbClose = `{{/${pbName}}}`;
          const pbCloseIdx = pbName ? input.indexOf(pbClose, pos) : -1;
          if (pbCloseIdx !== -1) advanceTo(pbCloseIdx + pbClose.length);
          throw generateSyntaxError('Handlebars partial blocks are not supported', sp(s, pos));
        }
        const isDecorator35 = cc() === 42; /* * */
        if (isDecorator35) {
          col++;
          pos++;
          // Decorator block: {{#* name}}...{{/name}} - consume all and throw
          const dbNameEnd = input.indexOf('}}', pos);
          const dbName = dbNameEnd !== -1 ? input.substring(pos, dbNameEnd).trim() : '';
          if (dbNameEnd !== -1) advanceTo(dbNameEnd + 2);
          const dbClose = `{{/${dbName}}}`;
          const dbCloseIdx = dbName ? input.indexOf(dbClose, pos) : -1;
          if (dbCloseIdx !== -1) advanceTo(dbCloseIdx + dbClose.length);
          throw generateSyntaxError('Handlebars decorator blocks are not supported', sp(s, pos));
        }
        return { kind: 'block', s, leftStrip: ls };
      }
      case CH_SLASH:
        col++;
        pos++;
        return { kind: 'close', s, leftStrip: ls };
      case CH_GT: {
        // Partial: {{> name}} - consume and throw
        col++;
        pos++;
        const pEnd = input.indexOf('}}', pos);
        if (pEnd !== -1) advanceTo(pEnd + 2);
        throw generateSyntaxError('Handlebars partials are not supported', sp(s, pos));
      }
      case CH_CARET: {
        col++;
        pos++;
        skipWs();
        let rs = false;
        if (cc() === CH_TILDE) {
          const sv = save();
          rs = true;
          col++;
          pos++;
          if (cc() === CH_RBRACE && cc(1) === CH_RBRACE) {
            advanceTo(pos + 2);
            return { kind: 'inverse', s, leftStrip: ls, rightStrip: rs };
          }
          restore(sv);
          rs = false;
        }
        if (cc() === CH_RBRACE && cc(1) === CH_RBRACE) {
          advanceTo(pos + 2);
          return { kind: 'inverse', s, leftStrip: ls, rightStrip: false };
        }
        return { kind: 'openInverse', s, leftStrip: ls };
      }
      case CH_LBRACE:
        col++;
        pos++;
        return { kind: 'unescaped', s, leftStrip: ls };
      case CH_AMP:
        col++;
        pos++;
        return { kind: 'mustache', s, leftStrip: ls, unescaped: true };
      case 42: /* * */ {
        col++;
        pos++;
        // Decorator: {{* name}} - consume and throw
        const dEnd = input.indexOf('}}', pos);
        if (dEnd !== -1) advanceTo(dEnd + 2);
        throw generateSyntaxError('Handlebars decorators are not supported', sp(s, pos));
      }
      default:
        return { kind: 'mustache', s, leftStrip: ls };
    }
  }

  // ── Stack frames ──────────────────────────────────────────────────────────────
  interface TemplateFrame {
    kind: 'template';
    body: ASTv1.Statement[];
  }
  interface ElementFrame {
    kind: 'element';
    tag: string;
    ns: number; // char pos of start of tag name
    ltPos: number; // char pos of '<'
    openTagEnd: number; // char pos just after '>'
    attrs: ASTv1.AttrNode[];
    modifiers: ASTv1.ElementModifierStatement[];
    params: ASTv1.VarHead[];
    comments: ASTv1.MustacheCommentStatement[];
    children: ASTv1.Statement[];
    inSVG: boolean; // whether this element is inside an SVG context
  }
  interface BlockFrame {
    kind: 'block';
    openStart: number; // char pos of '{{'
    openTagEnd: number; // char pos right after '}}' of opening tag
    path: ASTv1.PathExpression | ASTv1.SubExpression;
    params: ASTv1.Expression[];
    hash: ASTv1.Hash;
    blockParams: BlockParam[];
    openStrip: ASTv1.StripFlags;
    defaultBody: ASTv1.Statement[];
    elseBody: ASTv1.Statement[] | null;
    inverseStrip: ASTv1.StripFlags;
    inElse: boolean;
    isChained: boolean;
    // pos right after the {{else}}/{{else if}} closing }}: start of inverse body
    inverseStart: number;
    // char pos of the start of {{else}}/{{else if}} tag: end of default program body
    programEnd: number | undefined;
  }
  type Frame = TemplateFrame | ElementFrame | BlockFrame;

  const rootBody: ASTv1.Statement[] = [];
  const stack: Frame[] = [{ kind: 'template', body: rootBody }];

  function currentBody(): ASTv1.Statement[] {
    // stack always has at least the root template frame
    const t = stack[stack.length - 1] as Frame;
    if (t.kind === 'block') return t.inElse && t.elseBody ? t.elseBody : t.defaultBody;
    if (t.kind === 'element') return t.children;
    return t.body;
  }

  function append(node: ASTv1.Statement): void {
    currentBody().push(node);
  }

  // Check if we're currently inside an SVG element (for raw text mode detection)
  function isInSVGContext(): boolean {
    for (let i = stack.length - 1; i >= 0; i--) {
      const f = stack[i];
      if (f?.kind === 'element') {
        const ef = f;
        const tagLower = ef.tag.toLowerCase();
        if (tagLower === 'svg') return true;
        // foreignObject and desc re-enable HTML parsing
        if (tagLower === 'foreignobject' || tagLower === 'desc') return false;
      }
    }
    return false;
  }

  // ── HBS node parsing ──────────────────────────────────────────────────────────
  function parseHbsNode(): void {
    const open = classifyOpen();

    switch (open.kind) {
      case 'comment': {
        const node = b.mustacheComment({ value: open.value ?? '', loc: sp(open.s, pos) });
        // Store strip flags for tilde stripping post-pass
        if (open.commentStrip) {
          Object.defineProperty(node, '__strip', {
            value: open.commentStrip,
            enumerable: false,
            writable: true,
            configurable: true,
          });
        }
        append(node);
        return;
      }

      case 'mustache':
      case 'unescaped': {
        const trusting = open.kind === 'unescaped' || Boolean(open.unescaped);
        let path: ASTv1.Expression,
          params: ASTv1.Expression[],
          hash: ASTv1.Hash,
          strip: ASTv1.StripFlags;
        if (trusting && open.kind === 'unescaped') {
          // {{{...}}}
          skipWs();
          path = parseExpr();
          params = [];
          let hashOrUndef: ASTv1.Hash | undefined;
          skipWs();
          while (
            pos < len &&
            !(cc() === CH_RBRACE && cc(1) === CH_RBRACE && cc(2) === CH_RBRACE) &&
            !(cc() === CH_TILDE && cc(1) === CH_RBRACE)
          ) {
            if (isAtHash()) {
              hashOrUndef = parseHash();
              break;
            }
            params.push(parseExpr());
            skipWs();
          }
          skipWs();
          let rs = false;
          if (cc() === CH_TILDE) {
            rs = true;
            col++;
            pos++;
          }
          if (!(cc() === CH_RBRACE && cc(1) === CH_RBRACE && cc(2) === CH_RBRACE))
            err("Expected '}}}'");
          advanceTo(pos + 3);
          hash = hashOrUndef ?? b.hash({ pairs: [], loc: sp(pos, pos) });
          strip = { open: open.leftStrip, close: rs };
        } else {
          const guts = parseMustacheGuts(open.leftStrip, false, open.s);
          path = guts.path;
          params = guts.params;
          hash = guts.hash;
          strip = guts.strip;
        }
        append(b.mustache({ path, params, hash, trusting, loc: sp(open.s, pos), strip }));
        return;
      }

      case 'block':
      case 'openInverse': {
        const guts = parseMustacheGuts(open.leftStrip, true, open.s);
        const inverted = open.kind === 'openInverse';
        const openTagEnd = pos; // position right after }}
        stack.push({
          kind: 'block',
          openStart: open.s,
          openTagEnd,
          path: guts.path,
          params: guts.params,
          hash: guts.hash,
          blockParams: guts.blockParams,
          openStrip: guts.strip,
          defaultBody: [],
          elseBody: inverted ? [] : null,
          inverseStrip: { open: false, close: false },
          inElse: inverted,
          isChained: false,
          inverseStart: openTagEnd,
          programEnd: undefined,
        });
        return;
      }

      case 'inverse': {
        const bf = stack[stack.length - 1];
        if (!bf || bf.kind !== 'block') err('Unexpected {{else}}');
        bf.inElse = true;
        bf.elseBody = [];
        bf.inverseStrip = { open: open.leftStrip, close: open.rightStrip ?? false };
        bf.programEnd = open.s; // start of {{else}} = end of default program body
        bf.inverseStart = pos; // right after {{else}}'s }}
        return;
      }

      case 'inverseChain': {
        const bf = stack[stack.length - 1];
        if (!bf || bf.kind !== 'block') err('Unexpected {{else ...}}');
        bf.inElse = true;
        bf.elseBody = [];
        bf.inverseStrip = { open: open.leftStrip, close: false };
        bf.programEnd = open.s; // start of {{else if}} = end of outer program body
        const guts = parseMustacheGuts(open.leftStrip, true, open.s);
        const openTagEnd = pos;
        bf.inverseStart = openTagEnd; // right after {{else if}}'s }}
        stack.push({
          kind: 'block',
          openStart: open.s,
          openTagEnd,
          path: guts.path,
          params: guts.params,
          hash: guts.hash,
          blockParams: guts.blockParams,
          openStrip: guts.strip,
          defaultBody: [],
          elseBody: null,
          inverseStrip: { open: false, close: false },
          inElse: false,
          isChained: true,
          inverseStart: openTagEnd,
          programEnd: undefined,
        });
        return;
      }

      case 'close': {
        skipWs();
        const closePath = parseExpr();
        const closeRS = consumeClose();
        const closeName = pathOriginal(closePath as ASTv1.PathExpression | ASTv1.SubExpression);

        let closeWasChained = true;
        while (closeWasChained && stack.length > 1) {
          const bf = stack[stack.length - 1];
          if (!bf || bf.kind !== 'block') err('Unexpected close block');

          const openName = pathOriginal(bf.path);
          if (openName !== closeName && !bf.isChained) {
            throw generateSyntaxError(`${openName} doesn't match ${closeName}`, sp(open.s, pos));
          }

          closeWasChained = bf.isChained;
          stack.pop();

          // Build block params as VarHeads with correct source locations
          const bpVars: ASTv1.VarHead[] = bf.blockParams.map((bp) =>
            b.var({ name: bp.name, loc: sp(bp.s, bp.e) })
          );

          const closeStrip: ASTv1.StripFlags = { open: open.leftStrip, close: closeRS };
          let defaultBlock: ASTv1.Block,
            inverseBlock: ASTv1.Block | null = null;

          // program.loc: starts at openTagEnd (right after }} of opening tag),
          // ends at bf.programEnd (start of {{else}}/{{else if}}) or open.s (start of {{/}}) if no else.
          const programStart = bf.openTagEnd;
          const programEnd = bf.programEnd ?? open.s;

          // Block node loc: chained blocks end at open.s (start of {{/}}), regular at pos (after {{/}})
          const blockLoc = bf.isChained ? sp(bf.openStart, open.s) : sp(bf.openStart, pos);

          {
            defaultBlock = b.blockItself({
              body: bf.defaultBody,
              params: bpVars,
              chained: false,
              loc: sp(programStart, programEnd),
            });
            if (bf.elseBody !== null) {
              const chained =
                bf.elseBody.length === 1 &&
                bf.elseBody[0]?.type === 'BlockStatement' &&
                (bf.elseBody[0] as unknown as Record<string, unknown>)['__chained'] === true;
              let inverseLoc: ReturnType<typeof sp>;
              if (chained && bf.elseBody.length > 0) {
                // For chained inverse, end at the inner chained block's program end
                // (= start of the next {{else}} inside the chain)
                const innerBlock = bf.elseBody[0] as ASTv1.BlockStatement;
                const innerProgramEndOffset = innerBlock.program.loc.getEnd().offset;
                inverseLoc =
                  innerProgramEndOffset !== null
                    ? sp(bf.inverseStart, innerProgramEndOffset)
                    : sp(bf.inverseStart, open.s);
              } else {
                // Non-chained: inverse ends at start of {{/}}
                inverseLoc = sp(bf.inverseStart, open.s);
              }
              inverseBlock = b.blockItself({
                body: bf.elseBody,
                params: [],
                chained,
                loc: inverseLoc,
              });
            }
          }

          const blockNode = b.block({
            path: bf.path,
            params: bf.params,
            hash: bf.hash,
            defaultBlock,
            elseBlock: inverseBlock,
            loc: blockLoc,
            openStrip: bf.openStrip,
            inverseStrip: bf.inverseStrip,
            closeStrip,
          });

          // Store openTagEnd for standalone stripping detection
          Object.defineProperty(blockNode, '__openTagEnd', {
            value: bf.openTagEnd,
            enumerable: false,
            writable: true,
            configurable: true,
          });

          if (bf.isChained) {
            Object.defineProperty(blockNode, '__chained', {
              value: true,
              enumerable: false,
              writable: true,
              configurable: true,
            });
          }
          append(blockNode);
        }
        return;
      }

      default:
        err(`Unexpected HBS kind: ${open.kind}`);
    }
  }

  // ── HTML comment ──────────────────────────────────────────────────────────────
  function parseHtmlComment(): void {
    const s = pos;
    advanceTo(pos + 4); // skip <!--
    const ci = input.indexOf('-->', pos);
    if (ci === -1) err('Unterminated HTML comment');
    const value = input.substring(pos, ci);
    advanceTo(ci + 3);
    append(b.comment({ value, loc: sp(s, pos) }));
  }

  // ── Attribute value after '=' ─────────────────────────────────────────────────
  // attrStart: absolute char position of the start of the attr name (for error spans)
  function parseAttrValue(attrStart: number): ASTv1.AttrNode['value'] {
    const q = cc();

    if (q === CH_DQUOTE || q === CH_SQUOTE) {
      const oq = pos;
      col++;
      pos++; // open quote
      const parts: (ASTv1.TextNode | ASTv1.MustacheStatement)[] = [];
      let tbuf = '',
        ts = pos;

      const flushText = () => {
        if (tbuf.length > 0) {
          parts.push(b.text({ chars: tbuf, loc: sp(ts, pos) }));
          tbuf = '';
          ts = pos;
        }
      };

      while (pos < len && cc() !== q) {
        if (sw('{{')) {
          flushText();
          const mo = classifyOpen();
          if (mo.kind === 'comment') {
            const stateName =
              q === CH_DQUOTE ? 'attributeValueDoubleQuoted' : 'attributeValueSingleQuoted';
            throw generateSyntaxError(
              `Using a Handlebars comment when in the \`${stateName}\` state is not supported`,
              sp(mo.s, pos)
            );
          }
          if (mo.kind !== 'mustache' && mo.kind !== 'unescaped')
            err('Expected mustache in attribute value');
          const guts = parseMustacheGuts(mo.leftStrip, false, mo.s);
          // {{{...}}} triple-curly: parseMustacheGuts only consumed "}}", consume the extra "}"
          if (mo.kind === 'unescaped') {
            if (cc() !== CH_RBRACE) err("Expected '}}}'");
            col++;
            pos++;
          }
          parts.push(
            b.mustache({
              path: guts.path,
              params: guts.params,
              hash: guts.hash,
              trusting: mo.kind === 'unescaped' || Boolean(mo.unescaped),
              loc: sp(mo.s, pos),
              strip: guts.strip,
            })
          );
          ts = pos;
        } else if (cc() === CH_AMP) {
          // Try to decode HTML entity: &name; or &#NNN; or &#xHHH;
          col++;
          pos++;
          let entity = '';
          while (pos < len && cc() !== 59 /* ; */ && !isWhitespace(cc()) && entity.length < 20) {
            entity += input[pos];
            col++;
            pos++;
          }
          if (pos < len && cc() === 59 /* ; */) {
            col++;
            pos++;
            tbuf += codemod ? '&' + entity + ';' : decodeHtmlEntity(entity);
          } else {
            // Not a valid entity — treat as literal text
            tbuf += '&' + entity;
          }
        } else {
          tbuf += input[pos];
          if (cc() === CH_NL) {
            line++;
            col = 0;
            pos++;
          } else {
            col++;
            pos++;
          }
        }
      }
      flushText();
      if (cc() !== q) err('Unterminated attribute value');
      col++;
      pos++; // close quote

      if (parts.length === 0) return b.text({ chars: '', loc: sp(oq, pos) });
      // Always wrap in ConcatStatement when any part is dynamic — matches original tokenizer behavior
      const isDynamic = parts.some((p) => p.type === 'MustacheStatement');
      if (!isDynamic && parts.length === 1) {
        const t = parts[0] as ASTv1.TextNode;
        t.loc = sp(oq, pos);
        return t;
      }
      return b.concat({
        parts: parts as PresentArray<ASTv1.TextNode | ASTv1.MustacheStatement>,
        loc: sp(oq, pos),
      });
    }

    // Skip whitespace between '=' and unquoted value (e.g. class=\n{{foo}})
    if (isWhitespace(cc())) skipWs();

    if (sw('{{')) {
      // Check for comment in beforeAttributeValue state
      const mo = classifyOpen();
      if (mo.kind === 'comment') {
        throw generateSyntaxError(
          `Using a Handlebars comment when in the \`beforeAttributeValue\` state is not supported`,
          sp(mo.s, pos)
        );
      }
      if (mo.kind !== 'mustache' && mo.kind !== 'unescaped')
        err('Expected mustache as attribute value');
      const guts = parseMustacheGuts(mo.leftStrip, false, mo.s);
      // {{{...}}} triple-curly: parseMustacheGuts only consumed "}}", consume the extra "}"
      if (mo.kind === 'unescaped') {
        if (cc() !== CH_RBRACE) err("Expected '}}}'");
        col++;
        pos++;
      }
      const mustacheEnd = pos;
      // Check for awkward follow-up: mustache followed by non-WS non-> content
      if (
        pos < len &&
        !isWhitespace(cc()) &&
        cc() !== CH_GT &&
        !(cc() === CH_SLASH && cc(1) === CH_GT)
      ) {
        // Scan to get the full attr span (from attrStart to wherever this bad thing ends)
        const badStart = attrStart;
        // Scan until whitespace or >
        while (
          pos < len &&
          !isWhitespace(cc()) &&
          cc() !== CH_GT &&
          !(cc() === CH_SLASH && cc(1) === CH_GT)
        ) {
          col++;
          pos++;
        }
        throw generateSyntaxError(
          `An unquoted attribute value must be a string or a mustache, preceded by whitespace or a '=' character, and followed by whitespace, a '>' character, or '/>'`,
          sp(badStart, pos)
        );
      }
      return b.mustache({
        path: guts.path,
        params: guts.params,
        hash: guts.hash,
        trusting: mo.kind === 'unescaped' || Boolean(mo.unescaped),
        loc: sp(mo.s, mustacheEnd),
        strip: guts.strip,
      });
    }

    // Unquoted literal — check for text followed by mustache (awkward)
    const vs = pos;
    while (
      pos < len &&
      !isWhitespace(cc()) &&
      cc() !== CH_GT &&
      !(cc() === CH_SLASH && cc(1) === CH_GT) &&
      !sw('{{')
    ) {
      col++;
      pos++;
    }
    const hasText = pos > vs;
    if (hasText && sw('{{')) {
      // text followed by mustache — scan past mustache and check
      const textEnd = pos;
      classifyOpen(); // consume {{...}}
      parseMustacheGuts(false, false, textEnd);
      // Scan any trailing text
      while (
        pos < len &&
        !isWhitespace(cc()) &&
        cc() !== CH_GT &&
        !(cc() === CH_SLASH && cc(1) === CH_GT)
      ) {
        col++;
        pos++;
      }
      throw generateSyntaxError(
        `An unquoted attribute value must be a string or a mustache, preceded by whitespace or a '=' character, and followed by whitespace, a '>' character, or '/>'`,
        sp(attrStart, pos)
      );
    }
    return b.text({ chars: input.substring(vs, pos), loc: sp(vs, pos) });
  }

  // ── Element block params (as |x y|) ──────────────────────────────────────────
  function parseElemBlockParams(): BlockParam[] {
    skipWs();
    if (!sw('as')) return [];
    const asStart = pos;
    const aa = pos + 2;

    // 'as|' without space — always an error
    if (aa < len && input.charCodeAt(aa) === CH_PIPE) {
      throw generateSyntaxError(
        'Invalid block parameters syntax: expecting at least one space character between "as" and "|"',
        sp(asStart, aa + 1)
      );
    }

    if (aa >= len || !isWhitespace(input.charCodeAt(aa))) return [];
    let p = aa;
    while (p < len && isWhitespace(input.charCodeAt(p))) p++;
    if (p >= len || input.charCodeAt(p) !== CH_PIPE) return [];
    advanceTo(p + 1); // advance past opening '|'

    const params: BlockParam[] = [];
    skipWs();

    // Empty params: '||'
    if (cc() === CH_PIPE) {
      col++;
      pos++;
      throw generateSyntaxError(
        'Invalid block parameters syntax: empty parameters list, expecting at least one identifier',
        sp(asStart, pos)
      );
    }

    while (pos < len && cc() !== CH_PIPE) {
      // Mustache in params
      if (sw('{{')) {
        const ms = pos;
        const me = input.indexOf('}}', pos);
        const meEnd = me !== -1 ? me + 2 : pos + 2;
        advanceTo(meEnd);
        throw generateSyntaxError(
          'Invalid block parameters syntax: mustaches cannot be used inside parameters list',
          sp(ms, meEnd)
        );
      }

      // Tag closed prematurely (> or />) before closing '|' — include '>' in span
      if (cc() === CH_GT) {
        col++;
        pos++;
        throw generateSyntaxError(
          'Invalid block parameters syntax: expecting "|" but the tag was closed prematurely',
          sp(asStart, pos)
        );
      }
      if (cc() === CH_SLASH && cc(1) === CH_GT) {
        advanceTo(pos + 2);
        throw generateSyntaxError(
          'Invalid block parameters syntax: expecting "|" but the tag was closed prematurely',
          sp(asStart, pos)
        );
      }

      // EOF
      if (pos >= len) {
        throw generateSyntaxError(
          'Invalid block parameters syntax: expecting the tag to be closed with ">" or "/>" after parameters list',
          sp(asStart, pos)
        );
      }

      const ps = pos;
      // Scan valid identifier chars (a-z, A-Z, 0-9, _, -)
      let id = '';
      while (pos < len) {
        const c = cc();
        if (
          (c >= 65 && c <= 90) || // A-Z
          (c >= 97 && c <= 122) || // a-z
          (c >= 48 && c <= 57) || // 0-9
          c === 95 || // _
          c === 45 // -
        ) {
          id += input[pos];
          col++;
          pos++;
        } else break;
      }

      // Check for invalid chars immediately after or in place of identifier
      if (
        id === '' ||
        (pos < len &&
          cc() !== CH_PIPE &&
          !isWhitespace(cc()) &&
          cc() !== CH_GT &&
          !(cc() === CH_SLASH && cc(1) === CH_GT) &&
          !sw('{{'))
      ) {
        // Collect the bad identifier span
        while (
          pos < len &&
          cc() !== CH_PIPE &&
          !isWhitespace(cc()) &&
          cc() !== CH_GT &&
          !(cc() === CH_SLASH && cc(1) === CH_GT) &&
          !sw('{{')
        ) {
          col++;
          pos++;
        }
        const badId = input.substring(ps, pos);
        throw generateSyntaxError(
          `Invalid block parameters syntax: invalid identifier name \`${badId}\``,
          sp(ps, pos)
        );
      }

      params.push({ name: id, s: ps, e: pos });
      skipWs();
    }

    // EOF without closing '|'
    if (pos >= len) {
      throw generateSyntaxError(
        'Invalid block parameters syntax: expecting the tag to be closed with ">" or "/>" after parameters list',
        sp(asStart, pos)
      );
    }

    if (cc() !== CH_PIPE) {
      throw generateSyntaxError(
        'Invalid block parameters syntax: expecting "|" but the tag was closed prematurely',
        sp(asStart, pos)
      );
    }
    col++;
    pos++; // consume closing '|'

    // Check after closing '|': peek for extra content that isn't whitespace or '>' or '/>'
    let scanP = pos;
    while (scanP < len && isWhitespace(input.charCodeAt(scanP))) scanP++;

    // EOF after closing '|' — tag not closed
    if (scanP >= len) {
      throw generateSyntaxError(
        'Invalid block parameters syntax: expecting the tag to be closed with ">" or "/>" after parameters list',
        sp(asStart, pos)
      );
    }

    const sc = input.charCodeAt(scanP);
    if (sc === CH_GT || (sc === CH_SLASH && input.charCodeAt(scanP + 1) === CH_GT)) {
      // Fine — tag is closing normally; don't advance (outer loop handles it)
    } else if (sc === CH_LBRACE && input.charCodeAt(scanP + 1) === CH_LBRACE) {
      // Mustache modifier after params — span is just the mustache
      const mustacheStart = scanP;
      const mustacheClose = input.indexOf('}}', scanP);
      const mustacheEnd = mustacheClose !== -1 ? mustacheClose + 2 : scanP + 2;
      advanceTo(mustacheEnd);
      throw generateSyntaxError(
        'Invalid block parameters syntax: modifiers cannot follow parameters list',
        sp(mustacheStart, mustacheEnd)
      );
    } else {
      // Extra identifier or other content after closing '|' — span is just the extra content
      advanceTo(scanP);
      const extraStart = pos;
      while (
        pos < len &&
        !isWhitespace(cc()) &&
        cc() !== CH_GT &&
        !(cc() === CH_SLASH && cc(1) === CH_GT) &&
        !sw('{{')
      ) {
        col++;
        pos++;
      }
      throw generateSyntaxError(
        'Invalid block parameters syntax: expecting the tag to be closed with ">" or "/>" after parameters list',
        sp(extraStart, pos)
      );
    }

    return params;
  }

  // ── Start tag parser (after '<' consumed) ────────────────────────────────────
  interface StartTagInfo {
    tag: string;
    ns: number;
    ne: number;
    openTagEnd: number;
    attrs: ASTv1.AttrNode[];
    modifiers: ASTv1.ElementModifierStatement[];
    params: BlockParam[];
    selfClosing: boolean;
    comments: ASTv1.MustacheCommentStatement[];
  }

  function parseStartTag(_ltPos: number): StartTagInfo {
    // Scan tag name (supports @, :, a-z, A-Z, digits, -, _, ., :)
    const ns = pos;
    // Handle @ prefix
    if (cc() === CH_AT) {
      col++;
      pos++;
    }
    // Handle : prefix (named blocks)
    else if (cc() === CH_COLON) {
      col++;
      pos++;
    }
    // Scan rest of tag name
    while (pos < len) {
      const c = cc();
      if (
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) ||
        (c >= 48 && c <= 57) ||
        c === 45 ||
        c === 95 ||
        c === 46 ||
        c === 58
      ) {
        col++;
        pos++;
      } else break;
    }
    if (pos === ns) err('Expected tag name');
    const tag = input.substring(ns, pos);
    const ne = pos;

    // Validate named block names (tags starting with ':')
    if (tag.startsWith(':')) {
      const blockName = tag.slice(1);
      if (blockName.length === 0) {
        // '<:' with no block name — consume to '>' for better span
        const tagStart = ns - 1; // position of '<'
        while (pos < len && cc() !== CH_GT) {
          col++;
          pos++;
        }
        if (pos < len) {
          col++;
          pos++;
        } // consume '>'
        throw generateSyntaxError(
          'Invalid named block named detected, you may have created a named block without a name, or you may have began your name with a number. Named blocks must have names that are at least one character long, and begin with a lower case letter',
          sp(tagStart, pos)
        );
      }
      const firstCharCode = blockName.charCodeAt(0);
      if (firstCharCode >= 65 && firstCharCode <= 90) {
        // Starts with uppercase letter — scan open tag, find close tag, span both
        const tagStart = ns - 1;
        // Scan to end of open tag
        while (pos < len && cc() !== CH_GT) {
          col++;
          pos++;
        }
        if (pos < len) {
          col++;
          pos++;
        }
        const openTagClosePos = pos;
        // Scan to end of close tag
        const closeTagStr = `</:${blockName}>`;
        const closeTagIdx = input.indexOf(closeTagStr, pos);
        const fullEnd = closeTagIdx !== -1 ? closeTagIdx + closeTagStr.length : openTagClosePos;
        if (closeTagIdx !== -1) advanceTo(fullEnd);
        throw generateSyntaxError(
          `<:${blockName}> is not a valid named block, and named blocks must begin with a lowercase letter`,
          sp(tagStart, fullEnd)
        );
      }
    }

    // Check for mustache immediately after tag name (no whitespace) — error
    if (sw('{{')) {
      const ms = pos;
      const me = input.indexOf('}}', pos);
      const meEnd = me !== -1 ? me + 2 : pos + 2;
      throw generateSyntaxError('Cannot use mustaches in an elements tagname', sp(ms, meEnd));
    }

    const attrs: ASTv1.AttrNode[] = [];
    const modifiers: ASTv1.ElementModifierStatement[] = [];
    let elemBP: BlockParam[] = [];
    const comments: ASTv1.MustacheCommentStatement[] = [];

    loop: while (pos < len) {
      const posBeforeWs = pos;
      skipWs();
      const hadWs = pos > posBeforeWs;

      if (cc() === CH_GT) {
        col++;
        pos++;
        break loop;
      }
      if (cc() === CH_SLASH && cc(1) === CH_GT) {
        advanceTo(pos + 2);
        return {
          tag,
          ns,
          ne,
          openTagEnd: pos,
          attrs,
          modifiers,
          params: elemBP,
          selfClosing: true,
          comments,
        } as StartTagInfo & { comments: ASTv1.MustacheCommentStatement[] };
      }

      // {{modifier}} or {{!comment}}
      if (sw('{{')) {
        const mo = classifyOpen();
        if (mo.kind === 'comment') {
          if (hadWs) {
            // beforeAttributeName state: store in comments
            const node = b.mustacheComment({ value: mo.value ?? '', loc: sp(mo.s, pos) });
            comments.push(node);
          } else {
            // attributeName state: throw error
            throw generateSyntaxError(
              `Using a Handlebars comment when in the \`attributeName\` state is not supported`,
              sp(mo.s, pos)
            );
          }
          continue loop;
        }
        if (mo.kind !== 'mustache') err('Only {{modifiers}} allowed in element tags');
        const guts = parseMustacheGuts(mo.leftStrip, false, mo.s);
        modifiers.push(
          b.elementModifier({
            path: guts.path,
            params: guts.params,
            hash: guts.hash,
            loc: sp(mo.s, pos),
          })
        );
        continue loop;
      }

      // as |x| block params — also trigger on 'as|' (no space) so parseElemBlockParams can throw
      if (
        sw('as') &&
        (isWhitespace(input.charCodeAt(pos + 2)) || input.charCodeAt(pos + 2) === CH_PIPE)
      ) {
        const bp = parseElemBlockParams();
        if (bp.length > 0) {
          elemBP = bp;
          continue loop;
        }
      }

      // Check for disallowed attribute name starters
      if (cc() === CH_DQUOTE || cc() === CH_SQUOTE) {
        throw generateSyntaxError(
          `" is not a valid character within attribute names`,
          sp(pos, pos)
        );
      }
      if (cc() === CH_EQ) {
        throw generateSyntaxError(`attribute name cannot start with equals sign`, sp(pos, pos));
      }
      // Bare '|...|' block params without 'as' keyword
      if (cc() === CH_PIPE) {
        const pipeStart = pos;
        col++;
        pos++; // consume opening '|'
        skipWs();
        // Scan to closing '|'
        while (
          pos < len &&
          cc() !== CH_PIPE &&
          cc() !== CH_GT &&
          !(cc() === CH_SLASH && cc(1) === CH_GT)
        ) {
          col++;
          pos++;
        }
        if (cc() === CH_PIPE) {
          col++;
          pos++;
        } // consume closing '|'
        throw generateSyntaxError(
          'Invalid block parameters syntax: block parameters must be preceded by the `as` keyword',
          sp(pipeStart, pos)
        );
      }

      // Attribute name
      const ans = pos;
      let attrName = '';
      if (cc() === CH_AT) {
        col++;
        pos++;
        attrName = '@';
      } else if (sw('...')) {
        advanceTo(pos + 3);
        const r = scanId();
        attrName = '...' + (r ?? '');
      }

      // Continue scanning identifier chars for name
      const nameBodyStart = pos;
      while (pos < len) {
        const c = cc();
        if (
          (c >= 65 && c <= 90) ||
          (c >= 97 && c <= 122) ||
          (c >= 48 && c <= 57) ||
          c === 45 ||
          c === 95 ||
          c === 58 ||
          c === CH_BANG
        ) {
          attrName += input[pos];
          col++;
          pos++;
        } else break;
      }
      if (attrName === '' && pos === nameBodyStart)
        err(`Expected attribute name or '>' in <${tag}>`);

      // Peek ahead for '=' without consuming whitespace.
      // If we called skipWs() here and then didn't find '=', the next loop iteration
      // would have hadWs=false, causing the {{! comment }} handler to throw the wrong error.
      let eqScanPos = pos;
      while (eqScanPos < len && isWhitespace(input.charCodeAt(eqScanPos))) eqScanPos++;
      if (eqScanPos < len && input.charCodeAt(eqScanPos) === CH_EQ) {
        advanceTo(eqScanPos + 1); // advance past optional whitespace + '='
        const value = parseAttrValue(ans);
        attrs.push(b.attr({ name: attrName, value, loc: sp(ans, pos) }));
      } else {
        // Valueless attribute — loc includes trailing whitespace up to the next attr start,
        // matching the original tokenizer. eqScanPos points to the first non-whitespace after the name.
        attrs.push(
          b.attr({
            name: attrName,
            value: b.text({ chars: '', loc: sp(pos, pos) }),
            loc: sp(ans, eqScanPos),
          })
        );
      }
    }

    return {
      tag,
      ns,
      ne,
      openTagEnd: pos,
      attrs,
      modifiers,
      params: elemBP,
      selfClosing: false,
      comments,
    };
  }

  // ── HTML node dispatch ────────────────────────────────────────────────────────
  function parseHtmlNode(): void {
    const ltPos = pos;

    // HTML comment
    if (sw('<!--')) {
      parseHtmlComment();
      return;
    }

    // CDATA/doctype — treat as text
    if (sw('<!')) {
      const e = input.indexOf('>', pos);
      if (e === -1) err('Unterminated <! declaration');
      const txt = input.substring(ltPos, e + 1);
      advanceTo(e + 1);
      append(b.text({ chars: txt, loc: sp(ltPos, pos) }));
      return;
    }

    // Closing tag </tag>
    if (cc(1) === CH_SLASH) {
      const closeStart = pos;
      advanceTo(pos + 2); // skip </
      const ns = pos;
      while (pos < len && !isWhitespace(cc()) && cc() !== CH_GT) {
        col++;
        pos++;
      }
      const closedTag = input.substring(ns, pos);
      skipWs();
      if (cc() !== CH_GT) {
        // Consume to find end of close tag for the error span (span = from '<' to just before '>')
        while (pos < len && cc() !== CH_GT) {
          col++;
          pos++;
        }
        const badEnd = pos;
        if (pos < len) {
          col++;
          pos++;
        } // consume '>'
        throw generateSyntaxError(
          `Invalid end tag: closing tag must not have attributes`,
          sp(closeStart, badEnd)
        );
      }
      col++;
      pos++;
      const closeEnd = pos;

      // Void elements never have close tags (e.g. <input></input> is always wrong)
      if (voidMap.has(closedTag)) {
        throw generateSyntaxError(
          `<${closedTag}> elements do not need end tags. You should remove it`,
          sp(closeStart, closeEnd)
        );
      }

      // Find matching element frame
      let fi = stack.length - 1;
      while (fi >= 0 && stack[fi]?.kind !== 'element') fi--;
      if (fi < 0) {
        throw generateSyntaxError(
          `Closing tag </${closedTag}> without an open tag`,
          sp(closeStart, closeEnd)
        );
      }

      const ef = stack[fi] as ElementFrame;
      if (ef.tag !== closedTag) {
        throw generateSyntaxError(
          `Closing tag </${closedTag}> did not match last open tag <${ef.tag}> (on line ${source.hbsPosFor(ef.ltPos)?.line ?? '?'})`,
          sp(closeStart, closeEnd)
        );
      }

      // Pop everything above the element frame
      while (stack.length - 1 > fi) stack.pop();
      stack.pop();

      // Build the element
      const closeTagSpan = sp(closeStart, closeEnd);
      const elemSpan = sp(ef.ltPos, closeEnd);
      const openTagSpan = sp(ef.ltPos, ef.openTagEnd);
      const tagPath = buildTagPath(ef.tag, ef.ns, ef.ns + ef.tag.length);
      append(
        b.element({
          path: tagPath,
          selfClosing: false,
          attributes: ef.attrs,
          modifiers: ef.modifiers,
          params: ef.params,
          comments: ef.comments,
          children: ef.children,
          openTag: openTagSpan,
          closeTag: closeTagSpan,
          loc: elemSpan,
        })
      );
      return;
    }

    // Check for mustache in tagName space: <{{...}}>
    if (cc(1) === CH_LBRACE && cc(2) === CH_LBRACE) {
      col++;
      pos++; // skip <
      const ms = pos;
      const me = input.indexOf('}}', pos);
      const meEnd = me !== -1 ? me + 2 : pos + 2;
      throw generateSyntaxError('Cannot use mustaches in an elements tagname', sp(ms, meEnd));
    }

    // Start tag <tagname...>  — allow @, :, a-z, A-Z
    const fc = cc(1);
    if ((fc >= 65 && fc <= 90) || (fc >= 97 && fc <= 122) || fc === CH_AT || fc === CH_COLON) {
      col++;
      pos++; // skip <
      const info = parseStartTag(ltPos);

      // Only exact-lowercase void element names are treated as void (e.g. img, not imG).
      const isVoid = !info.selfClosing && voidMap.has(info.tag);
      const openTagSpan = sp(ltPos, info.openTagEnd);

      if (info.selfClosing || isVoid) {
        // selfClosing is true only for explicit />, not for void elements
        const tagPath = buildTagPath(info.tag, info.ns, info.ns + info.tag.length);
        append(
          b.element({
            path: tagPath,
            selfClosing: info.selfClosing,
            attributes: info.attrs,
            modifiers: info.modifiers,
            params: info.params.map((bp: BlockParam) =>
              b.var({ name: bp.name, loc: sp(bp.s, bp.e) })
            ),
            comments: info.comments,
            children: [],
            openTag: openTagSpan,
            closeTag: null,
            loc: openTagSpan,
          })
        );
      } else {
        // Check for SVG title raw text mode
        if (info.tag === 'title' && isInSVGContext()) {
          const rawTextStart = pos;
          const closeTag = '</title>';
          const closeIdx = input.indexOf(closeTag, pos);
          const rawText = closeIdx === -1 ? input.substring(pos) : input.substring(pos, closeIdx);
          const rawTextEnd = closeIdx === -1 ? len : closeIdx;
          const closeEnd = closeIdx !== -1 ? closeIdx + closeTag.length : len;
          advanceTo(closeEnd);
          const rawBody: ASTv1.Statement[] = rawText
            ? [b.text({ chars: rawText, loc: sp(rawTextStart, rawTextEnd) })]
            : [];
          const closeTagSpan = closeIdx !== -1 ? sp(closeIdx, closeEnd) : null;
          const tagPath = buildTagPath(info.tag, info.ns, info.ns + info.tag.length);
          append(
            b.element({
              path: tagPath,
              selfClosing: false,
              attributes: info.attrs,
              modifiers: info.modifiers,
              params: info.params.map((bp: BlockParam) =>
                b.var({ name: bp.name, loc: sp(bp.s, bp.e) })
              ),
              comments: info.comments,
              children: rawBody,
              openTag: openTagSpan,
              closeTag: closeTagSpan,
              loc: sp(ltPos, pos),
            })
          );
        } else {
          // Push to element stack
          const inSVG = isInSVGContext() || info.tag.toLowerCase() === 'svg';
          stack.push({
            kind: 'element',
            tag: info.tag,
            ns: info.ns,
            ltPos,
            openTagEnd: info.openTagEnd,
            attrs: info.attrs,
            modifiers: info.modifiers,
            params: info.params.map((bp: BlockParam) =>
              b.var({ name: bp.name, loc: sp(bp.s, bp.e) })
            ),
            comments: info.comments,
            children: [],
            inSVG,
          });
        }
      }
      return;
    }

    // '<' followed by something else — treat as text
    append(b.text({ chars: '<', loc: sp(ltPos, ltPos + 1) }));
    advanceTo(ltPos + 1);
  }

  // ── Text scanning ─────────────────────────────────────────────────────────────
  function scanTextNode(): boolean {
    if (pos >= len) return false;
    const s = pos;

    // Find next delimiter
    let nlt = input.indexOf('<', pos);
    if (nlt === -1) nlt = len;
    let nmu = input.indexOf('{{', pos);
    if (nmu === -1) nmu = len;

    let text = '',
      seg = pos;
    let limit = Math.min(nlt, nmu);

    // Scan for escaped mustaches within the window
    let sf = pos;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      const mi = input.indexOf('{{', sf);
      if (mi === -1 || mi >= limit) {
        text += input.substring(seg, limit);
        break;
      }
      if (mi > 0 && input.charCodeAt(mi - 1) === CH_BACKSLASH) {
        if (mi > 1 && input.charCodeAt(mi - 2) === CH_BACKSLASH) {
          text += input.substring(seg, mi - 1);
          limit = mi;
          break;
        }
        text += input.substring(seg, mi - 1) + '{{';
        const ci = input.indexOf('}}', mi + 2);
        if (ci === -1) {
          text += input.substring(mi + 2, limit);
          break;
        }
        text += input.substring(mi + 2, ci);
        seg = ci + 2;
        sf = ci + 2;
        nmu = input.indexOf('{{', sf);
        if (nmu === -1) nmu = len;
        limit = Math.min(nlt, nmu);
        continue;
      }
      text += input.substring(seg, mi);
      limit = mi;
      break;
    }

    if (!text.length) return false;
    // Decode HTML entities in text content (mirrors simple-html-tokenizer behavior).
    // In codemod mode, preserve entities as-is to keep original source positions.
    if (!codemod && text.includes('&')) {
      text = text.replace(/&([^;\s<>&]{1,20});/g, (_, name: string) => decodeHtmlEntity(name));
    }
    advanceTo(limit);
    append(b.text({ chars: text, loc: sp(s, pos) }));
    return true;
  }

  // ── Main scan loop ────────────────────────────────────────────────────────────
  while (pos < len) {
    const nlt = input.indexOf('<', pos);
    const nmu = input.indexOf('{{', pos);
    const elt = nlt === -1 ? len : nlt;
    const emu = nmu === -1 ? len : nmu;

    if (elt === len && emu === len) {
      if (pos < len) {
        const ts = pos;
        let txt = input.substring(pos, len);
        if (!codemod && txt.includes('&')) {
          txt = txt.replace(/&([^;\s<>&]{1,20});/g, (_, name: string) => decodeHtmlEntity(name));
        }
        advanceTo(len);
        if (txt) append(b.text({ chars: txt, loc: sp(ts, len) }));
      }
      break;
    }

    if (elt <= emu) {
      if (elt > pos) {
        scanTextNode();
      } else {
        parseHtmlNode();
      }
    } else {
      if (emu > pos) {
        scanTextNode();
      } else {
        parseHbsNode();
      }
    }
  }

  // Validate stack is clean
  if (stack.length > 1) {
    // stack always has at least the root template frame when length > 1
    const top = stack[stack.length - 1] as Frame;
    if (top.kind === 'element') {
      throw generateSyntaxError(`Unclosed element \`${top.tag}\``, sp(top.ltPos, top.openTagEnd));
    }
    if (top.kind === 'block') {
      const name = pathOriginal(top.path);
      throw generateSyntaxError(`Unclosed block \`${name}\``, sp(top.openStart, pos));
    }
  }

  // Apply tilde whitespace stripping (~ flags)
  const strippedBody1 = codemod ? rootBody : applyTildeStripping(rootBody);

  // Apply standalone whitespace stripping (mirrors Handlebars' WhitespaceControl)
  const ignoreStandalone = codemod || (options.parseOptions?.ignoreStandalone ?? false);
  const strippedBody = ignoreStandalone
    ? strippedBody1
    : applyStandaloneStripping(strippedBody1, input, source);

  // Build template
  return b.template({
    body: strippedBody,
    blockParams: options.locals ?? [],
    loc: sp(0, len),
  });
}
