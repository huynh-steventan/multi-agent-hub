import type { RepoEntry } from '../../shared/protocol.ts';

/**
 * The repo picker's selection model, kept out of the component so it can be
 * tested without a DOM.
 *
 * The picker is a filter box over a `<select>`, and the two interact in a way
 * that silently sent the wrong repo: the form's remembered choice is not
 * necessarily one of the options the filter leaves on screen. A controlled
 * `<select>` whose `value` matches no option does not blank out — the browser
 * shows the first option instead (and on iOS the picker wheel opens on it), so
 * the user reads the filtered-to repo as selected. If they then hit Start
 * without actively changing the selection, no `change` event ever fires and the
 * old value is what gets submitted.
 *
 * The cure is to make "what the list shows as chosen" and "what the form uses"
 * the same value by construction — see `effectiveRepo`.
 */

/**
 * Cap on rendered options.
 *
 * A long option list is unusable on a phone and slow to render; the filter box
 * is how you reach anything past the cap.
 */
const MAX_VISIBLE = 80;

/** The repos the picker actually renders, for a given filter string. */
export function visibleRepos(repos: RepoEntry[], filter: string): RepoEntry[] {
  const q = filter.trim().toLowerCase();
  const list = q ? repos.filter((r) => r.name.toLowerCase().includes(q)) : repos;
  return list.slice(0, MAX_VISIBLE);
}

/**
 * The repo the form will actually use, given what it would prefer and what the
 * list is currently showing.
 *
 * Always one of the visible entries, so the highlighted option and the
 * submitted path can never disagree. A preference that has been filtered out
 * yields the first visible repo — which is precisely what the browser displays
 * as selected — and an empty list yields `''`, which disables Start rather than
 * quietly falling back to a repo no longer on screen.
 *
 * Filtering therefore never mutates the draft: the preference survives, so
 * clearing a filter that matched nothing restores the original choice.
 */
export function effectiveRepo(preferred: string, visible: RepoEntry[]): string {
  return visible.some((r) => r.path === preferred) ? preferred : (visible[0]?.path ?? '');
}
