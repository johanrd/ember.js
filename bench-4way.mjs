/**
 * 4-way benchmark: main (Jison) vs v2-parser vs unified-1pass
 *
 * Compares full precompile() pipeline and parse-only timing.
 *   - main (Jison): /tmp/ember-main/ build
 *   - v2-parser: current branch's preprocess()
 *   - unified-1pass: current branch's unifiedPreprocess()
 *
 * Run: node bench-4way.mjs
 */

const MAIN_COMPILER = '/tmp/ember-main/dist/packages/ember-template-compiler/index.js';
const MAIN_SYNTAX   = '/tmp/ember-main/packages/@glimmer/syntax/dist/es/index.js';
const HERE_COMPILER = `${new URL('.', import.meta.url).pathname}dist/packages/ember-template-compiler/index.js`;
const HERE_SYNTAX   = `${new URL('.', import.meta.url).pathname}packages/@glimmer/syntax/dist/es/index.js`;

const { precompile: compileMain }   = await import(MAIN_COMPILER);
const { precompile: compileV2 }     = await import(HERE_COMPILER);
const { preprocess: parseMain }     = await import(MAIN_SYNTAX);
const { preprocess: parseV2, unifiedPreprocess: parseUni } = await import(HERE_SYNTAX);

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

// ── Helpers ────────────────────────────────────────────────────────────────────

function bench(fn, tpl, N) {
  for (let i = 0; i < Math.min(100, N); i++) fn(tpl);
  const t = performance.now();
  for (let i = 0; i < N; i++) fn(tpl);
  return (performance.now() - t) / N;
}

function pct(part, total) {
  return ((part / total) * 100).toFixed(0) + '%';
}

function ratio(a, b) {
  if (a / b >= 1) return `${(a / b).toFixed(2)}x`;
  return `${(b / a).toFixed(2)}x`;
}

// ── Section 1: Parse-only ──────────────────────────────────────────────────────

console.log('━'.repeat(90));
console.log('PARSE ONLY  (preprocess / unifiedPreprocess, ms/call, warmed JIT)');
console.log('━'.repeat(90));
console.log(
  'template'.padEnd(14) + 'chars'.padStart(7) +
  '  main(Jison)'.padStart(14) + '  v2-parser'.padStart(13) + '  unified-1pass'.padStart(17) +
  '  v2vsJison'.padStart(12) + '  uniVsJison'.padStart(13) + '  uniVsV2'.padStart(11)
);
console.log('─'.repeat(90));

const parseResults = {};
for (const [name, tpl, N] of templates) {
  const mMs  = bench(parseMain, tpl, N);
  const v2Ms = bench(parseV2,   tpl, N);
  const uMs  = bench(parseUni,  tpl, N);
  parseResults[name] = { mMs, v2Ms, uMs, chars: tpl.length };
  console.log(
    name.padEnd(14) +
    String(tpl.length).padStart(7) + '  ' +
    mMs.toFixed(4).padStart(12) + 'ms' +
    v2Ms.toFixed(4).padStart(11) + 'ms' +
    uMs.toFixed(4).padStart(13) + 'ms' +
    `  ${ratio(mMs, v2Ms)} ${mMs > v2Ms ? '↑' : '↓'}`.padStart(11) +
    `  ${ratio(mMs, uMs)} ${mMs > uMs ? '↑' : '↓'}`.padStart(13) +
    `  ${ratio(v2Ms, uMs)} ${v2Ms > uMs ? '↑' : '↓'}`.padStart(11)
  );
}

// ── Section 2: Full pipeline ───────────────────────────────────────────────────
// unified_full = unified_parse + (precompile_v2 - preprocess_v2)
// (compile step is identical code across all parsers)

console.log('\n' + '━'.repeat(90));
console.log('FULL PIPELINE  (precompile() → wire format, ms/call)');
console.log('  unified column = unified_parse + (precompile_v2 - preprocess_v2)');
console.log('━'.repeat(90));
console.log(
  'template'.padEnd(14) + 'chars'.padStart(7) +
  '  main(Jison)'.padStart(14) + '  v2-parser'.padStart(13) + '  unified-1pass'.padStart(17) +
  '  v2vsJison'.padStart(12) + '  uniVsJison'.padStart(13) + '  uniVsV2'.padStart(11)
);
console.log('─'.repeat(90));

