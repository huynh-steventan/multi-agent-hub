/**
 * Which sessions are open, and where.
 *
 * The desktop workspace is a fixed row of columns, each holding zero or more
 * sessions with one of them frontmost. A 1080p screen fits three side by side,
 * which is the width the layout is built around; a column holding more than one
 * session shows tabs.
 *
 * Kept pure and separate from React so the placement rules — which column a new
 * session lands in, what gets focused when the frontmost tab closes — can be
 * reasoned about and tested without rendering anything.
 */

export const COLUMN_COUNT = 3;

/**
 * Where a session goes when no column is empty.
 *
 * The middle column, because it is the one flanked by context on both sides and
 * the least likely to be holding something the user just walked away from.
 */
const FALLBACK_COLUMN = 1;

export interface Layout {
  /** Session ids per column, in tab order. */
  columns: string[][];
  /** The frontmost session in each column, or null when the column is empty. */
  active: (string | null)[];
}

export function emptyLayout(): Layout {
  return { columns: [[], [], []], active: [null, null, null] };
}

/** Every session currently on screen, in column order. */
export function openIds(layout: Layout): string[] {
  return layout.columns.flat();
}

export function columnOf(layout: Layout, id: string): number {
  return layout.columns.findIndex((column) => column.includes(id));
}

/**
 * Repair a layout read back from storage.
 *
 * The persisted copy can disagree with reality in every direction: sessions
 * deleted from another tab, a duplicated id, an array of the wrong length after
 * a change to COLUMN_COUNT. Rather than trusting it, everything unrecognized is
 * dropped and the shape is rebuilt.
 */
export function normalize(raw: unknown, knownIds: Set<string>): Layout {
  const source = raw as Partial<Layout> | null;
  const seen = new Set<string>();
  const columns: string[][] = [];

  for (let i = 0; i < COLUMN_COUNT; i += 1) {
    const column = Array.isArray(source?.columns?.[i]) ? source.columns[i]! : [];
    columns.push(
      column.filter((id) => {
        if (typeof id !== 'string' || !knownIds.has(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
      }),
    );
  }

  const active = columns.map((column, i) => {
    const wanted = source?.active?.[i];
    return typeof wanted === 'string' && column.includes(wanted) ? wanted : (column[0] ?? null);
  });

  return { columns, active };
}

/**
 * Show a session, placing it in an empty column when there is one.
 *
 * Opening into empty space is the behavior that makes a three-up workspace feel
 * like a workspace: the common case of opening a second and third session fills
 * the screen out instead of stacking everything into one column's tabs.
 */
export function openSession(layout: Layout, id: string): Layout {
  const existing = columnOf(layout, id);
  if (existing !== -1) return focusSession(layout, id);

  const empty = layout.columns.findIndex((column) => column.length === 0);
  return placeIn(layout, id, empty === -1 ? FALLBACK_COLUMN : empty);
}

/** Move a session to a specific column — the drag-and-drop path. */
export function moveSession(layout: Layout, id: string, toColumn: number): Layout {
  if (toColumn < 0 || toColumn >= COLUMN_COUNT) return layout;
  if (columnOf(layout, id) === toColumn) return focusSession(layout, id);
  return placeIn(layout, id, toColumn);
}

export function focusSession(layout: Layout, id: string): Layout {
  const column = columnOf(layout, id);
  if (column === -1) return layout;
  const active = [...layout.active];
  active[column] = id;
  return { columns: layout.columns, active };
}

/**
 * Remove a session from the workspace.
 *
 * When the frontmost tab closes, focus falls to the tab that slid into its
 * place, or to the new last tab if it was the rightmost — the same thing a
 * browser does, and the thing that keeps the eye where it already was.
 */
export function closeSession(layout: Layout, id: string): Layout {
  const from = columnOf(layout, id);
  if (from === -1) return layout;

  const index = layout.columns[from]!.indexOf(id);
  const columns = layout.columns.map((column, i) => (i === from ? column.filter((x) => x !== id) : column));
  const active = [...layout.active];
  if (active[from] === id) {
    const remaining = columns[from]!;
    active[from] = remaining[Math.min(index, remaining.length - 1)] ?? null;
  }
  return { columns, active };
}

/** Put `id` at the end of `toColumn`, removing it from wherever it was. */
function placeIn(layout: Layout, id: string, toColumn: number): Layout {
  const detached = closeSession(layout, id);
  const columns = detached.columns.map((column, i) => (i === toColumn ? [...column, id] : column));
  const active = [...detached.active];
  active[toColumn] = id;
  return { columns, active };
}
