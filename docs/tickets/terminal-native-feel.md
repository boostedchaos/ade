---
type: reference
tags: [repo/ade-windows-port]
up: "[[ade-windows-port]]"
---
# Terminal: Native Feel (latency + minimal chrome)

Make the streamed terminal feel like a native one. Primary setup: browser on
the same machine as the server (localhost webui), keyboard-heavy use of agent
panes running the `claude` CLI. Direction settled in interview 2026-07-20:
keep the raw TTY (no Warp-style blocks, no structured feed), kill the
latency, add only a slim status header + waiting-on-you bar.

Rev 2 after adversarial review (Fable, 2026-07-20): rev 1 targeted a dead
code path and misread the webui input transport. Both corrected below.

## Where the latency actually is (verified against the live pipeline)

Keystroke path in the webui:

```
keydown → xterm onData → tRPC terminal.write mutation
  → **HTTP POST** (httpBatchLink — NOT the WS; only subscriptions ride WS,
    apps/webui/src/trpc-client-web.ts:31-42)
  → server router → daemon (JSON-line socket) → pty-subprocess (framed stdio)
  → PTY write → PTY echo
  → pty-subprocess output batcher: **32ms / 128KB**
    (packages/server-core/src/terminal-host/pty-subprocess.ts:60-61;
    queueOutput() at :99-113 ALWAYS arms the 32ms timer for small chunks)
  → daemon Session broadcast (immediate, terminal-host/session.ts:289-299)
  → tRPC WS subscription emit (superjson, apps/server/src/routers/terminal.ts:286)
  → xterm.write → WriteBuffer → rAF parse/paint (~4-8ms floor)
```

Key facts:

- The dominant fixed cost is the **32ms batch timer in the PTY subprocess**.
  There is no other timed batching downstream — daemon and server emit
  per-frame immediately.
- **Dead code warning:** `packages/server-core/src/terminal/session.ts`
  (`createSession`/`setupDataHandler`) and its `DataBatcher`
  (`packages/server-core/src/data-batcher.ts`, 16ms/200KB) are NOT on the
  live path — the daemon pipeline constructs sessions via
  `terminal-host/session.ts:963`. Do not "fix" the dead class. (Deleting it
  is a separate janitor task, not part of this work.)
- Every keystroke is an HTTP POST with headers, superjson envelope, and
  batch framing — a persistent-WS message would be cheaper and is already
  available (`wsLink`/`wsClient` exist in the same file).
- Client already tracks alternate-screen + bracketed-paste per pane
  (`useTerminalModes.ts:39-64`). The claude CLI is Ink-based and renders in
  the **normal buffer** (needs a 2-minute empirical confirm — see issue 4).
- Renderer: WebGL addon with DOM fallback (`Terminal/helpers.ts:110-152`);
  ligatures loaded unconditionally (`helpers.ts:238`). `TerminalSearch`
  exists and is hotkey-only (`Terminal.tsx:541`).
- Read-only mirrors swallow local input (`useTerminalConnection.ts:64-67`).
- Pane status source: `PaneStatus` union incl. `"permission"` and `"review"`
  (`apps/desktop/src/shared/tabs-types.ts:24`), set by the notifications
  subscription (`useAgentHookListener.tsx:256`) from hooks the agent wrapper
  installs. Known staleness: nothing fires on permission denial or Ctrl+C
  (documented at `useAgentHookListener.tsx:30-43`).

## Global acceptance bar

Every latency issue must show a **measured before/after keystroke→paint
delta** on localhost (via the issue-2 instrumentation, or its DEBUG log
predecessor). Unit tests alone are insufficient — rev 1 of this plan would
have shipped green tests against dead code. Target after issues 1+2:
**≤ ~15ms median** keystroke→paint (one frame).

## Issues to open

### 1. terminal-host: micro-coalesce PTY output flushing (biggest lever)

**File:** `packages/server-core/src/terminal-host/pty-subprocess.ts`
(`OUTPUT_FLUSH_INTERVAL_MS`/`MAX_OUTPUT_BATCH_SIZE_BYTES` at :60-61,
`queueOutput()` at :99-113, `flushOutput` call in `onExit` :316-318).

**Spec:** replace the fixed 32ms batch with a short idle-coalesce.

- On first queued chunk, arm a **2ms** coalescing timer (not 32ms). Each
  additional chunk within the window rides the same timer.
- Keep the size force-flush (128KB) exactly as today.
- Do NOT flush the first small chunk synchronously: Ink/claude repaints
  arrive as bursts of small chunks (erase-line + rewrite) in the same
  millisecond; flushing mid-burst ships torn partial repaints that today's
  coalescing hides. The 2ms idle window preserves burst atomicity while
  cutting the fixed cost from 32ms to ~2ms.
- Optional guard: if >N flushes occurred in the last 16ms (sustained flood),
  fall back to a 16ms timer to cap frame rate. Only add if the flood test
  below shows message-rate pain; otherwise skip.
- Clear any armed timer correctly when the size threshold forces a flush.

**Acceptance:**
- Unit tests: small chunk flushes ~2ms after arrival; a burst of small
  chunks within 2ms flushes as ONE frame; 128KB force-flush intact;
  split multi-byte UTF-8 still handled by the existing framing.
- **End-to-end:** measured keystroke→paint delta (DEBUG_TERMINAL delta log
  or issue-2 readout) before/after in a claude pane on localhost; expect
  roughly −30ms median. `yes | head -100000`-style flood shows no visible
  regression (no flicker, no runaway message rate).

**Tier:** cheap agent, but the acceptance requires driving the real app.

### 2. webui: keystrokes over the WebSocket + honest latency readout

**Files:** `apps/webui/src/trpc-client-web.ts` (:31-42), new hook under
`Terminal/hooks/`.

