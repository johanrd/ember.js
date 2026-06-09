/**
 * Parser benchmark: this branch (perf/handlebars-v2-parser) vs PR #21313 (rust-parser-pest)
 *
 * Run: node bench-compare.mjs
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const currentDistPath = join(__dirname, 'packages/@glimmer/syntax/dist/es/index.js');
const prDistPath = '/tmp/pr-21313/packages/@glimmer/syntax/dist/es/index.js';

// ─── Templates ────────────────────────────────────────────────────────────────

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

const large = medium.repeat(10);

const realWorld = `
<div class="user-profile {{if this.isPremium "premium"}}">
  <header class="profile-header">
    <img src={{this.avatarUrl}} alt={{this.username}} class="avatar" />
    <div class="profile-info">
      <h2>{{this.displayName}}</h2>
      <p class="bio">{{this.bio}}</p>
      <span class="badge">{{this.role}}</span>
    </div>
    {{#if this.isOwnProfile}}
      <button {{on "click" this.editProfile}} class="edit-btn">Edit Profile</button>
    {{/if}}
  </header>

  <nav class="profile-tabs">
    {{#each this.tabs as |tab|}}
      <button
        class="tab {{if (eq tab.id this.activeTab) "active"}}"
        {{on "click" (fn this.setTab tab.id)}}
      >
        {{tab.label}}
        {{#if tab.count}}
          <span class="count">{{tab.count}}</span>
        {{/if}}
      </button>
    {{/each}}
  </nav>

  <section class="profile-content">
    {{#if (eq this.activeTab "posts")}}
      {{#each this.posts as |post|}}
        <article class="post-card">
          <h3>{{post.title}}</h3>
          <p>{{post.excerpt}}</p>
          <footer>
            <time>{{post.createdAt}}</time>
            <span>{{post.views}} views</span>
          </footer>
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
  ['large', large],
  ['real-world', realWorld],
];

// ─── Benchmark runner ─────────────────────────────────────────────────────────

function bench(preprocess, name, template, iterations = 1000) {
  // warm up
  for (let i = 0; i < 50; i++) preprocess(template);

  const start = performance.now();
  for (let i = 0; i < iterations; i++) preprocess(template);
  const elapsed = performance.now() - start;

  return {
    name,
    chars: template.length,
    ms: elapsed / iterations,
  };
}

function printTable(rows) {
  const colWidths = [18, 8, 12, 12, 12];
  const headers = ['template', 'chars', 'current (ms)', 'pr#21313 (ms)', 'speedup'];
  const sep = colWidths.map((w) => '-'.repeat(w)).join('-+-');

  const pad = (s, w) => String(s).padEnd(w);
  const rpad = (s, w) => String(s).padStart(w);

  console.log('\n' + headers.map((h, i) => pad(h, colWidths[i])).join(' | '));
  console.log(sep);
  for (const row of rows) {
    const faster = row.current < row.pr ? 'current' : 'rust-pr';
    const ratio =
      row.current < row.pr
        ? (row.pr / row.current).toFixed(2) + 'x (current wins)'
        : (row.current / row.pr).toFixed(2) + 'x (rust wins)';
    console.log(
      [
        pad(row.template, colWidths[0]),
        rpad(row.chars, colWidths[1]),
        rpad(row.current.toFixed(3), colWidths[2]),
        rpad(row.pr.toFixed(3), colWidths[3]),
        rpad(ratio, colWidths[4] + 20),
      ].join(' | ')
    );
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log('Loading parsers...');

const { preprocess: preprocessCurrent } = await import(currentDistPath);
const { preprocess: preprocessPR } = await import(prDistPath);

console.log('Parsers loaded. Running benchmarks...\n');

// Verify both produce output (smoke check)
try {
  const r1 = preprocessCurrent('<div>{{foo}}</div>');
  const r2 = preprocessPR('<div>{{foo}}</div>');
  console.log(`Current branch: ${r1.type} (${r1.body.length} top-level nodes)`);
  console.log(`PR #21313:      ${r2.type} (${r2.body.length} top-level nodes)`);
} catch (e) {
  console.error('Smoke check failed:', e.message);
  process.exit(1);
}

console.log('');

const N = 1000;
const rows = [];

for (const [name, tpl] of templates) {
  process.stdout.write(`  Benchmarking '${name}'...`);
  const currentResult = bench(preprocessCurrent, name, tpl, N);
  const prResult = bench(preprocessPR, name, tpl, N);
  process.stdout.write(' done\n');
  rows.push({
    template: name,
    chars: tpl.length,
    current: currentResult.ms,
    pr: prResult.ms,
  });
}

printTable(rows);

// Phase breakdown: measure the PR's WASM parse vs JS post-processing
console.log('\n--- Phase breakdown (PR #21313, medium template) ---');
const { parseTemplateToJson } =
  await import('/tmp/pr-21313/packages/@glimmer/syntax/pkg/universal.mjs');
const src = medium;
const N2 = 1000;

// warm up WASM
for (let i = 0; i < 50; i++) parseTemplateToJson(src);

const startWasm = performance.now();
for (let i = 0; i < N2; i++) parseTemplateToJson(src);
const wasmMs = (performance.now() - startWasm) / N2;

const startFull = performance.now();
for (let i = 0; i < N2; i++) preprocessPR(src);
const fullMs = (performance.now() - startFull) / N2;

console.log(`  WASM parse only:          ${wasmMs.toFixed(3)}ms`);
console.log(`  Full preprocess() (PR):   ${fullMs.toFixed(3)}ms`);
console.log(`  JS post-processing cost:  ${(fullMs - wasmMs).toFixed(3)}ms`);
