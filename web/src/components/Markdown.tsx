import { Fragment, type ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from '../markdown.ts';

/**
 * Render agent prose as formatted markdown.
 *
 * Builds React elements from the AST rather than setting HTML, so nothing an
 * agent writes — or relays out of a file or a web page it read — can inject
 * markup into the page. Unsupported syntax falls through as literal text, which
 * is the same thing the transcript showed before this existed.
 */
export function Markdown({ source }: { source: string }) {
  return <div className="md">{renderBlocks(parseMarkdown(source))}</div>;
}

function renderBlocks(blocks: Block[]): ReactNode {
  return blocks.map((block, i) => <Fragment key={i}>{renderBlock(block)}</Fragment>);
}

function renderBlock(block: Block): ReactNode {
  switch (block.type) {
    case 'paragraph':
      return <p>{renderInlines(block.children)}</p>;

    case 'heading': {
      // Agent replies open with "## Summary" constantly; rendered at document
      // scale those would tower over the conversation, so the whole scale is
      // shifted down in CSS and only the level is carried through.
      const Tag = `h${Math.min(block.level, 6)}` as 'h1';
      return <Tag>{renderInlines(block.children)}</Tag>;
    }

    case 'code':
      return (
        <pre className="md-code">
          <code data-lang={block.lang ?? undefined}>{block.value}</code>
        </pre>
      );

    case 'list':
      return block.ordered ? (
        <ol start={block.start}>{block.items.map((item, i) => <li key={i}>{renderItem(item)}</li>)}</ol>
      ) : (
        <ul>{block.items.map((item, i) => <li key={i}>{renderItem(item)}</li>)}</ul>
      );

    case 'quote':
      return <blockquote>{renderBlocks(block.children)}</blockquote>;

    case 'table':
      return (
        // Wrapped because a wide table must scroll inside itself; letting it
        // widen the row would put the whole transcript on a horizontal scrollbar.
        <div className="md-table-wrap">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th key={i} style={alignOf(block.align[i])}>
                    {renderInlines(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} style={alignOf(block.align[c])}>
                      {renderInlines(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case 'rule':
      return <hr />;
  }
}

/** A single-paragraph item renders inline, so tight lists do not gain gaps. */
function renderItem(item: Block[]): ReactNode {
  if (item.length === 1 && item[0]?.type === 'paragraph') return renderInlines(item[0].children);
  return renderBlocks(item);
}

function renderInlines(nodes: Inline[]): ReactNode {
  return nodes.map((node, i) => <Fragment key={i}>{renderInline(node)}</Fragment>);
}

function renderInline(node: Inline): ReactNode {
  switch (node.type) {
    case 'text':
      return node.value;
    case 'break':
      return <br />;
    case 'code':
      return <code>{node.value}</code>;
    case 'strong':
      return <strong>{renderInlines(node.children)}</strong>;
    case 'em':
      return <em>{renderInlines(node.children)}</em>;
    case 'strike':
      return <del>{renderInlines(node.children)}</del>;
    case 'link':
      return (
        <a href={node.href} target="_blank" rel="noreferrer noopener">
          {renderInlines(node.children)}
        </a>
      );
  }
}

function alignOf(align: 'left' | 'center' | 'right' | null | undefined) {
  return align ? { textAlign: align } : undefined;
}
