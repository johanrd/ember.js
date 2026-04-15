import type { Dict } from '@glimmer/interfaces';
import type { ASTv1 } from '@glimmer/syntax';
import { builders as b, preprocess as parse, traverse } from '@glimmer/syntax';
import { syntaxErrorFor } from '@glimmer-workspace/test-utils';

import { astEqual } from './support';

const { test } = QUnit;

QUnit.module('[glimmer-syntax] Parser - AST');

test('a simple piece of content', () => {
  let t = 'some content';
  astEqual(t, b.template([b.text('some content')]));
});

test('self-closed element', () => {
  let t = '<g />';
  astEqual(t, b.template([element('g/')]));
});

test('various html element paths', () => {
  const cases = [
    [`<Foo />`, b.fullPath(b.var('Foo'))],
    [`<Foo.bar.baz />`, b.fullPath(b.var('Foo'), ['bar', 'baz'])],
    [`<this />`, b.fullPath(b.this())],
    [`<this.foo.bar />`, b.fullPath(b.this(), ['foo', 'bar'])],
    [`<@Foo />`, b.fullPath(b.at('@Foo'))],
    [`<@Foo.bar.baz />`, b.fullPath(b.at('@Foo'), ['bar', 'baz'])],
    [`<:foo />`, b.fullPath(b.var(':foo'))],
  ] satisfies Array<[string, ASTv1.PathExpression]>;

  for (const [t, path] of cases) {
    astEqual(t, b.template([b.element({ path, selfClosing: true })]));
  }
});

test('elements can have empty attributes', () => {
  let t = '<img id="">';
  astEqual(t, b.template([element('img', ['attrs', ['id', '']])]));
});

test('disallowed quote in element space is rejected', (assert) => {
  let t = '<img foo="bar"" >';
  assert.throws(
    () => {
      parse(t, { meta: { moduleName: 'test-module' } });
    },
    syntaxErrorFor('" is not a valid character within attribute names', '', 'test-module', 1, 14)
  );
});

test('disallowed equals sign in element space is rejected', (assert) => {
  let t = '<img =foo >';
  assert.throws(
    () => {
      parse(t, { meta: { moduleName: 'test-module' } });
    },
    syntaxErrorFor('attribute name cannot start with equals sign', '', 'test-module', 1, 5)
  );
});

test('svg content', () => {
  let t = '<svg></svg>';
  astEqual(t, b.template([element('svg')]));
});

test('html content with html content inline', () => {
  let t = '<div><p></p></div>';
  astEqual(t, b.template([element('div', ['body', element('p')])]));
});

test('html content with svg content inline', () => {
  let t = '<div><svg></svg></div>';
  astEqual(t, b.template([element('div', ['body', element('svg')])]));
});

let integrationPoints = ['foreignObject', 'desc'];
function buildIntegrationPointTest(integrationPoint: string) {
  return function integrationPointTest() {
    let t = '<svg><' + integrationPoint + '><div></div></' + integrationPoint + '></svg>';
    astEqual(
      t,
      b.template([element('svg', ['body', element(integrationPoint, ['body', element('div')])])])
    );
  };
}

for (const integrationPoint of integrationPoints) {
  test(
    'svg content with html content inline for ' + integrationPoint,
    buildIntegrationPointTest(integrationPoint)
  );
}

test('svg title with html content', () => {
  let t = '<svg><title><div></div></title></svg>';
  astEqual(
    t,
    b.template([element('svg', ['body', element('title', ['body', b.text('<div></div>')])])])
  );
});

test('a piece of content with HTML', () => {
  let t = 'some <div>content</div> done';
  astEqual(
    t,
    b.template([b.text('some '), element('div', ['body', b.text('content')]), b.text(' done')])
  );
});

test('a piece of Handlebars with HTML', () => {
  let t = 'some <div>{{content}}</div> done';
  astEqual(
    t,
    b.template([
      b.text('some '),
      element('div', ['body', b.mustache(b.path('content'))]),
      b.text(' done'),
    ])
  );
});

test('attributes are not allowed as values', (assert) => {
  let t = '{{...attributes}}';
  assert.throws(
    () => {
      parse(t, { meta: { moduleName: 'test-module' } });
    },
    syntaxErrorFor('Illegal use of ...attributes', '{{...attributes}}', 'test-module', 1, 0)
  );
});

test('attributes are not allowed as modifiers', (assert) => {
  let t = '<div {{...attributes}}></div>';
  assert.throws(
    () => {
      parse(t, { meta: { moduleName: 'test-module' } });
    },
    syntaxErrorFor('Illegal use of ...attributes', '{{...attributes}}', 'test-module', 1, 5)
  );
});

test('attributes are not allowed as attribute values', (assert) => {
  let t = '<div class={{...attributes}}></div>';
  assert.throws(
    () => {
      parse(t, { meta: { moduleName: 'test-module' } });
    },
    syntaxErrorFor('Illegal use of ...attributes', '{{...attributes}}', 'test-module', 1, 11)
  );
});

test('Handlebars embedded in an attribute (quoted)', () => {
  let t = 'some <div class="{{foo}}">content</div> done';
  astEqual(
    t,
    b.template([
      b.text('some '),
      element(
        'div',
        ['attrs', ['class', b.concat([b.mustache('foo')])]],
        ['body', b.text('content')]
      ),
      b.text(' done'),
    ])
  );
});

test('Handlebars embedded in an attribute (unquoted)', () => {
  let t = 'some <div class={{foo}}>content</div> done';
  astEqual(
    t,
    b.template([
      b.text('some '),
      element('div', ['attrs', ['class', b.mustache(b.path('foo'))]], ['body', b.text('content')]),
      b.text(' done'),
    ])
  );
});

test('Handlebars embedded in an attribute of a self-closing tag (unqouted)', () => {
  let t = '<input value={{foo}}/>';

  let el = element('input/', ['attrs', ['value', b.mustache(b.path('foo'))]]);
  astEqual(t, b.template([el]));
});

test('Handlebars embedded in an attribute (sexprs)', () => {
  let t = 'some <div class="{{foo (foo "abc")}}">content</div> done';
  astEqual(
    t,
    b.template([
      b.text('some '),
      element(
        'div',
        [
          'attrs',
          [
            'class',
            b.concat([b.mustache(b.path('foo'), [b.sexpr(b.path('foo'), [b.string('abc')])])]),
          ],
        ],
        ['body', b.text('content')]
      ),
      b.text(' done'),
    ])
  );
});

test('Handlebars embedded in an attribute with other content surrounding it', () => {
  let t = 'some <a href="http://{{link}}/">content</a> done';
  astEqual(
    t,
    b.template([
      b.text('some '),
      element(
        'a',
        ['attrs', ['href', b.concat([b.text('http://'), b.mustache('link'), b.text('/')])]],
        ['body', b.text('content')]
      ),
      b.text(' done'),
    ])
  );
});

test('A more complete embedding example', () => {
  let t =
    "{{embed}} {{some 'content'}} " +
    "<div class='{{foo}} {{bind-class isEnabled truthy='enabled'}}'>{{ content }}</div>" +
    " {{more 'embed'}}";
  astEqual(
    t,
    b.template([
      b.mustache(b.path('embed')),
      b.text(' '),
      b.mustache(b.path('some'), [b.string('content')]),
      b.text(' '),
      element(
        'div',
        [
          'attrs',
          [
            'class',
            b.concat([
              b.mustache('foo'),
              b.text(' '),
              b.mustache(
                'bind-class',
                [b.path('isEnabled')],
                b.hash([b.pair('truthy', b.string('enabled'))])
              ),
            ]),
          ],
        ],
        ['body', b.mustache(b.path('content'))]
      ),
      b.text(' '),
      b.mustache(b.path('more'), [b.string('embed')]),
    ])
  );
});

test('Simple embedded block helpers', () => {
  let t = '{{#if foo}}<div>{{content}}</div>{{/if}}';
  astEqual(
    t,
    b.template([
      b.block(
        b.path('if'),
        [b.path('foo')],
        b.hash(),
        b.blockItself([element('div', ['body', b.mustache(b.path('content'))])])
      ),
    ])
  );
});