**Spec — transport:** widen the `splitLink` condition so `terminal.write`
(and `terminal.resize`) ride the existing `wsLink` instead of
`httpBatchLink`. Simplest correct form: route by `op.path.startsWith("terminal.")`
for mutations too; everything else stays HTTP. Auth is already carried by
the WS connection (`?token=` in the WS URL).

**Spec — measurement (primary metric = what the user feels):**
- `useTerminalLatency(paneId)`: on each user keystroke written to the pane,
  stamp `performance.now()`; resolve on the **next paint** after the next
  stream data event (`requestAnimationFrame` after `xterm.write` callback).
  Keep a rolling median over the last ~20 samples; expose `{ echoMs }`.
  TUI repaints make individual samples noisy — median, not EWMA.
- Keep a `terminal.ping` procedure (server→daemon round trip) ONLY as the
  idle/remote fallback shown when no typing has happened for >30s.
- No escape-sequence injection into the stream, ever.

**Acceptance:** keystroke echo in a claude pane shows a stable median on
localhost; DevTools network tab shows zero `/trpc` POSTs while typing;
mirrors/read-only panes produce no samples; issue-5's gate reads this
number.

**Tier:** cheap agent.

### 3. terminal: agent pane status header + waiting-on-you bar

**Files:** new `Terminal/components/TerminalStatusBar/`, mounted from
`Terminal.tsx` (render tree :532-569).

**Spec:** minimal chrome, terminal stays pure.

- Slim header (~24px, terminal-bg-matched), agent panes only (pane has an
  agent session — same gate the team dashboard uses; note: status only
  exists for wrapper-launched agents, manually-run `claude` in a plain
  shell gets none): status dot covering **all four** `PaneStatus` values
  (`working`/`permission`/`review`/`idle`, `tabs-types.ts:24`), the issue-2
  `echoMs` readout (stub "—" until issue 2 lands), and a search toggle
  opening the existing `TerminalSearch`.
- Sticky bottom bar, loud, only when `status === "permission"`:
  "Waiting on you", click focuses the terminal. Style language of
  `AgentStatusBadge` (team-dashboard components).
- **Staleness handling (required):** no hook fires on permission denial or
  Ctrl+C (`useAgentHookListener.tsx:30-43`), so the bar must ALSO clear on
  any user keystroke written to the pane (input ⇒ the user responded),
  mirroring the mobile-Esc clear at `Terminal.tsx:498-506`.
- No layout shift on status change; never overlaps the mobile
  `TerminalKeyBar`; plain shells render neither element.

**Acceptance:** header on agent panes only; dot tracks all four statuses
live; search button works; waiting bar appears on a real permission prompt,
clears on typing a response AND on denial-via-typing; no overlap with the
key bar on mobile viewport.

**Tier:** cheap agent.

### 4. SPIKE: is predictive local echo viable against claude's Ink UI?

**Half-day timebox, decision doc as output — no addon code.**

Rev 1 planned a straight port of VS Code's type-ahead addon. Review
flagged the likely failure: Ink doesn't echo typed characters — it repaints
the input-box region (cursor moves, line erases, rewritten rows, software
cursor). Prediction would mismatch → rollback → permanent cool-off exactly
in agent panes (VS Code ships `localEchoExcludePrograms` for this class of
program). And after issues 1+2, localhost echo should be ≤~15ms — under one
frame — so type-ahead's localhost value may round to zero anyway.

**Spike tasks:**
1. Record the raw stream (`SUPERSET_TERMINAL_DEBUG=1`) while typing into a
   claude pane. Confirm normal-buffer vs alt-screen (gates the whole idea).
2. Inspect the per-keystroke frames: is the typed char identifiable at a
   predictable cell, or is it a full region repaint?
3. Measure post-issue-1 localhost echo. If ≤15ms, type-ahead is a
   remote-only (Tailscale) feature by definition.

**Decision matrix:** (a) frames are match-able → open the full addon ticket
(mid-tier agent, VS Code reference, gates: alt-screen off, mirrors off,
unfocused off, kill switch); (b) not match-able → scope type-ahead to
plain-shell line editing only, parked until remote becomes primary;
(c) localhost already ≤15ms → park entirely under the remote milestone.

**Tier:** cheap agent can run the recording; the decision is ours.

### 5. (parked) flood/render tuning — gated on issue-2's echoMs

Open only if `echoMs` stays high after 1+2, or flood tests stutter:

- Ligatures addon loaded unconditionally (`helpers.ts:238`) — measure, make
  conditional if hot.
- Client per-chunk scans (`useTerminalStream.ts:150-152`) — cheap
  (`lastIndexOf` over small carry), profile before touching.
- Server per-chunk scans on the same hot path:
  `portManager.checkOutputForHint` + `historyManager.writeToHistory` run
  synchronously per data event (`daemon/daemon-manager.ts:175-179`).
- WS socket `setNoDelay` hygiene check while in there.

## Sequencing

```
1 (coalesce) ──┬─→ 4 (spike measures the post-1 world)
2 (WS + metric) ┘
3 (header) — independent; stubs echoMs until 2 lands
5 — only if 2's numbers demand it
```

1 ∥ 2 ∥ 3 parallelizable. 4 runs after 1+2 land (its decision depends on
their outcome).

## Out of scope (explicitly)

- Warp-style command blocks / OSC 133 — rejected in interview.
- Structured agent feed replacing the terminal — rejected.
- Deleting the dead `terminal/session.ts` + `data-batcher.ts` path — worth
  doing, but that's a repo-janitor ticket, not this milestone.
- Full superjson→binary transport rework — the WS routing change in issue 2
  is the cheap 90%; revisit the rest only if remote becomes primary.
- Plain shells get the latency fixes free (shared path) but no chrome.
