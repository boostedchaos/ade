# Phase 6 design — ACP by default, durable sessions, real status

**Status:** design approved for build, 2026-08-21. Brief: `PLAN_ACP_PANE.md`
Phase 6 + Risks 1/3/5. Recon 2026-08-21 (adapter 0.63.0 + repo source; file:line
refs verified there — do not re-derive).

## Ground truth

1. **Persistence storage already exists; the reader does not.** `AcpPaneState`
   persists `cwd` + `acpSessionId` through the tabs store (zustand persist v9,
   written at `AcpPane.tsx:109`, read by nothing). The CLI's own transcript
   store (`~/.claude/projects/<slug>/<sessionId>.jsonl`) outlives the adapter
   and the app.
2. **`session/load` = `session/resume` + full history replay.** Replay arrives
   as ORDINARY `session/update` notifications re-run through the same mapper as
   live traffic (no "history" marker), then `available_commands_update` is sent
   after replay on purpose. Same fingerprint discipline as resume: params must
   byte-match or the adapter tears the session down. Unknown/expired id →
   `RequestError.resourceNotFound`; deleted cwd → `invalidParams`.
3. **The router does not buffer events** (`routers/acp.ts:176`), and
   `AcpPane.tsx` starts the session (line 155) before the subscription mounts
   (line 158). Live traffic tolerates this; a load's instant replay does not.
4. **`user_message_chunk` is unmapped** (falls into `unknown`); a replayed
   conversation's user turns would render as nothing.
5. **`AskUserQuestion` is disabled by the adapter** when the client lacks
   `elicitation.form` (`acp-agent.js:4109` builds `disallowedTools`). This is
   the largest behavioural loss in the default flip — the agent cannot ask a
   multiple-choice question at all. The refusal-fallback consent dialog and MCP
   elicitation are gated on the same capability.
6. **Status:** ACP panes already ring Mission Control for working/review via
   `useAcpPaneStatus` (sole writer; hook env deliberately stripped). Missing:
   no `AcpPaneEvent` member for permission requests (the wire callback exists
   at `acp-connection.ts:250-252` and dead-ends), and `turn_error` maps to
   `idle` (a failed turn looks finished). The attention/notifications INBOX is
   a separate system ACP is not in (needs `agent_sessions` rows).
7. **Permission policy** (`auto-approve` | `prompt`) exists only inside
   acp-host; nothing plumbs it and no UI exists. `AcpConnection.setMode` and
   the mode list are already there.
8. **Creation paths that decide "terminal":** `GroupStrip.handleAddGroup`
   (:176) → `spawnAgentSession()` (`useAgentSession.ts:66`, which already does
   claude `--resume` lookup for terminal panes), `WorkspaceInitEffects` ×4,
   `bootstrap-open-worktree.ts:36`, and the `ade` CLI BridgeOp union (no `acp`
   member; duplicated in `@ade/control-plane` — "change one, change both").
9. Restart today: `main/index.ts:195` disposes all ACP children on quit; the
   tabs-store `merge` clears `working`/`permission` statuses on startup
   (keep-review) — restore must not fight it.

## Decisions

### Lane A — host + router (build first)

