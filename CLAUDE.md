# CLAUDE.md — multi-agent-hub

> New session: read this first. **It is the full handoff.** A fresh session should be able to
> continue the work from this file alone.

## What this project is

A mobile-first web console that drives three coding-agent CLIs — `claude`, `kimi`, and `qwen` — from
one interface, so an operator can start and steer agent sessions from a phone. It runs on the
operator's own machine, binds to loopback only, and is reached remotely over a private overlay
network (`tailscale serve`). A single operator, one machine; there is no multi-user story and no
cloud deployment.

It exists because the three CLIs are individually excellent and collectively unmanageable: three
terminals, three session models, three separate places to check how much quota is left. The hub
unifies session management, repo selection, model/mode switching, a combined usage dashboard, and an
optional per-session notification whenever a turn ends.

## Hard constraints (do not violate)

1. **Never set `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) in the hub's environment**, and never
   pass `claude --bare`. Both force the Claude CLI off subscription OAuth and onto metered API
   billing. `server/src/adapters/base.ts` scrubs these from the child environment and a unit test
   asserts `--bare` never appears in argv — keep both.
2. **Never bind the server to anything but `127.0.0.1`.** The hub is an unauthenticated
   shell-equivalent: anyone who reaches it can run arbitrary commands in any repo. Remote access is
   the overlay network's job, which supplies both TLS and private-mesh-only reachability.
   `tailscale funnel` is never correct here — it publishes to the open internet.
3. **Never log, echo, or send to the client any credential read from disk.** The Kimi access token
   and the Qwen console ticket stay inside their provider modules.
4. **Usage providers never fabricate a number.** An unknown percentage is `null` and renders as a
   dash. A zero would read as "plenty of quota left", which is the opposite of "could not
   determine" — see `UsageSnapshot.caveat`. The same rule covers `windowMs`: a window's span is set
   only when its `resetsAt` is also known (use `spanIfAnchored()`), because pace is derived from the
   pair and a guessed span yields a confident wrong answer.
5. **A permission mode an agent cannot honor must not be silently accepted.** The API falls back to
   the adapter's default and the UI only offers modes the adapter advertises. Kimi has exactly one.
6. **`bash scripts/verify.sh` green before any commit.** It runs typecheck (server + web), the unit
   tests, a real frontend build, and an end-to-end server smoke.
7. **A path an agent is told to read must be one the server built.** The prompt frame carries
   attachment `storedName`s, never paths; `findAttachment()` resolves them against the session's own
   directory and refuses anything not matching `^[0-9a-f]{8}-[A-Za-z0-9._-]+$`. The same check guards
   the download route. Loosening it turns the hub into a file-exfiltration endpoint.
8. **Nothing above `server/src/adapters/` may branch on `agent === 'x'` for protocol reasons.**
   UI-level branching (badge colors) is fine. See `docs/ADAPTERS.md`.

## Verified facts / research (do not re-litigate)

Established by direct probing of the installed CLIs. Do not re-derive; re-probe only if a CLI is
upgraded. The full dialect table and the qwen tool-registry measurements live in
[`docs/ADAPTERS.md`](docs/ADAPTERS.md) — that is the canonical copy.

- **All three support headless streaming and session resume**, which is what makes one uniform
  adapter shape possible.
- **When an agent names its session is dialect**, so nothing above the adapters may key on an init
  frame to learn it. The server used to persist `nativeSessionId` only on `init` — which claude and
  qwen emit and kimi does not — so kimi's id was captured into `TurnState`, never surfaced, and every
  kimi turn silently started a *new* CLI session that remembered nothing. `runTurn` therefore
  resolves `done` with a `TurnOutcome` carrying the id from **every** exit path (interrupt included:
  a stopped turn still created a real session worth resuming), and `startTurn` persists that. The
  init-time write is kept as well, so an id already known mid-turn survives a server restart that
  kills the turn under it. `runTurn.test.ts` covers the plumbing and `smoke.mjs` covers the store
  write end-to-end with a **stub `kimi` first on `PATH`** — the store write lives in `startTurn`,
  which is not importable, so no unit test can reach it.
- **Usage sources, one per agent** — the hardest-won part of this project:
  - **claude** — `~/.claude.json` → `cachedUsageUtilization`, already exact. No API call, no auth.
    *Superseded (2026-08-14): this used to read a dedicated `~/.claude/usage-cache.json`. As of CLI
    2.1.232 that file is no longer written at all — confirmed by probing the installed binary, which
    now folds this into the general config file instead. The refresh mechanism is unchanged in
    spirit: every session start fires a near-zero-cost `source: "quota_check"` API call (not a real
    turn) that reads it off the `anthropic-ratelimit-unified-*` response headers, throttled by an
    internal cooldown. Since every hub turn is itself a session start, this stays fresh for free —
    there is nothing extra to trigger. Caveat unchanged: it only refreshes *while a session runs*, so
    it goes stale when idle. The per-model weekly-cap parsing (`kind: 'weekly_scoped'`) is carried
    over from the old format and unverified against the new one — no account observed here has a
    per-model cap to confirm the shape still matches.*
  - **kimi** — an authenticated usage endpoint, bearer token read from the CLI's own credentials
    file. **The `User-Agent` MUST identify as a Kimi coding agent**; a generic UA returns
    `access_terminated_error`, which looks like an auth failure and is not. **Access tokens live only
    900s**, so the provider refreshes proactively (300s before expiry) and reactively (once on a
    401). **Kimi ROTATES refresh tokens**: every refresh issues a new one and invalidates the token
    it replaced, so the rotated pair is **written back** to the CLI's credentials file (merged into
    the existing JSON, temp-file + rename, mode 0600) — a correctness requirement, not bookkeeping.
    *Superseded: this used to cache refreshed tokens in memory only, on the reasoning that the CLI
    owns that file and writing there would race it. That held for concurrent writes but not for
    rotation — discarding the rotated token left a spent one on disk, so auth survived exactly one
    refresh cycle after each login and then failed `invalid_grant` permanently, taking the Kimi CLI's
    own credentials down with it. Do not revert to in-memory-only caching.*
  - **qwen** — the quota is denominated in **"token credits"**, not tokens, and only the Qwen Cloud
    console knows it. Returns fractions *consumed* for the 5-hour and 7-day windows plus reset
    timestamps. Window totals are not in the response, so they are config (`QWEN_SESSION_CREDITS` /
    `QWEN_WEEKLY_CREDITS`). **Auth is a browser session cookie**, NOT OAuth: there is no refresh
    token and no programmatic renewal, so expiry means re-copying the cookie by hand. Probed and
    confirmed: that **single cookie is sufficient** — `sec_token`, `origin`, `referer` and every
    tracking cookie are unnecessary. Fallback when the ticket dies: the per-call token ledger at
    `~/.qwen/usage/token-usage-<YYYY-MM>.jsonl`. **Not** the sibling `usage_record.jsonl`, which is
    written once per session at session *end*, so an in-progress session contributes nothing and
    "today" reads as a false zero. The two also disagree — per-session records over-counted a month
    by ~500M tokens versus the per-call ledger.
  - Raw tokens are a poor proxy for Qwen credits: the implied rate was ~33k–36k tokens/credit across
    two dashboard observations, and no linear model over (input, output, non-cached, call count) fit
    both windows without a negative coefficient. Use the console endpoint; do not try to compute
    credits from the ledger.
- **No CLI accepts an image or a file inline in a headless prompt**, and their reach across the
  filesystem differs: `claude --add-dir` and `kimi --add-dir` both widen it, **`qwen` has neither
  `--add-dir` nor `--include-directories`** and confines its file tools to the workspace root.
  Attachments therefore land *inside* the session's repo and are handed over as absolute paths in
  the prompt body — the weakest agent picks the design.
- **Headless permission denials look like missing tools from inside the session.** The `system/init`
  frame advertises the full tool list including `Bash` under *every* claude `--permission-mode`, and
  the hub passes no `--allowedTools`/`--disallowedTools`. What actually happens is that `-p` has
  nobody to answer a permission prompt, so anything needing approval is auto-denied — and repeated
  denials read to the model as an absent capability. Compounding it: **an untrusted workspace
  silently discards the project's entire `permissions.allow` list** (a stderr warning the hub was
  ignoring), so nearly every command fell through to a prompt. A denial arrives as an ordinary
  `tool_result` with `isError: true`, which the UI cannot distinguish from a command that genuinely
  failed — still true, still a gap.
- **What we spawn is not always the agent, so a turn must be signalled by process group.** `qwen`'s
  bin is a launcher that **`spawnSync`s** the real CLI, which itself spawns another process.
  `child.kill()` signals only the launcher, so Stop killed the shim and left the agent running —
  observed as a live `qwen` reparented to **PPID 1**, still holding the session, hours after Stop was
  pressed. The second-order effect is the one that actually broke the UI: a survivor inherits the
  stdout pipe, and node fires `close` only when *every* holder is gone, so the turn never settled —
  `active` never cleared, the session stayed pinned at `running`, further Stop presses were no-ops,
  and the composer refused new prompts with "A turn is already running". Killing the orphan by hand
  made the wedged session settle instantly, which is what confirmed the mechanism. Fixed by spawning
  `detached: true` and signalling `-pid` (SIGTERM, then SIGKILL after a grace), plus settling the
  turn on a timer regardless of whether the pipes ever close. `runTurn.test.ts` reproduces it with a
  fake launcher; against the old code the suite **hangs** rather than failing, which is the signature
  of this bug. Consequence to remember: `detached` also puts turns outside the server's process
  group, so they no longer die with it — `index.ts` interrupts every active handle on SIGINT/SIGTERM
  to compensate.
- **`claude` emits `rate_limit_event` frames mid-stream**, confirming subscription auth is in play
  (API-key usage does not produce them). Not yet consumed; a live-updating usage bar could use it.

## Current build state — what exists

Everything below is written, typechecked, unit-tested, and smoke-tested green, and all three agents
have run real turns end-to-end through the UI.

- `shared/protocol.ts` — the wire contract. `AgentEvent` is the normalized event union every adapter
  maps into; `AgentEventBody.kind: 'raw'` is the escape hatch so nothing is ever dropped silently.
- `server/src/adapters/base.ts` — `runTurn()`: spawns one CLI invocation per turn, line-parses
  stdout, guarantees **exactly one terminal `turn_end`** on every path (success, nonzero exit, spawn
  failure, interrupt) because that event is what fires the notifier. Also infers `awaiting_input` vs
  `completed`, since no CLI labels it.
- `server/src/adapters/{claude,kimi,qwen}.ts` — the three dialect mappers; `index.ts` is the
  registry. Each declares `defaultMode`, the permission posture a new session gets when the operator
  picks nothing; `/api/agents` publishes it and both the API and the new-session form defer to it
  rather than to any literal of their own.
- `server/src/usage/{claude,kimi,qwen}.ts` + `index.ts` — the three usage providers; `collectUsage()`
  never throws and never fabricates, and honors `USAGE_PROVIDERS` (a disabled provider still returns
  a snapshot with a caveat, rather than vanishing).
- `server/src/store.ts` — file-backed session registry + event log. Atomic writes via temp-file +
  rename; serialized so concurrent turns cannot interleave. The event log is **persisted** to
  `DATA_DIR/events/<sessionId>.json` (debounced ~750ms, flushed on SIGTERM/SIGINT, sequence numbers
  resume on load) so a redeploy no longer blanks open transcripts. `Store` is exported for tests.
- `server/src/attachments.ts` — prompt attachments. Owns the storage location
  (`<repo>/.multi-agent-hub/attachments/<sessionId>/`), the stored-name pattern that makes traversal
  impossible, `composePrompt()` (appends the path block after the operator's words), and
  `ensureGitIgnored()` (adds `.multi-agent-hub/` to `.git/info/exclude`, never to a tracked
  `.gitignore`). Nothing else builds an attachment path.
- `server/src/repos.ts` — shallow breadth-first git-repo discovery under `REPO_ROOTS`.
- `server/src/notify.ts` — Discord embed per turn end, colored by reason. Failures are swallowed: a
  webhook outage must never take down a turn that otherwise succeeded.
- `server/src/index.ts` — Express REST + `ws` websocket; loopback bind; usage poller.
- `shared/pace.ts` — burn-rate math (`computePace`), pure and injectable-clock so it is testable:
  expected-consumption line, ahead/behind status, projected exhaustion, day-boundary tick marks.
  `spanIfAnchored()` is what keeps `windowMs` and `resetsAt` from being supplied half-and-half.
- `web/src/` — React UI: `UsageStrip` (collapsed to names + weekly percentages by default; expanded
  it draws pace-colored bars with day marks), `SessionList` (page on mobile, drag-source sidebar on
  desktop), `NewSessionSheet` (bottom sheet with swipe-to-dismiss on mobile, centered modal on
  desktop; every keystroke is drafted to localStorage so cancelling costs nothing), `SessionView`
  (event stream, collapsible tool calls, settings panel, per-session persisted composer draft that
  grows to fit as it is typed — two lines up to a 40vh ceiling, then it scrolls — the attachment
  composer with paste/drag-drop/file-picker and image-preview chips uploaded eagerly so Send is
  instant, a title renamed in place from the header, and a transcript that follows the stream only
  while you are already at the end, with a floating ↓ button to resume following), `Workspace` (the
  desktop three-column layout).
- `web/src/markdown.ts` + `components/Markdown.tsx` — agent prose is rendered, not shown raw. The
  parser is pure and tested; the renderer builds React elements from its AST, so there is **no
  `dangerouslySetInnerHTML`** anywhere and no way for agent output — or a web page it read and
  relayed — to inject markup. Non-`http(s)`/`mailto` hrefs are refused and shown as literal text.
  Deliberately not CommonMark: it covers what the CLIs actually emit and lets the rest fall through
  as text. Two divergences on purpose — a single newline is a hard break, because agents wrap prose
  by intent; and `_` only opens emphasis at a word boundary, because `snake_case` is far commoner in
  agent prose than underscore emphasis. The operator's own echoed prompt is **not** rendered as
  markdown; it is marked `from: 'operator'` on the wire (a `> ` prefix would have been read as a
  blockquote) and shown exactly as typed.
- `web/src/permissionMode.ts` — the new-session form's mode-selection model, pure and tested:
  `resolveMode()` always returns something the chosen agent advertises, and `modeAfterAgentSwitch()`
  keeps an unchosen mode unchosen so each agent contributes its own default instead of inheriting the
  previous one's.
- `web/src/layout.ts` — the pure workspace-placement model (empty column first, else middle; tabs;
  focus-follows-close), separate from React so it can be tested. `web/src/persist.ts` — the
  localStorage wrapper behind every "where I was" value.
- `scripts/smoke.mjs` — boots the real server on a throwaway `DATA_DIR` and exercises every endpoint,
  using a stub CLI first on `PATH`. Spends **no** agent turns.
- `scripts/deploy.sh` (`npm run deploy`) — the one command from edit to live: build the frontend,
  restart the launchd service, re-assert `tailscale serve`, then *prove* it by health-checking and
  comparing the fingerprinted bundle name in `web/dist/index.html` against what the server serves.
  Deployment is three steps and doing two of them is the failure mode — `tsx` does not hot-reload
  under launchd, and the server only ever serves `web/dist`. Delegates to `deploy/install.sh` when
  the service is not installed or the plist template has changed; otherwise `launchctl kickstart -k`,
  which restarts in place without racing itself for the port.
  **`launchctl bootout` returns before launchd has finished tearing the job down**, and bootstrapping
  into that window fails with `Bootstrap failed: 5: Input/output error` — worse than it reads,
  because bootout already succeeded, so the hub is left *down* rather than merely un-updated.
  `install.sh` waits for the job to disappear and retries the bootstrap; this is also why the routine
  path is `kickstart -k`, which stops and starts as one operation and never opens that window.

**Usage refresh cadence:** quota is polled every **30 minutes** (`USAGE_POLL_MS`), and
`GET /api/usage` serves that cache rather than re-collecting per request — two of the three providers
are calls against someone else's API and these windows move over hours. A poll costs more than one
HTTP call: Kimi's access token lives 900s, so any poll spaced wider than that forces a refresh, and
because Kimi rotates refresh tokens that means one token rotation **and one rewrite of the CLI's
credentials file per poll**. Refreshes scale 1:1 with polls, so the interval is the only lever — 10
minutes meant ~144 rotations/day against Kimi's auth server, 30 minutes means ~48. Measured windows
are 5h and 1 week, so the added staleness is invisible. **Lowering this is not free.**

**Turn model (the central design decision):** every turn is a *fresh* one-shot CLI invocation resumed
by native session id — the hub holds no long-lived agent processes. Sessions therefore survive a
server restart, there are no orphans to reap, and all three CLIs behave identically. The tradeoff
accepted: no mid-turn interactive permission prompts, so permission posture is configured per-session
up front instead.

## Docs authority order

1. This file (`CLAUDE.md`) — wins on conflict.
2. `docs/DECISIONS.md` — the WHY; do not re-litigate entries there.
3. `docs/ADAPTERS.md` — the canonical CLI dialect reference.
4. `docs/CONVENTIONS.md` — the HOW.
5. Everything else — trust live code over stale prose; if a doc is wrong, mark it
   `SUPERSEDED (<date>) — disregard` and note the correction here.

## Known gaps / not wired

Deliberately deferred, and deliberately absent from the README:

- Slash commands (`/compact`, `/model`, …) — the CLIs expose them; the hub does not send them.
- Mid-turn permission approval — structurally excluded by the one-shot turn model.
- `rate_limit_event` frames are parsed but unused; they could drive a live-updating usage bar.
- A denial and a genuine tool failure are indistinguishable in the transcript (both are
  `tool_result` with `isError: true`).
