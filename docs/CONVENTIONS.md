# CONVENTIONS.md — the *what* (see DECISIONS.md for the *why*)

## Commit style

- **Small, verified increments.** One logical change per commit; `scripts/verify.sh` passes before
  every commit. A red build is never the base for the next change.
- **Message shape:** an imperative subject line describing the behavior change (not the files
  touched); a body only when the diff can't speak for itself; reference the CLAUDE.md increment or
  DECISIONS.md entry when one applies.
- **Fixed trailer:** if an agent authored or co-authored the change, end the message with the
  project's fixed attribution trailer, e.g.:

  ```
  Co-Authored-By: Claude <noreply@anthropic.com>
  ```

  Pick one trailer for the project and never vary it — a stable trailer is greppable provenance.

## Verify discipline

- **A change isn't done until it's exercised end-to-end** — typecheck and unit tests are necessary,
  not sufficient. Drive the affected flow for real (run the command, hit the endpoint, load the
  page) before calling it shipped.
- `scripts/verify.sh` is the **canonical gate**: it's what "green" means in this repo. Keep it fast
  enough that nobody is tempted to skip it, and keep its smoke steps current as the surface grows.
- Behavior changes come with a test. The pure modules (`shared/pace.ts`, `web/src/layout.ts`,
  `web/src/markdown.ts`, `web/src/permissionMode.ts`) are pure precisely so this is cheap.

## Doc-location rule

Before writing any document, place it deliberately in one of three homes:

1. **Private scratch** — ephemeral working notes, triage output, thinking-out-loud. Lives outside
   the repo (or in a gitignored scratch dir); never committed, never shipped.
2. **In-repo** — the doc *is* a deliverable or the durable home of project knowledge
   (CLAUDE.md, docs/, skills). Committed with the change it describes.
3. **Staged-external** — destined for an outside audience (a wiki page, a customer doc, a public
   post). Draft it locally first, review it for anything internal, and hand it off explicitly —
   never auto-publish.

The point: choosing the location *first* prevents internal reasoning from leaking into public
artifacts and prevents durable knowledge from dying in scratch files.

## Doc hygiene

- Outdated docs are marked **`SUPERSEDED (<date>) — disregard`** in place, never silently deleted;
  provenance survives, and CLAUDE.md's authority order says what wins.
- Time-boxed exceptions get a dated `TEMPORARY (…) — remove when …` banner so they can't quietly
  become permanent.
