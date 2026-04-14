/**
 * Stress test round 2: harder edge cases, pathological inputs,
 * real-world Ember patterns, and fuzz-like combinations.
 */
import { v2ParseWithoutProcessing as parse } from './lib/v2-parser.js';

let passed = 0,
  failed = 0;

function test(tpl, label) {
  try {
    const ast = parse(tpl);
    if (!ast || ast.type !== 'Program') {
      console.log(`FAIL [${label}]: got ${ast?.type}`);
      failed++;
      return;
    }
    passed++;
  } catch (e) {
    console.log(`FAIL [${label}]: ${e.message?.substring(0, 80)}`);
    console.log(`  template: ${JSON.stringify(tpl).substring(0, 80)}`);
    failed++;
  }
}

function testError(tpl, label) {
  try {
    parse(tpl);
    console.log(`FAIL [${label}]: expected error but parsed OK`);
    console.log(`  template: ${JSON.stringify(tpl).substring(0, 80)}`);
    failed++;
  } catch (e) {
    passed++;
  }
}

console.log('=== ROUND 2: TRYING TO BREAK IT ===\n');

// =====================================================================
// 1. PATHOLOGICAL / STRESS INPUTS
// =====================================================================
test(
  '{{a}}{{b}}{{c}}{{d}}{{e}}{{f}}{{g}}{{h}}{{i}}{{j}}{{k}}{{l}}{{m}}{{n}}{{o}}{{p}}',
  '16 adjacent mustaches'
);
test('{{a}}'.repeat(100), '100 adjacent mustaches');
test('x'.repeat(10000) + '{{foo}}', '10K content then mustache');
test('{{foo}}' + 'x'.repeat(10000), 'mustache then 10K content');
test('x'.repeat(100000), '100K content no mustaches');

// Deep nesting
let deepBlock = '';
for (let i = 0; i < 50; i++) deepBlock += `{{#a${i}}}`;
deepBlock += 'x';
for (let i = 49; i >= 0; i--) deepBlock += `{{/a${i}}}`;
test(deepBlock, '50-deep nested blocks');

let deepSexpr = '{{';
for (let i = 0; i < 20; i++) deepSexpr += '(foo ';
deepSexpr += 'bar';
for (let i = 0; i < 20; i++) deepSexpr += ')';
deepSexpr += '}}';
test(deepSexpr, '20-deep nested sub-expressions');

// Many params
test('{{foo ' + Array.from({ length: 50 }, (_, i) => `p${i}`).join(' ') + '}}', '50 params');
test(
  '{{foo ' + Array.from({ length: 50 }, (_, i) => `k${i}=v${i}`).join(' ') + '}}',
  '50 hash pairs'
);

// =====================================================================
// 2. BOUNDARY CONDITIONS — MINIMAL/EMPTY VARIANTS
// =====================================================================
testError('{{}}', 'empty mustache — should error');
testError('{{~}}', 'just strip in mustache');
testError('{{~  ~}}', 'strips with whitespace only');
test('{{!}}', 'empty short comment');
test('{{!--  --}}', 'long comment with only spaces');
test('{{!----}}', 'long comment empty body');
test('{{#foo}}{{/foo}}', 'empty block body');
test('{{#foo}}  {{/foo}}', 'block with whitespace body');
test('{{#foo}}\n{{/foo}}', 'block with newline body');
test('{{#foo}}{{else}}{{/foo}}', 'block empty both branches');
test('{{{{raw}}}}{{{{/raw}}}}', 'empty raw block');

// =====================================================================
// 3. ESCAPED MUSTACHES — ROUND 2 (the area where we found the hang)
// =====================================================================
test('\\{{', 'bare escaped open');
test('\\{{}}', 'escaped then close');
test('\\{{foo}}\\{{bar}}', 'two escaped mustaches');
test('text\\{{a}}middle\\{{b}}end', 'escaped with text between');
test('\\\\{{foo}}after', 'double-escaped then content');
test('\\\\\\{{foo}}', 'triple backslash before {{');
test('x\\{{y\\{{z', 'multiple escaped no close');
test('\\{{\\{{\\{{', 'triple escaped open');

// =====================================================================
// 4. LINE ENDING VARIANTS
// =====================================================================
test('line1\nline2\n{{foo}}\nline4', 'LF line endings');
test('line1\r\nline2\r\n{{foo}}\r\nline4', 'CRLF line endings');
test('line1\rline2\r{{foo}}\rline4', 'CR-only line endings');
test('mixed\n\r\n\r{{foo}}', 'mixed line endings');
test('{{#foo}}\r\n  content\r\n{{/foo}}', 'CRLF in block');

