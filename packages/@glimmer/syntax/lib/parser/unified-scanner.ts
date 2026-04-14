// @ts-nocheck
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

import type * as ASTv1 from '../v1/api';
import type { PreprocessOptions } from './tokenizer-event-handlers';

import { Source } from '../source/source';
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
const CH_DASH = 45;
const CH_DOT = 46;
const CH_SLASH = 47;
const CH_0 = 48;
const CH_9 = 57;
const CH_LT = 60;
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
    c === CH_TILDE || c === CH_RBRACE || isWhitespace(c) || c === CH_RPAREN || c === CH_RBRACKET || c !== c
  );
}

function idFromToken(t: string): string {
  return t.charCodeAt(0) === CH_LBRACKET && t.charCodeAt(t.length - 1) === CH_RBRACKET
    ? t.substring(1, t.length - 1)
    : t;
}

function pathOriginal(p: ASTv1.PathExpression | ASTv1.SubExpression): string {
  if (p.type === 'PathExpression') return p.original as string;
  // SubExpression has no meaningful name for close-block matching
  return '';
}

// ── Standalone-line whitespace stripping ───────────────────────────────────────
//
// Mirrors Handlebars' WhitespaceControl post-pass:
// A BlockStatement or MustacheCommentStatement is "standalone" when the text
// immediately before it (from the last \n to the node) contains only spaces/tabs,
// AND the text immediately after it (up to and including the first \n) contains
// only spaces/tabs.  If so, strip that surrounding whitespace and the leading/
// trailing whitespace inside the block's program/inverse bodies.

function isOnlySpacesAndTabs(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false; // not space or tab
  }
  return true;
}

function applyStandaloneStripping(body: ASTv1.Statement[]): ASTv1.Statement[] {
  for (let i = 0; i < body.length; i++) {
    const node = body[i]!;
    if (node.type !== 'BlockStatement' && node.type !== 'MustacheCommentStatement') continue;

    // Chained blocks ({{else if}}) are not standalone on their own; their surrounding
    // whitespace is governed by the parent block's standalone status.
    if ((node as any).__chained) continue;

    const prevNode = i > 0 ? body[i - 1]! : null;
    const nextNode = i < body.length - 1 ? body[i + 1]! : null;
    const prev = prevNode?.type === 'TextNode' ? (prevNode as ASTv1.TextNode) : null;
    const next = nextNode?.type === 'TextNode' ? (nextNode as ASTv1.TextNode) : null;

    // A non-text node immediately before/after means something is on the same line → not standalone.
    if (prevNode !== null && prev === null) continue;
    if (nextNode !== null && next === null) continue;

    // prev OK: everything from the last \n (exclusive) to end must be spaces/tabs only
    const prevStr = prev ? prev.chars : '';
    const prevLastNL = prevStr.lastIndexOf('\n');
    const prevAfterNL = prevLastNL === -1 ? prevStr : prevStr.slice(prevLastNL + 1);
    const prevOk = !prev || isOnlySpacesAndTabs(prevAfterNL);

    // next OK: everything from start to first \n (exclusive) must be spaces/tabs only
    const nextStr = next ? next.chars : '';
    const nextFirstNL = nextStr.indexOf('\n');
    const nextBeforeNL = nextFirstNL === -1 ? nextStr : nextStr.slice(0, nextFirstNL);
    const nextOk = !next || isOnlySpacesAndTabs(nextBeforeNL);

    if (!prevOk || !nextOk) continue;

    // Strip prev: drop everything after the last \n (the indentation of the helper line)
    if (prev) {
      prev.chars = prevLastNL === -1 ? '' : prevStr.slice(0, prevLastNL + 1);
    }

    // Strip next: drop everything up to and including the first \n
    if (next) {
      next.chars = nextFirstNL === -1 ? '' : nextStr.slice(nextFirstNL + 1);
    }

    // Strip first/last children inside the block's program and inverse bodies
    if (node.type === 'BlockStatement') {
      const bs = node as ASTv1.BlockStatement;
      for (const prog of [bs.program, bs.inverse]) {
        if (!prog || prog.body.length === 0) continue;

        // Strip leading \n from first child (for the open-tag line being standalone)
        const first = prog.body[0];
        if (first && first.type === 'TextNode') {
          const t = first as ASTv1.TextNode;
          const nl = t.chars.indexOf('\n');
          t.chars = nl === -1 ? '' : t.chars.slice(nl + 1);
        }

        // Strip trailing spaces/tabs from last child (for the close-tag line being standalone)
        const last = prog.body[prog.body.length - 1];
        if (last && last.type === 'TextNode') {
          const t = last as ASTv1.TextNode;
          const nl = t.chars.lastIndexOf('\n');
          t.chars = nl === -1 ? '' : t.chars.slice(0, nl + 1);
        }
      }

      // For chained inverses ({{else if}}), also strip the first child of each chained
      // block's program body — mirrors Handlebars' omitRight(firstInverse.body) for the
      // {{else if}} line being standalone.
      if (bs.inverse?.chained) {
        let inv: ASTv1.Block | null | undefined = bs.inverse;
        while (inv?.chained) {
          const chainedBlock = inv.body[0] as ASTv1.BlockStatement | undefined;
          if (!chainedBlock) break;
          const chainedFirst = chainedBlock.program.body[0];
          if (chainedFirst?.type === 'TextNode') {
            const t = chainedFirst as ASTv1.TextNode;
            const nl = t.chars.indexOf('\n');
            t.chars = nl === -1 ? '' : t.chars.slice(nl + 1);
          }
          inv = chainedBlock.inverse ?? null;
        }
      }
    }
  }

  // Remove now-empty text nodes
  const result = body.filter((n) => !(n.type === 'TextNode' && (n as ASTv1.TextNode).chars === ''));

  // Recurse into element children and block bodies
  for (const n of result) {
    if (n.type === 'BlockStatement') {
      const bs = n as ASTv1.BlockStatement;
      bs.program.body = applyStandaloneStripping(bs.program.body);
      if (bs.inverse) bs.inverse.body = applyStandaloneStripping(bs.inverse.body);
    } else if (n.type === 'ElementNode') {
      (n as ASTv1.ElementNode).children = applyStandaloneStripping(
        (n as ASTv1.ElementNode).children
      );
    }
  }

  return result;
}

