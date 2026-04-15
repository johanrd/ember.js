/**
 * Isolates the cost of simple-html-tokenizer's char-by-char processing
 * within the current preprocess() pipeline.
 *
 * Three questions:
 *   1. How many appendTo* callback invocations happen per parse?
 *   2. How much time is spent purely inside tokenizePart() calls?
 *   3. How much does the char-by-char string-building overhead cost vs batching?
 *
 * Run: node bench-html-isolation.mjs
 */

import {
  EventedTokenizer,
  EntityParser,
  HTML5NamedCharRefs,
} from './node_modules/simple-html-tokenizer/dist/es6/index.js';

// ── Templates ──────────────────────────────────────────────────────────────────

const small = `<div>{{this.title}}</div>`;

const medium = `
<div class="container">
  <h1>{{this.title}}</h1>
  {{#each this.items as |item index|}}
    <div class="item {{if item.active "active"}}">
      <span>{{item.name}}</span>
      <button {{on "click" (fn this.handleClick item)}}>Delete</button>
    </div>
  {{/each}}
  {{#if this.showFooter}}
    <footer>{{this.footerText}}</footer>
  {{/if}}
</div>`;

const realWorld = `
<div class="user-profile {{if this.isPremium "premium"}}">
  <header class="profile-header">
    <img src={{this.avatarUrl}} alt={{this.username}} class="avatar" />
    <h2>{{this.displayName}}</h2>
    <p class="bio">{{this.bio}}</p>
    {{#if this.isOwnProfile}}
      <button {{on "click" this.editProfile}}>Edit Profile</button>
    {{/if}}
  </header>
  <nav class="profile-tabs">
    {{#each this.tabs as |tab|}}
      <button class="tab {{if (eq tab.id this.activeTab) "active"}}" {{on "click" (fn this.setTab tab.id)}}>
        {{tab.label}}{{#if tab.count}}<span class="count">{{tab.count}}</span>{{/if}}
      </button>
    {{/each}}
  </nav>
  <section class="profile-content">
    {{#if (eq this.activeTab "posts")}}
      {{#each this.posts as |post|}}
        <article class="post-card">
          <h3>{{post.title}}</h3><p>{{post.excerpt}}</p>
          <footer><time>{{post.createdAt}}</time><span>{{post.views}} views</span></footer>
        </article>
      {{else}}
        <p class="empty-state">No posts yet.</p>
      {{/each}}
    {{else if (eq this.activeTab "followers")}}
      {{#each this.followers as |follower|}}
        <div class="follower-card">
          <img src={{follower.avatar}} alt={{follower.name}} />
          <span>{{follower.name}}</span>
          <button {{on "click" (fn this.followUser follower.id)}}>
            {{if follower.isFollowing "Unfollow" "Follow"}}
          </button>
        </div>
      {{/each}}
    {{/if}}
  </section>
</div>`;

const templates = [
  ['small', small],
  ['medium', medium],
  ['real-world', realWorld],
];

// ── Question 1: count appendTo* invocations ────────────────────────────────────

console.log('━'.repeat(70));
console.log('Q1: How many char-by-char callbacks fire per parse?');
console.log('━'.repeat(70));
console.log('(simulating the HTML content segments that tokenizePart() processes)\n');

// Simulate the content segments that HandlebarsNodeVisitors feeds to tokenizePart.
// The Jison/v2 parser splits the template at {{ boundaries; the HTML parts
// between mustaches are the ContentStatements fed to tokenizePart.
function extractContentSegments(tpl) {
  const segments = [];
  let pos = 0;
  while (pos < tpl.length) {
    const next = tpl.indexOf('{{', pos);
    if (next === -1) {
      if (pos < tpl.length) segments.push(tpl.slice(pos));
      break;
    }
    if (next > pos) segments.push(tpl.slice(pos, next));
    // skip to closing }}
    const close = tpl.indexOf('}}', next + 2);
    pos = close === -1 ? tpl.length : close + 2;
  }
  return segments.filter((s) => s.length > 0);
}