test('Involved block helper', () => {
  let t =
    '<p>hi</p> content {{#testing shouldRender}}<p>Appears!</p>{{/testing}} more <em>content</em> here';
  astEqual(
    t,
    b.template([
      element('p', ['body', b.text('hi')]),
      b.text(' content '),
      b.block(
        b.path('testing'),
        [b.path('shouldRender')],
        b.hash(),
        b.blockItself([element('p', ['body', b.text('Appears!')])])
      ),
      b.text(' more '),
      element('em', ['body', b.text('content')]),
      b.text(' here'),
    ])
  );
});

test('block with block params', () => {
  let t = `{{#foo as |bar bat baz|}}{{bar}} {{bat}} {{baz}}{{/foo}}`;

  astEqual(
    t,
    b.template([
      b.block(
        b.path('foo'),
        null,
        null,
        b.blockItself(
          [b.mustache('bar'), b.text(' '), b.mustache('bat'), b.text(' '), b.mustache('baz')],
          ['bar', 'bat', 'baz']
        )
      ),
    ])
  );
});

test('block with block params edge case: extra spaces', () => {
  let t = `{{#foo as | bar bat baz |}}{{bar}} {{bat}} {{baz}}{{/foo}}`;

  astEqual(
    t,
    b.template([
      b.block(
        b.path('foo'),
        null,
        null,
        b.blockItself(
          [b.mustache('bar'), b.text(' '), b.mustache('bat'), b.text(' '), b.mustache('baz')],
          ['bar', 'bat', 'baz']
        )
      ),
    ])
  );
});

test('block with block params edge case: multiline', () => {
  let t = `{{#foo as
|bar bat
      b
a
      z|}}{{bar}} {{bat}} {{baz}}{{/foo}}`;

  astEqual(
    t,
    b.template([
      b.block(
        b.path('foo'),
        null,
        null,
        b.blockItself(
          [b.mustache('bar'), b.text(' '), b.mustache('bat'), b.text(' '), b.mustache('baz')],
          ['bar', 'bat', 'b', 'a', 'z']
        )
      ),
    ])
  );
});

test('block with block params edge case: block-params like params', () => {
  let t = `{{#foo "as |a b c|" as |bar bat baz|}}{{bar}} {{bat}} {{baz}}{{/foo}}`;

  astEqual(
    t,
    b.template([
      b.block(
        b.path('foo'),
        [b.string('as |a b c|')],
        null,
        b.blockItself(
          [b.mustache('bar'), b.text(' '), b.mustache('bat'), b.text(' '), b.mustache('baz')],
          ['bar', 'bat', 'baz']
        )
      ),
    ])
  );
});

test('block with block params edge case: block-params like content', () => {
  let t = `{{#foo as |bar bat baz|}}as |a b c|{{/foo}}`;

  astEqual(
    t,
    b.template([
      b.block(
        b.path('foo'),
        null,
        null,
        b.blockItself([b.text('as |a b c|')], ['bar', 'bat', 'baz'])
      ),
    ])
  );
});

test('element with block params', () => {
  let t = `<Foo as |bar bat baz|>{{bar}} {{bat}} {{baz}}</Foo>`;

  astEqual(
    t,
    b.template([
      element(
        'Foo',
        ['as', b.var('bar'), b.var('bat'), b.var('baz')],
        ['body', b.mustache('bar'), b.text(' '), b.mustache('bat'), b.text(' '), b.mustache('baz')]
      ),
    ])
  );
});

test('element with block params edge case: extra spaces', () => {
  let t = `<Foo as | bar bat baz |>{{bar}} {{bat}} {{baz}}</Foo>`;

  astEqual(
    t,
    b.template([
      element(
        'Foo',
        ['as', b.var('bar'), b.var('bat'), b.var('baz')],
        ['body', b.mustache('bar'), b.text(' '), b.mustache('bat'), b.text(' '), b.mustache('baz')]
      ),
    ])
  );
});

test('element with block params edge case: multiline', () => {
  let t = `<Foo as
|bar bat
      b
a
      z|>{{bar}} {{bat}} {{baz}}</Foo>`;

  astEqual(
    t,
    b.template([
      element(
        'Foo',
        ['as', b.var('bar'), b.var('bat'), b.var('b'), b.var('a'), b.var('z')],
        ['body', b.mustache('bar'), b.text(' '), b.mustache('bat'), b.text(' '), b.mustache('baz')]
      ),
    ])
  );
});

test('element with block params edge case: block-params like attribute names', () => {
  let t = `<Foo as="a" async="b" as |bar bat baz|>as |a b c|</Foo>`;

  astEqual(
    t,
    b.template([
      element(
        'Foo',
        ['attrs', ['as', 'a'], ['async', 'b']],
        ['as', b.var('bar'), b.var('bat'), b.var('baz')],
        ['body', b.text('as |a b c|')]
      ),
    ])
  );
});

test('element with block params edge case: block-params like attribute values', () => {
  let t = `<Foo foo="as |a b c|" as |bar bat baz|>{{bar}} {{bat}} {{baz}}</Foo>`;

  astEqual(
    t,
    b.template([
      element(
        'Foo',
        ['attrs', ['foo', 'as |a b c|']],
        ['as', b.var('bar'), b.var('bat'), b.var('baz')],
        ['body', b.mustache('bar'), b.text(' '), b.mustache('bat'), b.text(' '), b.mustache('baz')]
      ),
    ])
  );
});

test('element with block params edge case: block-params like content', () => {
  let t = `<Foo as |bar bat baz|>as |a b c|</Foo>`;

  astEqual(
    t,
    b.template([
      element(
        'Foo',
        ['as', b.var('bar'), b.var('bat'), b.var('baz')],
        ['body', b.text('as |a b c|')]
      ),
    ])
  );
});

test('Element modifiers', () => {
  let t = "<p {{action 'boom'}} class='bar'>Some content</p>";
  astEqual(
    t,
    b.template([
      element(
        'p',
        ['attrs', ['class', 'bar']],
        ['modifiers', ['action', [b.string('boom')]]],
        ['body', b.text('Some content')]
      ),
    ])
  );
});

test('Tokenizer: MustacheStatement encountered in beforeAttributeName state', () => {
  let t = '<input {{bar}}>';
  astEqual(t, b.template([element('input', ['modifiers', 'bar'])]));
});

test('Tokenizer: MustacheStatement encountered in attributeName state', () => {
  let t = '<input foo{{bar}}>';
  astEqual(t, b.template([element('input', ['attrs', ['foo', '']], ['modifiers', ['bar']])]));
});

test('Tokenizer: MustacheStatement encountered in afterAttributeName state', () => {
  let t = '<input foo {{bar}}>';
  astEqual(t, b.template([element('input', ['attrs', ['foo', '']], ['modifiers', 'bar'])]));
});

test('Tokenizer: MustacheStatement encountered in afterAttributeValue state', () => {
  let t = '<input foo=1 {{bar}}>';
  astEqual(t, b.template([element('input', ['attrs', ['foo', '1']], ['modifiers', ['bar']])]));
});

test('Tokenizer: MustacheStatement encountered in afterAttributeValueQuoted state', () => {
  let t = "<input foo='1'{{bar}}>";
  astEqual(t, b.template([element('input', ['attrs', ['foo', '1']], ['modifiers', 'bar'])]));
});

test('Stripping - mustaches', () => {
  let t = 'foo {{~content}} bar';
  astEqual(
    t,
    b.template([
      b.text('foo'),
      b.mustache(b.path('content'), undefined, undefined, undefined, undefined, {
        open: true,
        close: false,
      }),
      b.text(' bar'),
    ])
  );

  t = 'foo {{content~}} bar';
  astEqual(
    t,
    b.template([
      b.text('foo '),
      b.mustache(b.path('content'), undefined, undefined, undefined, undefined, {
        open: false,
        close: true,
      }),
      b.text('bar'),
    ])
  );
});

test('Stripping - blocks', () => {
  let t = 'foo {{~#wat}}{{/wat}} bar';
  astEqual(
    t,
    b.template([
      b.text('foo'),
      b.block(b.path('wat'), [], b.hash(), b.blockItself(), undefined, undefined, {
        open: true,
        close: false,
      }),
      b.text(' bar'),
    ])
  );

  t = 'foo {{#wat}}{{/wat~}} bar';
  astEqual(
    t,
    b.template([
      b.text('foo '),
      b.block(
        b.path('wat'),
        [],
        b.hash(),
        b.blockItself(),
        undefined,
        undefined,
        undefined,
        undefined,
        { open: false, close: true }
      ),
      b.text('bar'),
    ])
  );
});

