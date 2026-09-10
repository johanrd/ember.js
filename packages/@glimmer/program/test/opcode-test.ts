import { ProgramHeapImpl, RuntimeOpImpl } from '@glimmer/program';
import { ARG_SHIFT } from '@glimmer/vm/lib/flags';

QUnit.module('RuntimeOp cursor');

interface Instruction {
  type: number;
  operands: number[];
  machine?: boolean;
}

/** Encode instructions into a heap and return the address each one starts at. */
function heapWith(instructions: Instruction[]) {
  let heap = new ProgramHeapImpl();
  let addresses: number[] = [];

  for (let { type, operands, machine } of instructions) {
    addresses.push(heap.offset);

    let header = type | (operands.length << ARG_SHIFT);
    if (machine) {
      heap.pushMachine(header);
    } else {
      heap.pushOp(header);
    }

    for (let operand of operands) {
      heap.pushRaw(operand);
    }
  }

  return { heap, addresses, end: heap.offset - 1 };
}

QUnit.test('seek decodes the whole header, not just part of it', (assert) => {
  let { heap, addresses } = heapWith([
    { type: 7, operands: [10, 20] },
    { type: 9, operands: [30], machine: true },
  ]);

  let op = new RuntimeOpImpl(heap);

  op.seek(addresses[0]!);
  assert.strictEqual(op.type, 7, 'type');
  assert.strictEqual(op.size, 3, 'size is the header plus two operands');
  assert.strictEqual(op.isMachine, 0, 'isMachine');
  assert.strictEqual(op.op1, 10, 'op1');
  assert.strictEqual(op.op2, 20, 'op2');

  op.seek(addresses[1]!);
  assert.strictEqual(op.type, 9, 'type after seek');
  assert.strictEqual(op.size, 2, 'size after seek');
  assert.strictEqual(op.isMachine, 1, 'isMachine after seek');
  assert.strictEqual(op.op1, 30, 'op1 after seek');
});

QUnit.test(
  'the decoded header stays in sync with the operands however the cursor moves',
  (assert) => {
    let { heap, addresses } = heapWith([
      { type: 7, operands: [10, 20] },
      { type: 9, operands: [30], machine: true },
    ]);

    let op = new RuntimeOpImpl(heap);

    op.seek(addresses[1]!);

    // Assigning `offset` is how the cursor moved before `seek` existed, and it is
    // still a writable field on the impl. Whatever moves the cursor, the decoded
    // header has to describe the instruction the operands are read from.
    op.offset = addresses[0]!;

    assert.strictEqual(op.op1, 10, 'op1 follows the cursor');
    assert.strictEqual(op.type, 7, 'type follows the cursor');
    assert.strictEqual(op.size, 3, 'size follows the cursor');
    assert.strictEqual(op.isMachine, 0, 'isMachine follows the cursor');
  }
);

QUnit.test('walking a slice the way logOpcodeSlice does does not throw', (assert) => {
  let { heap, addresses, end } = heapWith([
    { type: 7, operands: [10, 20] },
    { type: 9, operands: [30], machine: true },
  ]);

  let op = new RuntimeOpImpl(heap);
  let start = addresses[0]!;

  // The loop body of logOpcodeSlice (packages/@glimmer/debug/lib/debug.ts).
  let _size = 0;
  for (let i = start; i <= end; i = i + _size) {
    op.seek(i);
    _size = op.size;
  }

  assert.strictEqual(_size, 2, 'the walk ended on the last instruction');

  // ...and the line that follows that loop. `_size` is always >= 1, so this
  // moves the cursor to a negative address.
  op.seek(-_size);

  assert.ok(true, 'parking the cursor after the walk did not throw');
});
