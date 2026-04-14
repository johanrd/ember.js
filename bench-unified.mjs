/**
 * Benchmark: preprocess() vs unifiedPreprocess()
 * Also runs a quick correctness diff on the AST shape.
 *
 * Run: node bench-unified.mjs
 */

const SYNTAX_PATH = './packages/@glimmer/syntax/dist/es/index.js';

const { preprocess, unifiedPreprocess } = await import(SYNTAX_PATH);

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
  ['small', small, 5000],
  ['medium', medium, 2000],
  ['real-world', realWorld, 1000],
  ['large (10x)', large, 300],
];

// ── Correctness check ──────────────────────────────────────────────────────────
console.log('━'.repeat(70));
console.log('CORRECTNESS CHECK');
console.log('━'.repeat(70));

function nodeShape(node, depth = 0) {
  if (!node || typeof node !== 'object') return String(node);
  const { type, ...rest } = node;
  if (!type) return JSON.stringify(node);
  const parts = [`${type}`];
  for (const [k, v] of Object.entries(rest)) {
    if (k === 'loc' || k === 'strip') continue;
    if (Array.isArray(v)) parts.push(`${k}[${v.length}]`);
    else if (v && typeof v === 'object' && v.type) parts.push(`${k}:${nodeShape(v, depth + 1)}`);
    else if (typeof v === 'string') parts.push(`${k}="${v}"`);
    else if (typeof v === 'boolean' && v) parts.push(k);
  }
  return parts.join(' ');
}

function flatShapes(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const n of node) flatShapes(n, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  if (node.type) out.push(nodeShape(node));
  for (const [k, v] of Object.entries(node)) {
    if (k === 'loc' || k === 'strip') continue;
    flatShapes(v, out);
  }
  return out;
}

let allCorrect = true;
for (const [name, tpl] of templates.slice(0, 3)) {
  let refAst, uniAst, refErr, uniErr;
  try {
    refAst = preprocess(tpl);
  } catch (e) {
    refErr = e.message;
  }
  try {
    uniAst = unifiedPreprocess(tpl);
  } catch (e) {
    uniErr = e.message;
  }

  if (refErr || uniErr) {
    console.log(`${name}: ref=${refErr ?? 'ok'} uni=${uniErr ?? 'ok'}`);
    if (refErr !== uniErr) allCorrect = false;
    continue;
  }

  const refShapes = flatShapes(refAst).join('\n');
  const uniShapes = flatShapes(uniAst).join('\n');

  if (refShapes === uniShapes) {
    console.log(`${name}: ✓ AST shape matches (${refShapes.split('\n').length} nodes)`);
  } else {
    allCorrect = false;
    console.log(`${name}: ✗ AST MISMATCH`);
    const refLines = refShapes.split('\n');
    const uniLines = uniShapes.split('\n');
    const maxLen = Math.max(refLines.length, uniLines.length);
    let diffs = 0;
    for (let i = 0; i < maxLen && diffs < 10; i++) {
      if (refLines[i] !== uniLines[i]) {
        console.log(`  [${i}] ref: ${refLines[i] ?? '(none)'}`);
        console.log(`  [${i}] uni: ${uniLines[i] ?? '(none)'}`);
        diffs++;
      }
    }
    if (diffs === 10) console.log('  ... (more diffs truncated)');
  }
}
console.log();

// ── Benchmark ─────────────────────────────────────────────────────────────────
console.log('━'.repeat(70));
console.log('BENCHMARK (ms/call, warmed JIT)');
console.log('━'.repeat(70));
console.log(
  'template'.padEnd(14) +
    'chars'.padStart(7) +
    '  preprocess'.padStart(14) +
    '  unifiedPreprocess'.padStart(21) +
    '  speedup'.padStart(10)
);
console.log('─'.repeat(70));

function bench(fn, tpl, N) {
  for (let i = 0; i < Math.min(50, N); i++) fn(tpl);
  const t = performance.now();
  for (let i = 0; i < N; i++) fn(tpl);
  return (performance.now() - t) / N;
}

for (const [name, tpl, N] of templates) {
  const refMs = bench(preprocess, tpl, N);
  let uniMs;
  try {
    uniMs = bench(unifiedPreprocess, tpl, N);
  } catch (e) {
    console.log(`${name.padEnd(14)} FAILED: ${e.message.slice(0, 60)}`);
    continue;
  }
  const speedup = refMs / uniMs;
  console.log(
    name.padEnd(14) +
      String(tpl.length).padStart(7) +
      '  ' +
      refMs.toFixed(4).padStart(12) +
      'ms' +
      uniMs.toFixed(4).padStart(19) +
      'ms' +
      (speedup > 1
        ? `  ${speedup.toFixed(2)}x faster`
        : `  ${(1 / speedup).toFixed(2)}x slower`
      ).padStart(12)
  );
}
