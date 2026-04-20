import type { Nullable } from '@glimmer/interfaces';
import { assign } from '@glimmer/util';

import type { NodeVisitor } from '../traversal/visitor';
import type * as ASTv1 from '../v1/api';

import print from '../generation/print';
import { unifiedPreprocess } from './parser';
import * as src from '../source/api';
import traverse from '../traversal/traverse';
import Walker from '../traversal/walker';
import publicBuilder from '../v1/public-builders';

/**
  ASTPlugins can make changes to the Glimmer template AST before
  compilation begins.
*/
export interface ASTPluginBuilder<TEnv extends ASTPluginEnvironment = ASTPluginEnvironment> {
  (env: TEnv): ASTPlugin;
}

export interface ASTPlugin {
  name: string;
  visitor: NodeVisitor;
}

export interface ASTPluginEnvironment {
  meta?: object | undefined;
  syntax: Syntax;
}

interface HandlebarsParseOptions {
  srcName?: string;
  ignoreStandalone?: boolean;
}

export interface TemplateIdFn {
  (src: string): Nullable<string>;
}

export interface PrecompileOptions extends PreprocessOptions {
  id?: TemplateIdFn;

  /**
   * Additional non-native keywords.
   *
   * Local variables (block params or lexical scope) always takes precedence,
   * but otherwise, suitable free variable candidates (e.g. those are not part
   * of a path) are matched against this list and turned into keywords.
   *
   * In strict mode compilation, keywords suppresses the undefined reference
   * error and will be resolved by the runtime environment.
   *
   * In loose mode, keywords are currently ignored and since all free variables
   * are already resolved by the runtime environment.
   */
  keywords?: readonly string[];

  /**
   * In loose mode, this hook allows embedding environments to customize the name of an
   * angle-bracket component. In practice, this means that `<HelloWorld />` in Ember is
   * compiled by Glimmer as an invocation of a component named `hello-world`.
   *
   * It's a little weird that this is needed in addition to the resolver, but it's a
   * classic-only feature and it seems fine to leave it alone for classic consumers.
   */
  customizeComponentName?: ((input: string) => string) | undefined;
}

export interface PrecompileOptionsWithLexicalScope extends PrecompileOptions {
  lexicalScope: (variable: string) => boolean;
}

export interface PreprocessOptions {
  strictMode?: boolean | undefined;
  locals?: string[] | undefined;
  meta?:
    | {
        moduleName?: string | undefined;
      }
    | undefined;
  plugins?:
    | {
        ast?: ASTPluginBuilder[] | undefined;
      }
    | undefined;
  parseOptions?: HandlebarsParseOptions | undefined;
  customizeComponentName?: ((input: string) => string) | undefined;

  /**
    Useful for specifying a group of options together.

    When `'codemod'` we disable all whitespace control in handlebars
    (to preserve as much as possible) and we also avoid any
    escaping/unescaping of HTML entity codes.
   */
  mode?: 'codemod' | 'precompile' | undefined;
}

export interface Syntax {
  parse: typeof preprocess;
  builders: typeof publicBuilder;
  print: typeof print;
  traverse: typeof traverse;
  Walker: typeof Walker;
}

const syntax: Syntax = {
  parse: preprocess,
  builders: publicBuilder,
  print,
  traverse,
  Walker,
};

export function preprocess(
  input: string | src.Source,
  options: PreprocessOptions = {}
): ASTv1.Template {
  const rawString = typeof input === 'string' ? input : input.source;
  const scannerOptions =
    input instanceof src.Source &&
    input.module !== (options.meta?.moduleName ?? 'an unknown module')
      ? { ...options, meta: { ...options.meta, moduleName: input.module } }
      : options;
  let template = unifiedPreprocess(rawString, scannerOptions);
  if (options.plugins?.ast) {
    for (const transform of options.plugins.ast) {
      let env: ASTPluginEnvironment = assign({}, options, { syntax }, { plugins: undefined });
      let pluginResult = transform(env);
      traverse(template, pluginResult.visitor);
    }
  }
  return template;
}