test('Stripping - programs', () => {
  let t = '{{#wat~}} foo {{else}}{{/wat}}';
  astEqual(
    t,
    b.template([
      b.block(
        b.path('wat'),
        [],
        b.hash(),
        b.blockItself([b.text('foo ')]),
        b.blockItself(),
        undefined,
        { open: false, close: true }
      ),
    ])
  );

  t = '{{#wat}} foo {{~else}}{{/wat}}';
  astEqual(
    t,
    b.template([
      b.block(
        b.path('wat'),
        [],
        b.hash(),
        b.blockItself([b.text(' foo')]),
        b.blockItself(),
        undefined,
        undefined,
        { open: true, close: false }
      ),
    ])
  );

  t = '{{#wat}}{{else~}} foo {{/wat}}';
  astEqual(
    t,
    b.template([
      b.block(
        b.path('wat'),
        [],
        b.hash(),
        b.blockItself(),
        b.blockItself([b.text('foo ')]),
        undefined,
        undefined,
        { open: false, close: true }
      ),
    ])
  );

  t = '{{#wat}}{{else}} foo {{~/wat}}';
  astEqual(
    t,
    b.template([
      b.block(
        b.path('wat'),
        [],
        b.hash(),
        b.blockItself(),
        b.blockItself([b.text(' foo')]),
        undefined,
        undefined,
        undefined,
        { open: true, close: false }
      ),
    ])
  );
});

test('Stripping - removes unnecessary text nodes', () => {
  let t = '{{#each~}}\n  <li> foo </li>\n{{~/each}}';

  astEqual(
    t,
    b.template([
      b.block(
        b.path('each'),
        [],
        b.hash(),
        b.blockItself([element('li', ['body', b.text(' foo ')])]),
        null,
        undefined,
        { open: false, close: true },
        undefined,
        { open: true, close: false }
      ),
    ])
  );
});

test('Whitespace control - linebreaks after blocks removed by default', () => {
  let t = '{{#each}}\n  <li> foo </li>\n{{/each}}';

  astEqual(
    t,
    b.template([
      b.block(
        b.path('each'),
        [],
        b.hash(),
        b.blockItself([b.text('  '), element('li', ['body', b.text(' foo ')]), b.text('\n')]),
        null
      ),
    ])
  );
});

test('Whitespace control - preserve all whitespace if config is set', () => {
  let t = '{{#each}}\n  <li> foo </li>\n{{/each}}';

  astEqual(
    t,
    b.template([
      b.block(
        b.path('each'),
        [],
        b.hash(),
        b.blockItself([b.text('\n  '), element('li', ['body', b.text(' foo ')]), b.text('\n')]),
        null
      ),
    ]),
    undefined,
    {
      parseOptions: { ignoreStandalone: true },
    }
  );
});

// TODO: Make these throw an error.
test('Awkward mustache in unquoted attribute value', (assert) => {
  assert.throws(
    () => {
      parse('<div class=a{{foo}}></div>', {
        meta: { moduleName: 'test-module' },
      });
    },
    syntaxErrorFor(
      `An unquoted attribute value must be a string or a mustache, preceded by whitespace or a '=' character, and followed by whitespace, a '>' character, or '/>'`,
      'class=a{{foo}}',
      'test-module',
      1,
      5
    )
  );

  assert.throws(
    () => {
      parse('<div class=a{{foo}}b></div>', {
        meta: { moduleName: 'test-module' },
      });
    },
    syntaxErrorFor(
      `An unquoted attribute value must be a string or a mustache, preceded by whitespace or a '=' character, and followed by whitespace, a '>' character, or '/>'`,
      'class=a{{foo}}b',
      'test-module',
      1,
      5
    )
  );

  assert.throws(
    () => {
      parse('<div class={{foo}}b></div>', {
        meta: { moduleName: 'test-module' },
      });
    },
    syntaxErrorFor(
      `An unquoted attribute value must be a string or a mustache, preceded by whitespace or a '=' character, and followed by whitespace, a '>' character, or '/>'`,
      'class={{foo}}b',
      'test-module',
      1,
      5
    )
  );
});

test('an HTML comment', () => {
  let t = 'before <!-- some comment --> after';
  astEqual(t, b.template([b.text('before '), b.comment(' some comment '), b.text(' after')]));
});

test('a Handlebars comment inside an HTML comment', () => {
  let t = 'before <!-- some {{! nested thing }} comment --> after';
  astEqual(
    t,
    b.template([
      b.text('before '),
      b.comment(' some {{! nested thing }} comment '),
      b.text(' after'),
    ])
  );
});

test('a Handlebars comment', () => {
  let t = 'before {{! some comment }} after';
  astEqual(
    t,
    b.template([b.text('before '), b.mustacheComment(' some comment '), b.text(' after')])
  );
});

test('a Handlebars comment with whitespace removal', function () {
  let t = 'before {{~! some comment ~}} after';
  astEqual(t, b.program([b.text('before'), b.mustacheComment(' some comment '), b.text('after')]));
});

test('a Handlebars comment in proper element space', () => {
  let t = 'before <div {{! some comment }} data-foo="bar" {{! other comment }}></div> after';
  astEqual(
    t,
    b.template([
      b.text('before '),
      element(
        'div',
        ['attrs', ['data-foo', b.text('bar')]],
        ['comments', b.mustacheComment(' some comment '), b.mustacheComment(' other comment ')]
      ),
      b.text(' after'),
    ])
  );
});

test('a Handlebars comment after a valueless attribute', () => {
  let t = '<input foo {{! comment }}>';
  astEqual(
    t,
    b.template([
      element('input', ['attrs', ['foo', '']], ['comments', b.mustacheComment(' comment ')]),
    ])
  );
});

test('a Handlebars comment in invalid element space', (assert) => {
  assert.throws(
    () => {
      parse('\nbefore <div \n  a{{! some comment }} data-foo="bar"></div> after', {
        meta: { moduleName: 'test-module' },
      });
    },
    syntaxErrorFor(
      'Using a Handlebars comment when in the `attributeName` state is not supported',
      '{{! some comment }}',
      'test-module',
      3,
      3
    )
  );

  assert.throws(
    () => {
      parse('\nbefore <div \n  a={{! some comment }} data-foo="bar"></div> after', {
        meta: { moduleName: 'test-module' },
      });
    },
    syntaxErrorFor(
      'Using a Handlebars comment when in the `beforeAttributeValue` state is not supported',
      '{{! some comment }}',
      'test-module',
      3,
      4
    )
  );

  assert.throws(
    () => {
      parse('\nbefore <div \n  a="{{! some comment }}" data-foo="bar"></div> after', {
        meta: { moduleName: 'test-module' },
      });
    },
    syntaxErrorFor(
      'Using a Handlebars comment when in the `attributeValueDoubleQuoted` state is not supported',
      '{{! some comment }}',
      'test-module',
      3,
      5
    )
  );
});

test('allow {{null}} to be passed as helper name', () => {
  let ast = parse('{{null}}');

  astEqual(ast, b.template([b.mustache(b.null())]));
});

test('allow {{null}} to be passed as a param', () => {
  let ast = parse('{{foo null}}');

  astEqual(ast, b.template([b.mustache(b.path('foo'), [b.null()])]));
});

test('allow {{undefined}} to be passed as helper name', () => {
  let ast = parse('{{undefined}}');

  astEqual(ast, b.template([b.mustache(b.undefined())]));
});

test('allow {{undefined}} to be passed as a param', () => {
  let ast = parse('{{foo undefined}}');

  astEqual(ast, b.template([b.mustache(b.path('foo'), [b.undefined()])]));
});

test('Handlebars partial should error', (assert) => {
  assert.throws(
    () => {
      parse('{{> foo}}', { meta: { moduleName: 'test-module' } });
    },
    syntaxErrorFor('Handlebars partials are not supported', '{{> foo}}', 'test-module', 1, 0)
  );
});

test('Handlebars partial block should error', (assert) => {
  assert.throws(
    () => {
      parse('{{#> foo}}{{/foo}}', { meta: { moduleName: 'test-module' } });
    },
    syntaxErrorFor(
      'Handlebars partial blocks are not supported',
      '{{#> foo}}{{/foo}}',
      'test-module',
      1,
      0
    )
  );
});

