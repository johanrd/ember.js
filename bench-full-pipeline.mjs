/**
 * Full compile pipeline benchmark: preprocess() → normalize() → compile() → wire format
 *
 * Uses ember-template-compiler's precompile() which exercises the entire stack.
 * Three-way comparison: main (Jison), v2-parser (this branch), rust/wasm (PR #21313).
 *
 * Run: node bench-full-pipeline.mjs
 */

const MAIN = '/tmp/ember-main/dist/packages/ember-template-compiler/index.js';
const V2 = '/Users/real-world-project/ember.js/dist/packages/ember-template-compiler/index.js';
const RUST = '/tmp/pr-21313/dist/dev/packages/ember-template-compiler/index.js';

// Also import the syntax-only preprocess for the parse-only split
const MAIN_SYNTAX = '/tmp/ember-main/packages/@glimmer/syntax/dist/es/index.js';
const V2_SYNTAX = '/Users/real-world-project/ember.js/packages/@glimmer/syntax/dist/es/index.js';
const RUST_SYNTAX = '/tmp/pr-21313/packages/@glimmer/syntax/dist/es/index.js';

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

const large = medium.repeat(10);

const templates = [
  ['small', small, 2000],
  ['medium', medium, 1000],
  ['real-world', realWorld, 1000],
  ['large (10x)', large, 300],
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function bench(fn, tpl, N) {
  for (let i = 0; i < Math.min(50, N); i++) fn(tpl);
  const t = performance.now();
  for (let i = 0; i < N; i++) fn(tpl);
  return (performance.now() - t) / N;
}

function pct(part, total) {
  return ((part / total) * 100).toFixed(0) + '%';
}

// ── Load all parsers ───────────────────────────────────────────────────────────

console.log('Loading compilers...');
const [
  { precompile: compileMain },
  { precompile: compileV2 },
  { precompile: compileRust },
  { preprocess: parseMain },
  { preprocess: parseV2 },
  { preprocess: parseRust },
] = await Promise.all([
  import(MAIN),
  import(V2),
  import(RUST),
  import(MAIN_SYNTAX),
  import(V2_SYNTAX),
  import(RUST_SYNTAX),
]);
console.log('Loaded.\n');

// ── Section 1: full precompile() ───────────────────────────────────────────────

console.log('━'.repeat(90));
console.log('FULL PIPELINE: precompile() → wire format  (ms/call, warmed JIT)');
console.log('━'.repeat(90));
console.log(
  'template         chars    main(Jison)    v2-parser    rust/wasm    v2vsJison  v2vsRust'
);
console.log('─'.repeat(90));

const fullResults = {};
for (const [name, tpl, N] of templates) {
  const m = bench(compileMain, tpl, N);
  const v = bench(compileV2, tpl, N);
  const r = bench(compileRust, tpl, N);
  fullResults[name] = { m, v, r, chars: tpl.length };
  console.log(
    name.padEnd(16) +
      String(tpl.length).padStart(6) +
      '    ' +
      m.toFixed(3).padStart(11) +
      '  ' +
      v.toFixed(3).padStart(11) +
      '  ' +
      r.toFixed(3).padStart(10) +
      '     ' +
      (m / v).toFixed(2).padStart(7) +
      'x  ' +
      (r / v).toFixed(2).padStart(7) +
      'x'
  );
}

// ── Section 2: parse-only vs full compile split ────────────────────────────────

console.log('\n' + '━'.repeat(90));
console.log('PARSE vs COMPILE SPLIT  (medium template, showing where time goes)');
console.log('━'.repeat(90));

const N_SPLIT = 2000;
const parseOnlyMain = bench(parseMain, medium, N_SPLIT);
const parseOnlyV2 = bench(parseV2, medium, N_SPLIT);
const parseOnlyRust = bench(parseRust, medium, N_SPLIT);
const fullMain = bench(compileMain, medium, N_SPLIT);
const fullV2 = bench(compileV2, medium, N_SPLIT);
const fullRust = bench(compileRust, medium, N_SPLIT);

const compileOnlyMain = fullMain - parseOnlyMain;
const compileOnlyV2 = fullV2 - parseOnlyV2;
const compileOnlyRust = fullRust - parseOnlyRust;

console.log('\n               main(Jison)          v2-parser          rust/wasm');
console.log('─'.repeat(70));
console.log(
  'parse()      ' +
    `${parseOnlyMain.toFixed(3)}ms (${pct(parseOnlyMain, fullMain)})`.padEnd(20) +
    `${parseOnlyV2.toFixed(3)}ms (${pct(parseOnlyV2, fullV2)})`.padEnd(20) +
    `${parseOnlyRust.toFixed(3)}ms (${pct(parseOnlyRust, fullRust)})`
);
console.log(
  'compile only ' +
    `${compileOnlyMain.toFixed(3)}ms (${pct(compileOnlyMain, fullMain)})`.padEnd(20) +
    `${compileOnlyV2.toFixed(3)}ms (${pct(compileOnlyV2, fullV2)})`.padEnd(20) +
    `${compileOnlyRust.toFixed(3)}ms (${pct(compileOnlyRust, fullRust)})`
);
console.log(
  'total        ' +
    `${fullMain.toFixed(3)}ms`.padEnd(20) +
    `${fullV2.toFixed(3)}ms`.padEnd(20) +
    `${fullRust.toFixed(3)}ms`
);

// ── Section 3: 500-template project projection ─────────────────────────────────

console.log('\n' + '━'.repeat(90));
console.log('500-TEMPLATE PROJECT  (build-time projection, using real-world template timing)');
console.log('━'.repeat(90));

const { m: rwm, v: rwv, r: rwr } = fullResults['real-world'];
const scale = 500;
console.log(
  `\n  main(Jison):  ${(rwm * scale).toFixed(0)}ms total  (${rwm.toFixed(3)}ms × ${scale})`
);
console.log(
  `  v2-parser:    ${(rwv * scale).toFixed(0)}ms total  (${rwv.toFixed(3)}ms × ${scale})  — ${(rwm / rwv).toFixed(2)}x faster than Jison`
);
console.log(
  `  rust/wasm:    ${(rwr * scale).toFixed(0)}ms total  (${rwr.toFixed(3)}ms × ${scale})  — ${(rwr / rwv).toFixed(2)}x slower than v2`
);
