# DECISIONS.md — append-only WHY-log

> This file records **why**, not what. Each entry states the decision, the tradeoff, what was
> **rejected**, and the lesson — so future sessions (and forkers) don't re-litigate settled
> tradeoffs. Append only; never rewrite history. If a decision is later reversed, append a new
> entry that cites the old one — don't edit the old one. `docs/CONVENTIONS.md` is the *what*;
> this is the *why*. Optionally tag entries by theme, e.g. `[hooks]`, `[testing]`.

---

## 2026-07-11 — Doc-drift enforcement is a fail-open nudge, not a blocking gate `[hooks]`

- **Decision:** The Stop hook that detects "source changed but the doc didn't" prints one reminder
  line and always exits 0. Doc upkeep is enforced by convention + the nudge, not by failing the
  turn.
- **Tradeoff:** A fail-open nudge can be ignored, so docs *can* still drift; in exchange, the hook
  can never wedge a session, block an unrelated turn, or train the operator to bypass hooks.
- **Rejected:** (1) A blocking Stop/pre-commit check — too hostile for exploratory work and
  mid-task stops, and a hook that cries wolf gets disabled. (2) Auto-editing the doc from the
  hook — a hook must never write prose on the operator's behalf.
- **Lesson:** Reserve fail-closed behavior for security boundaries; upkeep mechanisms should be
  cheap, loud enough to see, and impossible to be harmed by.

## 2026-07-28 — Quota bars are colored by pace, not by absolute consumption `[usage]`

