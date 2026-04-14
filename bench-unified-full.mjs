/**
 * Unified-scanner benchmark: parse-only and full-pipeline comparison.
 *
 * Measures:
 *   1. parse-only: preprocess() vs unifiedPreprocess()
 *   2. full pipeline: precompile() approximation for the unified scanner
 *      (compile_only = precompile - preprocess; unified_full = unified_parse + compile_only)
 *
 * Run: node bench-unified-full.mjs
 */

const SYNTAX_PATH    = './packages/@glimmer/syntax/dist/es/index.js';
const COMPILER_PATH  = `${new URL('.', import.meta.url).pathname}dist/packages/ember-template-compiler/index.js`;

const { preprocess, unifiedPreprocess } = await import(SYNTAX_PATH);
const { precompile }                    = await import(COMPILER_PATH);

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
  ['small',       small,     5000],
  ['medium',      medium,    2000],
  ['real-world',  realWorld, 1000],
  ['large (10x)', large,      300],
];

function bench(fn, tpl, N) {
  for (let i = 0; i < Math.min(100, N); i++) fn(tpl);
  const t = performance.now();
  for (let i = 0; i < N; i++) fn(tpl);
  return (performance.now() - t) / N;
}

// ── 1. Parse-only ──────────────────────────────────────────────────────────────
console.log('━'.repeat(80));
console.log('PARSE ONLY  (preprocess / unifiedPreprocess, ms/call, warmed JIT)');
console.log('━'.repeat(80));
console.log('template'.padEnd(14) + 'chars'.padStart(7) +
            '  v2-parser'.padStart(12) + '  unified-1pass'.padStart(16) + '  speedup'.padStart(10));
console.log('─'.repeat(63));

const parseResults = {};
for (const [name, tpl, N] of templates) {
  const v2Ms   = bench(preprocess,       tpl, N);
  const uniMs  = bench(unifiedPreprocess, tpl, N);
  parseResults[name] = { v2Ms, uniMs, chars: tpl.length };
  const speedup = v2Ms / uniMs;
  console.log(
    name.padEnd(14) +
    String(tpl.length).padStart(7) + '  ' +
    v2Ms.toFixed(4).padStart(10) + 'ms' +
    uniMs.toFixed(4).padStart(13) + 'ms' +
    (speedup > 1
      ? `  ${speedup.toFixed(2)}x faster`
      : `  ${(1/speedup).toFixed(2)}x slower`).padStart(14)
  );
}

// ── 2. Full pipeline ───────────────────────────────────────────────────────────
// Approach: measure precompile() (v2-parser baseline) and preprocess() separately.
// compile_only = precompile - preprocess
// unified_full = unified_preprocess + compile_only
console.log('\n' + '━'.repeat(80));
console.log('FULL PIPELINE  (ms/call)');
console.log('  v2-parser column = precompile() from this build');
console.log('  unified column   = unified_preprocess + (precompile - preprocess)');
console.log('━'.repeat(80));
console.log('template'.padEnd(14) + 'chars'.padStart(7) +
            '  v2-parser'.padStart(12) + '  unified-1pass'.padStart(16) + '  speedup'.padStart(10));
console.log('─'.repeat(63));

for (const [name, tpl, N] of templates) {
  const { v2Ms, uniMs } = parseResults[name];
  const fullV2Ms  = bench(precompile, tpl, N);
  const compileMs = fullV2Ms - v2Ms;            // compile-only overhead (shared code)
  const fullUniMs = uniMs + compileMs;          // projected unified full pipeline
  const speedup   = fullV2Ms / fullUniMs;
  console.log(
    name.padEnd(14) +
    String(tpl.length).padStart(7) + '  ' +
    fullV2Ms.toFixed(4).padStart(10) + 'ms' +
    fullUniMs.toFixed(4).padStart(13) + 'ms' +
    (speedup > 1
      ? `  ${speedup.toFixed(2)}x faster`
      : `  ${(1/speedup).toFixed(2)}x slower`).padStart(14)
  );
}

// ── 3. Parse vs compile split ──────────────────────────────────────────────────
console.log('\n' + '━'.repeat(80));
console.log('PARSE vs COMPILE SPLIT  (medium template)');
console.log('━'.repeat(80));

const N_SPLIT = 3000;
const v2ParseMs    = bench(preprocess,        medium, N_SPLIT);
const uniParseMs   = bench(unifiedPreprocess,  medium, N_SPLIT);
const v2FullMs     = bench(precompile,         medium, N_SPLIT);
const compileOnlyMs = v2FullMs - v2ParseMs;
const uniFullMs    = uniParseMs + compileOnlyMs;

function pct(part, total) { return ((part / total) * 100).toFixed(0) + '%'; }

console.log('\n' + '                       v2-parser         unified-1pass');
console.log('─'.repeat(55));
console.log(
  'preprocess() only    ' +
  `${v2ParseMs.toFixed(3)}ms (${pct(v2ParseMs, v2FullMs)})`.padEnd(20) +
  `${uniParseMs.toFixed(3)}ms (${pct(uniParseMs, uniFullMs)})`
);
console.log(
  'compile only (same)  ' +
  `${compileOnlyMs.toFixed(3)}ms (${pct(compileOnlyMs, v2FullMs)})`.padEnd(20) +
  `${compileOnlyMs.toFixed(3)}ms (${pct(compileOnlyMs, uniFullMs)})`
);
console.log(
  'total                ' +
  `${v2FullMs.toFixed(3)}ms`.padEnd(20) +
  `${uniFullMs.toFixed(3)}ms`
);
