# Phase 5 design — ACP slash-command palette

**Status:** design approved for build, 2026-08-21. Brief: `PLAN_ACP_PANE.md` Phase 5.
The CAPABILITY already works — typing `/context` in an ACP pane runs it (verified
live, Phase 2). This phase is autocomplete UI plus the one host cache it needs.

## Ground truth

1. **The wire shape is already crossing.** `available_commands_update` maps to
   `{ kind, commands: AvailableCommand[] }` (`acp-host/types.ts:34`,
   `acp-connection.ts:77-80`) and is carried verbatim. The Phase 3 capture
   (`spikes/acp-phase3-capture/frames.json`) holds a real frame: **103 commands,
   and both `wrap-up` and `fable-orchestration` are in the live list.**
2. **`AvailableCommand` = `{ name, description, input?: { hint } | null }`**
   (SDK types.gen.d.ts:3817; input is `UnstructuredCommandInput`). Descriptions
   can be huge (a skill's whole trigger blurb, observed >1 KB) and carry a
   "(user)" suffix — the palette must render ONE truncated line.
3. **`session/new` does NOT return commands** (NewSessionResponse: sessionId,
   modes, configOptions only — SDK :2569). The list arrives solely as a
   notification shortly after start. Consequence: a pane that (re)mounts after
   that notification has fired — Mosaic remounts on split/drag — would show an
   empty palette forever if the renderer relies on the event stream alone. This
   is the exact trap the plan names ("an empty palette and a broken subscription
   look identical"). **The host must cache the latest list.**
4. Sending a command is just sending prompt text (`/name args`) through the
   existing `prompt` path. No new RPC.
5. Updates REPLACE the list wholesale (same semantics as plan/config lists).

## Decisions

- **D1 — Host cache, mirroring the config cache.** `AcpSession` stores the
  latest `AvailableCommand[]` (default `[]`), replaced on
  `available_commands_update` BEFORE the update is re-emitted; exposed as
  `AcpSessionInfo.availableCommands`. No seq: the renderer rule below makes the
  race benign, and command updates are rare (skill enable/disable).
- **D2 — Renderer seeding rule.** Per-pane `commands.ts` store (pure reducer +
  zustand, mirroring `controlBar.ts`): an EVENT always replaces the list; the
  mount seed (from `acp.state`) applies **only when the store's list is empty**.
  A live event can therefore never be clobbered by a stale snapshot.
- **D3 — Palette UI in `AcpComposer`.** Trigger: the composer text starts with
  `/` and the caret is still inside that first token (commands are line-initial;
  a `/` mid-sentence must NOT open it). Popover anchored above the textarea:
  filtered list, max ~8 rows visible then scroll, each row = `/name` +
  one-line truncated description. Filtering: case-insensitive prefix match on
  name first, then substring; pure function `filterCommands(list, query)` in
  `commands.ts`, tested DOM-free. Keyboard: ArrowUp/Down move, Enter or Tab
  accepts, Escape closes (and Escape/Enter must NOT leak to the composer's
  send-on-Enter while the palette is open). Accepting inserts `/name` and
  closes; if the command declares `input.hint`, show the hint as the composer's
  placeholder until the user types or sends. Mouse click accepts. Empty filter
  result: "no matching commands" row — never a silently absent popover.
- **D4 — Empty vs broken must be distinguishable.** When the palette opens
  before any list has arrived, show "commands not loaded yet" (list length 0)
  rather than nothing. This is the honest state for a dead subscription too —
  visible, not silent.
- **D5 — session_exit clears the command list** (per-session data, same rule as
  Phase 3's F2). The seed rule (D2) repopulates on the next session from its
  own state/events.

## Tests (author independently of the builder)

- Host: `available_commands_update` replaces the cache and `info()` carries it;
  the cached list survives a re-read; empty update empties it. Wire-level: the
  captured frame's shape crosses `mapSessionUpdate` intact (fixture or the
  capture file).
- Reducer/`filterCommands`: prefix-beats-substring ordering, case-insensitivity,
  empty query = full list, no-match, the D2 seed rule (seed on empty applies,
  seed on populated is ignored, event always wins), D5 clear on exit.
  **The disappearance case is the prove-it-fires test:** a second update
  WITHOUT `wrap-up` must remove it from the filtered result — deterministic
  stand-in for the plan's "disable a skill" check.
- Trigger logic (pure): "/" at start opens, "/" mid-text does not, caret
  position respected.
- Live gate (by hand or scripted): the real list contains `wrap-up` and
  `fable-orchestration` (ALREADY EVIDENCED in the committed capture); selecting
  `/wrap-up` in the pane and sending runs it. The live skill-disable check is
  NOT run against Kyle's real `~/.claude/skills` (too invasive); the
  deterministic disappearance test covers the mechanism and this is recorded as
  the deliberate gap.

## Out of scope

Argument autocomplete beyond the hint placeholder; structured command input;
command history; fuzzy-ranking beyond prefix/substring; palette for non-ACP
panes.

## Amendments after adversarial review (2026-08-21, findings F1-F8)

- **A1 (F1) — Exact match wins.** The D3 filter rule becomes: exact name match
  first, then prefix matches, then substring — the review found four real
  pairs in the live 103-command list ("loop"/"loop-library", "usage"/
  "usage-credits", "design"/"design-sync", "claude-api"/its plugin twin) where
  a fully typed name would silently accept a different command.
- **A2 (F2) — The hint is an inline element, not the textarea placeholder.**
  A placeholder renders only in an empty textarea, and accept always leaves
  "/name " — so the placeholder variant renders never (and tests can't see
  that). Render the hint as a muted inline strip adjacent to the composer
  while the accepted command's args are still empty; clear on typing/send.
- **A3 (F3) — The palette must fit the pane.** Every pane clips children
  (`overflow-hidden` ancestor); a fixed 15rem panel loses its TOP rows —
  the best matches — in short panes. Measure available space above the
  composer on open and cap the panel's maxHeight to it (floor ~3 rows).
- **A4 (F6) — The empty-palette message keys on session lifecycle.** "commands
  not loaded yet" only while the session is starting/ready-pre-notification;
  a dead/errored session says "session ended — commands unavailable". D4's
  point is that empty and broken are distinguishable; list-length alone
  cannot tell them apart.
- **A5 (F4, F5, F7, F8) — mechanical fixes:** highlighted row scrolls into view
  (`scrollIntoView({block:"nearest"})`, precedent in BrowserPane's
  UrlSuggestions); Enter/Tab/Escape branches guard `isComposing` (precedent in
  ai-elements prompt-input); clamp `selected` against the live matches length
  when the list shrinks mid-open; `info()` deep-copies cached command objects
  like ConfigOptionCache does.