- **A1 — `loadSession` on the connection and a resume path on the session.**
  `AcpConnection.loadSession(sessionId, params)`; `AcpSession` accepts
  `resumeSessionId?: string` in its options — when set, `handshake()` calls
  `session/load` with that id and the SAME `sessionParams` object it would give
  `session/new`/`resume` (fingerprint discipline, already the house rule).
  On `resourceNotFound` OR `invalidParams`, fall back to a fresh
  `session/new` in the same handshake and report which happened
  (`AcpSessionInfo.restored: "replayed" | "fresh"` — the pane must be able to
  say "restored" vs "new session", plan's honesty rule).
- **A2 — Router event buffer.** Per-pane bounded ring buffer (cap 5000 events,
  drop-oldest, drop counter surfaced as one synthetic event) filled from
  session start, drained to the FIRST `events` subscription attach, then
  pass-through. This fixes the replay-into-void race for load and every future
  early emitter. The buffer dies with the pane (dispose/exit).
- **A3 — Map `user_message_chunk`** into the union (`{kind:
  "user_message_chunk"; text}`) and the reducer (renders as the existing
  `user` role entry). Replay then reconstructs both sides of the conversation.
- **A4 — Permission events + policy plumbing.** New `AcpPaneEvent` member
  `permission_request` `{requestId, title/toolName, options}` emitted when the
  session's policy is `prompt`; router mutation `acp.answerPermission({paneId,
  requestId, optionId})` resolves the pending wire request. Policy source: new
  app-settings column `acpPermissionPolicy` (default `"auto-approve"`), passed
  through `ensureSession` → `AcpSessionOptions`. Under `auto-approve` behavior
  is unchanged (bypassPermissions mode, no events). A pending request that the
  pane never answers must not hang forever: reuse the 30 s config-RPC timeout
  class? NO — a permission prompt legitimately waits on a human; instead it is
  cancelled by turn cancel / session death (wire the existing teardown
  rejection), never by a timer.
- **A5 — Advertise `elicitation: { form: {} }`** (read the SDK's exact
  capability + request/response shapes from types.gen.d.ts BEFORE coding — do
  not guess) and implement the client-side elicitation handler: emit
  `elicitation_request` pane event `{requestId, message, form}` and accept
  `acp.answerElicitation({paneId, requestId, ...})`. Same lifecycle rules as
  A4 (human-paced, cancelled on teardown). This re-enables `AskUserQuestion`.
- **A6 — `turn_error` maps to `review`** (needs attention), not `idle`, in
  `useAcpPaneStatus`; `permission_request` maps pane status to `"permission"`
  while pending (rings Mission Control), back to `working` on answer.

### Lane B — renderer + flip (build second, on top of A)

- **B1 — Restore-on-mount.** `AcpPane.startSession` passes the persisted
  `acpSessionId` (already in `AcpPaneState`) as `resumeSessionId`; on
  `restored: "replayed"` show a one-line strip "restored previous session"
  (mirror of the terminal's RestoredModeOverlay, but inline and dismissable);
  on `"fresh"` with a stale id, say "previous session could not be restored —
  new session started". Replay renders through the EXISTING reducer (frames are
  ordinary updates — Phases 3/5 rendering is reused for free). Transcript
  store state survives remounts already; restore only runs when the transcript
  for that pane is EMPTY (else a remount would double-replay: the reducer
  replays into an already-populated store → guard).
- **B2 — Permission + question cards.** `permission_request` renders an
  in-transcript card with option buttons (idiom of the tool cards);
  `elicitation_request` renders the question/form card. Both disable on answer
  and show the chosen option. Pane status per A6.
- **B3 — The default flip.** `spawnAgentSession()` gains the branch: when the
  workspace has a worktree and the runtime is Claude Code, create an ACP tab
  (reusing `addAcpTab`); terminal remains for other runtimes and as the
  explicit opt-out. The AddTabButton menu: "Agent session" (ACP, default) and
  "Agent session (terminal)" (opt-out) — wording matching existing items.
  `WorkspaceInitEffects` + `bootstrap-open-worktree` launch paths flip the
  same way ONLY where the launched thing is a Claude Code agent session;
  paths that write arbitrary commands into a terminal stay terminal.
  **Deliberately deferred:** the `ade` CLI BridgeOp union (shared with
  `@ade/control-plane`, upstream-coupled — flip later as its own change);
  `--resume` parity for the flip path comes free via B1.
- **B4 — Settings toggle.** Settings UI gets two controls (idiom:
  `LinkBehaviorSetting`): "Agent sessions open as" (ACP conversation /
  Terminal) — a global escape hatch for the flip — and "ACP permission mode"
  (Auto-approve / Ask me), writing the settings columns. Policy change applies
  to NEW sessions; note that in the control's description (mid-session
  setMode is out of scope).

### Deliberate deferrals (Risk 1 audit — each decided, none silent)

Recorded in the plan file as open items, not built now: subagent transcript
capability (subagent tool calls render flat — acceptable; `_meta` retained in
frames); structured terminal output for Bash; images/resources in tool results
(placeholder stays); the attention/notifications inbox (`agent_sessions` rows —
ring works, reason text does not); `ade` CLI ACP ops; markdown rendering
(pre-existing gap); Windows teardown validation (this machine is macOS — the
plan's Risk 5 explicitly wants Windows tested before the flip ships to the
WINDOWS build; noted as a release gate for the Windows installer, not for
Kyle's Mac daily driver).

## Phase gates

1. **Durable restore (deterministic):** fake-child gains a `session/load`
   handler replaying a scripted history (incl. `user_message_chunk` + tool
   frames); test: host session with `resumeSessionId` produces the replayed
   transcript events in order, buffered until a late subscriber attaches, and
   a `resourceNotFound` id falls back to fresh with `restored: "fresh"`.
2. **Durable restore (live):** real adapter — create session, run a
   tool-using prompt, dispose the HOST (simulated app quit), new host +
   session with the stored id: the replayed stream reconstructs user turns,
   assistant text, and the three tool cards; `restored: "replayed"`.
3. **Permission (live):** policy `prompt` + real adapter: a file-writing
   prompt raises `permission_request`, pane status would be `"permission"`,
   answering allow completes the turn.
4. **AskUserQuestion (live):** with elicitation advertised, prompt the agent
   to ask an A/B question; the elicitation request arrives, answering returns
   the choice to the agent, turn completes mentioning the choice.
5. **Flip:** "+" on a worktree workspace creates an ACP pane; the opt-out
   menu item creates a terminal; the settings toggle flips the default back.
   (UI halves by hand; store-level halves by test.)

## Tests (author independently)

Fake-child `session/load` handler + replay fixture; buffer drain/cap/drop
tests; fallback-to-fresh; user_message_chunk mapping + reducer render;
permission/elicitation request-answer round trip over the real wire incl.
teardown rejection of a pending request; policy plumbing (auto-approve emits
nothing); status mapping (turn_error→review, permission pending→permission);
double-replay guard (B1); flip branch in the store (ACP tab for Claude Code
runtime, terminal for opt-out), settings column round-trip.

## Out of scope

Mid-session policy switching; multi-select or free-text elicitation beyond
what AskUserQuestion needs (read the SDK shape and support the minimum that
re-enables it, plainly erroring on unsupported forms); attention inbox;
subagent trees; Codex; virtualized transcript.
