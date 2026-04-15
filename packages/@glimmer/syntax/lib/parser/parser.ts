/**
 * Single-pass parser for Glimmer templates.
 *
 * Handles both Handlebars mustache syntax (`{{...}}`) and HTML in one
 * left-to-right pass, building ASTv1 nodes directly via
 * SourceSpan.forCharPositions() and the `b` builder API.
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
const CH_TAB = 9; // \t
const CH_NL = 10; // \n
const CH_FF = 12; // \f
const CH_CR = 13; // \r
const CH_SPACE = 32; //
const CH_BANG = 33; // !
const CH_DQUOTE = 34; // "
const CH_HASH = 35; // #
const CH_AMP = 38; // &
const CH_SQUOTE = 39; // '
const CH_LPAREN = 40; // (
const CH_RPAREN = 41; // )
const CH_STAR = 42; // *
const CH_DASH = 45; // -
const CH_DOT = 46; // .
const CH_SLASH = 47; // /
const CH_0 = 48; // 0
const CH_9 = 57; // 9
const CH_COLON = 58; // :
const CH_SEMICOLON = 59; // ;
const CH_EQ = 61; // =
const CH_GT = 62; // >
const CH_AT = 64; // @
const CH_A = 65; // A
const CH_X_UPPER = 88; // X
const CH_Z = 90; // Z
const CH_LBRACKET = 91; // [
const CH_BACKSLASH = 92; // \
const CH_RBRACKET = 93; // ]
const CH_CARET = 94; // ^
const CH_UNDERSCORE = 95; // _
const CH_BACKTICK = 96; // `
const CH_a = 97; // a
const CH_x = 120; // x
const CH_z = 122; // z
const CH_LBRACE = 123; // {
const CH_PIPE = 124; // |
const CH_RBRACE = 125; // }
const CH_TILDE = 126; // ~

function isAsciiAlpha(c: number): boolean {
  return (c >= CH_A && c <= CH_Z) || (c >= CH_a && c <= CH_z);
}

function isAsciiDigit(c: number): boolean {
  return c >= CH_0 && c <= CH_9;
}

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
      if (c0 === CH_HASH) {
        const c1 = name.charCodeAt(1);
        if (c1 === CH_x || c1 === CH_X_UPPER) {
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
  return c === CH_SPACE || c === CH_TAB || c === CH_NL || c === CH_CR || c === CH_FF;
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

// ── Per-parse metadata (avoids polluting AST nodes with non-standard properties) ─

interface ScanMeta {
  /** Position right after the opening `}}` of each BlockStatement. */
  blockOpenTagEnd: WeakMap<ASTv1.BlockStatement, number>;
  /** Set of BlockStatements that were produced by `{{else if}}` chaining. */
  blockIsChained: WeakSet<ASTv1.BlockStatement>;
  /** Tilde-strip flags for MustacheCommentStatements. */
  commentStrip: WeakMap<ASTv1.MustacheCommentStatement, { open: boolean; close: boolean }>;
}

// ── Whitespace stripping (~ and standalone-line) ───────────────────────────────
//
// Two mutation passes applied per body level, in order: tilde first, then
// standalone. Tilde mutates text siblings of mustaches/blocks/comments that
// carry `~`/strip flags; standalone mirrors Handlebars' WhitespaceControl and
// removes whitespace surrounding block/comment nodes that are alone on their
// line. A single recursion drives both: at each level we apply tilde, filter
// empty text, apply standalone, filter again, then recurse into block
// bodies and element children.

function isOnlySpacesAndTabs(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== CH_SPACE && c !== CH_TAB) return false;
  }
  return true;
}