// ── Main export ────────────────────────────────────────────────────────────────

export function unifiedPreprocess(input: string, options: PreprocessOptions = {}): ASTv1.Template {
  const source = new Source(input, options.meta?.moduleName);
  const len = input.length;

  let pos = 0, line = 1, col = 0;

  // ── Span ───────────────────────────────────────────────────────────────────────
  function sp(s: number, e: number): SourceSpan {
    return SourceSpan.forCharPositions(source, s, e);
  }

  // ── Position tracking ─────────────────────────────────────────────────────────
  function advanceTo(t: number): void {
    while (pos < t) {
      const nl = input.indexOf('\n', pos);
      if (nl === -1 || nl >= t) { col += t - pos; pos = t; return; }
      line++; col = 0; pos = nl + 1;
    }
  }

  function cc(o = 0): number { return input.charCodeAt(pos + o); }
  function sw(s: string, o = 0): boolean { return input.startsWith(s, pos + o); }

  interface Sv { pos: number; line: number; col: number; }
  function save(): Sv { return { pos, line, col }; }
  function restore(s: Sv): void { pos = s.pos; line = s.line; col = s.col; }

  function skipWs(): void {
    while (pos < len) {
      const c = cc();
      if (c === CH_NL) { line++; col = 0; pos++; }
      else if (c === CH_CR) { line++; col = 0; pos++; if (pos < len && cc() === CH_NL) pos++; }
      else if (c === CH_SPACE || c === CH_TAB || c === 12) { col++; pos++; }
      else break;
    }
  }

  function err(msg: string): never {
    throw new Error(`Parse error on line ${line}: ${msg} (near: ${JSON.stringify(input.slice(pos, pos + 20))})`);
  }

  // ── Low-level scanning ────────────────────────────────────────────────────────
  function scanId(): string | null {
    const s = pos;
    while (pos < len && isIdChar(cc())) { col++; pos++; }
    return pos > s ? input.substring(s, pos) : null;
  }

  function scanIdOrEscaped(): string | null {
    if (cc() === CH_LBRACKET) {
      const s = pos; col++; pos++;
      while (pos < len) {
        const c = cc();
        if (c === CH_BACKSLASH && pos + 1 < len) { col += 2; pos += 2; }
        else if (c === CH_RBRACKET) { col++; pos++; return input.substring(s, pos); }
        else if (c === CH_NL) { line++; col = 0; pos++; }
        else { col++; pos++; }
      }
      err('Unterminated [...]');
    }
    if (cc() === CH_DOT && cc(1) === CH_DOT) { col += 2; pos += 2; return '..'; }
    if (cc() === CH_DOT && isLookahead(cc(1))) { col++; pos++; return '.'; }
    return scanId();
  }

  function scanString(): { value: string; s: number; e: number } | null {
    const q = cc();
    if (q !== CH_DQUOTE && q !== CH_SQUOTE) return null;
    const s = pos; col++; pos++;
    let result = '', seg = pos;
    while (pos < len) {
      const c = cc();
      if (c === CH_BACKSLASH && pos + 1 < len && cc(1) === q) {
        result += input.substring(seg, pos); col += 2; pos += 2;
        result += String.fromCharCode(q); seg = pos;
      } else if (c === q) {
        result += input.substring(seg, pos); col++; pos++;
        return { value: result, s, e: pos };
      } else if (c === CH_NL) { line++; col = 0; pos++; }
      else { col++; pos++; }
    }
    err('Unterminated string');
  }

  function scanNumber(): string | null {
    const sv = save();
    if (cc() === CH_DASH) { col++; pos++; }
    if (pos >= len || cc() < CH_0 || cc() > CH_9) { restore(sv); return null; }
    while (pos < len && cc() >= CH_0 && cc() <= CH_9) { col++; pos++; }
    if (pos < len && cc() === CH_DOT) {
      col++; pos++;
      while (pos < len && cc() >= CH_0 && cc() <= CH_9) { col++; pos++; }
    }
    if (pos < len && !isLiteralLookahead(cc())) { restore(sv); return null; }
    return input.substring(sv.pos, pos);
  }

  function scanSep(): string | null {
    if (cc() === CH_DOT && cc(1) === CH_HASH) { col += 2; pos += 2; return '.#'; }
    if (cc() === CH_DOT || cc() === CH_SLASH) { const c = input[pos]; col++; pos++; return c; }
    return null;
  }

  // ── ASTv1 path building ───────────────────────────────────────────────────────
  function buildPath(
    data: boolean,
    segs: Array<{ part: string; original: string; separator?: string }>,
    s: number, e: number
  ): ASTv1.PathExpression {
    const fullSp = sp(s, e);
    let orig = data ? '@' : '';
    const tail: string[] = [];

    for (const { part, original, separator } of segs) {
      const esc = original !== part;
      const pfx = separator === '.#' ? '#' : '';
      orig += (separator ?? '') + part;
      if (!esc && (part === '..' || part === '.' || part === 'this')) {
        // depth tracking — Glimmer disallows ../ anyway
      } else {
        tail.push(`${pfx}${part}`);
      }
    }

    // Glimmer validations
    if (orig.includes('/')) {
      if (orig.startsWith('./')) throw generateSyntaxError(`Using "./" is not supported in Glimmer and unnecessary`, fullSp);
      if (orig.startsWith('../')) throw generateSyntaxError(`Changing context using "../" is not supported in Glimmer`, fullSp);
      if (orig.includes('.')) throw generateSyntaxError(`Mixing '.' and '/' in paths is not supported in Glimmer; use only '.' to separate property paths`, fullSp);
      return b.path({ head: b.var({ name: orig, loc: fullSp }), tail: [], loc: fullSp });
    }
    if (orig === '.') throw generateSyntaxError(`'.' is not a supported path in Glimmer; check for a path with a trailing '.'`, fullSp);

    const tailCopy = [...tail];
    let head: ASTv1.PathHead;

    if (orig === 'this' || orig.startsWith('this.')) {
      head = b.this({ loc: sp(s, s + 4) });
    } else if (data) {
      if (!tailCopy.length) throw generateSyntaxError(`Attempted to parse a path expression, but it was not valid. Paths beginning with @ must start with a-z.`, fullSp);
      const hname = tailCopy.shift()!;
      head = b.atName({ name: `@${hname}`, loc: sp(s, s + 1 + hname.length) });
    } else {
      if (!tailCopy.length) throw generateSyntaxError(`Attempted to parse a path expression, but it was not valid. Paths must start with a-z or A-Z.`, fullSp);
      const hname = tailCopy.shift()!;
      head = b.var({ name: hname, loc: sp(s, s + hname.length) });
    }

    return b.path({ head, tail: tailCopy, loc: fullSp });
  }

  function parsePath(data: boolean, s: number): ASTv1.PathExpression {
    const segs: Array<{ part: string; original: string; separator?: string }> = [];
    const first = scanIdOrEscaped();
    if (!first) err('Expected path identifier');
    segs.push({ part: idFromToken(first!), original: first! });
    while (pos < len) {
      const sv = save(); const sep = scanSep();
      if (!sep) break;
      const id = scanIdOrEscaped();
      if (!id) { restore(sv); break; }
      segs.push({ part: idFromToken(id), original: id, separator: sep });
    }
    return buildPath(data, segs, s, pos);
  }

  // ── Expressions ───────────────────────────────────────────────────────────────
  function parseExpr(): ASTv1.Expression {
    skipWs();
    const s = pos; const c = cc();

    if (c === CH_LPAREN) return parseSexpr();

    if (c === CH_DQUOTE || c === CH_SQUOTE) {
      const str = scanString()!;
      return b.literal({ type: 'StringLiteral', value: str.value, loc: sp(str.s, str.e) });
    }

    if (c === CH_DASH || (c >= CH_0 && c <= CH_9)) {
      const sv = save(); const num = scanNumber();
      if (num !== null) return b.literal({ type: 'NumberLiteral', value: Number(num), loc: sp(s, pos) });
      restore(sv);
    }

    if (sw('true') && isLiteralLookahead(cc(4))) { advanceTo(pos + 4); return b.literal({ type: 'BooleanLiteral', value: true, loc: sp(s, pos) }); }
    if (sw('false') && isLiteralLookahead(cc(5))) { advanceTo(pos + 5); return b.literal({ type: 'BooleanLiteral', value: false, loc: sp(s, pos) }); }
    if (sw('undefined') && isLiteralLookahead(cc(9))) { advanceTo(pos + 9); return b.literal({ type: 'UndefinedLiteral', value: undefined, loc: sp(s, pos) }); }
    if (sw('null') && isLiteralLookahead(cc(4))) { advanceTo(pos + 4); return b.literal({ type: 'NullLiteral', value: null, loc: sp(s, pos) }); }

    if (c === CH_AT) {
      col++; pos++;
      if (cc() >= CH_0 && cc() <= CH_9) err('Expected identifier after @');
      return parsePath(true, s);
    }
    return parsePath(false, s);
  }

  function parseSexpr(): ASTv1.SubExpression {
    const s = pos; col++; pos++; // skip (
    skipWs();
    const path = parseExpr() as ASTv1.PathExpression | ASTv1.SubExpression;
    const params: ASTv1.Expression[] = [];
    let hash: ASTv1.Hash | undefined;
    skipWs();
    while (cc() !== CH_RPAREN && pos < len) {
      if (isAtHash()) { hash = parseHash(); break; }
      params.push(parseExpr()); skipWs();
    }
    if (cc() !== CH_RPAREN) err("Expected ')'");
    col++; pos++;
    if (!hash) hash = b.hash({ pairs: [], loc: sp(pos, pos) });
    return b.sexpr({ path, params, hash, loc: sp(s, pos) });
  }

  function isAtHash(): boolean {
    if (!isIdChar(cc()) && cc() !== CH_LBRACKET) return false;
    let p = pos;
    if (input.charCodeAt(p) === CH_LBRACKET) {
      p++;
      while (p < len && input.charCodeAt(p) !== CH_RBRACKET) { if (input.charCodeAt(p) === CH_BACKSLASH) p++; p++; }
      p++;
    } else { while (p < len && isIdChar(input.charCodeAt(p))) p++; }
    while (p < len && isWhitespace(input.charCodeAt(p))) p++;
    return p < len && input.charCodeAt(p) === CH_EQ;
  }

  function parseHash(): ASTv1.Hash {
    const s = pos; const pairs: ASTv1.HashPair[] = [];
    let lastEnd = pos;
    while (pos < len && isAtHash()) {
      skipWs();
      const ps = pos;
      const key = scanIdOrEscaped();
      if (!key) err('Expected hash key');
      skipWs();
      if (cc() !== CH_EQ) err("Expected '='");
      col++; pos++;
      const value = parseExpr();
      lastEnd = pos;
      pairs.push(b.pair({ key: idFromToken(key!), value, loc: sp(ps, pos) }));
      const sv = save(); skipWs();
      if (!isAtHash()) { restore(sv); break; }
    }
    return b.hash({ pairs, loc: sp(s, lastEnd) });
  }

  function consumeClose(): boolean {
    skipWs();
    let rs = false;
    if (cc() === CH_TILDE) { rs = true; col++; pos++; }
    if (cc() !== CH_RBRACE || cc(1) !== CH_RBRACE) err("Expected '}}'");
    advanceTo(pos + 2); return rs;
  }

  function parseHbsBlockParams(): string[] | null {
    skipWs();
    if (!sw('as')) return null;
    const afterAs = pos + 2;
    if (afterAs >= len || !isWhitespace(input.charCodeAt(afterAs))) return null;
    let p = afterAs;
    while (p < len && isWhitespace(input.charCodeAt(p))) p++;
    if (p >= len || input.charCodeAt(p) !== CH_PIPE) return null;
    advanceTo(p + 1);
    const ids: string[] = [];
    skipWs();
    while (cc() !== CH_PIPE && pos < len) {
      const id = scanId(); if (!id) err('Expected block param identifier'); ids.push(id!); skipWs();
    }
    if (cc() !== CH_PIPE) err("Expected '|'"); col++; pos++;
    return ids;
  }

  // Parse path+params+hash inside a mustache, return guts
  function parseMustacheGuts(leftStrip: boolean, wantBlockParams: boolean) {
    skipWs();
    const path = parseExpr() as ASTv1.PathExpression | ASTv1.SubExpression;
    const params: ASTv1.Expression[] = [];
    let hash: ASTv1.Hash | undefined;
    let blockParams: string[] = [];

    skipWs();
    while (pos < len && cc() !== CH_RBRACE && !(cc() === CH_TILDE && cc(1) === CH_RBRACE)) {
      if (wantBlockParams && sw('as') && isWhitespace(input.charCodeAt(pos + 2))) {
        const bp = parseHbsBlockParams();
        if (bp) { blockParams = bp; break; }
      }
      if (isAtHash()) {
        hash = parseHash(); skipWs();
        if (wantBlockParams && sw('as') && isWhitespace(input.charCodeAt(pos + 2))) {
          blockParams = parseHbsBlockParams() ?? [];
        }
        break;
      }
      params.push(parseExpr()); skipWs();
    }
    const rightStrip = consumeClose();
    if (!hash) hash = b.hash({ pairs: [], loc: sp(pos, pos) });
    return { path, params, hash, blockParams, strip: { open: leftStrip, close: rightStrip } };
  }

  // ── Open classifier ───────────────────────────────────────────────────────────
  interface Open {
    kind: string; s: number; leftStrip: boolean;
    rightStrip?: boolean; // for inverse/inverse-chain
    value?: string;       // for comment
    unescaped?: boolean;  // for & or {{{
    isDecorator?: boolean;
  }

  function classifyOpen(): Open {
    const s = pos;
    if (sw('{{{{')) err('Raw blocks not supported');
    advanceTo(pos + 2); // skip {{
    let ls = false;
    if (cc() === CH_TILDE) { ls = true; col++; pos++; }
    const afterStrip = save(); skipWs(); const wsSkipped = pos > afterStrip.pos;

    // 'else' check
    if (sw('else')) {
      const afterElse = pos + 4; const cae = input.charCodeAt(afterElse);
      if (isWhitespace(cae) || cae === CH_TILDE || cae === CH_RBRACE) {
        advanceTo(afterElse); skipWs();
        let rs = false;
        if (cc() === CH_TILDE) { rs = true; col++; pos++; }
        if (cc() === CH_RBRACE && cc(1) === CH_RBRACE) {
          advanceTo(pos + 2); return { kind: 'inverse', s, leftStrip: ls, rightStrip: rs };
        }
        // {{else X ...}} — inverseChain; pos is right after 'else '+ws
        if (pos !== afterElse) { restore(afterStrip); advanceTo(afterElse); }
        skipWs();
        return { kind: 'inverseChain', s, leftStrip: ls };
      }
      restore(afterStrip);
    } else if (wsSkipped) restore(afterStrip);

    const c = cc();
    switch (c) {
      case CH_BANG: {
        col++; pos++;
        const ab = pos;
        const se = input.indexOf('}}', ab); if (se === -1) err('Unterminated comment');
        let srs = false; if (se > 0 && input.charCodeAt(se - 1) === CH_TILDE) srs = true;
        const sme = se + 2;
        const sdd = input.charCodeAt(ab) === CH_DASH && input.charCodeAt(ab + 1) === CH_DASH;
        if (sdd) {
          let lme = -1, lrs = false, sf = ab + 2;
          while (sf < len) {
            const di = input.indexOf('--', sf); if (di === -1) break;
            let ad = di + 2; let tr = false;
            if (ad < len && input.charCodeAt(ad) === CH_TILDE) { tr = true; ad++; }
            if (ad + 1 < len && input.charCodeAt(ad) === CH_RBRACE && input.charCodeAt(ad + 1) === CH_RBRACE) { lme = ad + 2; lrs = tr; break; }
            sf = di + 1;
          }
          if (lme > sme) {
            const raw = input.substring(s, lme); advanceTo(lme);
            const val = raw.replace(/^\{\{~?!-?-?/, '').replace(/-?-?~?\}\}$/, '');
            return { kind: 'comment', s, leftStrip: ls, value: val };
          }
        }
        const raw = input.substring(s, sme); advanceTo(sme);
        const val = raw.replace(/^\{\{~?!-?-?/, '').replace(/-?-?~?\}\}$/, '');
        return { kind: 'comment', s, leftStrip: ls, value: val };
      }
      case 35: /* # */ col++; pos++; // CH_HASH
        if (cc() === CH_GT) { col++; pos++; err('Partial blocks not supported'); }
        const isDecorator35 = cc() === 42; /* * */ if (isDecorator35) { col++; pos++; }
        return { kind: 'block', s, leftStrip: ls, isDecorator: isDecorator35 };
      case CH_SLASH: col++; pos++; return { kind: 'close', s, leftStrip: ls };
      case CH_GT: err('Partials not supported');
      case CH_CARET: {
        col++; pos++; skipWs();
        let rs = false;
        if (cc() === CH_TILDE) { const sv = save(); rs = true; col++; pos++; if (cc() === CH_RBRACE && cc(1) === CH_RBRACE) { advanceTo(pos + 2); return { kind: 'inverse', s, leftStrip: ls, rightStrip: rs }; } restore(sv); rs = false; }
        if (cc() === CH_RBRACE && cc(1) === CH_RBRACE) { advanceTo(pos + 2); return { kind: 'inverse', s, leftStrip: ls, rightStrip: false }; }
        return { kind: 'openInverse', s, leftStrip: ls };
      }
      case CH_LBRACE: col++; pos++; return { kind: 'unescaped', s, leftStrip: ls };
      case CH_AMP: col++; pos++; return { kind: 'mustache', s, leftStrip: ls, unescaped: true };
      case 42: /* * */ col++; pos++; return { kind: 'mustache', s, leftStrip: ls, isDecorator: true };
      default: return { kind: 'mustache', s, leftStrip: ls };
    }
  }

  // ── Stack frames ──────────────────────────────────────────────────────────────
  interface TemplateFrame { kind: 'template'; body: ASTv1.Statement[]; }
  interface ElementFrame {
    kind: 'element'; tag: string;
    ltPos: number;    // char pos of '<'
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
    path: ASTv1.PathExpression | ASTv1.SubExpression;
    params: ASTv1.Expression[];
    hash: ASTv1.Hash;
    blockParams: string[];
    openStrip: ASTv1.StripFlags;
    defaultBody: ASTv1.Statement[];
    elseBody: ASTv1.Statement[] | null;
    inverseStrip: ASTv1.StripFlags;
    inElse: boolean;
    isChained: boolean; // true = this block is inside an {{else if}} chain
  }
  type Frame = TemplateFrame | ElementFrame | BlockFrame;

  const rootBody: ASTv1.Statement[] = [];
  const stack: Frame[] = [{ kind: 'template', body: rootBody }];

  function currentBody(): ASTv1.Statement[] {
    const t = stack[stack.length - 1]!;
    if (t.kind === 'block') return t.inElse ? t.elseBody! : t.defaultBody;
    if (t.kind === 'element') return t.children;
    return t.body;
  }

  function append(node: ASTv1.Statement): void { currentBody().push(node); }

  // ── HBS node parsing ──────────────────────────────────────────────────────────
  function parseHbsNode(): void {
    const open = classifyOpen();

    switch (open.kind) {
      case 'comment':
        append(b.mustacheComment({ value: open.value ?? '', loc: sp(open.s, pos) }));
        return;

      case 'mustache':
      case 'unescaped': {
        const trusting = open.kind === 'unescaped' || !!open.unescaped;
        let path: ASTv1.Expression, params: ASTv1.Expression[], hash: ASTv1.Hash, strip: ASTv1.StripFlags;
        if (trusting && open.kind === 'unescaped') {
          // {{{...}}}
          skipWs(); path = parseExpr(); params = []; hash = undefined!;
          skipWs();
          while (pos < len && !(cc() === CH_RBRACE && cc(1) === CH_RBRACE && cc(2) === CH_RBRACE) && !(cc() === CH_TILDE && cc(1) === CH_RBRACE)) {
            if (isAtHash()) { hash = parseHash(); break; }
            params.push(parseExpr()); skipWs();
          }
          skipWs(); let rs = false;
          if (cc() === CH_TILDE) { rs = true; col++; pos++; }
          if (!(cc() === CH_RBRACE && cc(1) === CH_RBRACE && cc(2) === CH_RBRACE)) err("Expected '}}}'");
          advanceTo(pos + 3);
          if (!hash) hash = b.hash({ pairs: [], loc: sp(pos, pos) });
          strip = { open: open.leftStrip, close: rs };
        } else {
          const guts = parseMustacheGuts(open.leftStrip, false);
          path = guts.path; params = guts.params; hash = guts.hash; strip = guts.strip;
        }
        append(b.mustache({ path: path as any, params, hash, trusting, loc: sp(open.s, pos), strip }));
        return;
      }

      case 'block':
      case 'openInverse': {
        const guts = parseMustacheGuts(open.leftStrip, true);
        const inverted = open.kind === 'openInverse';
        stack.push({
          kind: 'block', openStart: open.s,
          path: guts.path, params: guts.params, hash: guts.hash,
          blockParams: guts.blockParams, openStrip: guts.strip,
          defaultBody: [], elseBody: inverted ? [] : null,
          inverseStrip: { open: false, close: false },
          inElse: inverted, isChained: false,
        });
        return;
      }

      case 'inverse': {
        const bf = stack[stack.length - 1] as BlockFrame;
        if (!bf || bf.kind !== 'block') err('Unexpected {{else}}');
        bf.inElse = true; bf.elseBody = [];
        bf.inverseStrip = { open: open.leftStrip, close: open.rightStrip ?? false };
        return;
      }

      case 'inverseChain': {
        const bf = stack[stack.length - 1] as BlockFrame;
        if (!bf || bf.kind !== 'block') err('Unexpected {{else ...}}');
        bf.inElse = true; bf.elseBody = [];
        bf.inverseStrip = { open: open.leftStrip, close: false };
        // Parse the chained block opener (e.g. 'if cond}}')
        const guts = parseMustacheGuts(open.leftStrip, true);
        stack.push({
          kind: 'block', openStart: open.s,
          path: guts.path, params: guts.params, hash: guts.hash,
          blockParams: guts.blockParams, openStrip: guts.strip,
          defaultBody: [], elseBody: null,
          inverseStrip: { open: false, close: false },
          inElse: false, isChained: true,
        });
        return;
      }

      case 'close': {
        // Parse close path + }}
        skipWs();
        const closePath = parseExpr();
        const closeRS = consumeClose();
        const closeName = pathOriginal(closePath as any);

        // Close all chained frames + the first non-chained frame
        let closeWasChained = true;
        while (closeWasChained && stack.length > 1) {
          const bf = stack[stack.length - 1] as BlockFrame;
          if (!bf || bf.kind !== 'block') err('Unexpected close block');

          const openName = pathOriginal(bf.path);
          if (openName !== closeName) {
            throw generateSyntaxError(`${openName} doesn't match ${closeName}`, sp(open.s, pos));
          }

          closeWasChained = bf.isChained;
          stack.pop();

          // Build block params as VarHeads (approx location)
          const bpVars: ASTv1.VarHead[] = bf.blockParams.map((name) =>
            b.var({ name, loc: sp(bf.openStart, bf.openStart + name.length) })
          );

          const closeStrip: ASTv1.StripFlags = { open: open.leftStrip, close: closeRS };
          let defaultBlock: ASTv1.Block, inverseBlock: ASTv1.Block | null = null;

          if ((bf as any)._inverted) {
            // openInverse: swap default/else
            defaultBlock = b.blockItself({ body: bf.elseBody ?? [], params: bpVars, chained: false, loc: sp(bf.openStart, pos) });
            inverseBlock = b.blockItself({ body: bf.defaultBody, params: [], chained: false, loc: sp(bf.openStart, pos) });
          } else {
            defaultBlock = b.blockItself({ body: bf.defaultBody, params: bpVars, chained: false, loc: sp(bf.openStart, pos) });
            if (bf.elseBody !== null) {
              const chained = bf.elseBody.length === 1 && bf.elseBody[0]?.type === 'BlockStatement' && (bf.elseBody[0] as any).__chained;
              inverseBlock = b.blockItself({ body: bf.elseBody, params: [], chained, loc: sp(bf.openStart, pos) });
            }
          }

          const blockNode = b.block({
            path: bf.path, params: bf.params, hash: bf.hash,
            defaultBlock, elseBlock: inverseBlock,
            loc: sp(bf.openStart, pos),
            openStrip: bf.openStrip,
            inverseStrip: bf.inverseStrip,
            closeStrip,
          });
          // Mark chained blocks for parent's chained detection (non-enumerable to avoid
          // appearing in AST serialization / node-shape comparisons)
          if (bf.isChained) {
            Object.defineProperty(blockNode, '__chained', { value: true, enumerable: false, writable: true, configurable: true });
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
    const s = pos; advanceTo(pos + 4); // skip <!--
    const ci = input.indexOf('-->', pos); if (ci === -1) err('Unterminated HTML comment');
    const value = input.substring(pos, ci); advanceTo(ci + 3);
    append(b.comment({ value, loc: sp(s, pos) }));
  }

  // ── Attribute value after '=' ─────────────────────────────────────────────────
  function parseAttrValue(): ASTv1.AttrNode['value'] {
    const q = cc();

    if (q === CH_DQUOTE || q === CH_SQUOTE) {
      const oq = pos; col++; pos++; // open quote
      const parts: (ASTv1.TextNode | ASTv1.MustacheStatement)[] = [];
      let tbuf = '', ts = pos;

      const flushText = () => {
        if (tbuf.length > 0) { parts.push(b.text({ chars: tbuf, loc: sp(ts, pos) })); tbuf = ''; ts = pos; }
      };

      while (pos < len && cc() !== q) {
        if (sw('{{')) {
          flushText();
          const mo = classifyOpen();
          if (mo.kind !== 'mustache' && mo.kind !== 'unescaped') err('Expected mustache in attribute value');
          const guts = parseMustacheGuts(mo.leftStrip, false);
          parts.push(b.mustache({ path: guts.path, params: guts.params, hash: guts.hash, trusting: mo.kind === 'unescaped' || !!mo.unescaped, loc: sp(mo.s, pos), strip: guts.strip }));
          ts = pos;
        } else {
          tbuf += input[pos];
          if (cc() === CH_NL) { line++; col = 0; pos++; } else { col++; pos++; }
        }
      }
      flushText();
      if (cc() !== q) err('Unterminated attribute value');
      col++; pos++; // close quote

      if (parts.length === 0) return b.text({ chars: '', loc: sp(oq + 1, pos - 1) });
      if (parts.length === 1) return parts[0] as ASTv1.TextNode | ASTv1.MustacheStatement;
      return b.concat({ parts: parts as any, loc: sp(oq + 1, pos - 1) });
    }

    if (sw('{{')) {
      // Unquoted mustache: src={{url}}
      const mo = classifyOpen();
      if (mo.kind !== 'mustache' && mo.kind !== 'unescaped') err('Expected mustache as attribute value');
      const guts = parseMustacheGuts(mo.leftStrip, false);
      return b.mustache({ path: guts.path, params: guts.params, hash: guts.hash, trusting: mo.kind === 'unescaped' || !!mo.unescaped, loc: sp(mo.s, pos), strip: guts.strip });
    }

    // Unquoted literal
    const vs = pos;
    while (pos < len && !isWhitespace(cc()) && cc() !== CH_GT && !(cc() === CH_SLASH && cc(1) === CH_GT) && !sw('{{')) {
      col++; pos++;
    }
    return b.text({ chars: input.substring(vs, pos), loc: sp(vs, pos) });
  }

  // ── Element block params (as |x y|) ──────────────────────────────────────────
  function parseElemBlockParams(): string[] {
    skipWs();
    if (!sw('as')) return [];
    const aa = pos + 2;
    if (aa >= len || !isWhitespace(input.charCodeAt(aa))) return [];
    let p = aa; while (p < len && isWhitespace(input.charCodeAt(p))) p++;
    if (p >= len || input.charCodeAt(p) !== CH_PIPE) return [];
    advanceTo(p + 1);
    const ids: string[] = []; skipWs();
    while (cc() !== CH_PIPE && pos < len) { const id = scanId(); if (!id) err('Expected block param'); ids.push(id!); skipWs(); }
    if (cc() !== CH_PIPE) err("Expected '|'"); col++; pos++;
    return ids;
  }

  // ── Start tag parser (after '<' consumed) ────────────────────────────────────
  function parseStartTag(ltPos: number): { tag: string; openTagEnd: number; attrs: ASTv1.AttrNode[]; modifiers: ASTv1.ElementModifierStatement[]; params: ASTv1.VarHead[]; selfClosing: boolean } {
    // Scan tag name
    const ns = pos;
    while (pos < len) {
      const c = cc();
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 95 || c === 46 || c === 58) { col++; pos++; }
      else break;
    }
    if (pos === ns) err('Expected tag name');
    const tag = input.substring(ns, pos);

    const attrs: ASTv1.AttrNode[] = [];
    const modifiers: ASTv1.ElementModifierStatement[] = [];
    let elemBP: string[] = [];

    loop: while (pos < len) {
      skipWs();

      if (cc() === CH_GT) { col++; pos++; break loop; }
      if (cc() === CH_SLASH && cc(1) === CH_GT) { advanceTo(pos + 2); return { tag, openTagEnd: pos, attrs, modifiers, params: elemBP.map((n) => b.var({ name: n, loc: sp(ltPos, pos) })), selfClosing: true }; }

      // {{modifier}} or {{!comment}}
      if (sw('{{')) {
        const mo = classifyOpen();
        if (mo.kind === 'comment') { /* just a comment, discard */ continue loop; }
        if (mo.kind !== 'mustache') err('Only {{modifiers}} allowed in element tags');
        const guts = parseMustacheGuts(mo.leftStrip, false);
        modifiers.push(b.elementModifier({ path: guts.path, params: guts.params, hash: guts.hash, loc: sp(mo.s, pos) }));
        continue loop;
      }

      // as |x| block params
      if (sw('as') && isWhitespace(input.charCodeAt(pos + 2))) {
        const bp = parseElemBlockParams();
        if (bp.length > 0) { elemBP = bp; continue loop; }
      }

      // Attribute name
      const ans = pos;
      let attrName = '';
      if (cc() === CH_AT) { col++; pos++; attrName = '@'; }
      else if (sw('...')) { advanceTo(pos + 3); const r = scanId(); attrName = '...' + (r ?? ''); }

      // Continue scanning identifier chars for name
      const nameBodyStart = pos;
      while (pos < len) {
        const c = cc();
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 95 || c === 58 || c === CH_BANG) { attrName += input[pos]; col++; pos++; }
        else break;
      }
      if (attrName === '' && pos === nameBodyStart) err(`Expected attribute name or '>' in <${tag}>`);

      skipWs();
      if (cc() === CH_EQ) {
        col++; pos++;
        const value = parseAttrValue();
        attrs.push(b.attr({ name: attrName, value, loc: sp(ans, pos) }));
      } else {
        attrs.push(b.attr({ name: attrName, value: b.text({ chars: '', loc: sp(pos, pos) }), loc: sp(ans, pos) }));
      }
    }

    return { tag, openTagEnd: pos, attrs, modifiers, params: elemBP.map((n) => b.var({ name: n, loc: sp(ltPos, pos) })), selfClosing: false };
  }

  // ── HTML node dispatch ────────────────────────────────────────────────────────
  function parseHtmlNode(): void {
    const ltPos = pos;

    // HTML comment
    if (sw('<!--')) { parseHtmlComment(); return; }

    // CDATA/doctype — treat as text
    if (sw('<!')) {
      const e = input.indexOf('>', pos); if (e === -1) err('Unterminated <! declaration');
      const txt = input.substring(ltPos, e + 1); advanceTo(e + 1);
      append(b.text({ chars: txt, loc: sp(ltPos, pos) })); return;
    }

    // Closing tag </tag>
    if (cc(1) === CH_SLASH) {
      const closeStart = pos; advanceTo(pos + 2); // skip </
      const ns = pos;
      while (pos < len && !isWhitespace(cc()) && cc() !== CH_GT) { col++; pos++; }
      const closedTag = input.substring(ns, pos);
      skipWs();
      if (cc() !== CH_GT) err(`Expected '>' in </${closedTag}>`);
      col++; pos++;
      const closeEnd = pos;

      // Find matching element frame
      let fi = stack.length - 1;
      while (fi >= 0 && stack[fi]!.kind !== 'element') fi--;
      if (fi < 0) throw generateSyntaxError(`Closing tag </${closedTag}> without an open tag`, sp(closeStart, closeEnd));

      const ef = stack[fi] as ElementFrame;
      if (ef.tag !== closedTag) {
        throw generateSyntaxError(
          `Closing tag </${closedTag}> did not match last open tag <${ef.tag}> (on line ${source.hbsPosFor(ef.ltPos)?.line ?? '?'})`,
          sp(closeStart, closeEnd)
        );
      }

      // Pop everything above the element frame (should only be block frames — error in valid template)
      while (stack.length - 1 > fi) stack.pop();
      stack.pop();

      // Build the element
      const closeTagSpan = sp(closeStart, closeEnd);
      const elemSpan = sp(ef.ltPos, closeEnd);
      const openTagSpan = sp(ef.ltPos, ef.openTagEnd);
      const tagPath = b.path({ head: b.var({ name: ef.tag, loc: openTagSpan }), tail: [], loc: openTagSpan });
      append(b.element({ path: tagPath, selfClosing: false, attributes: ef.attrs, modifiers: ef.modifiers, params: ef.params, comments: ef.comments, children: ef.children, openTag: openTagSpan, closeTag: closeTagSpan, loc: elemSpan }));
      return;
    }

    // Start tag <tagname...>
    const fc = cc(1);
    if ((fc >= 65 && fc <= 90) || (fc >= 97 && fc <= 122)) {
      col++; pos++; // skip <
      const info = parseStartTag(ltPos);
      const selfClosing = info.selfClosing || voidMap.has(info.tag.toLowerCase());
      const openTagSpan = sp(ltPos, info.openTagEnd);
      if (selfClosing) {
        const tagPath = b.path({ head: b.var({ name: info.tag, loc: openTagSpan }), tail: [], loc: openTagSpan });
        append(b.element({ path: tagPath, selfClosing: true, attributes: info.attrs, modifiers: info.modifiers, params: info.params, comments: [], children: [], openTag: openTagSpan, closeTag: null, loc: openTagSpan }));
      } else {
        stack.push({ kind: 'element', tag: info.tag, ltPos, openTagEnd: info.openTagEnd, attrs: info.attrs, modifiers: info.modifiers, params: info.params, comments: [], children: [] });
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
    let nlt = input.indexOf('<', pos); if (nlt === -1) nlt = len;
    let nmu = input.indexOf('{{', pos); if (nmu === -1) nmu = len;

    let text = '', seg = pos;
    let limit = Math.min(nlt, nmu);

    // Scan for escaped mustaches within the window
    let sf = pos;
    while (true) {
      const mi = input.indexOf('{{', sf);
      if (mi === -1 || mi >= limit) { text += input.substring(seg, limit); break; }
      if (mi > 0 && input.charCodeAt(mi - 1) === CH_BACKSLASH) {
        if (mi > 1 && input.charCodeAt(mi - 2) === CH_BACKSLASH) {
          // \\{{ — strip one \, stop ({{ is real mustache)
          text += input.substring(seg, mi - 1); limit = mi; break;
        }
        // \{{ — becomes literal {{, consume the escaped mustache content
        text += input.substring(seg, mi - 1) + '{{';
        const ci = input.indexOf('}}', mi + 2);
        if (ci === -1) { text += input.substring(mi + 2, limit); break; }
        text += input.substring(mi + 2, ci);
        seg = ci + 2; sf = ci + 2;
        nmu = input.indexOf('{{', sf); if (nmu === -1) nmu = len;
        limit = Math.min(nlt, nmu);
        continue;
      }
      text += input.substring(seg, mi); limit = mi; break;
    }

    if (!text.length) return false;
    advanceTo(limit);
    append(b.text({ chars: text, loc: sp(s, pos) }));
    return true;
  }

  // ── Terminator check ──────────────────────────────────────────────────────────
  function isTerminator(terminators: string[]): boolean {
    if (!sw('{{')) return false;
    let p = pos + 2;
    if (p < len && input.charCodeAt(p) === CH_TILDE) p++;
    let pw = p;
    while (pw < len && isWhitespace(input.charCodeAt(pw))) pw++;
    const c = input.charCodeAt(p);
    for (const t of terminators) {
      if (t === 'close' && c === CH_SLASH) return true;
      if (t === 'inverse' && (c === CH_CARET || input.startsWith('else', pw))) return true;
    }
    return false;
  }

  // ── Main scan loop ────────────────────────────────────────────────────────────
  while (pos < len) {
    // Fast path: find the next delimiter
    const nlt = input.indexOf('<', pos);
    const nmu = input.indexOf('{{', pos);
    const elt = nlt === -1 ? len : nlt;
    const emu = nmu === -1 ? len : nmu;

    if (elt === len && emu === len) {
      // Remaining is plain text
      if (pos < len) {
        const ts = pos; const txt = input.substring(pos, len);
        advanceTo(len);
        if (txt) append(b.text({ chars: txt, loc: sp(ts, len) }));
      }
      break;
    }

    if (elt <= emu) {
      // '<' comes first (or tied with '{{' — prefer '<')
      if (elt > pos) {
        scanTextNode();
      } else {
        parseHtmlNode();
      }
    } else {
      // '{{' comes first
      if (emu > pos) {
        scanTextNode();
      } else {
        parseHbsNode();
      }
    }
  }

  // Validate stack is clean
  if (stack.length > 1) {
    const top = stack[stack.length - 1]!;
    if (top.kind === 'element') {
      throw generateSyntaxError(`Unclosed element \`${(top as ElementFrame).tag}\``, sp((top as ElementFrame).ltPos, pos));
    }
    if (top.kind === 'block') {
      const bf = top as BlockFrame;
      const name = pathOriginal(bf.path);
      throw generateSyntaxError(`Unclosed block \`${name}\``, sp(bf.openStart, pos));
    }
  }

  // Apply standalone whitespace stripping (mirrors Handlebars' WhitespaceControl)
  const ignoreStandalone = (options as any).parseOptions?.ignoreStandalone ?? false;
  const strippedBody = ignoreStandalone ? rootBody : applyStandaloneStripping(rootBody);

  // Build template
  return b.template({
    body: strippedBody,
    blockParams: options.locals ?? [],
    loc: sp(0, len),
  });
}
