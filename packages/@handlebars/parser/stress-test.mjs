/**
 * Stress test: try to break the v2-parser with edge cases.
 * Compare full JSON (including locs) against Jison for valid templates.
 * For error templates, just verify both throw (or note differences).
 */
/**
 * v2-parser only stress test. Jison comparison was done separately
 * (153/153 audit). This test focuses on finding crashes, hangs, or
 * wrong behavior in the v2-parser across a wide range of edge cases.
 */
import { v2ParseWithoutProcessing as parse } from './lib/v2-parser.js';

let passed = 0,
  failed = 0;

function test(tpl, label) {
  try {
    const ast = parse(tpl);
    if (!ast || ast.type !== 'Program') {
      console.log(`FAIL [${label}]: didn't return Program, got ${ast?.type}`);
      failed++;
      return;
    }
    passed++;
  } catch (e) {
    console.log(`FAIL [${label}]: ${e.message?.substring(0, 80)}`);
    console.log(`  template: ${JSON.stringify(tpl).substring(0, 60)}`);
    failed++;
  }
}

function testError(tpl, label) {
  try {
    parse(tpl);
    console.log(`FAIL [${label}]: expected error but parsed OK`);
    console.log(`  template: ${JSON.stringify(tpl).substring(0, 60)}`);
    failed++;
  } catch (e) {
    passed++;
  }
}

function testV2Only(tpl, label, shouldError) {
  if (shouldError) testError(tpl, label);
  else test(tpl, label);
}

// === ESCAPED MUSTACHES ===
test('\\{{foo}}', 'escaped mustache');
test('\\\\{{foo}}', 'double-escaped');
test('text\\{{foo}}more', 'escaped with text');
test('a\\{{b}}c{{d}}e', 'escaped then real');

// === UNICODE ===
test('{{café}}', 'unicode id');
test('{{naïve}}', 'diacritic');
test('{{日本語}}', 'CJK');
test('{{foo$bar}}', 'dollar');
test('{{foo-bar-baz}}', 'dashes');
test('{{$}}', 'just dollar');
test('{{_}}', 'just underscore');
test('{{-}}', 'just dash');

// === WHITESPACE ===
test('{{  foo  }}', 'extra ws');
test('{{  foo  bar  }}', 'extra ws params');
test('{{\tfoo\t}}', 'tabs');
test('{{\nfoo\n}}', 'newlines');
test('{{\r\nfoo\r\n}}', 'crlf');
test('  ', 'ws only');
test('\t\n\r\n', 'mixed ws');
test('{{#foo}}\n\n\n{{/foo}}', 'blank lines in block');

// === EMPTY/MINIMAL ===
test('', 'empty');
test('{{foo}}', 'bare');
test('{{""}}', 'empty string lit');
test("{{''}}", 'empty single-quoted');
test('{{0}}', 'zero');
test('{{-1}}', 'negative');
test('{{0.0}}', 'zero float');
test('{{-0.5}}', 'negative decimal');
test('{{1.23456789}}', 'long decimal');

// === PATHS ===
test('{{a.b.c.d.e.f.g}}', 'deep path');
test('{{this.a.b.c}}', 'this deep');
test('{{@a.b.c}}', 'data deep');
test('{{../a}}', 'parent');
test('{{../../a}}', 'grandparent');
test('{{../../../a}}', 'great-grandparent');
test('{{../a.b}}', 'parent then child');
test('{{foo.[bar]}}', 'escaped segment');
test('{{foo.[bar.baz]}}', 'escaped segment dot');
test('{{foo.[bar baz]}}', 'escaped segment space');
test('{{[foo].[bar]}}', 'both escaped');
test('{{[this]}}', 'escaped this');
test('{{[true]}}', 'escaped true');
test('{{[false]}}', 'escaped false');
test('{{[null]}}', 'escaped null');
test('{{this/bar}}', 'this slash');
test('{{a/b}}', 'slash path');
test('{{a.#b}}', 'private sep');
test('{{@a.#b.c}}', 'data private');
test('{{this.#foo}}', 'this private');

// === STRIP FLAGS ===
test('{{foo}}', 'no strip');
test('{{~foo}}', 'left strip');
test('{{foo~}}', 'right strip');
test('{{~foo~}}', 'both strip');
test('{{~#foo}}x{{/foo~}}', 'block LR strip');
test('{{#foo~}}x{{~/foo}}', 'block RL strip');
test('{{~#foo~}}x{{~/foo~}}', 'block all strip');
test('{{~> foo~}}', 'partial strip');
test('{{~! comment ~}}', 'comment strip');
test('{{~!-- long --~}}', 'long comment strip');
test('{{~^foo~}}x{{~/foo~}}', 'inverse strip');
test('{{#foo}}x{{~else~}}y{{/foo}}', 'else strip');
test('{{#foo}}x{{~^~}}y{{/foo}}', 'caret inverse strip');
testError('{{{~foo~}}}', 'triple stache strip — invalid syntax');

