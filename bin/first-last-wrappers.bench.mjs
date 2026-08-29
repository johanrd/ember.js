/**
 * Microbench for the First/Last wrapper elimination in
 * @glimmer/runtime/lib/vm/element-builder.ts (AppendingBlockImpl).
 *
 * The old form allocated `new First(node)` (once) and `new Last(node)`
 * (every call) per didAppendNode invocation. Both wrappers are stored on
 * the instance so V8 cannot elide them. The new form stores the raw node
 * + a boolean discriminator.
 *
 * Krausest templates are shallow (few nodes per row), so the per-append
 * wrapper cost doesn't register. Templates with deep per-row nesting
 * (form-heavy admin screens, cells with multiple elements) allocate
 * proportionally more wrappers.
 *
 * Run:  pnpm bench:first-last
 */

import { bench, do_not_optimize as doNotOptimize, run } from 'mitata';

class First {
  constructor(node) {
    this.node = node;
  }
  firstNode() {
    return this.node;
  }
}

class Last {
  constructor(node) {
    this.node = node;
  }
  lastNode() {
    return this.node;
  }
}

class OldBlock {
  constructor() {
    this.first = null;
    this.last = null;
    this.nesting = 0;
  }
  didAppendNode(node) {
    if (this.nesting !== 0) return;
    if (!this.first) this.first = new First(node);
    this.last = new Last(node);
  }
  firstNode() {
    return this.first.firstNode();
  }
  lastNode() {
    return this.last.lastNode();
  }
}

class NewBlock {
  constructor() {
    this._first = null;
    this._last = null;
    this._firstIsBounds = false;
    this._lastIsBounds = false;
    this.nesting = 0;
  }
  didAppendNode(node) {
    if (this.nesting !== 0) return;
    if (this._first === null) {
      this._first = node;
      this._firstIsBounds = false;
    }
    this._last = node;
    this._lastIsBounds = false;
  }
  firstNode() {
    return this._firstIsBounds ? this._first.firstNode() : this._first;
  }
  lastNode() {
    return this._lastIsBounds ? this._last.lastNode() : this._last;
  }
}

// Stand-in for a SimpleNode — small plain object with a nodeType.
function makeNode() {
  return { nodeType: 1, parentNode: null };
}

const NODES_PER_ROW_SHALLOW = 5; // Krausest-like
const NODES_PER_ROW_DEEP = 20; // form-heavy app template
const ROWS = 1000;

const shallowNodes = Array.from({ length: NODES_PER_ROW_SHALLOW * ROWS }, makeNode);
const deepNodes = Array.from({ length: NODES_PER_ROW_DEEP * ROWS }, makeNode);

bench(`AppendingBlock.didAppendNode (old) ${shallowNodes.length} nodes (shallow)`, () => {
  const block = new OldBlock();
  for (let i = 0; i < shallowNodes.length; i++) {
    block.didAppendNode(shallowNodes[i]);
  }
  // Exercise read path too so we don't let the JIT dead-code the wrappers.
  return doNotOptimize(block.firstNode(), block.lastNode());
});

bench(`AppendingBlock.didAppendNode (new) ${shallowNodes.length} nodes (shallow)`, () => {
  const block = new NewBlock();
  for (let i = 0; i < shallowNodes.length; i++) {
    block.didAppendNode(shallowNodes[i]);
  }
  return doNotOptimize(block.firstNode(), block.lastNode());
});

bench(`AppendingBlock.didAppendNode (old) ${deepNodes.length} nodes (deep)`, () => {
  const block = new OldBlock();
  for (let i = 0; i < deepNodes.length; i++) {
    block.didAppendNode(deepNodes[i]);
  }
  return doNotOptimize(block.firstNode(), block.lastNode());
});

bench(`AppendingBlock.didAppendNode (new) ${deepNodes.length} nodes (deep)`, () => {
  const block = new NewBlock();
  for (let i = 0; i < deepNodes.length; i++) {
    block.didAppendNode(deepNodes[i]);
  }
  return doNotOptimize(block.firstNode(), block.lastNode());
});

await run({ throw: true });
