import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { RepoEntry } from '../../shared/protocol.ts';
import { effectiveRepo, visibleRepos } from './repoPicker.ts';

const repo = (name: string): RepoEntry => ({
  path: `/Users/x/${name}`,
  name,
  branch: null,
  dirty: false,
});

const REPOS = [repo('multi-agent-hub'), repo('payments-api'), repo('docs-site')];

test('the filter matches on name, case-insensitively', () => {
  assert.deepEqual(
    visibleRepos(REPOS, 'PAYMENTS').map((r) => r.name),
    ['payments-api'],
  );
  assert.deepEqual(visibleRepos(REPOS, '   ').map((r) => r.name), REPOS.map((r) => r.name), 'blank filter shows all');
});

test('the option list is capped so a huge tree stays usable', () => {
  const many = Array.from({ length: 200 }, (_, i) => repo(`r${i}`));
  assert.equal(visibleRepos(many, '').length, 80);
});

test('a preference that survives the filter is kept', () => {
  const visible = visibleRepos(REPOS, 'a');
  assert.equal(effectiveRepo('/Users/x/payments-api', visible), '/Users/x/payments-api');
});

test('filtering the preferred repo away selects what the list shows instead', () => {
  // The bug this guards: the form remembers multi-agent-hub, the operator filters to
  // payments-api and presses Start without touching the select. The browser was
  // displaying payments-api, so that is what must be used — not the remembered
  // multi-agent-hub, which is no longer on screen.
  const visible = visibleRepos(REPOS, 'payments');
  assert.equal(effectiveRepo('/Users/x/multi-agent-hub', visible), '/Users/x/payments-api');
});

test('a filter matching nothing selects nothing rather than a hidden repo', () => {
  assert.equal(effectiveRepo('/Users/x/multi-agent-hub', visibleRepos(REPOS, 'zzz')), '');
});

test('no preference falls through to the first visible repo', () => {
  assert.equal(effectiveRepo('', visibleRepos(REPOS, '')), '/Users/x/multi-agent-hub');
  assert.equal(effectiveRepo('', []), '');
});