for (const [name, tpl] of templates) {
  const segments = extractContentSegments(tpl);
  const htmlChars = segments.reduce((s, seg) => s + seg.length, 0);

  // Count appendTo* calls by running the tokenizer with a counting delegate
  let counts = {
    appendToData: 0,
    appendToTagName: 0,
    appendToAttributeName: 0,
    appendToAttributeValue: 0,
    other: 0,
  };
  const countingDelegate = {
    reset() {},
    beginData() {},
    appendToData(c) {
      counts.appendToData++;
    },
    finishData() {},
    beginStartTag() {},
    appendToTagName(c) {
      counts.appendToTagName++;
    },
    beginAttribute() {},
    appendToAttributeName(c) {
      counts.appendToAttributeName++;
    },
    finishAttributeName() {},
    beginAttributeValue(q) {},
    appendToAttributeValue(c) {
      counts.appendToAttributeValue++;
    },
    finishAttributeValue() {},
    finishTag() {},
    beginEndTag() {},
    markTagAsSelfClosing() {},
    beginComment() {},
    appendToCommentData(c) {},
    finishComment() {},
    reportSyntaxError() {},
    tagOpen() {},
    consumeCharRef() {},
  };

  const tok = new EventedTokenizer(countingDelegate, new EntityParser(HTML5NamedCharRefs));
  for (const seg of segments) {
    tok.tokenizePart(seg);
    tok.flushData();
  }

  const totalAppendTo =
    counts.appendToData +
    counts.appendToTagName +
    counts.appendToAttributeName +
    counts.appendToAttributeValue;

  console.log(
    `${name} (${tpl.length} chars total, ${htmlChars} HTML chars in ${segments.length} segments):`
  );
  console.log(`  appendToData:           ${counts.appendToData} calls`);
  console.log(`  appendToTagName:        ${counts.appendToTagName} calls`);
  console.log(`  appendToAttributeName:  ${counts.appendToAttributeName} calls`);
  console.log(`  appendToAttributeValue: ${counts.appendToAttributeValue} calls`);
  console.log(
    `  total appendTo* calls:  ${totalAppendTo}  (${((totalAppendTo / htmlChars) * 100).toFixed(0)}% of HTML chars)`
  );
  console.log();
}

// ── Question 2: how much time does tokenizePart() actually take? ───────────────

console.log('━'.repeat(70));
console.log('Q2: Time spent inside tokenizePart() per parse (HTML layer only)');
console.log('━'.repeat(70) + '\n');

const N = 5000;

function benchTokenizerOnly(tpl) {
  const segments = extractContentSegments(tpl);
  // no-op delegate — measures tokenizer machinery + dispatch, not AST building
  const noop = {
    reset() {},
    beginData() {},
    appendToData() {},
    finishData() {},
    beginStartTag() {},
    appendToTagName() {},
    beginAttribute() {},
    appendToAttributeName() {},
    finishAttributeName() {},
    beginAttributeValue() {},
    appendToAttributeValue() {},
    finishAttributeValue() {},
    finishTag() {},
    beginEndTag() {},
    markTagAsSelfClosing() {},
    beginComment() {},
    appendToCommentData() {},
    finishComment() {},
    reportSyntaxError() {},
    tagOpen() {},
    consumeCharRef() {},
  };
  const tok = new EventedTokenizer(noop, new EntityParser(HTML5NamedCharRefs));

  // warm up
  for (let i = 0; i < 100; i++) {
    for (const seg of segments) {
      tok.tokenizePart(seg);
      tok.flushData();
    }
    tok.reset();
  }

  const t = performance.now();
  for (let i = 0; i < N; i++) {
    for (const seg of segments) {
      tok.tokenizePart(seg);
      tok.flushData();
    }
    tok.reset();
  }
  return (performance.now() - t) / N;
}

