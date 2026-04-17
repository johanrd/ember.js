import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMacros } from '@embroider/macros/babel';

const macros = buildMacros();

// NOTE: intentionally NOT setting generatorOpts.compact: false (benchmark-app
// sets that for readability of compiled output; it's a perf foot-gun for
// real-world-matching build timings — large-app is a perf fixture).
//
// Plugin ordering mirrors what a real Ember consumer app does:
//   1. ember-template-compilation — extracts <template> tags into runtime calls
//   2. @babel/plugin-transform-typescript — strips TS syntax (.ts, .gts)
//   3. decorator-transforms — @tracked, @action, @service, etc.
//   4. @babel/plugin-transform-runtime — hoists shared runtime helpers
export default {
  plugins: [
    [
      'babel-plugin-ember-template-compilation',
      {
        transforms: [...macros.templateMacros],
      },
    ],
    [
      '@babel/plugin-transform-typescript',
      {
        allowDeclareFields: true,
      },
    ],
    [
      'module:decorator-transforms',
      {
        runtime: {
          import: import.meta.resolve('decorator-transforms/runtime-esm'),
        },
      },
    ],
    [
      '@babel/plugin-transform-runtime',
      {
        absoluteRuntime: dirname(fileURLToPath(import.meta.url)),
        useESModules: true,
        regenerator: false,
      },
    ],
    ...macros.babelMacros,
  ],
};