// =====================================================================
// 5. UNICODE STRESS
// =====================================================================
test('{{emoji-🎉}}', 'emoji in id (if valid)');
test('{{foo "🎉 hello 世界"}}', 'emoji in string param');
test('{{foo "\\""}}', 'escaped quote in string');
test('{{"multi\nline"}}', 'newline in string');
test("{{foo 'it\\'s'}}", 'apostrophe escaped');
test('{{foo "say \\"hello\\""}}', 'multiple escaped quotes');

// =====================================================================
// 6. KEYWORDS AS ESCAPED IDENTIFIERS
// =====================================================================
test('{{[if]}}', 'escaped keyword if');
test('{{[else]}}', 'escaped keyword else');
test('{{[each]}}', 'escaped keyword each');
test('{{[true]}}', 'escaped keyword true');
test('{{[false]}}', 'escaped keyword false');
test('{{[null]}}', 'escaped keyword null');
test('{{[undefined]}}', 'escaped keyword undefined');
test('{{[as]}}', 'escaped keyword as');
test('{{foo.[if].bar}}', 'escaped keyword in path');
test('{{foo [if]=bar}}', 'escaped keyword as hash key');

// =====================================================================
// 7. STRIP FLAGS — EXHAUSTIVE COMBOS WITH BLOCKS
// =====================================================================
test('{{~#foo~}}{{~/foo~}}', 'block all strip empty');
test('{{~#foo}}content{{/foo~}}', 'block strip open-left close-right');
test('{{#foo~}}content{{~/foo}}', 'block strip open-right close-left');
test('{{~#foo~}}x{{~else~}}y{{~/foo~}}', 'block+else all strip');
test('{{~#foo~}}x{{~^~}}y{{~/foo~}}', 'block+caret all strip');
test('{{~#foo as |x|~}}{{x}}{{~/foo~}}', 'block params all strip');
test('{{~> partial~}}', 'partial both strip');
test('{{~#> partial~}}x{{~/partial~}}', 'partial block both strip');

// =====================================================================
// 8. COMPLEX REAL-WORLD PATTERNS
// =====================================================================
test(
  `
<div class="sidebar {{if @collapsed "collapsed"}} {{if @theme @theme "default"}}">
  {{#if @showNav}}
    <nav role="navigation" aria-label={{t "nav.label"}}>
      <ul class="nav-list">
        {{#each @navItems as |item index|}}
          <li class="nav-item {{if (eq @activeIndex index) "active"}}">
            <a
              href={{item.url}}
              class={{if item.disabled "disabled"}}
              aria-current={{if (eq @activeIndex index) "page"}}
              {{on "click" (fn @onNavigate item)}}
            >
              {{item.label}}
              {{#if item.badge}}
                <span class="badge">{{item.badge}}</span>
              {{/if}}
            </a>
          </li>
        {{/each}}
      </ul>
    </nav>
  {{else}}
    <p class="empty-state">{{t "nav.empty"}}</p>
  {{/if}}
</div>
`.trim(),
  'real: complex nav component'
);

test(
  `
{{#let
  (hash
    title=@model.title
    description=@model.description
    tags=(if @model.tags @model.tags (array))
    author=(hash
      name=@model.author.name
      avatar=@model.author.avatar
    )
  )
  as |data|
}}
  <article>
    <h1>{{data.title}}</h1>
    <p>{{data.description}}</p>
    {{#each data.tags as |tag|}}
      <span class="tag">{{tag}}</span>
    {{/each}}
    <footer>
      <img src={{data.author.avatar}} alt={{data.author.name}} />
      <span>{{data.author.name}}</span>
    </footer>
  </article>
{{/let}}
`.trim(),
  'real: let with complex hash'
);

test(
  `
{{#each @rows as |row rowIndex|}}
  <tr class={{if (eq rowIndex @selectedRow) "selected"}}>
    {{#each @columns as |column colIndex|}}
      <td
        class="cell {{if column.alignRight "text-right"}} {{if (and (eq rowIndex @selectedRow) (eq colIndex @selectedCol)) "active"}}"
        {{on "click" (fn @onCellClick rowIndex colIndex)}}
        {{on "dblclick" (fn @onCellEdit rowIndex colIndex)}}
        role="gridcell"
        aria-selected={{if (and (eq rowIndex @selectedRow) (eq colIndex @selectedCol)) "true" "false"}}
      >
        {{get (get @data rowIndex) column.key}}
      </td>
    {{/each}}
  </tr>
{{/each}}
`.trim(),
  'real: data grid component'
);

