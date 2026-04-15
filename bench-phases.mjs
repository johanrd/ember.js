/**
 * Phase-by-phase compile benchmark.
 *
 * Splits the ~87% "compile" step (everything after parse) into:
 *   parse      — unifiedPreprocess (source → ASTv1)
 *   normalize  — normalizeAST (ASTv1 → ASTv2)
 *   pass0      — ASTv2 → HIR (keyword translation, element classification, scope)
 *   pass2      — HIR → wire format
 *   stringify  — JSON.stringify(wire)
 *
 * Run: node bench-phases.mjs
 */

const HERE_COMPILER = `${new URL('.', import.meta.url).pathname}dist/dev/packages/ember-template-compiler/index.js`;
const { _precompileJSONWithPhaseTiming: timedCompile } = await import(HERE_COMPILER);

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
  ['medium', medium, 800],
  ['real-world', realWorld, 400],
  ['large (10x)', large, 120],
];

// ── Benchmark ──────────────────────────────────────────────────────────────────

function benchPhases(tpl, N) {
  // Warm JIT
  for (let i = 0; i < Math.min(50, N); i++) timedCompile(tpl);

  const sum = { parse: 0, normalize: 0, pass0: 0, pass2: 0, stringify: 0, total: 0 };
  for (let i = 0; i < N; i++) {
    const { timings } = timedCompile(tpl);
    sum.parse += timings.parse;
    sum.normalize += timings.normalize;
    sum.pass0 += timings.pass0;
    sum.pass2 += timings.pass2;
    sum.stringify += timings.stringify;
    sum.total += timings.total;
  }
  for (const k of Object.keys(sum)) sum[k] /= N;
  return sum;
}

function pct(part, total) {
  return ((part / total) * 100).toFixed(0).padStart(3) + '%';
}

function fmt(ms) {
  return ms.toFixed(4).padStart(9) + 'ms';
}

// ── Report ─────────────────────────────────────────────────────────────────────

console.log('━'.repeat(95));
console.log('PHASE-BY-PHASE COMPILE BREAKDOWN  (ms/call, warmed JIT)');
console.log('━'.repeat(95));

console.log(
  '\n' +
    'template'.padEnd(14) +
    'total'.padStart(11) +
    'parse'.padStart(15) +
    'normalize'.padStart(15) +
    'pass0'.padStart(15) +
    'pass2'.padStart(14) +
    'stringify'.padStart(14)
);
console.log('─'.repeat(95));

for (const [name, tpl, N] of templates) {
  const r = benchPhases(tpl, N);
  console.log(
    name.padEnd(14) +
      fmt(r.total) +
      fmt(r.parse) +
      ` (${pct(r.parse, r.total)})`.padStart(6) +
      fmt(r.normalize) +
      ` (${pct(r.normalize, r.total)})`.padStart(6) +
      fmt(r.pass0) +
      ` (${pct(r.pass0, r.total)})`.padStart(6) +
      fmt(r.pass2) +
      ` (${pct(r.pass2, r.total)})`.padStart(6) +
      fmt(r.stringify) +
      ` (${pct(r.stringify, r.total)})`.padStart(6)
  );
}

console.log('\nNote: "total" here is summed from individual phase timings. Includes');
console.log('      per-call timing overhead which inflates numbers slightly vs bench.mjs.');