test('Handlebars decorator should error', (assert) => {
  assert.throws(
    () => {
      parse('{{* foo}}', { meta: { moduleName: 'test-module' } });
    },
    syntaxErrorFor('Handlebars decorators are not supported', '{{* foo}}', 'test-module', 1, 0)
  );
});

test('Handlebars decorator block should error', (assert) => {
  assert.throws(
    () => {
      parse('{{#* foo}}{{/foo}}', { meta: { moduleName: 'test-module' } });
    },
    syntaxErrorFor(
      'Handlebars decorator blocks are not supported',
      '{{#* foo}}{{/foo}}',
      'test-module',
      1,
      0
    )
  );
});

test('disallowed mustaches in the tagName space', (assert) => {
  assert.throws(
    () => {
      parse('<{{"asdf"}}></{{"asdf"}}>', { meta: { moduleName: 'test-module' } });
    },
    syntaxErrorFor('Cannot use mustaches in an elements tagname', '{{"asdf"}}', 'test-module', 1, 1)
  );

  assert.throws(
    () => {
      parse('<input{{bar}}>', { meta: { moduleName: 'test-module' } });
    },
    syntaxErrorFor('Cannot use mustaches in an elements tagname', '{{bar}}', 'test-module', 1, 6)
  );
});

test('mustache immediately followed by self closing tag does not error', () => {
  let ast = parse('<FooBar data-foo={{blah}}/>');
  let el = element('FooBar/', ['attrs', ['data-foo', b.mustache('blah')]]);
  astEqual(ast, b.template([el]));
});

QUnit.dump.maxDepth = 100;

test('named blocks', () => {
  let ast = parse(strip`
    <Tab>
      <:header>
        It's a header!
      </:header>

      <:body as |contents|>
        <div>{{contents}}</div>
      </:body>
    </Tab>
  `);

  let el = element('Tab', [
    'body',
    element(':header', ['body', b.text(`It's a header!`)]),
    element(
      ':body',
      ['body', element('div', ['body', b.mustache('contents')])],
      ['as', b.var('contents')]
    ),
  ]);
  astEqual(ast, b.template([el]));
});

test('path expression with "dangling dot" throws error', (assert) => {
  assert.throws(
    () => {
      parse('{{if foo. bar baz}}', { meta: { moduleName: 'test-module' } });
    },
    syntaxErrorFor(
      "'.' is not a supported path in Glimmer; check for a path with a trailing '.'",
      '.',
      'test-module',
      1,
      8
    )
  );
});

test('string literal as path throws error', (assert) => {
  assert.throws(
    () => {
      parse('{{("foo-baz")}}', { meta: { moduleName: 'test-module' } });
    },
    syntaxErrorFor(
      `StringLiteral "foo-baz" cannot be called as a sub-expression, replace ("foo-baz") with "foo-baz"`,
      '"foo-baz"',
      'test-module',
      1,
      3
    )
  );
});

test('boolean literal as path throws error', (assert) => {
  assert.throws(
    () => {
      parse('{{(true)}}', { meta: { moduleName: 'test-module' } });
    },
    syntaxErrorFor(
      `BooleanLiteral "true" cannot be called as a sub-expression, replace (true) with true`,
      'true',
      'test-module',
      1,
      3
    )
  );
});

test('undefined literal as path throws error', (assert) => {
  assert.throws(
    () => {
      parse('{{(undefined)}}', { meta: { moduleName: 'test-module' } });
    },
    syntaxErrorFor(
      `UndefinedLiteral "undefined" cannot be called as a sub-expression, replace (undefined) with undefined`,
      'undefined',
      'test-module',
      1,
      3
    )
  );
});

test('null literal as path throws error', (assert) => {
  assert.throws(
    () => {
      parse('{{(null)}}', { meta: { moduleName: 'test-module' } });
    },
    syntaxErrorFor(
      `NullLiteral "null" cannot be called as a sub-expression, replace (null) with null`,
      'null',
      'test-module',
      1,
      3
    )
  );
});

test('number literal as path throws error', (assert) => {
  assert.throws(
    () => {
      parse('{{(42)}}', { meta: { moduleName: 'test-module' } });
    },
    syntaxErrorFor(
      `NumberLiteral "42" cannot be called as a sub-expression, replace (42) with 42`,
      '42',
      'test-module',
      1,
      3
    )
  );
});

// ── Backslash escape sequences ─────────────────────────────────────────────────
// These tests document the Jison-matching escape behaviour of unified-scanner.ts.
// See: packages/@glimmer/syntax/lib/parser/unified-scanner.ts § scanTextNode

QUnit.module('[glimmer-syntax] Parser - backslash escape sequences');

// k=1: \{{ → escape. Backslash consumed, {{content}} becomes literal text.
test('\\{{ produces literal {{ in a TextNode', () => {
  // Input file: \{{foo}}
  astEqual('\\{{foo}}', b.template([b.text('{{foo}}')]));
});

test('\\{{ merges escaped content with following text (emu-state behaviour)', () => {
  // Input file: \{{foo}} bar baz  →  one TextNode: "{{foo}} bar baz"
  astEqual('\\{{foo}} bar baz', b.template([b.text('{{foo}} bar baz')]));
});

test('text before \\{{ is emitted as a separate TextNode', () => {
  // Input file: prefix\{{foo}} suffix  →  "prefix" + "{{foo}} suffix"
  astEqual('prefix\\{{foo}} suffix', b.template([b.text('prefix'), b.text('{{foo}} suffix')]));
});

test('\\{{ followed by a real mustache stops the emu-state merge', () => {
  // Input file: \{{foo}}{{bar}}  →  TextNode "{{foo}}" + MustacheStatement bar
  astEqual('\\{{foo}}{{bar}}', b.template([b.text('{{foo}}'), b.mustache(b.path('bar'))]));
});

test('emu-state merge stops at \\{{ (another escape)', () => {
  // Input file: \{{foo}} text \{{bar}} done {{baz}}
  // → TextNode "{{foo}} text " + TextNode "{{bar}} done " + Mustache baz
  astEqual(
    '\\{{foo}} text \\{{bar}} done {{baz}}',
    b.template([b.text('{{foo}} text '), b.text('{{bar}} done '), b.mustache(b.path('baz'))])
  );
});

// k=2: \\{{ → real mustache, ONE literal backslash emitted as TextNode.
test('\\\\{{ emits one literal backslash and a real mustache', () => {
  // Input file: \\{{foo}}  →  TextNode "\" + MustacheStatement foo
  astEqual('\\\\{{foo}}', b.template([b.text('\\'), b.mustache(b.path('foo'))]));
});

// k=3: \\\{{ → real mustache, TWO literal backslashes emitted as TextNode.
test('\\\\\\{{ emits two literal backslashes and a real mustache', () => {
  // Input file: \\\{{foo}}  →  TextNode "\\" + MustacheStatement foo
  astEqual('\\\\\\{{foo}}', b.template([b.text('\\\\'), b.mustache(b.path('foo'))]));
});

test('full escaped.hbs sequence produces correct AST', () => {
  // Input file (raw):
  //   an escaped mustache:\n\{{my-component}}\na non-escaped mustache:\n\\{{my-component}}\nanother non-escaped mustache:\n\\\{{my-component}}\n
  const input =
    'an escaped mustache:\n\\{{my-component}}\na non-escaped mustache:\n' +
    '\\\\{{my-component}}\nanother non-escaped mustache:\n\\\\\\{{my-component}}\n';
  astEqual(
    input,
    b.template([
      b.text('an escaped mustache:\n'),
      b.text('{{my-component}}\na non-escaped mustache:\n'),
      b.text('\\'),
      b.mustache(b.path('my-component')),
      b.text('\nanother non-escaped mustache:\n\\\\'),
      b.mustache(b.path('my-component')),
      b.text('\n'),
    ])
  );
});

// ── Inside HTML elements ───────────────────────────────────────────────────────

test('\\{{ in element text content produces literal {{', () => {
  // Input file: <div>\{{foo}}</div>
  astEqual('<div>\\{{foo}}</div>', b.template([element('div', ['body', b.text('{{foo}}')])]));
});