function benchTokenizerWithStringBuild(tpl) {
  const segments = extractContentSegments(tpl);
  // accumulating delegate — measures tokenizer + string concatenation
  let buf = '';
  const accum = {
    reset() {},
    beginData() {
      buf = '';
    },
    appendToData(c) {
      buf += c;
    },
    finishData() {
      const _ = buf;
    },
    beginStartTag() {
      buf = '';
    },
    appendToTagName(c) {
      buf += c;
    },
    beginAttribute() {
      buf = '';
    },
    appendToAttributeName(c) {
      buf += c;
    },
    finishAttributeName() {},
    beginAttributeValue() {
      buf = '';
    },
    appendToAttributeValue(c) {
      buf += c;
    },
    finishAttributeValue() {
      const _ = buf;
    },
    finishTag() {},
    beginEndTag() {
      buf = '';
    },
    markTagAsSelfClosing() {},
    beginComment() {
      buf = '';
    },
    appendToCommentData(c) {
      buf += c;
    },
    finishComment() {},
    reportSyntaxError() {},
    tagOpen() {},
    consumeCharRef() {},
  };
  const tok = new EventedTokenizer(accum, new EntityParser(HTML5NamedCharRefs));

  for (let i = 0; i < 100; i++) {
    for (const seg of segments) {
      tok.tokenizePart(seg);
      tok.flushData();
    }
    tok.reset();
  }

  const t = performance.now();
  for (let i = 0; i < N; i++) {
    for (const seg of segments) {
      tok.tokenizePart(seg);
      tok.flushData();
    }
    tok.reset();
  }
  return (performance.now() - t) / N;
}

for (const [name, tpl] of templates) {
  const machinery = benchTokenizerOnly(tpl);
  const withConcat = benchTokenizerWithStringBuild(tpl);
  const concatCost = withConcat - machinery;
  console.log(`${name}:`);
  console.log(`  tokenizer machinery (noop delegate):  ${machinery.toFixed(4)}ms`);
  console.log(`  tokenizer + string concat (accum):    ${withConcat.toFixed(4)}ms`);
  console.log(
    `  string concat overhead:               ${concatCost.toFixed(4)}ms  (${((concatCost / withConcat) * 100).toFixed(0)}% of HTML layer)`
  );
  console.log();
}

// ── Question 3: micro-benchmark — char-by-char vs indexOf+slice ───────────────

console.log('━'.repeat(70));
console.log('Q3: Micro-benchmark — char-by-char concat vs indexOf+slice');
console.log('━'.repeat(70) + '\n');

// representative HTML-heavy segment
const htmlSeg = `  <div class="container">
    <h1 class="title large">Hello World</h1>
    <p class="description">This is some text content here.</p>
    <footer class="footer-area">Some footer text</footer>
  </div>`;

const M = 50000;

// char-by-char
let result1 = '';
const t1 = performance.now();
for (let r = 0; r < M; r++) {
  let s = '';
  for (let i = 0; i < htmlSeg.length; i++) s += htmlSeg[i];
  result1 = s;
}
const charByChar = (performance.now() - t1) / M;

// indexOf + slice
let result2 = '';
const t2 = performance.now();
for (let r = 0; r < M; r++) {
  result2 = htmlSeg.slice(0, htmlSeg.length);
}
const batchSlice = (performance.now() - t2) / M;

console.log(`Segment: ${htmlSeg.length} chars of typical HTML`);
console.log(`  char-by-char (s += char × N):  ${charByChar.toFixed(4)}ms`);
console.log(`  indexOf + slice once:           ${batchSlice.toFixed(4)}ms`);
console.log(`  speedup:                        ${(charByChar / batchSlice).toFixed(1)}x`);
console.log();
console.log('Note: the real tokenizer does more than just concatenate (state dispatch,');
console.log('line tracking, delegate calls) — Q2 measures the actual total.');
