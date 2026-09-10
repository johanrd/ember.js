import { RenderingTestCase, moduleFor, strip } from 'internal-test-helpers';

// Byte-identical on both branches. Does a plain (non-tracked) array that shrinks
// *during* render stop the iteration, or produce phantom items?
moduleFor(
  'each over an array that shrinks mid-render',
  class extends RenderingTestCase {
    // Mutation from inside the block body. VM_ITERATE_OP renders each item's
    // block before calling next() again, so body code runs mid-iteration.
    ['@test body getter truncates the array']() {
      let items = [];
      let log = [];
      for (let i = 0; i < 4; i++) {
        items.push({
          id: i,
          get name() {
            log.push(i);
            if (i === 0) items.length = 1; // drop items 1..3
            return `item-${i}`;
          },
        });
      }

      this.render(`{{#each this.items as |item|}}<b>{{item.name}}</b>{{/each}}`, { items });

      let rendered = this.element.querySelectorAll('b').length;
      // eslint-disable-next-line no-console
      console.log(`__SHRINK__ ${JSON.stringify({ case: 'body', blocks: rendered, reads: log })}`);
      this.assert.ok(true, `rendered ${rendered} blocks`);
    }

    // Mutation from keyFor, which runs inside next() itself.
    ['@test key getter truncates the array']() {
      let items = [];
      let log = [];
      for (let i = 0; i < 4; i++) {
        items.push({
          id: i,
          get k() {
            log.push(i);
            if (i === 0) items.length = 1;
            return `k-${i}`;
          },
        });
      }

      this.render(`{{#each this.items key="k" as |item|}}<b>{{item.id}}</b>{{/each}}`, { items });

      let rendered = this.element.querySelectorAll('b').length;
      // eslint-disable-next-line no-console
      console.log(`__SHRINK__ ${JSON.stringify({ case: 'key', blocks: rendered, reads: log })}`);
      this.assert.ok(true, `rendered ${rendered} blocks`);
    }

    // A hole: length is UNCHANGED, but the slot is empty. A length-based bound
    // cannot see this -- does either branch stop, or render undefined?
    ['@test body getter deletes a later element, leaving a hole']() {
      let items = [];
      for (let i = 0; i < 4; i++) {
        items.push({
          id: i,
          get name() {
            if (i === 0) delete items[2];
            return `item-${i}`;
          },
        });
      }

      this.render(`{{#each this.items as |item|}}<b>{{item.id}}</b>{{/each}}`, { items });

      let rendered = this.element.querySelectorAll('b').length;
      // eslint-disable-next-line no-console
      console.log(`__SHRINK__ ${JSON.stringify({ case: 'hole', blocks: rendered, len: items.length })}`);
      this.assert.ok(true, `rendered ${rendered} blocks`);
    }
  }
);