function mutateTilde(body: ASTv1.Statement[], meta: ScanMeta): void {
  for (let i = 0; i < body.length; i++) {
    const node = body[i];
    if (!node) continue;

    if (node.type === 'MustacheStatement') {
      if (node.strip.open) {
        const prev = i > 0 ? body[i - 1] : null;
        if (prev?.type === 'TextNode') prev.chars = stripTrailingWS(prev.chars);
      }
      if (node.strip.close) {
        const next = i < body.length - 1 ? body[i + 1] : null;
        if (next?.type === 'TextNode') next.chars = stripLeadingWS(next.chars);
      }
      continue;
    }

    if (node.type === 'MustacheCommentStatement') {
      const strip = meta.commentStrip.get(node);
      if (strip?.open) {
        const prev = i > 0 ? body[i - 1] : null;
        if (prev?.type === 'TextNode') prev.chars = stripTrailingWS(prev.chars);
      }
      if (strip?.close) {
        const next = i < body.length - 1 ? body[i + 1] : null;
        if (next?.type === 'TextNode') next.chars = stripLeadingWS(next.chars);
      }
      continue;
    }

    if (node.type === 'BlockStatement') {
      const bs = node;
      if (bs.openStrip.open) {
        const prev = i > 0 ? body[i - 1] : null;
        if (prev?.type === 'TextNode') prev.chars = stripTrailingWS(prev.chars);
      }
      if (bs.openStrip.close) {
        const first = bs.program.body[0];
        if (first?.type === 'TextNode') first.chars = stripLeadingWS(first.chars);
      }
      if (bs.inverseStrip.open) {
        const prog = bs.program.body;
        const last = prog[prog.length - 1];
        if (last?.type === 'TextNode') last.chars = stripTrailingWS(last.chars);
      }
      if (bs.inverseStrip.close && bs.inverse) {
        const first = bs.inverse.body[0];
        if (first?.type === 'TextNode') first.chars = stripLeadingWS(first.chars);
      }
      if (bs.closeStrip.open) {
        const prog = bs.inverse ?? bs.program;
        const last = prog.body[prog.body.length - 1];
        if (last?.type === 'TextNode') last.chars = stripTrailingWS(last.chars);
      }
      if (bs.closeStrip.close) {
        const next = i < body.length - 1 ? body[i + 1] : null;
        if (next?.type === 'TextNode') next.chars = stripLeadingWS(next.chars);
      }
    }
  }
}

function mutateStandalone(
  body: ASTv1.Statement[],
  input: string,
  source: srcApi.Source,
  meta: ScanMeta
): void {
  const len = input.length;

  function trimLocStart(t: ASTv1.TextNode, stripped: number): void {
    if (stripped <= 0) return;
    const s = t.loc.getStart().offset;
    const e = t.loc.getEnd().offset;
    if (s !== null && e !== null) t.loc = SourceSpan.forCharPositions(source, s + stripped, e);
  }

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
    if (node.type === 'BlockStatement' && meta.blockIsChained.has(node)) continue;

    const prevNode = i > 0 ? (body[i - 1] ?? null) : null;
    const nextNode = i < body.length - 1 ? (body[i + 1] ?? null) : null;
    const prev = prevNode?.type === 'TextNode' ? prevNode : null;
    const next = nextNode?.type === 'TextNode' ? nextNode : null;

    // A non-text node immediately before/after means something is on the same line → not standalone.
    if (prevNode !== null && prev === null) continue;
    if (nextNode !== null && next === null) continue;

    // Check that everything from the opening }} to the end of the line is whitespace.
    // This prevents treating `{{#wat}} foo {{/wat}}` as standalone.
    const openTagEnd = node.type === 'BlockStatement' ? meta.blockOpenTagEnd.get(node) : undefined;
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

    const prevStr = prev ? prev.chars : '';
    const prevLastNL = prevStr.lastIndexOf('\n');
    const prevAfterNL = prevLastNL === -1 ? prevStr : prevStr.slice(prevLastNL + 1);
    let prevOk = !prev || isOnlySpacesAndTabs(prevAfterNL);

    // If there's no newline in prevStr, scan the source backward to verify there really is a
    // newline or start-of-input. Catches `<ul>{{#each}}` and `foo {{#each}}`.
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

    const nextStr = next ? next.chars : '';
    const nextFirstNL = nextStr.indexOf('\n');
    const nextBeforeNL = nextFirstNL === -1 ? nextStr : nextStr.slice(0, nextFirstNL);
    let nextOk = !next || isOnlySpacesAndTabs(nextBeforeNL);

    // A non-text node on the same line as the closing tag means we're not standalone.
    if (nextOk && nextFirstNL === -1 && next !== null) {
      const nodeAfterText = i + 2 < body.length ? body[i + 2] : null;
      if (nodeAfterText !== null) nextOk = false;
    }

    if (!prevOk || !nextOk) continue;

    if (prev) {
      const origLen = prevStr.length;
      prev.chars = prevLastNL === -1 ? '' : prevStr.slice(0, prevLastNL + 1);
      trimLocEnd(prev, origLen - prev.chars.length);
    }
    if (next) {
      const stripped = nextFirstNL === -1 ? nextStr.length : nextFirstNL + 1;
      next.chars = nextFirstNL === -1 ? '' : nextStr.slice(nextFirstNL + 1);
      trimLocStart(next, stripped);
    }

    if (node.type === 'BlockStatement') {
      const bs = node;
      for (const prog of [bs.program, bs.inverse]) {
        if (!prog || prog.body.length === 0) continue;

        const first = prog.body[0];
        if (first && first.type === 'TextNode') {
          const nl = first.chars.indexOf('\n');
          const stripped = nl === -1 ? first.chars.length : nl + 1;
          first.chars = nl === -1 ? '' : first.chars.slice(nl + 1);
          trimLocStart(first, stripped);
        }

        const last = prog.body[prog.body.length - 1];
        if (last && last.type === 'TextNode') {
          const nl = last.chars.lastIndexOf('\n');
          const origLen = last.chars.length;
          last.chars = nl === -1 ? '' : last.chars.slice(0, nl + 1);
          trimLocEnd(last, origLen - last.chars.length);
        }
      }

      // For chained inverses ({{else if}}), also strip the first child of each chained block's body.
      if (bs.inverse?.chained) {
        let inv: ASTv1.Block | null | undefined = bs.inverse;
        while (inv?.chained) {
          const chainedBlock = inv.body[0] as ASTv1.BlockStatement | undefined;
          if (!chainedBlock) break;
          const chainedFirst = chainedBlock.program.body[0];
          if (chainedFirst?.type === 'TextNode') {
            const nl = chainedFirst.chars.indexOf('\n');
            const stripped = nl === -1 ? chainedFirst.chars.length : nl + 1;
            chainedFirst.chars = nl === -1 ? '' : chainedFirst.chars.slice(nl + 1);
            trimLocStart(chainedFirst, stripped);
          }
          inv = chainedBlock.inverse ?? null;
        }
      }
    }
  }
}

