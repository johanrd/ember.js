import { v2ParseWithoutProcessing } from './v2-parser.js';
import WhitespaceControl from './whitespace-control.js';

export function parseWithoutProcessing(input, options) {
  return v2ParseWithoutProcessing(input, options);
}

export function parse(input, options) {
  let ast = parseWithoutProcessing(input, options);
  let strip = new WhitespaceControl(options);

  return strip.accept(ast);
}
