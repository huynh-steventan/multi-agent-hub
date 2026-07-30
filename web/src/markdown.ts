/**
 * A small Markdown parser, sized for what coding agents actually emit.
 *
 * Pure and separate from React so it can be tested directly, like `pace.ts` and
 * `layout.ts`. It produces an AST rather than an HTML string — the renderer
 * builds React elements from it, so there is no `dangerouslySetInnerHTML` and
 * therefore no way for agent output (or a tool result quoting a web page) to
 * inject markup into the page.
 *
 * Deliberately not CommonMark. It covers what the three CLIs produce in prose —
 * headings, fences, lists, tables, quotes, rules, and the inline set — and
 * ignores the rest (reference links, HTML blocks, setext headings, footnotes),
 * which show through as literal text rather than being silently swallowed. A
 * full implementation is a dependency's worth of work for output nobody writes.
 *
 * One deliberate divergence from GFM: a single newline inside a paragraph is a
 * hard break, not a space. Agents wrap prose by intent, and collapsing those
 * breaks reflows their output into walls of text.
 */

export type Inline =
  | { type: 'text'; value: string }
  | { type: 'break' }
  | { type: 'code'; value: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'strike'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] };

export type Align = 'left' | 'center' | 'right' | null;

export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'code'; lang: string | null; value: string }
  | { type: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { type: 'quote'; children: Block[] }
  | { type: 'table'; align: Align[]; header: Inline[][]; rows: Inline[][][] }
  | { type: 'rule' };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]+)?.*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
/** A table's second line: pipes, dashes, and optional alignment colons. */
const DELIMITER = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

export function parseMarkdown(src: string): Block[] {
  return parseBlocks(src.replace(/\r\n?/g, '\n').split('\n'));
}

function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i += 1;
      // An unterminated fence runs to the end rather than being dropped: a turn
      // can be interrupted mid-code-block, and showing the partial code beats
      // showing nothing.
      while (i < lines.length && !isClosingFence(lines[i]!, marker)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1;
      out.push({ type: 'code', lang: fence[2] ?? null, value: body.join('\n') });
      continue;
    }

    if (RULE.test(line)) {
      out.push({ type: 'rule' });
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ type: 'heading', level: heading[1]!.length, children: parseInline(heading[2]!) });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        body.push(lines[i]!.replace(QUOTE, ''));
        i += 1;
      }
      out.push({ type: 'quote', children: parseBlocks(body) });
      continue;
    }

    const table = parseTable(lines, i);
    if (table) {
      out.push(table.block);
      i = table.next;
      continue;
    }

    if (ITEM.test(line)) {
      const list = parseList(lines, i);
      out.push(list.block);
      i = list.next;
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !startsBlock(lines, i)) {
      para.push(lines[i]!);
      i += 1;
    }
    // A paragraph that cannot consume its own first line would spin forever;
    // startsBlock is checked from the second line on for exactly that reason.
    if (para.length === 0) {
      para.push(lines[i]!);
      i += 1;
    }
    out.push({ type: 'paragraph', children: parseInline(para.join('\n')) });
  }

  return out;
}

/** Whether line `i` interrupts a paragraph already in progress. */
function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i]!;
  if (i === 0) return false;
  return (
    FENCE.test(line) ||
    RULE.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line) ||
    ITEM.test(line) ||
    parseTable(lines, i) !== null
  );
}

function isClosingFence(line: string, marker: string): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return m !== null && m[1]![0] === marker[0] && m[1]!.length >= marker.length;
}

function parseList(lines: string[], start: number): { block: Block; next: number } {
  const first = ITEM.exec(lines[start]!)!;
  const ordered = /\d/.test(first[2]!);
  const items: Block[][] = [];
  let i = start;

  while (i < lines.length) {
    const match = ITEM.exec(lines[i]!);
    // A different marker family starts a new list rather than continuing this one.
    if (!match || /\d/.test(match[2]!) !== ordered) break;

    const indent = match[1]!.length + match[2]!.length + 1;
    const body = [match[3]!];
    i += 1;

    // Continuation lines: anything indented past the marker, and blank lines so
    // long as indented content follows. Dedented so nesting parses recursively.
    while (i < lines.length) {
      const line = lines[i]!;
      if (!line.trim()) {
        const next = lines[i + 1];
        if (next === undefined || !next.trim() || leadingSpaces(next) < indent) break;
        body.push('');
        i += 1;
        continue;
      }
      // Dedenting past the marker ends the item — that is either a sibling or
      // the end of the list, and both are the outer loop's business.
      if (leadingSpaces(line) < indent) break;
      body.push(line.slice(indent));
      i += 1;
    }

    items.push(parseBlocks(body));
  }

  const startAt = ordered ? Number.parseInt(first[2]!, 10) : 1;
  return { block: { type: 'list', ordered, start: Number.isNaN(startAt) ? 1 : startAt, items }, next: i };
}

function leadingSpaces(line: string): number {
  const m = /^[ \t]*/.exec(line)!;
  // A tab counts as a small indent rather than a full stop, which is enough to
  // keep tab-indented continuations attached to their item.
  return m[0].replace(/\t/g, '  ').length;
}

