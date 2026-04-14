/**
 * CLI/build-style benchmark: simulates a real build pass over a project.
 *
 * IDE benchmark: same template, many iterations (measures JIT-warmed throughput)
 * CLI benchmark: many distinct templates, one pass (cold-ish JIT, one-time init cost)
 *
 * Run: node bench-cli.mjs
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const currentDistPath = join(__dirname, 'packages/@glimmer/syntax/dist/es/index.js');
const prDistPath = '/tmp/pr-21313/packages/@glimmer/syntax/dist/es/index.js';

// ─── Realistic template corpus ────────────────────────────────────────────────
// ~50 distinct templates of varying complexity, simulating a real Ember project.

const TEMPLATES = [
  `<div>{{this.title}}</div>`,
  `<span class="label">{{@label}}</span>`,
  `<button {{on "click" this.handleClick}} type="button">{{yield}}</button>`,
  `{{#if this.isLoading}}<Spinner />{{else}}{{yield}}{{/if}}`,
  `<ul>{{#each @items as |item|}}<li>{{item.name}}</li>{{/each}}</ul>`,
  `<input type="text" value={{this.value}} {{on "input" this.onInput}} />`,
  `<div class="card {{if @highlighted "card--highlighted"}}">{{yield}}</div>`,
  `<h1>{{this.title}}</h1><p>{{this.description}}</p>`,
  `{{#let (hash name=@name age=@age) as |person|}}{{person.name}}{{/let}}`,
  `<form {{on "submit" this.handleSubmit}}><Input @value={{this.email}} /><button type="submit">Submit</button></form>`,

  `<div class="modal {{if @isOpen "modal--open"}}">
  <div class="modal__backdrop" {{on "click" @onClose}}></div>
  <div class="modal__content">
    <header class="modal__header">
      <h2>{{@title}}</h2>
      <button {{on "click" @onClose}} class="modal__close">&times;</button>
    </header>
    <div class="modal__body">{{yield}}</div>
    {{#if (has-block "footer")}}
      <footer class="modal__footer">{{yield to="footer"}}</footer>
    {{/if}}
  </div>
</div>`,

  `<nav class="breadcrumbs">
  {{#each @crumbs as |crumb index|}}
    {{#if (gt index 0)}}<span class="separator">/</span>{{/if}}
    {{#if crumb.href}}
      <a href={{crumb.href}}>{{crumb.label}}</a>
    {{else}}
      <span class="current">{{crumb.label}}</span>
    {{/if}}
  {{/each}}
</nav>`,

  `<table class="data-table">
  <thead>
    <tr>
      {{#each @columns as |col|}}
        <th class="col-{{col.key}} {{if col.sortable "sortable"}}"
            {{on "click" (fn this.sort col.key)}}>
          {{col.label}}
          {{#if (eq this.sortKey col.key)}}
            <span class="sort-icon {{if this.sortAsc "asc" "desc"}}"></span>
          {{/if}}
        </th>
      {{/each}}
    </tr>
  </thead>
  <tbody>
    {{#each this.sortedRows as |row|}}
      <tr class="{{if row.selected "selected"}}">
        {{#each @columns as |col|}}
          <td>{{get row col.key}}</td>
        {{/each}}
      </tr>
    {{/each}}
  </tbody>
</table>`,

  `<div class="pagination">
  <button {{on "click" this.prevPage}} disabled={{this.isFirstPage}}>Prev</button>
  {{#each this.pageNumbers as |page|}}
    <button
      class="page-btn {{if (eq page this.currentPage) "active"}}"
      {{on "click" (fn this.goToPage page)}}
    >{{page}}</button>
  {{/each}}
  <button {{on "click" this.nextPage}} disabled={{this.isLastPage}}>Next</button>
</div>`,

  `<aside class="sidebar {{if this.isCollapsed "collapsed"}}">
  <button {{on "click" this.toggleCollapse}} class="sidebar__toggle">
    {{if this.isCollapsed "→" "←"}}
  </button>
  <nav class="sidebar__nav">
    {{#each @navItems as |item|}}
      <a href={{item.href}}
         class="nav-item {{if item.isActive "active"}} {{if item.isDisabled "disabled"}}"
         {{on "click" (fn this.onNavClick item)}}>
        {{#if item.icon}}<Icon @name={{item.icon}} />{{/if}}
        <span class="nav-item__label">{{item.label}}</span>
        {{#if item.badge}}
          <span class="badge">{{item.badge}}</span>
        {{/if}}
      </a>
    {{/each}}
  </nav>
</aside>`,

  `{{#each @notifications as |notif|}}
  <div class="notification notification--{{notif.type}} {{if notif.read "read"}}"
       role="alert">
    <Icon @name={{concat "icon-" notif.type}} />
    <div class="notification__body">
      <p class="notification__message">{{notif.message}}</p>
      <time class="notification__time">{{format-relative notif.createdAt}}</time>
    </div>
    <button {{on "click" (fn @onDismiss notif.id)}} class="notification__dismiss">
      &times;
    </button>
  </div>
{{/each}}`,

  `<div class="dropdown {{if this.isOpen "dropdown--open"}}">
  <button {{on "click" this.toggle}} class="dropdown__trigger" aria-expanded={{this.isOpen}}>
    {{this.selectedLabel}}
    <Icon @name="chevron-down" />
  </button>
  {{#if this.isOpen}}
    <ul class="dropdown__menu" role="listbox">
      {{#each @options as |option|}}
        <li role="option"
            aria-selected={{eq option.value this.selected}}
            class="dropdown__option {{if (eq option.value this.selected) "selected"}} {{if option.disabled "disabled"}}"
            {{on "click" (fn this.select option.value)}}>
          {{option.label}}
        </li>
      {{/each}}
    </ul>
  {{/if}}
</div>`,

  `<div class="rich-text-editor" ...attributes>
  <div class="editor__toolbar">
    {{#each this.toolbarButtons as |btn|}}
      <button {{on "click" (fn this.execCommand btn.command)}}
              class="toolbar-btn {{if btn.isActive "active"}}"
              title={{btn.title}}
              disabled={{btn.disabled}}>
        <Icon @name={{btn.icon}} />
      </button>
    {{/each}}
  </div>
  <div class="editor__content"
       contenteditable="true"
       {{on "input" this.onInput}}
       {{on "keydown" this.onKeyDown}}>
  </div>
</div>`,

  `<div class="calendar">
  <header class="calendar__header">
    <button {{on "click" this.prevMonth}}>&lt;</button>
    <h3>{{this.monthLabel}} {{this.year}}</h3>
    <button {{on "click" this.nextMonth}}>&gt;</button>
  </header>
  <div class="calendar__grid">
    {{#each this.weeks as |week|}}
      <div class="calendar__week">
        {{#each week as |day|}}
          <button
            class="calendar__day
              {{if day.isToday "today"}}
              {{if day.isSelected "selected"}}
              {{if day.isOutsideMonth "outside-month"}}"
            {{on "click" (fn this.selectDay day.date)}}
            disabled={{day.isDisabled}}
          >{{day.label}}</button>
        {{/each}}
      </div>
    {{/each}}
  </div>
</div>`,

  // Extra medium-sized templates to fill out the corpus
  ...Array.from(
    { length: 30 },
    (_, i) => `
<section class="section-${i}" data-index="${i}">
  <header>
    <h2>{{@title}}</h2>
    {{#if @subtitle}}<p class="subtitle">{{@subtitle}}</p>{{/if}}
  </header>
  <div class="content">
    {{#each @items as |item|}}
      <div class="item {{if item.featured "featured"}}">
        <h3>{{item.name}}</h3>
        {{#if item.description}}
          <p>{{item.description}}</p>
        {{/if}}
        <footer>
          <span>{{item.category}}</span>
          <button {{on "click" (fn @onSelect item)}}>Select</button>
        </footer>
      </div>
    {{/each}}
  </div>
</section>`
  ),
];

console.log(
  `Corpus: ${TEMPLATES.length} distinct templates, total ${TEMPLATES.reduce((s, t) => s + t.length, 0)} chars\n`
);

// ─── Measurements ─────────────────────────────────────────────────────────────

async function measureParser(label, distPath) {
  // Measure cold first-parse (includes module load + any lazy init like WASM)
  const t0 = performance.now();
  const { preprocess } = await import(distPath);
  const loadMs = performance.now() - t0;

  // First parse (triggers WASM init if applicable, cold V8)
  const t1 = performance.now();
  preprocess(TEMPLATES[0]);
  const firstParseMs = performance.now() - t1;

  // Single-pass build simulation: parse each template once (no repetition)
  // Run this 10 times to get stable numbers (simulates running the build tool 10x)
  const buildTimes = [];
  for (let run = 0; run < 10; run++) {
    const start = performance.now();
    for (const tpl of TEMPLATES) preprocess(tpl);
    buildTimes.push(performance.now() - start);
  }
  const buildMin = Math.min(...buildTimes);
  const buildMed = buildTimes.slice().sort((a, b) => a - b)[5]; // p50

  // Extrapolate to a 500-template project
  const perTemplate = buildMin / TEMPLATES.length;
  const proj500 = perTemplate * 500;

  return { label, loadMs, firstParseMs, buildMin, buildMed, perTemplate, proj500 };
}

console.log('Loading and measuring (this takes ~10s)...\n');

const current = await measureParser('current branch', currentDistPath);
const pr = await measureParser('PR #21313 (rust)', prDistPath);

// ─── Output ───────────────────────────────────────────────────────────────────

function row(label, cur, prv, unit = 'ms', lowerIsBetter = true) {
  const winner = lowerIsBetter
    ? cur < prv
      ? 'current'
      : 'rust-pr'
    : cur > prv
      ? 'current'
      : 'rust-pr';
  const ratio = winner === 'current' ? (prv / cur).toFixed(2) : (cur / prv).toFixed(2);
  const arrow = winner === 'current' ? '<' : '>';
  console.log(
    `  ${label.padEnd(32)} ${String(cur.toFixed(2) + unit).padStart(10)}  ${arrow}  ${String(prv.toFixed(2) + unit).padStart(10)}   ${ratio}x (${winner} wins)`
  );
}

console.log(
  `${'Metric'.padEnd(32)} ${'current'.padStart(10)}     ${'PR#21313'.padStart(10)}   winner`
);
console.log('-'.repeat(80));

row('Module load (import)', current.loadMs, pr.loadMs);
row('First parse (cold)', current.firstParseMs, pr.firstParseMs);
row(`Build pass (${TEMPLATES.length} tpl, best of 10)`, current.buildMin, pr.buildMin);
row(`Build pass (p50)`, current.buildMed, pr.buildMed);
row('Per-template avg (build)', current.perTemplate, pr.perTemplate, 'ms');
row('500-template project (proj)', current.proj500, pr.proj500, 'ms');

console.log('');
console.log('Notes:');
console.log(`  current branch : JS pipeline (handlebars v2 parser)`);
console.log(`  PR #21313      : Rust/WASM (pest.rs) + JSON bridge + JS post-processing`);
console.log(
  `  "build pass"   : single-pass over ${TEMPLATES.length} distinct templates (no repeat, simulates CLI)`
);
console.log(`  "first parse"  : includes any lazy WASM init (one-time per process)`);
