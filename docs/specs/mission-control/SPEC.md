# Mission Control — agent control plane for ADE

Spec date: 2026-08-09 · Target: macOS first (Windows compiles, shim deferred)
· Base commit: `302d183` · Status: APPROVED for autonomous build

Inspired by manaflow-ai/cmux (research 2026-08-09). **cmux is GPL-3.0 —
NEVER copy, port, or paraphrase its code. This spec reimplements ideas from
observed behavior and public docs only.** cmux is Swift/AppKit; nothing in it
compiles here anyway. ADE is ELv2 — keeping it that way is a hard constraint.

## What this delivers

Four features, one dependency chain:

1. **`ade` CLI + control socket** — a command-line tool agents (and Kyle)
   can call to drive ADE: create/split/focus/close panes, send keys, read
   screens, manage workspaces, todos, notifications, and stream events.
2. **Agent session tracking** — ADE knows, per terminal pane, whether the
   agent inside is `working`, `needsInput`, `idle`, or `ended` — driven by
   Claude Code hooks, not screen-scraping heuristics.
3. **Attention notifications** — a visible ring on the pane that needs
   Kyle, badge counts on tabs/workspaces/Dock, and `jump-to-unread`.
4. **`ade claude-teams` (fake-tmux shim)** — launch Claude Code with its
   experimental agent-teams feature pointed at a shim `tmux` binary, so
   teammate agents materialize as real ADE panes Kyle can watch.

Build order is 1 → 2 → 3 → 4 (the shim needs the CLI; notifications need
session state). Everything lands behind no feature flag except the shim,
which is gated on `process.platform === "darwin"` in v1.

## Ground truth already verified (do not re-research)

From the 2026-08-09 architecture recon of this repo at `302d183`. Executors
MUST re-verify any file:line they touch (files move), but these are settled:

- Panes: react-mosaic. Mosaic root + `renderPane` switch:
  `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/index.tsx`.
  PaneType = `terminal | webview | file-viewer | devtools`
  (`apps/desktop/src/shared/tabs-types.ts`). PaneStatus already exists:
  `idle | working | permission | review` (same file).
- Layout state: one Zustand store `renderer/stores/tabs/store.ts` (~1,900
  lines) with `splitPaneVertical/Horizontal/Auto`, `movePaneToTab`,
  `addTabWithMultiplePanes`, `preset-launch.ts` launch plans. Tab.layout is
  a persisted `MosaicNode<string>`. **Extend within mosaic; never replace it.**
- Terminals: sessions keyed by **paneId**
  (`apps/desktop/src/lib/trpc/routers/terminal/terminal.ts`). PTYs live in a
  separate daemon: `packages/server-core/src/terminal-host/daemon.ts` —
  NDJSON over `~/.ade/terminal-host.sock` (named pipe on win32), token-authed,
  `@xterm/headless` mirror per session (scrollback survives restarts),
  `MAX_CONCURRENT_SPAWNS = 3` in `terminal-host/terminal-host.ts`.
- Agent CLIs launch via preset commands:
  `packages/shared/src/agent-command.ts` (`AGENT_PRESET_COMMANDS`) through
  wrappers in `packages/server-core/src/agent-setup/`. Resume works by
  typing `claude --resume <id>` into the PTY
  (`renderer/.../Terminal/hooks/useTerminalLifecycle.ts`).
- DB: better-sqlite3 + Drizzle, schema at
  `packages/local-db/src/schema/schema.ts` (workspaces at :97 with ADE's
  `runtime` column; worktrees at :67). **Local-db host hooks must be
  imported before any server-core import in `main/index.ts`** or the
  packaged app dies on boot.
- IPC: tRPC-over-Electron, routers at `apps/desktop/src/lib/trpc/routers/`.
- Two parallel-session modes exist today: N workspaces = N git worktrees
  (isolated), or N terminal panes in one workspace = same checkout.

## Feature 1 — `ade` CLI + control socket

### Server side