// === COMMENTS ===
test('{{! }}', 'comment space');
test('{{!}}', 'empty comment');
test('{{!-}}', 'comment dash');
test('{{!--}}', 'comment looks like long');
test('{{!---}}', 'triple dash');
test('{{!----}}', 'quad dash');
test('{{!-- --}}', 'long minimal');
test('{{!-- x --}}', 'long content');
test('{{!-- }} --}}', 'long with }}');
test('{{!-- {{ --}}', 'long with {{');
test('{{!-- {{foo}} --}}', 'long with mustache');
test('{{!-- --\n--}}', 'long with -- on line');
test('{{! {{foo}} }}', 'short with mustache-like');
test('before{{! comment }}after', 'comment between');
test('{{!-- a --}}{{!-- b --}}', 'adjacent long');
test('{{! a }}{{! b }}', 'adjacent short');

// === RAW BLOCKS ===
test('{{{{raw}}}}{{{{/raw}}}}', 'empty raw');
test('{{{{raw}}}}content{{{{/raw}}}}', 'raw content');
test('{{{{raw}}}}{{foo}}{{{{/raw}}}}', 'raw with mustache');
test('{{{{raw}}}}{{{foo}}}{{{{/raw}}}}', 'raw with triple');
test('{{{{raw}}}}{{#if x}}y{{/if}}{{{{/raw}}}}', 'raw with block');
test('{{{{raw}}}}{{!-- comment --}}{{{{/raw}}}}', 'raw with comment');
test('{{{{raw}}}}{{{{inner}}}}x{{{{/inner}}}}{{{{/raw}}}}', 'nested raw');
test('{{{{raw helper}}}}content{{{{/raw}}}}', 'raw with params');

// === SUB-EXPRESSIONS ===
test('{{(foo)}}', 'sexpr minimal');
test('{{(foo bar)}}', 'sexpr arg');
test('{{(foo bar baz)}}', 'sexpr multi args');
test('{{(foo bar=baz)}}', 'sexpr hash');
test('{{(foo bar baz=qux)}}', 'sexpr arg+hash');
test('{{(foo (bar))}}', 'nested sexpr');
test('{{(foo (bar (baz)))}}', 'double nested sexpr');
test('{{(foo (bar baz) (qux quux))}}', 'multi sexpr args');
test('{{helper (a) (b) (c)}}', 'multi sexpr params');
test('{{helper key=(foo bar)}}', 'sexpr as hash val');
test('{{helper key=(foo (bar baz))}}', 'nested sexpr hash val');
test('{{(foo).bar}}', 'sexpr path');
test('{{(foo).bar.baz}}', 'sexpr deep path');
test('{{(foo bar).baz}}', 'sexpr args path');
test('{{helper (foo).bar}}', 'sexpr path arg');

// === BLOCKS ===
test('{{#a}}{{#b}}{{#c}}x{{/c}}{{/b}}{{/a}}', 'triple nested');
test('{{#a}}{{#b}}x{{/b}}{{#c}}y{{/c}}{{/a}}', 'sibling blocks');
test('{{#a}}x{{^}}y{{/a}}', 'caret inverse');
test('{{#a}}x{{else}}y{{/a}}', 'else inverse');
test('{{#a}}x{{else b}}y{{/a}}', 'else chain');
test('{{#a}}x{{else b}}y{{else c}}z{{/a}}', 'two else chains');
test('{{#a}}x{{else b}}y{{else c}}z{{else}}w{{/a}}', 'chains + final else');
test('{{#a}}{{#b}}x{{else}}y{{/b}}{{/a}}', 'nested inner else');
test('{{#a as |x|}}{{#b as |y|}}{{x}} {{y}}{{/b}}{{/a}}', 'nested block params');
test('{{^a}}x{{/a}}', 'standalone inverse');
test('{{^a as |x|}}{{x}}{{/a}}', 'inverse with params');

// === PARTIALS ===
test('{{> foo}}', 'partial');
test('{{> (foo)}}', 'partial sexpr name');
test('{{> "foo"}}', 'partial string name');
test('{{> foo bar}}', 'partial context');
test('{{> foo bar=baz}}', 'partial hash');
test('{{> foo bar baz=qux}}', 'partial context+hash');
test('{{#> foo}}x{{/foo}}', 'partial block');
test('{{#> foo bar=baz}}x{{/foo}}', 'partial block hash');

// === DECORATORS ===
test('{{* foo}}', 'decorator');
test('{{* foo bar}}', 'decorator arg');
test('{{* foo bar=baz}}', 'decorator hash');
test('{{#* foo}}{{/foo}}', 'decorator block');
test('{{#* foo}}content{{/foo}}', 'decorator block content');