test('\\\\{{ in element text content produces one backslash + real mustache', () => {
  // Input file: <div>\\{{foo}}</div>
  astEqual(
    '<div>\\\\{{foo}}</div>',
    b.template([element('div', ['body', b.text('\\'), b.mustache(b.path('foo'))])])
  );
});

// ── Inside quoted attribute values ─────────────────────────────────────────────

test('\\{{ inside a quoted attribute value emits {{ as literal text', () => {
  // Input file: <div title="foo \{{"></div>
  // The attr value TextNode should have chars "foo {{"
  const ast = parse('<div title="foo \\{{"></div>');
  const el = ast.body[0] as ASTv1.ElementNode;
  const attr = el.attributes[0] as ASTv1.AttrNode;
  const value = attr.value as ASTv1.TextNode;
  QUnit.assert.strictEqual(value.chars, 'foo {{');
});

// ── Backslash NOT before {{ passes through unchanged ───────────────────────────

test('plain backslash not before {{ is preserved in text', () => {
  // Input file: foo\bar  →  TextNode "foo\bar"
  astEqual('foo\\bar', b.template([b.text('foo\\bar')]));
});

test('double backslash not before {{ is preserved in text', () => {
  // Input file: foo\\bar  →  TextNode "foo\\bar"
  astEqual('foo\\\\bar', b.template([b.text('foo\\\\bar')]));
});

test('triple backslash not before {{ is preserved in text (backslashes.hbs)', () => {
  // Input file: <p>\\\</p>  →  TextNode "\\\"
  astEqual('<p>\\\\\\</p>', b.template([element('p', ['body', b.text('\\\\\\')])]));
});

test('triple backslash + \\\\{{ in element text (backslashes.hbs)', () => {
  // Input file: <p>\\\ \\{{foo}}</p>  →  TextNode "\\\ \" + Mustache foo
  astEqual(
    '<p>\\\\\\ \\\\{{foo}}</p>',
    b.template([element('p', ['body', b.text('\\\\\\ \\'), b.mustache(b.path('foo'))])])
  );
});

test('plain backslash in attribute value is preserved (backslashes-in-attributes.hbs)', () => {
  // Input file: <p data-attr="backslash \ in an attribute"></p>
  const ast = parse('<p data-attr="backslash \\\\ in an attribute"></p>');
  const attr = (ast.body[0] as ASTv1.ElementNode).attributes[0] as ASTv1.AttrNode;
  QUnit.assert.strictEqual((attr.value as ASTv1.TextNode).chars, 'backslash \\\\ in an attribute');
});

test('\\{{ in quoted class attribute value (mustache.hbs)', () => {
  // Input file: <div class=" bar \{{">  →  attr value TextNode " bar {{"
  const ast = parse('<div class=" bar \\{{"></div>');
  const attr = (ast.body[0] as ASTv1.ElementNode).attributes[0] as ASTv1.AttrNode;
  QUnit.assert.strictEqual((attr.value as ASTv1.TextNode).chars, ' bar {{');
});

// ── Unclosed escape (\\{{ with no }}) ─────────────────────────────────────────

test('\\{{ without closing }} emits {{ and following text up to end', () => {
  // Input file: \{{ unclosed  →  TextNode "{{ unclosed"
  astEqual('\\{{ unclosed', b.template([b.text('{{ unclosed')]));
});

test('\\{{ without closing }} stops at < (HTML element boundary)', () => {
  // Input file: <div>\{{ unclosed</div>
  // The escape has no }}, so it emits {{ ... up to the < of </div>
  astEqual(
    '<div>\\{{ unclosed</div>',
    b.template([element('div', ['body', b.text('{{ unclosed')])])
  );
});

// ── Ported from @handlebars/parser spec/parser.js ─────────────────────────────

QUnit.module('[glimmer-syntax] Parser - HBS spec (ported from @handlebars/parser)');

// ── Simple mustaches ──────────────────────────────────────────────────────────