New package `packages/control-plane` (workspace name `@ade/control-plane`),
hosted **in the Electron main process** (it must reach both the terminal-host
daemon and the renderer's tabs store).

- Listener: `~/.ade/control.sock` (win32: `\\.\pipe\ade-control-<user>`).
  Reuse the terminal-host daemon's existing socket/token pattern — same
  auth handshake style, same NDJSON framing. Token file `~/.ade/control.token`
  mode 0600, regenerated per app launch. Refuse connections without it.
- Protocol: one JSON request per line →
  `{id, ok, result} | {id, ok:false, error}` per line. A long-lived
  `subscribe` request turns the connection into an event stream.
- Handles: every command accepting a target takes a UUID, a ref
  (`workspace:2`, `pane:3`), or `focused`. Resolution lives server-side.
- Layout commands cannot run in main (the tabs store is renderer state).
  Bridge: main forwards layout ops to the renderer over the existing tRPC/
  IPC event channel; the renderer executes them through the **existing store
  actions** (`splitPaneVertical`, `addTabWithMultiplePanes`, …) and replies
  with the resulting paneId/tabId. Add a single renderer-side dispatcher
  module (`renderer/stores/tabs/control-plane-bridge.ts`) rather than
  scattering handlers. Terminal I/O commands (`send`, `read-screen`) go
  straight from main to the terminal-host daemon — no renderer round-trip.
- If the app is not running, the CLI exits 3 with
  `ADE app is not running (no control socket)`. Never auto-launch the app.

### CLI side

New package `packages/cli`, bin name **`ade`**, TypeScript compiled to a
single Node entry (same toolchain as other packages; no new bundler).
Installed onto PATH by a new `ade cli install` step AND automatically for
agents: ADE already injects wrappers into agent PATHs via
`packages/server-core/src/agent-setup/` — add the `ade` bin dir there so
every agent terminal has it without Kyle doing anything.

Command surface (cmux-parity scope, per Kyle's ruling 2026-08-09):

| Group | Commands |
|---|---|
| Panes/layout | `new-pane --type terminal\|browser\|file-viewer\|devtools --direction left\|right\|up\|down [--url] [--path] [--cwd] [--command] [--focus false]`, `new-split`, `split-off`, `focus-pane`, `move-pane --to-tab`, `close-pane`, `list-panes` |
| Tabs/workspaces | `new-tab`, `list-tabs`, `new-workspace --project <p> [--worktree]`, `list-workspaces`, `focus-workspace` |
| Terminal I/O | `send <pane> <text>`, `send-key <pane> <key>` (Enter, C-c, Escape, …), `read-screen <pane> [--lines N]`, `capture-pane <pane>` (full scrollback via the daemon's serialize) |
| Status | `set-status <pane> working\|needsInput\|idle`, `set-progress <pane> <0-100\|clear>`, `agent-sessions` (list Feature-2 records) |
| Todos | `todo add\|list\|start\|done\|rm --workspace <w>` — states `pending\|in-progress\|completed`, persisted in local-db (new `workspace_todos` table + migration) |
| Notifications | `notify --title --body [--pane]`, `list-notifications [--unread]`, `mark-notification-read <id\|--all>`, `jump-to-unread` |
| Browser pane | `browser open\|navigate\|click\|type\|fill\|screenshot --pane <p> …` — implemented against the existing webview pane's WebContents (`webContents.executeJavaScript` + `capturePage`). Document what is NOT supported (no CDP, no cookie import) in the command's `--help`. |
| Events | `ade events` — reconnectable NDJSON stream: pane created/closed/focused, agent state changes, notifications |
| Hooks | `ade hooks setup claude` (Feature 2), `ade hooks status` |
| Teams | `ade claude-teams [...]` (Feature 4), `ade tmux-compat <argv…>` (internal — the shim target) |

Ship a bundled skill at `skills/ade-workspace/SKILL.md` (repo-level, plus
installed for agents by `agent-setup`) teaching Claude the pattern:
"open a browser pane to the right without stealing focus" =
`ade new-pane --type browser --direction right --url … --focus false`.

## Feature 2 — agent session tracking

Design rule (adopted from cmux's published spec, reimplemented): **hooks are
the authority; the transcript is only used to correct stuck states, never to
invent them. No screen-text or title heuristics, ever.**

- Inject `ADE_SURFACE_ID=<paneId>` and `ADE_WORKSPACE_ID=<workspaceId>` into
  every PTY spawn in terminal-host. Any process in that pane inherits them.
- `ade hooks setup claude` writes Claude Code hook config (merge, don't
  clobber, `~/.claude/settings.json` hooks) mapping:
  `SessionStart→idle`, `UserPromptSubmit|PreToolUse|PostToolUse→working`,
  `Notification|PermissionRequest→needsInput`, `Stop→idle`,
  `SessionEnd→ended`. Each hook runs
  `ade agent-event --event <name> --session-id … --transcript-path …`
  (reads `ADE_SURFACE_ID` from env; exits 0 fast and silent when the socket
  is absent so hooks never break Claude Code outside ADE).
- One authoritative `AgentSession` record per pane, held in main:
  `{surfaceId, workspaceId, agentKind, sessionId, transcriptPath, state,
  pid, lastActivityAt}`. Persist snapshots to local-db (new table +
  migration) so state survives app restart; reconcile on boot.
- Map `AgentSession.state` onto the existing `PaneStatus`
  (`working→working`, `needsInput→permission`, `idle/ended→idle`) so current
  UI affordances light up with zero new renderer plumbing, then extend UI in
  Feature 3.
- Liveness: terminal-host already owns the PTY child — use its exit event
  (no pid polling). A session with `state=working` and no event for 10 min
  triggers a background (worker-thread or async, never main-thread-blocking)
  tail of the transcript JSONL to correct the state; log every correction.

## Feature 3 — attention notifications

- **Pane ring**: mosaic tile of a pane with `needsInput` gets a themed
  accent ring (reuse the existing PaneStatus rendering path in the pane
  chrome; check `TabPane.tsx` for where status is already drawn).
- **Badges**: unread-attention count on the tab strip item, the workspace
  rail entry, and the macOS Dock (`app.dock.setBadge`). Native macOS
  notification (Electron `Notification`) when a pane enters `needsInput`
  while the app is unfocused — clicking it focuses that pane.
- **Notification center**: a simple panel (new pane type NOT required — use
  a popover/sheet off the workspace rail) listing notifications
  newest-first with read/unread; `jump-to-unread` cycles focus through
  panes with unread attention items.
- All of it event-sourced from Feature 2 state transitions plus explicit
  `ade notify` calls. Store in local-db (new `notifications` table).

## Feature 4 — `ade claude-teams` (fake-tmux shim)

- `ade claude-teams [--continue] [--model X] [claude args…]`:
  1. Materializes shim dir `~/.ade/claude-teams-bin/` containing an
     executable `tmux` that execs `ade tmux-compat "$@"`.
  2. Launches `claude` in the current pane with env:
     `PATH=~/.ade/claude-teams-bin:$PATH`, `TMUX=/fake-socket,0,0`,
     `TMUX_PANE=%0`, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`,
     plus the already-injected `ADE_SURFACE_ID`.
- `ade tmux-compat` translates the tmux vocabulary to control-plane calls:
  `new-session|new-window` → new tab in the current workspace;
  `split-window` → mosaic split of the invoking pane (direction from
  `-h`/`-v`); `send-keys` → `send`/`send-key`; `capture-pane` →
  `capture-pane`; `select-pane` → `focus-pane`; `kill-pane` → `close-pane`;
  `list-panes` → `list-panes` in tmux's output format;
  `display-message -p` → answer format strings for the fields Claude Code
  asks for. Unknown commands: log + exit 0 with empty output (fail-soft).
- Mapping state (`tmux pane id ↔ ADE paneId`, session/window numbering) in
  `~/.ade/tmux-compat-store.json`, written atomically.
- **Hard rule (learned from cmux's public postmortem): wrap EVERY pane
  start command in `/bin/sh -c '<single-quoted command>'` unconditionally.**
  Claude Code teammates respawn with `cd <dir> && env … claude …`; a bare
  exec of that string fails silently. Never try to classify which commands
  need a shell.
- Raise `MAX_CONCURRENT_SPAWNS` in terminal-host from 3 to 8 and make it a
  constant-with-env-override (`ADE_MAX_CONCURRENT_SPAWNS`) — a team spawn
  burst would otherwise queue behind the cap.
- Isolation is process-level by design (teammates share the workspace's
  worktree cwd — that is what agent-teams expects). Do not add worktree
  orchestration in this build.
- **Phase-0 probe is a prerequisite**: agent-teams is an experimental,
  undocumented-vocabulary feature. Before implementing `tmux-compat`, run
  Claude Code with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` against a
  LOGGING fake tmux (a script that records argv + stdin to a file and
  replies with plausible empties) in a scratch project, ask it to spawn a
  teammate, and capture the exact command vocabulary + format strings the
  CURRENT Claude Code version emits. The captured log is the contract
  `tmux-compat` is built and tested against; commit it under
  `docs/specs/mission-control/probe/`. If the flag turns out dead in the
  current version, still build the shim against tmux's documented behavior
  for the same verb set, mark the launcher experimental in `--help`, and
  say so in the final report — do not silently drop the feature.

## Platform scoping

- Windows: everything compiles; control socket uses the named-pipe path
  branch (pattern exists in terminal-host); `claude-teams` command exits 2
  with "macOS only in v1" on win32. Tests that exercise unix-socket or
  shim behavior: `skipIf(win32)` (the repo's existing pattern).
- windows-ci MUST stay green — it is a ship gate.

## Verification (ship gates — all mandatory)

1. **Baseline-diff tests**: `git worktree add <scratch>/baseline 302d183`,
   run the full suite on both trees (`> log 2>&1` — bun test writes
   failures to stderr), strip timings, `comm` sorted failure lists. Ship
   only when ours ⊆ baseline. Repo has ~38 pre-existing failures; that
   list, not zero, is the bar.
2. **New-code tests**: unit tests for tmux-compat translation (input: the
   probe log's captured commands; golden outputs), handle resolution, hook
   state machine (every transition), todo/notification CRUD. Store-level
   tests follow the existing patterns in `renderer/stores/tabs/*.test.ts`.
3. **Live smoke on macOS**: packaged app boots; `ade list-workspaces` works
   from an external terminal; `ade new-pane --type browser` splits the live
   window; hooks flip a real Claude pane working→needsInput→idle; probe-run
   `ade claude-teams` spawns at least one teammate pane (skip-with-note if
   the flag is dead upstream).
4. **Adversarial review**: fresh-eyes Claude reviewer on the full diff
   (BLOCKER/MAJOR/MINOR, verify-in-code required) **plus Codex CLI
   cross-check** (`codex exec --sandbox read-only`, tight brief, SHIP/
   FIX-FIRST verdict). Both before merge. This repo is public — also grep
   the diff for homelab hostnames/IPs/tokens before any push.
5. **CI ground truth**: windows-ci green on the branch before merge to main.
6. **Packaged build**: mac 0.4.0 DMG. Build from a clone under
   `/private/tmp` (codesign fails under ~/Documents), scrub `SUPERSET_*`
   env, and bake `SUPERSET_WORKSPACE_NAME=default` (build-time define —
   Kyle's daily app binds to `~/.ade-default`). Verify boot via isolated
   smoke before handing over. Do NOT publish releases — leave artifacts +
   SHA256SUMS.txt at the project root for Kyle.

## Security constraints

- Control socket: token-authed, 0600, per-launch token. It executes
  commands with the user's full power — never bind TCP, never relax the
  token check, never log the token.
- `ade hooks setup` merges into Claude Code settings — back up the file it
  edits first and print the backup path.
- Browser-pane scripting executes JS in the webview — commands act only on
  panes the caller names; no "run in all panes".
- No license text, comments, or code from cmux/Ghostty/Bonsplit anywhere in
  the tree. NOTICE stays as-is (this is original work from public behavior).

## Out of scope (do not build)

Canvas/freeform layout · worktree auto-orchestration for teams · Windows
shim · cookie/history import · CDP support · cloud/remote anything ·
hibernation · hooks for agents other than Claude Code (Codex/OpenCode setup
stubs may print "not yet supported").

## Phases (commit + one-line progress note at every boundary)

- **Phase 0 — Recon + probe.** Re-verify the file:line ground truth above at
  HEAD; run the agent-teams logging probe; commit the probe contract.
  Also: decide socket message schema and write it down in this dir.
- **Phase 1 — Control plane + CLI core.** Socket server, renderer bridge,
  `ade` bin with panes/tabs/terminal-I/O/workspaces groups, agent-setup PATH
  injection, `ade events`.
- **Phase 2 — Session tracking.** Env injection, hooks setup/merge,
  AgentSession state machine + local-db table, PaneStatus mapping,
  transcript-corrector.
- **Phase 3 — Notifications.** Ring, badges, Dock/native notifications,
  panel, jump-to-unread, notify/list/mark CLI, local-db table.
- **Phase 4 — Teams shim.** tmux-compat translator against the probe
  contract, claude-teams launcher, spawn-cap raise, compat store.
- **Phase 5 — Parity extras.** Todos, browser-pane scripting, set-status/
  set-progress, bundled ade-workspace skill.
- **Phase 6 — Verify + ship.** Gates 1–6 above, docs
  (`docs/mission-control.md` user doc, low cognitive load), CHANGELOG,
  final report with what was deliberately NOT changed.