const fullResults = {};
for (const [name, tpl, N] of templates) {
  const { mMs, v2Ms, uMs } = parseResults[name];
  const fullMMs  = bench(compileMain, tpl, N);
  const fullV2Ms = bench(compileV2,   tpl, N);
  const compileMs = fullV2Ms - v2Ms;      // compile-only cost (identical across parsers)
  const fullUMs  = uMs + compileMs;       // projected unified full pipeline
  fullResults[name] = { fullMMs, fullV2Ms, fullUMs };
  console.log(
    name.padEnd(14) +
    String(tpl.length).padStart(7) + '  ' +
    fullMMs.toFixed(4).padStart(12) + 'ms' +
    fullV2Ms.toFixed(4).padStart(11) + 'ms' +
    fullUMs.toFixed(4).padStart(13) + 'ms' +
    `  ${ratio(fullMMs, fullV2Ms)} ${fullMMs > fullV2Ms ? '↑' : '↓'}`.padStart(11) +
    `  ${ratio(fullMMs, fullUMs)} ${fullMMs > fullUMs ? '↑' : '↓'}`.padStart(13) +
    `  ${ratio(fullV2Ms, fullUMs)} ${fullV2Ms > fullUMs ? '↑' : '↓'}`.padStart(11)
  );
}

// ── Section 3: Parse vs compile split (medium) ────────────────────────────────

console.log('\n' + '━'.repeat(80));
console.log('PARSE vs COMPILE SPLIT  (medium template)');
console.log('━'.repeat(80));

const N_SPLIT = 3000;
const sMainParse  = bench(parseMain,  medium, N_SPLIT);
const sV2Parse    = bench(parseV2,    medium, N_SPLIT);
const sUniParse   = bench(parseUni,   medium, N_SPLIT);
const sMainFull   = bench(compileMain, medium, N_SPLIT);
const sV2Full     = bench(compileV2,  medium, N_SPLIT);
const sCompile    = sV2Full - sV2Parse;   // shared compile step
const sUniFull    = sUniParse + sCompile;

console.log('\n' + '                    main(Jison)           v2-parser            unified-1pass');
console.log('─'.repeat(80));
console.log(
  'preprocess() only   ' +
  `${sMainParse.toFixed(3)}ms (${pct(sMainParse, sMainFull)})`.padEnd(22) +
  `${sV2Parse.toFixed(3)}ms (${pct(sV2Parse, sV2Full)})`.padEnd(22) +
  `${sUniParse.toFixed(3)}ms (${pct(sUniParse, sUniFull)})`
);
console.log(
  'compile only        ' +
  `${(sMainFull - sMainParse).toFixed(3)}ms (${pct(sMainFull - sMainParse, sMainFull)})`.padEnd(22) +
  `${sCompile.toFixed(3)}ms (${pct(sCompile, sV2Full)})`.padEnd(22) +
  `${sCompile.toFixed(3)}ms (${pct(sCompile, sUniFull)})`
);
console.log(
  'total               ' +
  `${sMainFull.toFixed(3)}ms`.padEnd(22) +
  `${sV2Full.toFixed(3)}ms`.padEnd(22) +
  `${sUniFull.toFixed(3)}ms`
);

// ── Section 4: 500-template build projection ──────────────────────────────────

console.log('\n' + '━'.repeat(80));
console.log('500-TEMPLATE PROJECT PROJECTION  (using real-world template timing)');
console.log('━'.repeat(80));

const { fullMMs: rwM, fullV2Ms: rwV2, fullUMs: rwUni } = fullResults['real-world'];
const scale = 500;
console.log(`\n  main (Jison):   ${(rwM * scale).toFixed(0)}ms  (${rwM.toFixed(3)}ms × ${scale})`);
console.log(`  v2-parser:      ${(rwV2 * scale).toFixed(0)}ms  (${rwV2.toFixed(3)}ms × ${scale})  — ${(rwM / rwV2).toFixed(2)}x faster than Jison`);
console.log(`  unified-1pass:  ${(rwUni * scale).toFixed(0)}ms  (${rwUni.toFixed(3)}ms × ${scale})  — ${(rwM / rwUni).toFixed(2)}x faster than Jison, ${(rwV2 / rwUni).toFixed(2)}x faster than v2-parser`);
