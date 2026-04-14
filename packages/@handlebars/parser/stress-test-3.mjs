/**
 * Stress test round 3:
 * 1. Parse ALL .hbs/.gts/.gjs across every project in ~/real-world-project
 * 2. Adversarial fuzzing — generated templates with random combinations
 * 3. Pathological patterns designed to break recursive descent parsers
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import jisonParser from './lib/parser.js';
import * as Helpers from './lib/helpers.js';
import { v2ParseWithoutProcessing } from './lib/v2-parser.js';

let b = {};
for (let h in Helpers) { if (Object.prototype.hasOwnProperty.call(Helpers, h)) b[h] = Helpers[h]; }
function jison(input) {
  jisonParser.yy = b;
  jisonParser.yy.locInfo = l => new Helpers.SourceLocation(undefined, l);
  jisonParser.yy.syntax = { square: 'string', hash: (h,l) => ({type:'HashLiteral',pairs:h.pairs,loc:l}) };
  return jisonParser.parse(input);
}

let passed = 0, failed = 0, total = 0;
const failures = [];

function compare(tpl, label) {
  total++;
  let j, v, jErr, vErr;
  try { j = jison(tpl); } catch(e) { jErr = e; }
  try { v = v2ParseWithoutProcessing(tpl); } catch(e) { vErr = e; }
  if (jErr && vErr) { passed++; return; }
  if (!!jErr !== !!vErr) {
    failed++;
    if (failures.length < 30) failures.push({ label, issue: 'error mismatch', jison: jErr ? 'ERR' : 'OK', v2: vErr ? 'ERR: ' + vErr.message?.substring(0,60) : 'OK' });
    return;
  }
  const jj = JSON.stringify(j), vj = JSON.stringify(v);
  if (jj === vj) { passed++; return; }
  failed++;
  // Find diff point
  let i = 0;
  while (i < jj.length && i < vj.length && jj[i] === vj[i]) i++;
  const strip = (k,v) => k === 'loc' || k === 'source' ? undefined : v;
  const locOnly = JSON.stringify(j, strip) === JSON.stringify(v, strip);
  if (failures.length < 30) failures.push({
    label,
    issue: locOnly ? 'LOC diff' : 'STRUCTURAL diff',
    jison: jj.substring(Math.max(0,i-25), i+25),
    v2: vj.substring(Math.max(0,i-25), i+25),
  });
}

// =====================================================================
// PART 1: All templates in ~/real-world-project
// =====================================================================
console.log('=== PART 1: All templates in ~/real-world-project ===\n');

const allFiles = execSync(
  'find /Users/johanrd/real-world-project -name "*.hbs" -o -name "*.gts" -o -name "*.gjs" 2>/dev/null | grep -v node_modules | grep -v dist | grep -v tmp | grep -v .claude',
  { encoding: 'utf8' }
).trim().split('\n').filter(Boolean);

console.log(`Found ${allFiles.length} files`);

let templateCount = 0;
for (const f of allFiles) {
  try {
    const content = readFileSync(f, 'utf8');
    const ext = f.split('.').pop();
    if (ext === 'hbs') {
      templateCount++;
      compare(content, f.replace(/.*\/real-world-project\//, ''));
    } else {
      // .gts/.gjs — extract <template>...</template>
      const regex = /<template>([\s\S]*?)<\/template>/g;
      let m;
      while ((m = regex.exec(content)) !== null) {
        templateCount++;
        compare(m[1], f.replace(/.*\/real-world-project\//, '') + ':template');
      }
    }
  } catch {}
}
console.log(`Parsed ${templateCount} templates: ${passed} identical, ${failed} different\n`);

// =====================================================================
// PART 2: Adversarial fuzzing — generated templates
// =====================================================================
console.log('=== PART 2: Adversarial fuzzing ===\n');

const fuzzStart = total;

// Atoms for building random templates
const ids = ['foo', 'bar', 'baz', 'x', 'y', 'this', 'this.foo', '@foo', '@bar', '../foo', 'true', 'false', 'null', 'undefined'];
const vals = [...ids, '123', '-1', '0.5', '"hello"', "'world'", '(foo bar)', '(foo bar=baz)'];
const strips = ['', '~'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function maybe(fn, prob = 0.5) { return Math.random() < prob ? fn() : ''; }

function randomHash(maxPairs = 3) {
  const n = Math.floor(Math.random() * maxPairs) + 1;
  return Array.from({ length: n }, () => `${pick(ids.slice(0,5))}=${pick(vals)}`).join(' ');
}

function randomMustache() {
  const ls = pick(strips), rs = pick(strips);
  const kind = Math.random();
  if (kind < 0.6) {
    // Regular mustache
    const path = pick(ids);
    const params = maybe(() => ' ' + Array.from({length: Math.floor(Math.random()*3)+1}, () => pick(vals)).join(' '), 0.4);
    const hash = maybe(() => ' ' + randomHash(), 0.3);
    return `{{${ls}${path}${params}${hash}${rs}}}`;
  } else if (kind < 0.8) {
    // Comment
    return maybe(() => `{{${ls}!-- comment --${rs}}}`, 0.5) || `{{${ls}! short ${rs}}}`;
  } else {
    // Triple stache
    return `{{{${pick(ids.slice(0,5))}${maybe(() => ' ' + pick(vals), 0.3)}}}}`;
  }
}

function randomBlock(depth = 0) {
  const name = pick(ids.slice(0, 5));
  const ls = pick(strips), rs = pick(strips);
  const params = maybe(() => ' ' + pick(vals), 0.3);
  const hash = maybe(() => ' ' + randomHash(2), 0.2);
  const bp = maybe(() => ` as |${pick(ids.slice(0,3))}|`, 0.2);
  let body = maybe(() => randomContent(depth + 1), 0.7);
  let inv = '';
  if (Math.random() < 0.3 && depth < 2) {
    inv = `{{${pick(strips)}else${pick(strips)}}}` + maybe(() => randomContent(depth + 1), 0.5);
  }
  return `{{${ls}#${name}${params}${hash}${bp}${rs}}}${body}${inv}{{${pick(strips)}/${name}${pick(strips)}}}`;
}

function randomContent(depth = 0) {
  const n = Math.floor(Math.random() * 4) + 1;
  let result = '';
  for (let i = 0; i < n; i++) {
    const kind = Math.random();
    if (kind < 0.3) result += 'text content ';
    else if (kind < 0.7) result += randomMustache();
    else if (depth < 3) result += randomBlock(depth);
    else result += randomMustache();
  }
  return result;
}

// Generate and test random templates
const FUZZ_COUNT = 500;
let fuzzErrors = 0;
for (let i = 0; i < FUZZ_COUNT; i++) {
  const tpl = randomContent();
  try {
    compare(tpl, `fuzz#${i}`);
  } catch(e) {
    // If compare itself crashes (shouldn't happen), count it
    fuzzErrors++;
    if (fuzzErrors <= 5) console.log(`CRASH fuzz#${i}: ${e.message?.substring(0,60)}`);
  }
}
console.log(`Fuzzed ${FUZZ_COUNT} random templates: ${total - fuzzStart - fuzzErrors} compared, ${fuzzErrors} crashed\n`);

// =====================================================================
// PART 3: Pathological patterns
// =====================================================================
console.log('=== PART 3: Pathological patterns ===\n');

const pathoStart = total;

// Deeply nested else-if chains
let elseChain = '{{#if a}}0';
for (let i = 1; i <= 20; i++) elseChain += `{{else if a${i}}}${i}`;
elseChain += '{{else}}final{{/if}}';
compare(elseChain, 'patho: 20 else-if chains');

// Very long content lines (column tracking stress)
compare('x'.repeat(50000) + '{{foo}}', 'patho: 50K char content line');
compare('{{foo ' + '"hello" '.repeat(200) + '}}', 'patho: 200 string params');

// Many adjacent comments
compare(Array.from({length: 100}, (_, i) => `{{! comment ${i} }}`).join(''), 'patho: 100 adjacent comments');

// Many adjacent blocks
compare(Array.from({length: 50}, (_, i) => `{{#x${i}}}y{{/x${i}}}`).join(''), 'patho: 50 adjacent blocks');

// Block with many block params
compare('{{#foo as |a b c d e f g h i j|}}{{a}}{{b}}{{c}}{{/foo}}', 'patho: 10 block params');

// Nested partials
compare('{{#> a}}{{#> b}}{{#> c}}x{{/c}}{{/b}}{{/a}}', 'patho: nested partial blocks');

// Mixed features in one expression
compare('{{helper (sub1 (sub2 arg1 key1=(sub3 arg2)) arg3) key2=(sub4 (sub5 arg4 key3=val3) arg5) key4="../path"}}', 'patho: deeply nested mixed features');

// Sub-expression as path then more sub-expressions
compare('{{(helper arg).prop.deep (other).thing key=(yet-another val).result}}', 'patho: sub-expr paths everywhere');

// String with many escaped quotes
compare('{{foo "say \\"hello\\" and \\"goodbye\\" and \\"maybe\\""}}', 'patho: many escaped quotes in string');

// Escaped brackets in paths
compare('{{[foo bar].[baz qux].[hello world]}}', 'patho: escaped path segments');
compare('{{foo.[contains \\] bracket]}}', 'patho: escaped bracket in path segment');

// Numbers in all positions
compare('{{foo 0 1 -1 0.5 -0.5 999 bar=0 baz=-1 qux=0.5}}', 'patho: numbers everywhere');

// this in various positions
compare('{{this}}', 'patho: bare this');
compare('{{this.foo.bar.baz}}', 'patho: this deep');
compare('{{foo this.bar}}', 'patho: this as param');
compare('{{foo bar=this.baz}}', 'patho: this as hash val');

// Data in various positions
compare('{{@foo @bar key=@baz}}', 'patho: data everywhere');
compare('{{@foo.bar.baz}}', 'patho: data deep');

// Empty-ish templates
compare('\n\n\n', 'patho: just newlines');
compare('   \t\t\t   ', 'patho: just whitespace');
compare('\r\n\r\n\r\n', 'patho: just CRLF');

// Multiple escaped mustaches in sequence
compare('\\{{a}} \\{{b}} \\{{c}}', 'patho: 3 escaped with spaces');
compare('\\{{}}\\{{}}\\{{}}', 'patho: 3 escaped empty');

// Content with every brace pattern
compare('} }} }}} }}}} { {{ {{{ {{{{', 'patho: all brace patterns as content');
compare('{{foo}} } {{ {{bar}} }} {{{ {{{baz}}}', 'patho: mixed braces and mustaches');

// Multi-line with various indentation
compare(`
  {{#if a}}
    {{#if b}}
      {{#each c as |d|}}
        {{#let (hash e=f) as |g|}}
          <div class="{{g.e}} {{if d.h "i"}}">
            {{d.j}}
            {{! nested comment }}
          </div>
        {{/let}}
      {{/each}}
    {{else}}
      {{#if k}}
        {{l}}
      {{/if}}
    {{/if}}
  {{else if m}}
    {{n}}
  {{else}}
    {{o}}
  {{/if}}
`.trim(), 'patho: deeply nested multi-line with everything');

console.log(`Pathological: ${total - pathoStart} tests\n`);

// =====================================================================
// RESULTS
// =====================================================================
console.log('='.repeat(60));
console.log(`TOTAL: ${passed} passed, ${failed} failed out of ${total}`);
console.log('='.repeat(60));

if (failures.length > 0) {
  console.log('\n--- Failures ---');
  for (const f of failures) {
    console.log(`\n${f.issue}: ${f.label?.substring(0, 80)}`);
    if (f.jison && f.v2) {
      if (f.issue === 'error mismatch') {
        console.log(`  Jison: ${f.jison}, v2: ${f.v2}`);
      } else {
        console.log(`  Jison: ...${f.jison}...`);
        console.log(`  v2:    ...${f.v2}...`);
      }
    }
  }
  if (failures.length >= 30) console.log('\n(showing first 30 failures)');
}