function filterEmptyText(body: ASTv1.Statement[]): ASTv1.Statement[] {
  return body.filter((n) => !(n.type === 'TextNode' && n.chars === ''));
}

// Walk `body` applying `mutate` at each level, filtering empty text nodes,
// then recursing into block programs/inverses and element children.
// The two whitespace passes must run as separate full-tree walks (tilde,
// then standalone) because standalone at an outer level reads text inside
// nested blocks' first/last children, and we want that read to observe the
// already-tilde-stripped state — not an interleaved half-state.
function walkAndStrip(
  body: ASTv1.Statement[],
  mutate: (body: ASTv1.Statement[]) => void
): ASTv1.Statement[] {
  mutate(body);
  const result = filterEmptyText(body);
  for (const n of result) {
    if (n.type === 'BlockStatement') {
      n.program.body = walkAndStrip(n.program.body, mutate);
      if (n.inverse) n.inverse.body = walkAndStrip(n.inverse.body, mutate);
    } else if (n.type === 'ElementNode') {
      n.children = walkAndStrip(n.children, mutate);
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
      } else if (c === CH_SPACE || c === CH_TAB || c === CH_FF) {
        col++;
        pos++;
      } else break;
    }
  }

  function err(msg: string): never {
    throw generateSyntaxError(msg, sp(pos, pos));
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
    skipWs(); // closing ) may be on a new line
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

  function toVarHeads(params: BlockParam[]): ASTv1.VarHead[] {
    return params.map((bp) => b.var({ name: bp.name, loc: sp(bp.s, bp.e) }));
  }

  // True when the cursor is still inside an opening tag — not whitespace, not
  // '>' and not the start of '/>'. Callers that also want to stop at '{{' or
  // '|' add those checks inline.
  function isInsideOpenTag(): boolean {
    return !isWhitespace(cc()) && cc() !== CH_GT && !(cc() === CH_SLASH && cc(1) === CH_GT);
  }

  // Consume a `{{…}}` (and for blocks, its matching close tag) that uses a
  // Handlebars feature we don't support, so the resulting SyntaxError spans
  // the whole construct rather than just `{{`.
  function rejectUnsupportedMustache(s: number, feature: string): never {
    const end = input.indexOf('}}', pos);
    if (end !== -1) advanceTo(end + 2);
    throw generateSyntaxError(`Handlebars ${feature} are not supported`, sp(s, pos));
  }

  function rejectUnsupportedBlock(s: number, feature: string): never {
    const nameEnd = input.indexOf('}}', pos);
    const name = nameEnd !== -1 ? input.substring(pos, nameEnd).trim() : '';
    if (nameEnd !== -1) advanceTo(nameEnd + 2);
    const close = `{{/${name}}}`;
    const closeIdx = name ? input.indexOf(close, pos) : -1;
    if (closeIdx !== -1) advanceTo(closeIdx + close.length);
    throw generateSyntaxError(`Handlebars ${feature} are not supported`, sp(s, pos));
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
        const afterBang = pos;
        const isLongForm =
          input.charCodeAt(afterBang) === CH_DASH && input.charCodeAt(afterBang + 1) === CH_DASH;
        if (isLongForm) {
          let searchFrom = afterBang + 2;
          while (searchFrom < len) {
            const dashIdx = input.indexOf('--', searchFrom);
            if (dashIdx === -1) break;
            let afterDash = dashIdx + 2;
            let trailingTilde = false;
            if (afterDash < len && input.charCodeAt(afterDash) === CH_TILDE) {
              trailingTilde = true;
              afterDash++;
            }
            if (
              afterDash + 1 < len &&
              input.charCodeAt(afterDash) === CH_RBRACE &&
              input.charCodeAt(afterDash + 1) === CH_RBRACE
            ) {
              const closeEnd = afterDash + 2;
              const rightStrip = trailingTilde;
              const raw = input.substring(s, closeEnd);
              advanceTo(closeEnd);
              const val = raw.replace(/^\{\{~?!-?-?/, '').replace(/-?-?~?\}\}$/, '');
              return {
                kind: 'comment',
                s,
                leftStrip: ls,
                value: val,
                commentStrip: { open: ls, close: rightStrip },
              };
            }
            searchFrom = dashIdx + 1;
          }
        }
        // Single-line comment or non-long-form
        const shortCloseIdx = input.indexOf('}}', afterBang);
        if (shortCloseIdx === -1) err('Unterminated comment');
        let shortRightStrip = false;
        if (shortCloseIdx > 0 && input.charCodeAt(shortCloseIdx - 1) === CH_TILDE)
          shortRightStrip = true;
        const shortCloseEnd = shortCloseIdx + 2;
        const raw = input.substring(s, shortCloseEnd);
        advanceTo(shortCloseEnd);
        const val = raw.replace(/^\{\{~?!-?-?/, '').replace(/-?-?~?\}\}$/, '');
        return {
          kind: 'comment',
          s,
          leftStrip: ls,
          value: val,
          commentStrip: { open: ls, close: shortRightStrip },
        };
      }
      case CH_HASH: {
        col++;
        pos++;
        if (cc() === CH_GT) {
          col++;
          pos++;
          return rejectUnsupportedBlock(s, 'partial blocks');
        }
        if (cc() === CH_STAR) {
          col++;
          pos++;
          return rejectUnsupportedBlock(s, 'decorator blocks');
        }
        return { kind: 'block', s, leftStrip: ls };
      }
      case CH_SLASH:
        col++;
        pos++;
        return { kind: 'close', s, leftStrip: ls };
      case CH_GT: {
        col++;
        pos++;
        return rejectUnsupportedMustache(s, 'partials');
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
      case CH_STAR: {
        col++;
        pos++;
        return rejectUnsupportedMustache(s, 'decorators');
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

  const meta: ScanMeta = {
    blockOpenTagEnd: new WeakMap(),
    blockIsChained: new WeakSet(),
    commentStrip: new WeakMap(),
  };

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
        if (open.commentStrip) meta.commentStrip.set(node, open.commentStrip);
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
        bf.programEnd = open.s; // start of {{else if}} = end of outer program body
        const guts = parseMustacheGuts(open.leftStrip, true, open.s);
        // inverseStrip.close comes from the ~ in {{else if cond~}}, not hardcoded false
        bf.inverseStrip = { open: open.leftStrip, close: guts.strip.close };
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
          const bpVars: ASTv1.VarHead[] = toVarHeads(bf.blockParams);

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
              const firstElse = bf.elseBody[0];
              const chained =
                bf.elseBody.length === 1 &&
                firstElse?.type === 'BlockStatement' &&
                meta.blockIsChained.has(firstElse);
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

          meta.blockOpenTagEnd.set(blockNode, bf.openTagEnd);
          if (bf.isChained) meta.blockIsChained.add(blockNode);
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
    // Skip optional whitespace between '=' and the value (e.g. class = "value" or class =\n{{foo}})
    if (isWhitespace(cc())) skipWs();

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
        if (cc() === CH_BACKSLASH && sw('{{', 1)) {
          // \{{ inside quoted attr value — emit {{ as literal text (skip the backslash).
          col++;
          pos++; // skip backslash
          tbuf += '{{';
          col += 2;
          pos += 2; // skip {{ as literal text
        } else if (sw('{{')) {
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
          while (pos < len && cc() !== CH_SEMICOLON && !isWhitespace(cc()) && entity.length < 20) {
            entity += input[pos];
            col++;
            pos++;
          }
          if (pos < len && cc() === CH_SEMICOLON) {
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
      if (pos < len && isInsideOpenTag()) {
        // Scan to get the full attr span (from attrStart to wherever this bad thing ends)
        const badStart = attrStart;
        // Scan until whitespace or >
        while (pos < len && isInsideOpenTag()) {
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
    while (pos < len && isInsideOpenTag() && !sw('{{')) {
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
      while (pos < len && isInsideOpenTag()) {
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
        if (isAsciiAlpha(c) || isAsciiDigit(c) || c === CH_UNDERSCORE || c === CH_DASH) {
          id += input[pos];
          col++;
          pos++;
        } else break;
      }

      // Check for invalid chars immediately after or in place of identifier
      if (id === '' || (pos < len && cc() !== CH_PIPE && isInsideOpenTag() && !sw('{{'))) {
        // Collect the bad identifier span
        while (pos < len && cc() !== CH_PIPE && isInsideOpenTag() && !sw('{{')) {
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
      while (pos < len && isInsideOpenTag() && !sw('{{')) {
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
        isAsciiAlpha(c) ||
        isAsciiDigit(c) ||
        c === CH_DASH ||
        c === CH_UNDERSCORE ||
        c === CH_DOT ||
        c === CH_COLON
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
      if (firstCharCode >= CH_A && firstCharCode <= CH_Z) {
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
          isAsciiAlpha(c) ||
          isAsciiDigit(c) ||
          c === CH_DASH ||
          c === CH_UNDERSCORE ||
          c === CH_COLON ||
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
    if (isAsciiAlpha(fc) || fc === CH_AT || fc === CH_COLON) {
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
            params: toVarHeads(info.params),
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
              params: toVarHeads(info.params),
              comments: info.comments,
              children: rawBody,
              openTag: openTagSpan,
              closeTag: closeTagSpan,
              loc: sp(ltPos, pos),
            })
          );
        } else {
          // Push to element stack
          stack.push({
            kind: 'element',
            tag: info.tag,
            ns: info.ns,
            ltPos,
            openTagEnd: info.openTagEnd,
            attrs: info.attrs,
            modifiers: info.modifiers,
            params: toVarHeads(info.params),
            comments: info.comments,
            children: [],
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
  //
  // Handlebars backslash-escape rules (matching Jison's lexer behaviour exactly):
  //
  //   k = number of consecutive backslashes immediately before {{
  //
  //   k=0: plain mustache — outer loop calls parseHbsNode
  //   k=1: escape — backslash is consumed, {{content}} becomes literal text.
  //         Jison's "emu" state then merges the escaped content with the following
  //         text (until the next {{, \{{, or \\{{) into ONE ContentStatement.
  //         We emit the text-before-\ as a SEPARATE ContentStatement first.
  //   k≥2: real mustache — (k-1) backslashes are emitted as literal text, the
  //         last backslash is discarded, and {{ is left for parseHbsNode.
  //
  // Examples (k=3 follows the same "real mustache" path as k=2):
  //   \{{x}}   → ContentStatement("{{x}}" merged with following text)
  //   \\{{x}}  → ContentStatement("\") + MustacheStatement(x)
  //   \\\{{x}} → ContentStatement("\\") + MustacheStatement(x)
  function emitText(chars: string, s: number, e: number): void {
    if (chars.length === 0) return;
    if (!codemod && chars.includes('&')) {
      chars = chars.replace(/&([^;\s<>&]{1,20});/g, (_, name: string) => decodeHtmlEntity(name));
    }
    append(b.text({ chars, loc: sp(s, e) }));
  }

  function scanTextNode(): boolean {
    if (pos >= len) return false;
    const s = pos;

    const nlt = input.indexOf('<', pos);
    const nltPos = nlt === -1 ? len : nlt;
    const nmu = input.indexOf('{{', pos);
    const nmuPos = nmu === -1 ? len : nmu;
    const hardLimit = Math.min(nltPos, nmuPos);

    if (hardLimit <= pos) return false;

    if (nmuPos > nltPos || nmuPos >= len) {
      // No {{ before < (or no {{): emit text up to <
      emitText(input.substring(pos, nltPos), s, nltPos);
      advanceTo(nltPos);
      return true;
    }

    // {{ found before <. Count consecutive backslashes before {{ from current pos.
    let k = 0;
    while (nmuPos - k - 1 >= pos && input.charCodeAt(nmuPos - k - 1) === CH_BACKSLASH) {
      k++;
    }

    if (k === 0) {
      // Plain {{ — emit text before it, outer loop handles {{
      const textBefore = input.substring(pos, nmuPos);
      if (textBefore.length === 0) return false;
      emitText(textBefore, s, nmuPos);
      advanceTo(nmuPos);
      return true;
    }

    if (k >= 2) {
      // Real mustache: emit text + (k-1) backslashes, skip the last backslash.
      // input.substring(pos, nmuPos-1) = plain text + (k-1) backslashes
      // (last backslash at nmuPos-1 is the one stripped by Jison's lexer).
      emitText(input.substring(pos, nmuPos - 1), s, nmuPos - 1);
      advanceTo(nmuPos); // skip last backslash; outer loop sees {{ at pos
      return true;
    }

    // k === 1: escape sequence.
    // ContentStatement 1 — text before the backslash (may be absent).
    const backslashPos = nmuPos - 1;
    if (backslashPos > pos) {
      emitText(input.substring(pos, backslashPos), s, backslashPos);
    }
    // Skip the backslash; pos is now at {{.
    advanceTo(nmuPos);

    // ContentStatement 2 — {{content}} merged with following text (Jison emu state).
    const cs2Start = pos; // = nmuPos
    let chars2 = '';

    // Read {{content}}
    const closePos = input.indexOf('}}', pos + 2);
    if (closePos !== -1 && closePos < nltPos) {
      chars2 = input.substring(pos, closePos + 2);
      advanceTo(closePos + 2);
    } else {
      // No closing }} before < — treat everything up to < as literal text.
      chars2 = input.substring(pos, nltPos);
      advanceTo(nltPos);
      if (chars2.length > 0) emitText(chars2, cs2Start, pos);
      return true;
    }

    // Emu-merge: accumulate text until we hit <, {{, \{{, or \\{{.
    // (Jison's emu lookahead stops at "{{", "\{{", "\\{{".)
    if (pos < len) {
      const nlt2 = input.indexOf('<', pos);
      const nltPos2 = nlt2 === -1 ? len : nlt2;
      const nmu2 = input.indexOf('{{', pos);
      const nmuPos2 = nmu2 === -1 ? len : nmu2;

      if (nltPos2 <= nmuPos2) {
        // < comes first or no {{: add text up to < and stop.
        if (nltPos2 > pos) {
          chars2 += input.substring(pos, nltPos2);
          advanceTo(nltPos2);
        }
      } else if (nmuPos2 > pos) {
        // {{ comes first: stop just before the backslash sequence (or before {{ when k2=0).
        let k2 = 0;
        while (nmuPos2 - k2 - 1 >= pos && input.charCodeAt(nmuPos2 - k2 - 1) === CH_BACKSLASH) k2++;
        const stopPos = nmuPos2 - k2;
        if (stopPos > pos) {
          chars2 += input.substring(pos, stopPos);
          advanceTo(stopPos);
        }
      }
    }

    if (chars2.length > 0) emitText(chars2, cs2Start, pos);
    return true;
  }

  // ── Main scan loop ────────────────────────────────────────────────────────────
  while (pos < len) {
    const nlt = input.indexOf('<', pos);
    const nmu = input.indexOf('{{', pos);
    const elt = nlt === -1 ? len : nlt;
    const emu = nmu === -1 ? len : nmu;

    if (elt <= emu) {
      if (elt > pos) scanTextNode();
      else parseHtmlNode();
    } else {
      if (emu > pos) scanTextNode();
      else parseHbsNode();
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

  // Tilde stripping (~ flags) and standalone-line stripping run as two
  // full-tree walks, in that order. See walkAndStrip() comment for why.
  const ignoreStandalone = codemod || (options.parseOptions?.ignoreStandalone ?? false);
  const afterTilde = codemod ? rootBody : walkAndStrip(rootBody, (b) => mutateTilde(b, meta));
  const strippedBody = ignoreStandalone
    ? afterTilde
    : walkAndStrip(afterTilde, (b) => mutateStandalone(b, input, source, meta));

  // Build template
  return b.template({
    body: strippedBody,
    blockParams: options.locals ?? [],
    loc: sp(0, len),
  });
}
