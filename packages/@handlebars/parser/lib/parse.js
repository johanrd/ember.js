// @deprecated - @glimmer/syntax now uses the unified-scanner for all string/Source inputs.
// These exports are retained for any remaining HBS.Program fallback path only.
import parser from './parser.js';
import WhitespaceControl from './whitespace-control.js';
import * as Helpers from './helpers.js';

let baseHelpers = {};

for (let helper in Helpers) {
  if (Object.prototype.hasOwnProperty.call(Helpers, helper)) {
    baseHelpers[helper] = Helpers[helper];
  }
}

export function parseWithoutProcessing(input, options) {
  // Just return if an already-compiled AST was passed in.
  if (input.type === 'Program') {
    return input;
  }

  parser.yy = baseHelpers;

  // Altering the shared object here, but this is ok as parser is a sync operation
  parser.yy.locInfo = function (locInfo) {
    return new Helpers.SourceLocation(options && options.srcName, locInfo);
  };

  let hashSyntax;

  if (typeof options?.syntax?.hash === 'function') {
    hashSyntax = options.syntax.hash;
  } else {
    hashSyntax = hashLiteralNode;
  }

  parser.yy.syntax = {
    hash: hashSyntax,
  };

  return parser.parse(input);
}

function hashLiteralNode(hash, loc) {
  return {
    type: 'HashLiteral',
    pairs: hash.pairs,
    loc,
  };
}

export function parse(input, options) {
  let ast = parseWithoutProcessing(input, options);
  let strip = new WhitespaceControl(options);

  return strip.accept(ast);
}
