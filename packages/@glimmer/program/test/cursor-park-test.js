import { ProgramHeapImpl, RuntimeOpImpl } from '@glimmer/program';
import { ARG_SHIFT } from '@glimmer/vm/lib/flags';

// Byte-identical on both branches. Reproduces the tail of `logOpcodeSlice`
// (packages/@glimmer/debug/lib/debug.ts) using whichever cursor API the branch
// has: `opcode.offset = i` before emberjs/ember.js#21602, `opcode.seek(i)` after.
function moveCursor(op, offset) {
  if (typeof op.seek === 'function') return op.seek(offset);
  op.offset = offset;
  return op;
}

QUnit.module('logOpcodeSlice cursor park');

QUnit.test('parking the cursor after the walk does not throw', (assert) => {
  let heap = new ProgramHeapImpl();
  heap.pushOp(7 | (2 << ARG_SHIFT)); // one instruction, two operands
  heap.pushRaw(10);
  heap.pushRaw(20);
  let end = heap.offset - 1;

  let op = new RuntimeOpImpl(heap);

  // --- the loop in logOpcodeSlice ---
  let _size = 0;
  for (let i = 0; i <= end; i = i + _size) {
    moveCursor(op, i);
    _size = op.size;
  }

  assert.strictEqual(_size, 3, 'walked one instruction of size 3');
  assert.ok(_size >= 1, 'size is never 0, so -_size is always negative');

  // --- the line immediately after that loop ---
  moveCursor(op, -_size);

  assert.ok(true, 'parking the cursor did not throw');
});