- **Decision:** Wherever a window's span is known, the bar's color answers "am I burning too fast"
  rather than "how much is gone": green on or under the straight line that lands on 100% at reset,
  amber up to ~20% over it, red beyond. Gray ticks mark each day boundary, and when the current
  burn projects past 100% before the reset, that time is printed. Windows whose span is unknown
  (Kimi's rolling one) keep the old absolute severity.
- **Tradeoff:** Pace needs a window *start*, which no provider reports — it is derived as
  `resetsAt − windowMs`, so `windowMs` had to be added to the wire type and hard-coded per
  provider. A CLI silently changing its window length would produce confidently wrong pace lines.
- **Rejected:** (1) Coloring by absolute percentage — 60% is comfortable on day five and alarming
  on day one, so a fixed threshold is wrong twice. (2) Guessing a span for Kimi's rolling window
  to make the UI uniform — a fabricated denominator is exactly what constraint 4 forbids.
  (3) A pure ratio test with no absolute floor — two hours into a week the pace line sits near
  zero, so one ordinary turn reads as "200% over pace" and the bar is permanently red; a 3-point
  grace band absorbs that without hiding a real overspend.
- **Lesson:** A number is only actionable next to the expectation it should be compared against.
  Also: `windowMs` without `resetsAt` is useless, so providers now emit the pair or neither —
  a derived value's inputs should be made impossible to supply half of.

## 2026-07-28 — The event log is persisted, not just held in memory `[state]`

- **Decision:** `store` writes each session's recent events to `DATA_DIR/events/<id>.json`,
  debounced ~750ms and flushed on SIGTERM/SIGINT, and replays them on boot with sequence numbers
  resuming where they left off.
- **Tradeoff:** Transcript writes now touch the disk during a streaming turn, and a hard kill can
  still lose the last sub-second of scrollback. In exchange, a redeploy — the single most common
  event in this project's life — stops blanking every open session.
- **Rejected:** (1) Keeping it in memory and calling the wipe cosmetic — the hub is redeployed
  several times an hour, so "cosmetic" meant losing the visible conversation constantly.
  (2) Persisting from the browser into localStorage — that hides the loss per-device rather than
  fixing it, and the server is the thing that actually holds the record. (3) Writing on every
  append — a streaming turn emits dozens of events a second and nothing reads the file until the
  next boot.
- **Lesson:** "It's only the frontend that loses it" is usually a claim about *where the symptom
  shows*, not about where the state should live.

## 2026-07-28 — The desktop layout is three fixed columns, not floating windows `[ui]`

- **Decision:** Above 1100px the UI becomes a sidebar plus three equal columns; a column with more
  than one session grows tabs, sessions are dragged between columns, and a newly opened session
  takes an empty column or falls back to the middle. Below that width it stays the single-pane
  phone UI. The arrangement is persisted, as are per-session composer drafts.
- **Tradeoff:** Fixed columns cannot be resized or rearranged, and three is a hard cap on
  simultaneous sessions. In exchange there is no window management to build, no z-order, no
  overlap, and the layout is a small enough value to serialize and repair on load.
- **Rejected:** (1) Free-floating draggable windows — far more state and interaction for a
  three-session ceiling. (2) Rendering the workspace at all widths and letting it squeeze — three
  columns below ~1100px are too narrow to read a transcript in. (3) A "+ New" button per column —
  one button plus the empty-column drop target says the same thing once.
- **Lesson:** When the number of things on screen is bounded and small, a tiling layout removes an
  entire category of UI work that a general solution would have demanded.

## 2026-07-28 — Attachments reach agents as in-repo paths, not inline data `[protocol]`

- **Decision:** Pasted images and picked files upload to
  `<repo>/.multi-agent-hub/attachments/<sessionId>/`, and the server appends their **absolute paths** to
  the prompt text so the agent reads them with its own file tool. The hub adds `.multi-agent-hub/` to the
  repo's `.git/info/exclude` on first use. The client sends back only `storedName`s; the server
  rebuilds every path itself.
- **Tradeoff:** Real files appear in the operator's working tree, and an agent that ignores the
  instruction simply never looks at the attachment — there is no protocol-level guarantee it was
  read. In exchange one mechanism covers all three CLIs, with no adapter branching and no
  per-agent capability matrix.
- **Rejected:** (1) Inline image data in the prompt — **none** of the three CLIs accept it in
  headless mode, so there is nothing to send it through. (2) Storing under `DATA_DIR` and widening
  the agent's reach with `--add-dir` — `claude` and `kimi` have that flag but **`qwen` does not**,
  and confines its file tools to the workspace root, so a third of the agents could not read their
  own attachments. (3) A hybrid that stores outside the repo for two agents and inside it for
  `qwen` — that puts `agent === 'x'` branching above the adapter layer, which `CLAUDE.md` forbids.
  (4) Writing to `.gitignore` — that is a tracked file the repo owns; `.git/info/exclude` is
  local-only and produces no diff to explain. (5) Trusting a client-supplied path on the prompt
  frame — the hub would then take dictation on which file to feed an agent.
- **Lesson:** When capabilities differ across backends, the constraint that decides the design is
  the *weakest* one, not the average. `qwen`'s missing `--add-dir` picked the storage location for
  all three.

## 2026-07-28 — Every agent defaults to the most permissive mode it can honor `[permissions]`

- **Decision:** `AgentAdapter.defaultMode` is per-agent and fully permissive wherever the CLI can
  express it: `claude` → `bypass` (`--permission-mode bypassPermissions`), `qwen` → `bypass`
  (`--approval-mode yolo`), `kimi` → its lone `default`, which is already yolo headlessly. A unit
  test asserts the mode is a member of `supportedModes`; a smoke check asserts a session created
  without a mode gets the adapter's, per agent.
- **Tradeoff:** A hub session can now do anything in the repo it was pointed at, with no per-tool
  gate. This adds no exposure the hub did not already have — it is unauthenticated and
  shell-equivalent by construction, which is why it binds to loopback behind Tailscale — but it
  does remove the accidental brake that permission denials were providing.
- **Rejected:** (1) `acceptEdits` for `claude` — it covers file writes only, so Bash still prompts,
  and on a headless turn a prompt nobody can answer is a denial. (2) Leaving `default` and relying
  on `permissions.allow` — that list is silently discarded in an untrusted workspace, and it only
  ever covers commands enumerated in advance. (3) Injecting `/yolo` as an automatic first turn for
  `kimi` — probed: it replies "Yolo mode is already active", so it buys nothing while spending a
  real turn of quota and adding a junk exchange plus a new failure mode to every session.
  (4) A single global default constant — wrong for at least one agent at all times, since `kimi`
  has exactly one mode and the others have four.
- **Lesson:** A denial and a failure are indistinguishable downstream. The hub surfaces both as a
  `tool_result` with `isError: true`, so a gated agent does not report "I was not allowed to" — it
  reports, and apparently believes, that the capability is missing. Where no human is present to
  approve, the honest choices are full permission or none; a middle setting mostly manufactures
  misleading transcripts.

## 2026-07-30 — Machine-specific deployment is a rendered template, not a checked-in file `[deploy]`

- **Decision:** The launchd plist ships as `*.plist.template` with `__REPO__` / `__HOME__` /
  `__PATH__` / `__PORT__` / `__NPM__` / `__LOG__` placeholders, and `deploy/install.sh` renders it at
  install time from the invoking shell's own environment. The script derives the repo path from its
  own location and resolves `tailscale` and `npm` on `PATH` rather than at fixed absolute paths.
- **Tradeoff:** The installed plist is now a generated artifact, so `deploy.sh` can no longer diff
  the repo copy against the installed one to detect drift — it compares mtimes instead, which is
  coarser and will occasionally reinstall unnecessarily. In exchange nothing in the repo encodes one
  machine's home directory, PATH layout, or hostname.
- **Rejected:** (1) Checking in a plist with real paths and telling people to edit it — a config file
  everyone must edit before first use is a file everyone commits back by accident. (2) Generating the
  plist entirely from a heredoc in the script — the comments in that file explain *why* PATH matters
  and why `ANTHROPIC_API_KEY` is absent, and burying them in shell quoting loses them. (3) Asking the
  operator to supply the paths — the shell running the installer already knows them, and asking a
  human for something the machine can answer is how installs go wrong.
- **Lesson:** Seeding a service's environment from the shell that installs it is not merely
  convenient, it is *load-bearing*: launchd sources no profile, so the PATH captured at install time
  is the only evidence available about where the agent CLIs actually live. A CLI missing from it
  fails at turn time, not install time — a long way from the cause.

## 2026-07-30 — Usage collection is opt-out-able per provider `[usage]`

- **Decision:** `USAGE_PROVIDERS` selects which agents' quota is collected; unset means all three. A
  disabled provider still returns a snapshot, carrying a caveat that says it was turned off.
- **Tradeoff:** One more config key, and a code path where a card exists with no data in it. In
  exchange, the two providers that touch credentials can be declined without editing code — which
  matters because their costs are not comparable: reading Claude's quota is a local file read, while
  Kimi's rewrites the Kimi CLI's own credentials file on every refresh.
- **Rejected:** (1) Dropping disabled agents from the response entirely — a card that silently
  vanishes reads as "this agent has no quota", which is exactly the fabrication constraint 4 exists
  to prevent; the failure mode is identical whether the misleading value is a zero or an absence.
  (2) A single boolean disabling the whole dashboard — the objectionable provider is usually one
  specific one, and an all-or-nothing switch makes declining it cost the other two. (3) Prompting on
  first run — there is no interactive surface; the hub is a service.
- **Lesson:** "Never fabricate a number" generalizes to "never fabricate an absence". A UI element
  that disappears is making a claim too.

<!-- Append new entries below, newest last. Keep the four-part shape:
     Decision / Tradeoff / Rejected / Lesson. -->