// === HASH ===
test('{{foo a=1 b=2 c=3 d=4 e=5}}', 'many hash pairs');
test('{{foo a="b" c=\'d\'}}', 'hash mixed quotes');
test('{{foo a=true b=false c=null d=undefined}}', 'hash all lits');
test('{{foo a=@bar}}', 'hash data val');
test('{{foo a=(bar baz)}}', 'hash sexpr val');
test('{{foo a=bar.baz}}', 'hash path val');
test('{{foo a=../bar}}', 'hash parent path');
test('{{foo=bar baz=qux}}', 'hash-only multi');

// === STRINGS ===
test('{{foo "hello world"}}', 'string space');
test('{{foo "hello\\"world"}}', 'string escaped quote');
test("{{foo 'hello\\'world'}}", 'single-quoted escaped');
test('{{foo ""}}', 'empty string');
test("{{foo ''}}", 'empty single');

// === CONTENT ===
test('}}', 'close-like content');
test('}}{{foo}}', 'close then mustache');
test('{foo}', 'single brace');
test('text}}more', 'stray close');
test('a}b}c', 'single braces');
test('a{b{c', 'single open braces');
test('\n\n{{foo}}\n\n', 'newlines around');

// === MULTI-LINE ===
test('{{foo\nbar}}', 'multi-line mustache');
test('{{foo\n  bar\n  baz}}', 'multi-line params');
test('{{foo\n  bar=baz\n  qux=quux\n}}', 'multi-line hash');
test('{{#foo\n  bar\n  baz=qux\n  as |a b|\n}}content{{/foo}}', 'multi-line block open');
test('{{#if\n  (eq a b)\n}}yes{{else}}no{{/if}}', 'multi-line sexpr');

// === ADJACENT ===
test('{{a}}{{b}}{{c}}', 'adjacent');
test('{{a}}x{{b}}y{{c}}', 'interleaved');
test('{{! a}}{{b}}', 'comment then mustache');
test('{{a}}{{! b}}', 'mustache then comment');
test('{{#a}}{{/a}}{{#b}}{{/b}}', 'adjacent blocks');
test('{{> a}}{{> b}}', 'adjacent partials');
test('{{{a}}}{{{b}}}', 'adjacent triple');

// === REAL-WORLD ===
test('<div class="{{if @isActive "active" "inactive"}}">{{@title}}</div>', 'real: cond class');
test(
  '{{#each @items as |item index|}}  <li>{{item.name}} ({{index}})</li>\n{{/each}}',
  'real: each'
);
test(
  '{{#if @showHeader}}\n  <header>{{@title}}</header>\n{{else if @showFooter}}\n  <footer>{{@title}}</footer>\n{{else}}\n  <main>{{@title}}</main>\n{{/if}}',
  'real: if/else-if/else'
);
test('{{yield (hash title=@title body=(component "my-body" model=@model))}}', 'real: yield hash');
test('{{on "click" (fn @onClick @item)}}', 'real: on+fn');
test('{{#let (hash a=1 b=2) as |config|}}\n  {{config.a}}\n{{/let}}', 'real: let hash');
test(
  '<button\n  type="button"\n  class="btn {{if @primary "btn-primary"}}"\n  disabled={{@disabled}}\n  {{on "click" @onClick}}\n>{{yield}}</button>',
  'real: button'
);
test(
  '{{#each @items as |item|}}\n  {{#if item.isVisible}}\n    <div class="item {{if item.isSelected "selected"}}" {{on "click" (fn @onSelect item)}}>\n      <span>{{item.label}}</span>\n      {{#if item.badge}}\n        <span class="badge">{{item.badge}}</span>\n      {{/if}}\n    </div>\n  {{/if}}\n{{/each}}',
  'real: complex list'
);
test('{{@model.user.profile.avatar.url}}', 'real: deep access');
test('{{t "some.translation.key" count=@items.length}}', 'real: translation');
test('{{format-date @date format="YYYY-MM-DD"}}', 'real: format');
test('{{#if (and @a (or @b @c) (not @d))}}yes{{/if}}', 'real: boolean logic');
test('{{(if @condition "yes" "no")}}', 'real: inline if');

// === ERRORS (v2 only — Jison OOMs on some) ===
testV2Only('{{foo}', 'error: unclosed mustache', true);
testV2Only('{{#foo}}', 'error: unclosed block', true);
testV2Only('{{> }}', 'error: empty partial', true);
testV2Only('{{#}}', 'error: empty block', true);
testV2Only('{{{foo}}', 'error: unclosed triple', true);

// === ERRORS (both parsers) ===
testError('{{#foo}}{{/bar}}', 'error: mismatch');
testError('{{{{foo}}}}{{{{/bar}}}}', 'error: raw mismatch');
testError('{{foo/../bar}}', 'error: invalid path ..');
testError('{{foo/./bar}}', 'error: invalid path .');
testError('{{foo/this/bar}}', 'error: invalid path this');

console.log(`\n${'='.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed out of ${passed + failed}`);
console.log(`${'='.repeat(60)}`);