test(
  `
{{! This is a file upload component }}
{{!--
  It supports drag and drop, file selection,
  and previewing uploaded files.
  @param {Array} @files - current files
  @param {Function} @onUpload - upload handler
--}}
<div
  class="upload-zone {{if @isDragging "dragging"}} {{if @disabled "disabled"}}"
  {{on "dragover" @onDragOver}}
  {{on "dragleave" @onDragLeave}}
  {{on "drop" @onDrop}}
  role="button"
  tabindex="0"
  aria-disabled={{if @disabled "true"}}
>
  {{#if @files.length}}
    {{#each @files as |file|}}
      <div class="file-preview">
        {{#if (eq file.type "image")}}
          <img src={{file.preview}} alt={{file.name}} />
        {{else}}
          <span class="file-icon">{{file.extension}}</span>
        {{/if}}
        <span>{{file.name}}</span>
        <button {{on "click" (fn @onRemove file)}} type="button" aria-label={{concat "Remove " file.name}}>×</button>
      </div>
    {{/each}}
  {{else}}
    <p>{{t "upload.dropzone"}}</p>
  {{/if}}
</div>
`.trim(),
  'real: file upload component'
);

// =====================================================================
// 9. TRICKY CLOSE/OPEN PATTERNS
// =====================================================================
test('}}{{foo}}', 'stray close then real mustache');
test('}}}}{{foo}}', 'double stray close then mustache');
test('}}}{{foo}}', 'triple close before mustache');
test('{{foo}}}}', 'mustache then stray close');
test('{{{foo}}}}}', 'triple stache then extra braces');
test('{{foo}}{', 'mustache then single brace');
test('}{{foo}}', 'single close then mustache');

// =====================================================================
// 10. COMMENTS WITH TRICKY CONTENT
// =====================================================================
test('{{!-- }} --}}', 'long comment with }} inside');
test('{{!-- {{ --}}', 'long comment with {{ inside');
test('{{!-- {{#if x}} --}}', 'long comment with block inside');
test('{{!-- {{!-- nested --}} --}}', 'comment with comment-like inside');
test('{{! }} }}', 'short comment with }}');
test('{{!-- \n\n\n --}}', 'long comment with blank lines');
test('before{{!-- mid --}}after', 'comment between content');
test('{{foo}}{{!-- between --}}{{bar}}', 'comment between mustaches');

// =====================================================================
// 11. HASH-ONLY MUSTACHES (the {{key=val}} syntax)
// =====================================================================
test('{{a=b}}', 'hash-only single pair');
test('{{a=b c=d e=f}}', 'hash-only multiple pairs');
test('{{a=(foo bar)}}', 'hash-only with sub-expr value');
test('{{a="string" b=123 c=true d=null}}', 'hash-only mixed value types');

// =====================================================================
// 12. PARTIAL EDGE CASES
// =====================================================================
test('{{> (lookup . "partialName")}}', 'dynamic partial name');
testError('{{> foo as |bar|}}', 'partial with as — invalid syntax');

// =====================================================================
// 13. ELSE CHAIN STRESS
// =====================================================================
test(
  '{{#if a}}1{{else if b}}2{{else if c}}3{{else if d}}4{{else if e}}5{{else}}6{{/if}}',
  '5 else-if chains'
);
test(
  '{{#if a}}\n  {{#if b}}\n    inner\n  {{else}}\n    else-inner\n  {{/if}}\n{{else if c}}\n  chain\n{{else}}\n  final\n{{/if}}',
  'nested blocks in else chain'
);

// =====================================================================
// 14. PATH EXPRESSION EDGE CASES
// =====================================================================
test('{{foo.bar.baz.qux.quux.corge.grault.garply}}', '8-segment path');
test('{{@index}}', 'common data: @index');
test('{{@key}}', 'common data: @key');
test('{{@first}}', 'common data: @first');
test('{{@last}}', 'common data: @last');
test('{{@root.foo}}', 'data root path');
test('{{this.this}}', 'this.this');
test('{{../this}}', 'parent this');
test('{{this.[foo bar]}}', 'this with escaped segment');
test('{{foo.[0]}}', 'numeric-looking escaped segment');
test('{{foo.[class]}}', 'reserved-word escaped segment');

// =====================================================================
// 15. NUMBER EDGE CASES
// =====================================================================
test('{{foo 0}}', 'zero param');
test('{{foo -0}}', 'negative zero');
test('{{foo 999999999}}', 'large number');
test('{{foo -999999999}}', 'large negative');
test('{{foo 1.0}}', 'float one');
test('{{foo 0.001}}', 'small float');
test('{{foo 3.14159265}}', 'pi-ish');

// =====================================================================
// 16. WHITESPACE IN UNUSUAL PLACES
// =====================================================================
testError('{{   #   foo   }}x{{   /   foo   }}', 'spaces around # — invalid (Jison also rejects)');
testError('{{ > foo }}', 'space before > — invalid (Jison also rejects)');
test('{{ ! comment }}', 'space before !');
test('{{ foo bar = baz }}', 'spaces around = in hash');

// =====================================================================
// RESULTS
// =====================================================================
console.log(`\n${'='.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed out of ${passed + failed}`);
console.log(`${'='.repeat(60)}`);
