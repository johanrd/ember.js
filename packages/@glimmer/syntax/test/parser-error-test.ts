import { preprocess as parse } from '@glimmer/syntax';

const { test } = QUnit;

QUnit.module('[glimmer-syntax] Parser - parse error regression fixtures');

// prettier tests/format/handlebars/_errors_/invalid-3.hbs
test('empty mustache {{}} is a parse error (invalid-3.hbs)', (assert) => {
  assert.throws(
    () => {
      parse('<a>\n\n{{}}\n', { meta: { moduleName: 'test-module' } });
    },
    /./u,
    'empty mustache should throw a parse error'
  );
});

// prettier tests/format/handlebars/_errors_/invalid.hbs
test('unclosed mustache {{@name} is a parse error (invalid.hbs)', (assert) => {
  assert.throws(
    () => {
      parse('<A >\nx, {{@name}\n', { meta: { moduleName: 'test-module' } });
    },
    /./u,
    'unclosed mustache should throw a parse error'
  );
});

// prettier tests/format/handlebars/_errors_/tilde-comments-1.hbs
test('bare tilde mustache {{~}} is a parse error (tilde-comments-1.hbs)', (assert) => {
  assert.throws(
    () => {
      parse('{{~}}\n', { meta: { moduleName: 'test-module' } });
    },
    /./u,
    'bare tilde mustache should throw a parse error'
  );
});

// prettier tests/format/handlebars/_errors_/tilde-comments-2.hbs
test('double tilde mustache {{~~}} is a parse error (tilde-comments-2.hbs)', (assert) => {
  assert.throws(
    () => {
      parse('{{~~}}\n', { meta: { moduleName: 'test-module' } });
    },
    /./u,
    'double tilde mustache should throw a parse error'
  );
});

// assert-reserved-named-arguments-test: '@' alone is reserved / parse error
test('mustache with bare @ is a parse error ({{@}})', (assert) => {
  assert.throws(
    () => {
      parse('{{@}}', { meta: { moduleName: 'test-module' } });
    },
    /./u,
    'mustache with bare @ should throw a parse error'
  );
});

// assert-reserved-named-arguments-test: '@0' is not a valid path
test('mustache with @<digit> is a parse error ({{@0}})', (assert) => {
  assert.throws(
    () => {
      parse('{{@0}}', { meta: { moduleName: 'test-module' } });
    },
    /./u,
    '@<digit> is not a valid identifier'
  );
});

// assert-reserved-named-arguments-test: '@@', '@=', '@!' etc.
test('mustache with @<non-id-char> is a parse error ({{@@}}, {{@=}}, {{@!}})', (assert) => {
  for (const input of ['{{@@}}', '{{@=}}', '{{@!}}']) {
    assert.throws(
      () => {
        parse(input, { meta: { moduleName: 'test-module' } });
      },
      /./u,
      `${input} should throw a parse error`
    );
  }
});

// Jison has a quirk where digit-only segments are rejected as the LAST segment
// (lexer matches NUMBER before ID) but accepted as middle segments (e.g.
// {{foo.0.bar}}). Real Ember templates use .0. as array access:
//   {{@equipmentEdgeList.0.node.profile.modelInfo.manufacturer.name}}
// The v2-parser uniformly accepts digit segments in all positions, which is
// more permissive than Jison but doesn't break any real-world templates.
test('digit path segment as middle segment is accepted ({{foo.0.bar}})', (assert) => {
  const ast = parse('{{foo.0.bar}}', { meta: { moduleName: 'test-module' } });
  assert.strictEqual(ast.body[0]?.type, 'MustacheStatement');
});

test('digit path segment with data path is accepted ({{@list.0.name}})', (assert) => {
  const ast = parse('{{@list.0.name}}', { meta: { moduleName: 'test-module' } });
  assert.strictEqual(ast.body[0]?.type, 'MustacheStatement');
});