function parseTable(lines: string[], start: number): { block: Block; next: number } | null {
  const header = lines[start];
  const delimiter = lines[start + 1];
  if (!header || !delimiter) return null;
  if (!header.includes('|') || !DELIMITER.test(delimiter) || !delimiter.includes('-')) return null;

  const align: Align[] = splitRow(delimiter).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });

  const headerCells = splitRow(header).map(parseInline);
  const rows: Inline[][][] = [];
  let i = start + 2;
  while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|')) {
    rows.push(splitRow(lines[i]!).map(parseInline));
    i += 1;
  }

  return { block: { type: 'table', align, header: headerCells, rows }, next: i };
}

/** Split one table row on unescaped pipes, dropping the leading/trailing ones. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === '\\' && line[i + 1] === '|') {
      cell += '|';
      i += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(cell);
      cell = '';
      continue;
    }
    cell += ch;
  }
  cells.push(cell);
  if (cells.length > 1 && !cells[0]!.trim()) cells.shift();
  if (cells.length > 1 && !cells[cells.length - 1]!.trim()) cells.pop();
  return cells.map((c) => c.trim());
}

/**
 * Inline spans, in precedence order.
 *
 * Code first, because backticks protect whatever they contain — `**not bold**`
 * is the case that matters, since agents quote markdown constantly when they are
 * writing *about* markdown.
 */
const INLINE_SOURCE = [
  /\\(?<esc>[\\`*_~[\]()#>+-])/, // escaped punctuation
  /(?<ticks>`+)(?<code>[\s\S]*?[^`])\k<ticks>(?!`)/, // code span
  /!?\[(?<ltext>[^\]]*)\]\(\s*<?(?<lhref>[^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/, // link (an image renders as its text)
  /(?<smark>\*\*|__)(?=\S)(?<sbody>[\s\S]*?\S)\k<smark>/, // strong
  /(?<kmark>~~)(?=\S)(?<kbody>[\s\S]*?\S)\k<kmark>/, // strikethrough
  /(?<emark>\*|_)(?=\S)(?<ebody>[^*_\n]*?\S)\k<emark>/, // emphasis
  /<(?<auto>(?:https?|mailto):[^>\s]+)>/, // autolink in angle brackets
  /(?<url>(?:https?:\/\/|www\.)[^\s<>()[\]]+[^\s<>()[\]".,;:!?])/, // bare url
]
  .map((r) => `(?:${r.source})`)
  .join('|');

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  // A fresh regex per call, because this function recurses into the body of
  // every span it matches: a shared /g regex would have its lastIndex reset by
  // the inner call and the outer scan would restart from zero forever.
  const re = new RegExp(INLINE_SOURCE, 'g');

  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const g = m.groups!;

    // `snake_case` and `a * b` are not emphasis. An underscore only opens one at
    // a word boundary; the alternative is mangling identifiers, which appear in
    // agent prose far more often than underscore emphasis does.
    if ((g.emark === '_' || g.smark === '__') && isWordChar(src[m.index - 1])) {
      re.lastIndex = m.index + 1;
      continue;
    }

    if (m.index > last) pushText(out, src.slice(last, m.index));
    last = m.index + m[0].length;

    if (g.esc !== undefined) pushText(out, g.esc);
    else if (g.ticks !== undefined) out.push({ type: 'code', value: g.code!.trim() });
    else if (g.lhref !== undefined) {
      const href = safeHref(g.lhref);
      const children = parseInline(g.ltext!);
      if (href) {
        out.push({ type: 'link', href, children: children.length ? children : [{ type: 'text', value: g.lhref }] });
      } else {
        // Refused rather than rendered: shown as the literal markdown it was.
        pushText(out, m[0]);
      }
    } else if (g.sbody !== undefined) out.push({ type: 'strong', children: parseInline(g.sbody) });
    else if (g.kbody !== undefined) out.push({ type: 'strike', children: parseInline(g.kbody) });
    else if (g.ebody !== undefined) out.push({ type: 'em', children: parseInline(g.ebody) });
    else if (g.auto !== undefined) out.push({ type: 'link', href: g.auto, children: [{ type: 'text', value: g.auto }] });
    else {
      const url = g.url!;
      out.push({ type: 'link', href: url.startsWith('www.') ? `https://${url}` : url, children: [{ type: 'text', value: url }] });
    }
  }

  if (last < src.length) pushText(out, src.slice(last));
  return out;
}

/** Split on newlines so the renderer can emit real breaks instead of collapsing them. */
function pushText(out: Inline[], value: string): void {
  const parts = value.split('\n');
  parts.forEach((part, i) => {
    if (i > 0) out.push({ type: 'break' });
    if (part) out.push({ type: 'text', value: part });
  });
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w]/.test(ch);
}

/**
 * Only schemes that cannot execute.
 *
 * Link text comes from an agent, which routinely relays content it read from
 * elsewhere, so `javascript:` and `data:` are refused and the raw markdown is
 * shown instead — visible and inert beats rendered and clickable.
 */
function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (/^(https?:|mailto:|#|\/|\.{1,2}\/)/i.test(trimmed)) return trimmed;
  // A bare host or path with no scheme is fine; anything with a scheme is not.
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? null : trimmed;
}
