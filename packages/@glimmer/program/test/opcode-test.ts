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

QUnit.test('the cursor can only be moved by seek', (assert) => {
  let { heap, addresses } = heapWith([
    { type: 7, operands: [10, 20] },
    { type: 9, operands: [30], machine: true },
  ]);

  let op = new RuntimeOpImpl(heap);

  op.seek(addresses[1]!);

  // Assigning `offset` is how the cursor moved before `seek` existed. It has to be
  // rejected now, because it would move `op1`/`op2`/`op3` to another instruction
  // while `type`/`size`/`isMachine` still described this one.
  assert.throws(
    () => {
      (op as unknown as { offset: number }).offset = addresses[0]!;
    },
    TypeError,
    'offset is not writable'
  );

  assert.strictEqual(op.type, 9, 'type still describes the instruction seeked to');
  assert.strictEqual(op.op1, 30, 'op1 still describes the instruction seeked to');
});

QUnit.test('walking a slice the way logOpcodeSlice does visits every instruction', (assert) => {
  let { heap, addresses, end } = heapWith([
    { type: 7, operands: [10, 20] },
    { type: 9, operands: [30], machine: true },
  ]);

  let op = new RuntimeOpImpl(heap);
  let visited: number[] = [];

  // The loop in logOpcodeSlice (packages/@glimmer/debug/lib/debug.ts).
  let _size = 0;
  for (let i = addresses[0]!; i <= end; i = i + _size) {
    op.seek(i);
    visited.push(op.type);
    _size = op.size;
  }

  assert.deepEqual(visited, [7, 9], 'every instruction in the slice was decoded');
});

QUnit.test('seeking outside the heap throws instead of decoding garbage', (assert) => {
  let { heap } = heapWith([{ type: 7, operands: [10, 20] }]);

  let op = new RuntimeOpImpl(heap);

  // `seek` reads the header eagerly, so an out-of-heap address is a hard error
  // rather than a cursor that happens to be parked somewhere unused. Anything
  // that used to move the cursor to a throwaway position has to stop doing so.
  assert.throws(() => op.seek(-1), /Expected value to be present/u, 'negative address');
});
