import { RenderingTestCase, moduleFor } from 'internal-test-helpers';

// MEASUREMENT ONLY -- not a real test. Counts First/Last allocations against
// appended nodes for a krausest-shaped row list, to check the
// "two allocations per appended node" claim in emberjs/ember.js#21610.
//
// Run:  pnpm vite build --mode development --minify false
//       pnpm testem ci -f testem.alloc.cjs --host 127.0.0.1 --port 13144
// Read the __ALLOC_COUNTS__ line.
const ROWS = Number(new URL(window.location.href).searchParams.get('rows') ?? 10000);

moduleFor(
  'Alloc counters',
  class extends RenderingTestCase {
    ['@test First/Last allocations per appended node']() {
      let rows = [];
      for (let i = 0; i < ROWS; i++) rows.push({ id: i, label: `row ${i}` });

      // element-builder.ts captured this object at import time: mutate, never replace.
      let counts = globalThis.__EB_COUNTS;
      let before = { ...counts };

      this.render(
        `<table><tbody>{{#each this.rows key="id" as |row|}}` +
          `<tr><td class="col-md-1">{{row.id}}</td>` +
          `<td class="col-md-4"><a>{{row.label}}</a></td>` +
          `<td class="col-md-1"><a><span class="glyphicon"></span></a></td></tr>` +
          `{{/each}}</tbody></table>`,
        { rows }
      );

      let delta = {};
      for (let k of Object.keys(counts)) delta[k] = counts[k] - before[k];
      // eslint-disable-next-line no-console
      console.log('__ALLOC_COUNTS__ ' + JSON.stringify({ rows: ROWS, ...delta }));
      this.assert.ok(delta.didAppendNode > 0, 'rendered something');
    }
  }
);
