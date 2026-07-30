import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInline, parseMarkdown, type Block, type Inline } from './markdown.ts';

/** Flatten an inline tree back to its visible text, for terse assertions. */
function text(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      if (n.type === 'text') return n.value;
      if (n.type === 'code') return n.value;
      if (n.type === 'break') return '\n';
      return text(n.children);
    })
    .join('');
}

function kinds(blocks: Block[]): string[] {
  return blocks.map((b) => b.type);
}

test('bold, italic and code stop showing their own punctuation', () => {
  const nodes = parseInline('a **bold** and _em_ and `code`');

  assert.deepEqual(
    nodes.map((n) => n.type),
    ['text', 'strong', 'text', 'em', 'text', 'code'],
  );
  assert.equal(text(nodes), 'a bold and em and code');
});

test('code spans protect the markdown inside them', () => {
  // The case that matters most: agents constantly write *about* markdown.
  const nodes = parseInline('use `**not bold**` here');

  assert.deepEqual(nodes[1], { type: 'code', value: '**not bold**' });
  assert.equal(nodes.filter((n) => n.type === 'strong').length, 0);
});

test('an identifier keeps its underscores', () => {
  // snake_case appears in agent prose far more often than underscore emphasis.
  const nodes = parseInline('call some_long_name(x) now');

  assert.equal(text(nodes), 'call some_long_name(x) now');
  assert.equal(nodes.filter((n) => n.type === 'em').length, 0);
});

test('a lone asterisk is not emphasis', () => {
  assert.equal(text(parseInline('2 * 3 * 4')), '2 * 3 * 4');
});

test('escaped punctuation renders literally', () => {
  const nodes = parseInline('a \\*not em\\* b');

  assert.equal(text(nodes), 'a *not em* b');
  assert.equal(nodes.filter((n) => n.type === 'em').length, 0);
});

test('links keep their text and drop their syntax', () => {
  const nodes = parseInline('see [the docs](https://example.com/x) for more');

  assert.deepEqual(nodes[1], {
    type: 'link',
    href: 'https://example.com/x',
    children: [{ type: 'text', value: 'the docs' }],
  });
});

test('a script-bearing href is refused and shown as literal text', () => {
  // Agents relay content they read elsewhere; a rendered javascript: link would
  // make that content executable by a tap.
  const nodes = parseInline('[click](javascript:alert(1))');

  assert.equal(nodes.filter((n) => n.type === 'link').length, 0);
  assert.equal(text(nodes), '[click](javascript:alert(1))');
});

test('a bare url becomes a link', () => {
  const nodes = parseInline('visit https://example.com/a?b=1 today');

  const link = nodes.find((n) => n.type === 'link');
  assert.equal(link?.type === 'link' && link.href, 'https://example.com/a?b=1');
});

test('a single newline is a hard break, not a space', () => {
  // Agents wrap prose by intent; collapsing these reflows their output.
  const nodes = parseInline('line one\nline two');

  assert.deepEqual(
    nodes.map((n) => n.type),
    ['text', 'break', 'text'],
  );
});

test('a fenced block keeps its body verbatim and records its language', () => {
  const blocks = parseMarkdown('before\n\n```ts\nconst a = **1**;\n```\n\nafter');

  assert.deepEqual(kinds(blocks), ['paragraph', 'code', 'paragraph']);
  const code = blocks[1];
  assert.ok(code?.type === 'code');
  assert.equal(code.lang, 'ts');
  assert.equal(code.value, 'const a = **1**;');
});

test('an unterminated fence still renders what arrived', () => {
  // A turn can be interrupted mid-code-block; showing the partial code beats
  // showing nothing at all.
  const blocks = parseMarkdown('```\npartial output');

  const code = blocks[0];
  assert.ok(code?.type === 'code');
  assert.equal(code.value, 'partial output');
});

test('headings carry their level', () => {
  const blocks = parseMarkdown('# One\n\n### Three');

  assert.deepEqual(
    blocks.map((b) => (b.type === 'heading' ? b.level : null)),
    [1, 3],
  );
});

test('a bullet list becomes items, not lines of asterisks', () => {
  const blocks = parseMarkdown('- first\n- second\n- third');

  const list = blocks[0];
  assert.ok(list?.type === 'list');
  assert.equal(list.ordered, false);
  assert.equal(list.items.length, 3);
  assert.equal(list.items[1]?.[0]?.type === 'paragraph' && text(list.items[1][0].children), 'second');
});

test('an ordered list remembers where it started', () => {
  const blocks = parseMarkdown('3. three\n4. four');

  const list = blocks[0];
  assert.ok(list?.type === 'list');
  assert.equal(list.ordered, true);
  assert.equal(list.start, 3);
  assert.equal(list.items.length, 2);
});

test('a nested list nests', () => {
  const blocks = parseMarkdown('- outer\n  - inner\n  - inner two\n- outer two');

  const list = blocks[0];
  assert.ok(list?.type === 'list');
  assert.equal(list.items.length, 2);
  const nested = list.items[0]?.find((b) => b.type === 'list');
  assert.ok(nested?.type === 'list');
  assert.equal(nested.items.length, 2);
});

test('a list interrupts the paragraph above it', () => {
  const blocks = parseMarkdown('Here are the steps:\n- one\n- two');

  assert.deepEqual(kinds(blocks), ['paragraph', 'list']);
});

test('a table parses into header, alignment and rows', () => {
  const blocks = parseMarkdown('| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 | 4 |');

  const table = blocks[0];
  assert.ok(table?.type === 'table');
  assert.deepEqual(table.align, ['left', 'right']);
  assert.deepEqual(table.header.map(text), ['a', 'b']);
  assert.deepEqual(
    table.rows.map((r) => r.map(text)),
    [
      ['1', '2'],
      ['3', '4'],
    ],
  );
});

test('a pipe in prose is not a table', () => {
  const blocks = parseMarkdown('run a | b to pipe it');

  assert.deepEqual(kinds(blocks), ['paragraph']);
});

test('block quotes and rules parse', () => {
  const blocks = parseMarkdown('> quoted\n> still quoted\n\n---\n\nafter');

  assert.deepEqual(kinds(blocks), ['quote', 'rule', 'paragraph']);
  const quote = blocks[0];
  assert.ok(quote?.type === 'quote');
  assert.deepEqual(kinds(quote.children), ['paragraph']);
});

test('plain prose survives untouched', () => {
  const blocks = parseMarkdown('Just a sentence, nothing special.');

  assert.deepEqual(kinds(blocks), ['paragraph']);
  const p = blocks[0];
  assert.ok(p?.type === 'paragraph');
  assert.equal(text(p.children), 'Just a sentence, nothing special.');
});

test('empty input produces nothing rather than an empty paragraph', () => {
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown('\n\n  \n'), []);
});

test('a realistic agent reply parses end to end', () => {
  const blocks = parseMarkdown(
    [
      '## Summary',
      '',
      'I fixed the **session id** bug in `base.ts`. Notes:',
      '',
      '1. `runTurn` now returns an outcome',
      '2. the store is written after the turn',
      '',
      '```bash',
      'npm test',
      '```',
      '',
      'See [the notes](https://example.com).',
    ].join('\n'),
  );

  assert.deepEqual(kinds(blocks), ['heading', 'paragraph', 'list', 'code', 'paragraph']);
});