test('parses a number literal mustache', (assert) => {
  const ast = parse('{{123}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual((m.path as ASTv1.NumberLiteral).value, 123);
});

test('parses a string literal mustache', (assert) => {
  const ast = parse('{{"foo"}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual((m.path as ASTv1.StringLiteral).value, 'foo');
});

test('parses a false boolean literal mustache', (assert) => {
  const ast = parse('{{false}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual((m.path as ASTv1.BooleanLiteral).value, false);
});

test('parses a true boolean literal mustache', (assert) => {
  const ast = parse('{{true}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual((m.path as ASTv1.BooleanLiteral).value, true);
});

test('parses a simple path mustache', (assert) => {
  const ast = parse('{{foo}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual((m.path as ASTv1.PathExpression).original, 'foo');
});

test('parses a path mustache with ? suffix', (assert) => {
  const ast = parse('{{foo?}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual((m.path as ASTv1.PathExpression).original, 'foo?');
});

test('parses a path mustache with _ suffix', (assert) => {
  const ast = parse('{{foo_}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual((m.path as ASTv1.PathExpression).original, 'foo_');
});

test('parses a path mustache with - suffix', (assert) => {
  const ast = parse('{{foo-}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual((m.path as ASTv1.PathExpression).original, 'foo-');
});

test('parses a path mustache with : suffix', (assert) => {
  const ast = parse('{{foo:}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual((m.path as ASTv1.PathExpression).original, 'foo:');
});

// ── Data (@) paths ────────────────────────────────────────────────────────────

test('parses @foo data path', (assert) => {
  const ast = parse('{{@foo}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual((m.path as ASTv1.PathExpression).original, '@foo');
});

// ── Paths with separators ─────────────────────────────────────────────────────

test('parses foo/bar path (slash separator)', (assert) => {
  const ast = parse('{{foo/bar}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual((m.path as ASTv1.PathExpression).original, 'foo/bar');
});

test('parses foo.bar path (dot separator)', (assert) => {
  const ast = parse('{{foo.bar}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual((m.path as ASTv1.PathExpression).original, 'foo.bar');
});

test('parses this.foo path', (assert) => {
  const ast = parse('{{this.foo}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual((m.path as ASTv1.PathExpression).original, 'this.foo');
});

test('parses foo-bar path (dash in identifier)', (assert) => {
  const ast = parse('{{foo-bar}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual((m.path as ASTv1.PathExpression).original, 'foo-bar');
});

// ── Mustaches with params ─────────────────────────────────────────────────────

test('parses mustache with a path param', (assert) => {
  const ast = parse('{{foo bar}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual((m.path as ASTv1.PathExpression).original, 'foo');
  assert.strictEqual((m.params[0] as ASTv1.PathExpression).original, 'bar');
});

test('parses mustache with dotted path and a path param', (assert) => {
  const ast = parse('{{this.foo bar}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual((m.path as ASTv1.PathExpression).original, 'this.foo');
  assert.strictEqual((m.params[0] as ASTv1.PathExpression).original, 'bar');
});

test('parses mustache with a path param and a string param', (assert) => {
  const ast = parse('{{foo bar "baz"}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual((m.path as ASTv1.PathExpression).original, 'foo');
  assert.strictEqual((m.params[0] as ASTv1.PathExpression).original, 'bar');
  assert.strictEqual((m.params[1] as ASTv1.StringLiteral).value, 'baz');
});

test('parses mustache with a number param', (assert) => {
  const ast = parse('{{foo 1}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual((m.params[0] as ASTv1.NumberLiteral).value, 1);
});

test('parses mustache with a true boolean param', (assert) => {
  const ast = parse('{{foo true}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual((m.params[0] as ASTv1.BooleanLiteral).value, true);
});

test('parses mustache with a false boolean param', (assert) => {
  const ast = parse('{{foo false}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual((m.params[0] as ASTv1.BooleanLiteral).value, false);
});

test('parses {{undefined}} as UndefinedLiteral mustache', (assert) => {
  const ast = parse('{{undefined}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual(m.path.type, 'UndefinedLiteral');
});

test('parses {{null}} as NullLiteral mustache', (assert) => {
  const ast = parse('{{null}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual(m.path.type, 'NullLiteral');
});

test('parses mustache with undefined and null params', (assert) => {
  const ast = parse('{{foo undefined null}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual(m.params[0]!.type, 'UndefinedLiteral');
  assert.strictEqual(m.params[1]!.type, 'NullLiteral');
});

test('parses mustache with @data param', (assert) => {
  const ast = parse('{{foo @bar}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual((m.params[0] as ASTv1.PathExpression).original, '@bar');
});

// ── Hash arguments ────────────────────────────────────────────────────────────

test('parses hash with a path value', (assert) => {
  const ast = parse('{{foo bar=baz}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  const pair = m.hash.pairs[0]!;
  assert.strictEqual(pair.key, 'bar');
  assert.strictEqual((pair.value as ASTv1.PathExpression).original, 'baz');
});

test('parses hash with a number value', (assert) => {
  const ast = parse('{{foo bar=1}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  const pair = m.hash.pairs[0]!;
  assert.strictEqual((pair.value as ASTv1.NumberLiteral).value, 1);
});

test('parses hash with a true boolean value', (assert) => {
  const ast = parse('{{foo bar=true}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  const pair = m.hash.pairs[0]!;
  assert.strictEqual((pair.value as ASTv1.BooleanLiteral).value, true);
});

test('parses hash with a false boolean value', (assert) => {
  const ast = parse('{{foo bar=false}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  const pair = m.hash.pairs[0]!;
  assert.strictEqual((pair.value as ASTv1.BooleanLiteral).value, false);
});

test('parses hash with a @data value', (assert) => {
  const ast = parse('{{foo bar=@baz}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  const pair = m.hash.pairs[0]!;
  assert.strictEqual((pair.value as ASTv1.PathExpression).original, '@baz');
});

test('parses hash with multiple pairs', (assert) => {
  const ast = parse('{{foo bar=baz bat=bam}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual(m.hash.pairs[0]!.key, 'bar');
  assert.strictEqual((m.hash.pairs[0]!.value as ASTv1.PathExpression).original, 'baz');
  assert.strictEqual(m.hash.pairs[1]!.key, 'bat');
  assert.strictEqual((m.hash.pairs[1]!.value as ASTv1.PathExpression).original, 'bam');
});

test('parses hash with path and string values', (assert) => {
  const ast = parse('{{foo bar=baz bat="bam"}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual((m.hash.pairs[0]!.value as ASTv1.PathExpression).original, 'baz');
  assert.strictEqual((m.hash.pairs[1]!.value as ASTv1.StringLiteral).value, 'bam');
});

test('parses hash with single-quoted string value', (assert) => {
  const ast = parse("{{foo bat='bam'}}");
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual((m.hash.pairs[0]!.value as ASTv1.StringLiteral).value, 'bam');
});

test('parses mustache with positional param and hash', (assert) => {
  const ast = parse('{{foo omg bar=baz bat="bam"}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual((m.params[0] as ASTv1.PathExpression).original, 'omg');
  assert.strictEqual((m.hash.pairs[0]!.value as ASTv1.PathExpression).original, 'baz');
  assert.strictEqual((m.hash.pairs[1]!.value as ASTv1.StringLiteral).value, 'bam');
});

// ── Text content followed by mustache ─────────────────────────────────────────

test('parses text content followed by a mustache', (assert) => {
  const ast = parse('foo bar {{baz}}');
  assert.strictEqual((ast.body[0] as ASTv1.TextNode).chars, 'foo bar ');
  assert.strictEqual(
    ((ast.body[1] as ASTv1.MustacheStatement).path as ASTv1.PathExpression).original,
    'baz'
  );
});

// ── Partials, decorators (throw in Glimmer) ───────────────────────────────────

test('partial throws with correct error message', (assert) => {
  assert.throws(() => parse('{{> foo }}'), /Handlebars partials are not supported/);
});

test('partial block throws with correct error message', (assert) => {
  assert.throws(() => parse('{{#> foo}}{{/foo}}'), /Handlebars partial blocks are not supported/);
});

test('decorator throws with correct error message', (assert) => {
  assert.throws(() => parse('{{* foo}}'), /Handlebars decorators are not supported/);
});

test('decorator block throws with correct error message', (assert) => {
  assert.throws(() => parse('{{#* foo}}{{/foo}}'), /Handlebars decorator blocks are not supported/);
});

// ── Comments ──────────────────────────────────────────────────────────────────

test('parses a single-line Handlebars comment', (assert) => {
  const ast = parse('{{! this is a comment }}');
  const comment = ast.body[0] as ASTv1.MustacheCommentStatement;
  assert.strictEqual(comment.type, 'MustacheCommentStatement');
  assert.strictEqual(comment.value, ' this is a comment ');
});

test('parses a multi-line Handlebars comment', (assert) => {
  const ast = parse('{{!\nthis is a multi-line comment\n}}');
  const comment = ast.body[0] as ASTv1.MustacheCommentStatement;
  assert.strictEqual(comment.type, 'MustacheCommentStatement');
  assert.strictEqual(comment.value, '\nthis is a multi-line comment\n');
});

// ── Block statements ──────────────────────────────────────────────────────────

test('parses block with ^ inverse section', (assert) => {
  const ast = parse('{{#foo}} bar {{^}} baz {{/foo}}');
  const block = ast.body[0] as ASTv1.BlockStatement;
  assert.strictEqual((block.path as ASTv1.PathExpression).original, 'foo');
  assert.strictEqual((block.program.body[0] as ASTv1.TextNode).chars, ' bar ');
  assert.notStrictEqual(block.inverse, null);
  assert.strictEqual((block.inverse!.body[0] as ASTv1.TextNode).chars, ' baz ');
});

test('parses block with {{else}} inverse section', (assert) => {
  const ast = parse('{{#foo}} bar {{else}} baz {{/foo}}');
  const block = ast.body[0] as ASTv1.BlockStatement;
  assert.strictEqual((block.program.body[0] as ASTv1.TextNode).chars, ' bar ');
  assert.notStrictEqual(block.inverse, null);
  assert.strictEqual((block.inverse!.body[0] as ASTv1.TextNode).chars, ' baz ');
});

test('parses block with chained else (multiple inverse sections)', (assert) => {
  const ast = parse('{{#foo}} bar {{else if bar}}{{else}} baz {{/foo}}');
  const block = ast.body[0] as ASTv1.BlockStatement;
  assert.strictEqual((block.program.body[0] as ASTv1.TextNode).chars, ' bar ');
  // The chained else creates a nested block in the inverse
  assert.notStrictEqual(block.inverse, null);
  const innerBlock = block.inverse!.body[0] as ASTv1.BlockStatement;
  assert.strictEqual(innerBlock.type, 'BlockStatement');
  assert.strictEqual((innerBlock.path as ASTv1.PathExpression).original, 'if');
  assert.notStrictEqual(innerBlock.inverse, null);
  assert.strictEqual((innerBlock.inverse!.body[0] as ASTv1.TextNode).chars, ' baz ');
});

test('parses an empty block', (assert) => {
  const ast = parse('{{#foo}}{{/foo}}');
  const block = ast.body[0] as ASTv1.BlockStatement;
  assert.strictEqual(block.type, 'BlockStatement');
  assert.strictEqual(block.program.body.length, 0);
  assert.strictEqual(block.inverse, null);
});

test('parses an empty block with ^ inverse', (assert) => {
  const ast = parse('{{#foo}}{{^}}{{/foo}}');
  const block = ast.body[0] as ASTv1.BlockStatement;
  assert.strictEqual(block.program.body.length, 0);
  assert.notStrictEqual(block.inverse, null);
  assert.strictEqual(block.inverse!.body.length, 0);
});

test('parses an empty block with {{else}} inverse', (assert) => {
  const ast = parse('{{#foo}}{{else}}{{/foo}}');
  const block = ast.body[0] as ASTv1.BlockStatement;
  assert.strictEqual(block.program.body.length, 0);
  assert.notStrictEqual(block.inverse, null);
  assert.strictEqual(block.inverse!.body.length, 0);
});

test('parses a block with block params', (assert) => {
  const ast = parse('{{#foo as |bar baz|}}content{{/foo}}');
  const block = ast.body[0] as ASTv1.BlockStatement;
  assert.strictEqual((block.path as ASTv1.PathExpression).original, 'foo');
  assert.strictEqual(block.program.blockParams[0], 'bar');
  assert.strictEqual(block.program.blockParams[1], 'baz');
  assert.strictEqual((block.program.body[0] as ASTv1.TextNode).chars, 'content');
});

test('parses ^foo standalone inverse block', (assert) => {
  const ast = parse('{{^foo}}bar{{/foo}}');
  const block = ast.body[0] as ASTv1.BlockStatement;
  assert.strictEqual((block.path as ASTv1.PathExpression).original, 'foo');
  assert.strictEqual(block.program.body.length, 0);
  assert.notStrictEqual(block.inverse, null);
  assert.strictEqual((block.inverse!.body[0] as ASTv1.TextNode).chars, 'bar');
});

// ── Sub-expressions ───────────────────────────────────────────────────────────

test('parses a sub-expression as the mustache path', (assert) => {
  const ast = parse('{{(my-helper foo)}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual(m.path.type, 'SubExpression');
  const sexpr = m.path as ASTv1.SubExpression;
  assert.strictEqual((sexpr.path as ASTv1.PathExpression).original, 'my-helper');
  assert.strictEqual((sexpr.params[0] as ASTv1.PathExpression).original, 'foo');
});

test('parses a sub-expression as the path with an additional param', (assert) => {
  const ast = parse('{{(my-helper foo) bar}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual(m.path.type, 'SubExpression');
  assert.strictEqual((m.params[0] as ASTv1.PathExpression).original, 'bar');
});

test('parses a nested sub-expression (double parentheses)', (assert) => {
  const ast = parse('{{((my-helper foo))}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual(m.path.type, 'SubExpression');
  const outer = m.path as ASTv1.SubExpression;
  assert.strictEqual(outer.path.type, 'SubExpression');
  const inner = outer.path as ASTv1.SubExpression;
  assert.strictEqual((inner.path as ASTv1.PathExpression).original, 'my-helper');
});

test('parses nested sub-expression with param', (assert) => {
  const ast = parse('{{((my-helper foo) bar)}}');
  const m = ast.body[0] as ASTv1.MustacheStatement;
  assert.strictEqual(m.path.type, 'SubExpression');
  const outer = m.path as ASTv1.SubExpression;
  assert.strictEqual(outer.path.type, 'SubExpression');
  assert.strictEqual((outer.params[0] as ASTv1.PathExpression).original, 'bar');
});

// ── Error cases ───────────────────────────────────────────────────────────────

test('throws on stray ^ outside a block', (assert) => {
  assert.throws(() => parse('foo{{^}}bar'), /Parse error/i);
});

test('throws on unclosed mustache', (assert) => {
  assert.throws(() => parse('{{foo}'), /Parse error/i);
});

test('throws on mismatched block open/close tags', (assert) => {
  assert.throws(() => parse('{{#goodbyes}}{{/hellos}}'), /goodbyes doesn't match hellos/);
});

test('throws on invalid path with ../ segment', (assert) => {
  assert.throws(() => parse('{{foo/../bar}}'), /not supported in Glimmer|Mixing/i);
});

test('throws on invalid path with ./ segment', (assert) => {
  assert.throws(() => parse('{{foo/./bar}}'), /not supported in Glimmer|Mixing/i);
});

test('parse error references correct line number (line 3)', (assert) => {
  assert.throws(() => parse('hello\nmy\n{{foo}'), /line 3/i);
});

test('parse error references correct line number (line 5)', (assert) => {
  assert.throws(() => parse('hello\n\nmy\n\n{{foo}'), /line 5/i);
});

test('parse error references correct line number (line 7)', (assert) => {
  assert.throws(() => parse('\n\nhello\n\nmy\n\n{{foo}'), /line 7/i);
});

// ── Ported from @handlebars/parser spec/ast.js ────────────────────────────────

QUnit.module('[glimmer-syntax] Parser - whitespace control (tilde and standalone)');

// ── Tilde (whitespace stripping) ──────────────────────────────────────────────

test('tilde on mustache strips adjacent whitespace text nodes, which are then removed', (assert) => {
  // {{~comment~}}: leftStrip strips trailing WS from '  ', rightStrip strips leading WS from ' '.
  // Both text nodes become '' and are removed by the post-pass filter.
  const ast = parse('  {{~comment~}} ');
  assert.strictEqual(ast.body.length, 1, 'empty text nodes are removed after tilde stripping');
  assert.strictEqual(ast.body[0]!.type, 'MustacheStatement');
});

test('tilde on block open/close strips program body content', (assert) => {
  // Use a non-standalone block (prefix 'x' prevents standalone detection) so that
  // only tilde stripping applies, with no interaction with standalone stripping.
  // {{# comment~}}: openStrip.close strips leading WS from program body.
  // {{~/comment}}: closeStrip.open strips trailing WS from program body.
  const ast = parse('x{{# comment~}} \nfoo\n {{~/comment}}y');
  const block = ast.body[1] as ASTv1.BlockStatement;
  assert.strictEqual((block.program.body[0] as ASTv1.TextNode).chars, 'foo');
});

// ── ignoreStandalone (parseWithoutProcessing equivalent) ─────────────────────

test('ignoreStandalone: tilde still strips adjacent text nodes', (assert) => {
  // ignoreStandalone only skips standalone-line detection; tilde stripping still runs.
  const ast = parse('  {{~comment~}} ', { parseOptions: { ignoreStandalone: true } });
  assert.strictEqual(ast.body.length, 1, 'tilde-stripped empty nodes are removed even without standalone detection');
  assert.strictEqual(ast.body[0]!.type, 'MustacheStatement');
});

// ── Standalone block detection ────────────────────────────────────────────────

test('standalone block: surrounding whitespace text nodes are removed after stripping', (assert) => {
  // Leading ' ' and trailing ' ' are stripped to '' by standalone detection, then removed.
  const ast = parse(' {{#comment}} \nfoo\n {{/comment}} ');
  assert.strictEqual(ast.body.length, 1, 'surrounding empty text nodes are removed');
  const block = ast.body[0] as ASTv1.BlockStatement;
  assert.strictEqual((block.program.body[0] as ASTv1.TextNode).chars, 'foo\n');
});

test('standalone block with else: surrounding nodes removed, inner content standalone-stripped', (assert) => {
  const ast = parse(' {{#comment}} \nfoo\n {{else}} \n  bar \n  {{/comment}} ');
  assert.strictEqual(ast.body.length, 1);
  const block = ast.body[0] as ASTv1.BlockStatement;
  assert.strictEqual((block.program.body[0] as ASTv1.TextNode).chars, 'foo\n');
  assert.strictEqual((block.inverse!.body[0] as ASTv1.TextNode).chars, '  bar \n');
});

test('standalone block at start of line: program body strips leading newline', (assert) => {
  const ast = parse('{{#comment}} \nfoo\n {{/comment}}');
  const block = ast.body[0] as ASTv1.BlockStatement;
  assert.strictEqual((block.program.body[0] as ASTv1.TextNode).chars, 'foo\n');
});

test('standalone block containing mustache: surrounding text is stripped and empty node removed', (assert) => {
  // Program body: [TextNode(' \n'), MustacheStatement(foo), TextNode('\n ')].
  // Standalone strips first child to '' (removed) and last child to '\n'.
  const ast = parse('{{#comment}} \n{{foo}}\n {{/comment}}');
  const block = ast.body[0] as ASTv1.BlockStatement;
  assert.strictEqual(block.program.body.length, 2);
  assert.strictEqual(block.program.body[0]!.type, 'MustacheStatement');
  assert.strictEqual((block.program.body[1] as ASTv1.TextNode).chars, '\n');
});

test('non-standalone block (inline): whitespace is NOT stripped', (assert) => {
  // When a block open tag shares a line with other mustaches, it is not standalone
  const ast = parse('{{#foo}} {{#comment}} \nfoo\n {{/comment}} {{/foo}}');
  const outerBlock = ast.body[0] as ASTv1.BlockStatement;
  // The inner block is not standalone because the line has other content
  const innerBlock = outerBlock.program.body[1] as ASTv1.BlockStatement;
  assert.strictEqual(innerBlock.type, 'BlockStatement');
  // The program body of the non-standalone inner block keeps its whitespace
  assert.strictEqual((innerBlock.program.body[0] as ASTv1.TextNode).chars, ' \nfoo\n ');
});

// ── Standalone comment detection ──────────────────────────────────────────────

test('standalone comment: trailing whitespace node is removed after stripping', (assert) => {
  // Trailing ' ' is stripped to '' and removed; only the comment node remains.
  const ast = parse('{{! comment }} ');
  assert.strictEqual(ast.body.length, 1);
  assert.strictEqual(ast.body[0]!.type, 'MustacheCommentStatement');
});

test('standalone comment: both surrounding text nodes are removed after stripping', (assert) => {
  // '  ' and ' ' both stripped to '' and removed.
  const ast = parse('  {{! comment }} ');
  assert.strictEqual(ast.body.length, 1);
  assert.strictEqual(ast.body[0]!.type, 'MustacheCommentStatement');
});

// ── ignoreStandalone: standalone detection is skipped ────────────────────────

test('ignoreStandalone: standalone block is NOT stripped', (assert) => {
  const ast = parse('{{#comment}} \nfoo\n {{/comment}}', {
    parseOptions: { ignoreStandalone: true },
  });
  const block = ast.body[0] as ASTv1.BlockStatement;
  // Without standalone detection the raw content is preserved
  assert.strictEqual((block.program.body[0] as ASTv1.TextNode).chars, ' \nfoo\n ');
});

// ── Ported from @handlebars/parser spec/visitor.js ────────────────────────────

QUnit.module('[glimmer-syntax] Traversal - visitor coverage');

test('traverse visits all node types in a complex template without throwing', (assert) => {
  const src = `
    {{#if foo}}
      <div class="{{bar}} baz">
        {{#each items as |item|}}
          {{item.name}}
        {{/each}}
      </div>
    {{else}}
      nothing
    {{/if}}
  `;
  const ast = parse(src);
  const visited: string[] = [];
  traverse(ast, {
    All(node) {
      visited.push(node.type);
    },
  });
  assert.ok(visited.length > 0, 'at least one node was visited');
  assert.ok(visited.includes('Template'), 'Template node was visited');
  assert.ok(visited.includes('BlockStatement'), 'BlockStatement node was visited');
  assert.ok(visited.includes('ElementNode'), 'ElementNode was visited');
  assert.ok(visited.includes('MustacheStatement'), 'MustacheStatement was visited');
});

test('traverse visits MustacheStatement nodes with correct path values', (assert) => {
  const ast = parse('{{foo}} {{bar}}');
  const paths: string[] = [];
  traverse(ast, {
    MustacheStatement(node) {
      paths.push((node.path as ASTv1.PathExpression).original);
    },
  });
  assert.deepEqual(paths, ['foo', 'bar']);
});

test('traverse visits TextNode nodes with correct chars', (assert) => {
  const ast = parse('hello {{world}} done');
  const texts: string[] = [];
  traverse(ast, {
    TextNode(node) {
      texts.push(node.chars);
    },
  });
  assert.ok(texts.includes('hello '), 'leading text node visited');
  assert.ok(texts.includes(' done'), 'trailing text node visited');
});

test('traverse visits BlockStatement with correct open tag path', (assert) => {
  const ast = parse('{{#each items as |item|}}{{item.name}}{{/each}}');
  const blockPaths: string[] = [];
  traverse(ast, {
    BlockStatement(node) {
      blockPaths.push((node.path as ASTv1.PathExpression).original);
    },
  });
  assert.deepEqual(blockPaths, ['each']);
});

test('traverse visits all node types in template with enter/exit', (assert) => {
  const ast = parse('<div>{{foo}}</div>');
  const entered: string[] = [];
  const exited: string[] = [];
  traverse(ast, {
    All: {
      enter(node) {
        entered.push(node.type);
      },
      exit(node) {
        exited.push(node.type);
      },
    },
  });
  assert.ok(entered.length > 0, 'enter was called');
  assert.ok(exited.length > 0, 'exit was called');
  assert.strictEqual(entered.length, exited.length, 'enter and exit called same number of times');
});

export function strip(strings: TemplateStringsArray, ...args: string[]) {
  return strings
    .map((str: string, i: number) => {
      return `${str
        .split('\n')
        .map((s) => s.trim())
        .join('')}${args[i] ? args[i] : ''}`;
    })
    .join('');
}

export type ElementParts =
  | ['attrs', ...AttrSexp[]]
  | ['modifiers', ...ModifierSexp[]]
  | ['body', ...ASTv1.Statement[]]
  | ['comments', ...ASTv1.MustacheCommentStatement[]]
  | ['as', ...ASTv1.VarHead[]]
  | ['loc', ASTv1.SourceLocation];

export type PathSexp = string | ['path', string, LocSexp?];

export type ModifierSexp =
  | string
  | [PathSexp, LocSexp?]
  | [PathSexp, ASTv1.Expression[], LocSexp?]
  | [PathSexp, ASTv1.Expression[], Dict<ASTv1.Expression>, LocSexp?];

export type AttrSexp = [string, ASTv1.AttrNode['value'] | string, LocSexp?];

export type LocSexp = ['loc', ASTv1.SourceLocation];

export type SexpValue =
  | string
  | ASTv1.Expression[]
  | Dict<ASTv1.Expression>
  | LocSexp
  | PathSexp
  | undefined;

export type BuildElementParams = Parameters<typeof b.element>;
export type TagDescriptor = BuildElementParams[0];
export type BuildElementOptions = NonNullable<BuildElementParams[1]>;

export function element(tag: TagDescriptor, ...options: ElementParts[]): ASTv1.ElementNode {
  return b.element(tag, normalizeElementParts(...options));
}

export function normalizeElementParts(...args: ElementParts[]): BuildElementOptions {
  let out: BuildElementOptions = {};

  for (let arg of args) {
    switch (arg[0]) {
      case 'attrs': {
        let [, ...rest] = arg;
        out.attrs = rest.map(normalizeAttr);
        break;
      }
      case 'modifiers': {
        let [, ...rest] = arg;
        out.modifiers = rest.map(normalizeModifier);
        break;
      }
      case 'body': {
        let [, ...rest] = arg;
        out.children = rest;
        break;
      }
      case 'comments': {
        let [, ...rest] = arg;

        out.comments = rest;
        break;
      }
      case 'as': {
        let [, ...rest] = arg;
        out.blockParams = rest;
        break;
      }
      case 'loc': {
        let [, rest] = arg;
        out.loc = rest;
        break;
      }
    }
  }

  return out;
}

export function normalizeAttr(sexp: AttrSexp): ASTv1.AttrNode {
  let name = sexp[0];
  let value;

  if (typeof sexp[1] === 'string') {
    value = b.text(sexp[1]);
  } else {
    value = sexp[1];
  }

  return b.attr(name, value);
}

export function normalizeModifier(sexp: ModifierSexp): ASTv1.ElementModifierStatement {
  if (typeof sexp === 'string') {
    return b.elementModifier(sexp);
  }

  let path: ASTv1.Expression = normalizeHead(sexp[0]);
  let params: ASTv1.Expression[] | undefined;
  let hash: ASTv1.Hash | undefined;
  let loc: ASTv1.SourceLocation | null = null;

  let parts = sexp.slice(1);
  let next = parts.shift();

  _process: {
    if (isParamsSexp(next)) {
      params = next;
    } else {
      break _process;
    }

    next = parts.shift();

    if (isHashSexp(next)) {
      hash = normalizeHash(next);
    } else {
      break _process;
    }
  }

  if (isLocSexp(next)) {
    loc = next[1];
  }

  return b.elementModifier(path as ASTv1.CallableExpression, params, hash, b.loc(loc || null));
}

export function normalizeHead(path: PathSexp): ASTv1.Expression {
  if (typeof path === 'string') {
    return b.path(path);
  } else {
    return b.path(path[1], path[2] && path[2][1]);
  }
}

export function normalizeHash(
  hash: Dict<ASTv1.Expression>,
  loc?: ASTv1.SourceLocation
): ASTv1.Hash {
  let pairs = Object.entries(hash).map(([key, value]) => b.pair(key, value));

  return b.hash(pairs, loc);
}

export function isParamsSexp(value: SexpValue): value is ASTv1.Expression[] {
  return Array.isArray(value) && !isLocSexp(value);
}

export function isLocSexp(value: SexpValue): value is LocSexp {
  return Array.isArray(value) && value.length === 2 && value[0] === 'loc';
}

export function isHashSexp(value: SexpValue): value is Dict<ASTv1.Expression> {
  if (typeof value === 'object' && !Array.isArray(value)) {
    expectType<Dict<ASTv1.Expression>>(value);
    return true;
  } else {
    return false;
  }
}

function expectType<T>(_input: T): void {
  return;
}
