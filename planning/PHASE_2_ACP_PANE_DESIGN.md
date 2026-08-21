# Phase 2 Design — Minimal ACP Pane

Status: DESIGN — implement from this document. Author: Fable (architect). Date: 2026-08-21.

**Amendments:** 2026-08-21 — **D1 overridden by the repo owner** (no bundled
Claude Code CLI; the adapter drives the user's install via
`CLAUDE_CODE_EXECUTABLE`). Everything downstream of that decision — the
packaging entries, the file list, §6 and §7 — is updated in place and marked.
2026-08-21 — **D4's direct host-listener subscription corrected during
implementation** (it goes deaf when a session dies); see D4.

Scope: `PaneType` gains `"acp"`; a pane renders a conversation, text in / text
out; a session tab can be created as ACP instead of terminal; the desktop main
process wires the Phase 1 `acp-host` module (shipped at `b1238bb`) into Electron.
Deliberately minimal: no tool cards, no thinking view, no plan, no usage meter
(Phase 3), no model/effort bar (Phase 4), no slash palette (Phase 5), no
default-view or resume (Phase 6). Everything here is designed so those phases
slot in without rework, and nothing here builds them.

Repo rules that bind this phase: Bun only, tab indent, TS strict, no `any`.
Biome is configured at ROOT only — **never run `bun run lint:fix` at the repo
root** (it reformats ~119 unrelated tracked files); scope it to the directories
this phase touches.

---

## 1. The seven decisions

### D1 — Where the `claude-agent-acp` binary comes from

> **OVERRIDDEN 2026-08-21 by the repo owner.** The original decision bundled
> `@anthropic-ai/claude-agent-sdk`'s vendored per-platform Claude Code CLI and
> accepted ~300 MB of installer weight. **Rejected**, for two reasons the
> design did not weigh: the repo's README (line 58) states "Argus orchestrates
> coding CLIs; it does not bundle them", and a bundled CLI drifts from the
> Claude Code the user actually runs. The original text is preserved below the
> line, because its reasoning about the packaged-resolution mechanism (asar,
> `extraResources`, `package.json`-not-bare-specifier) survives intact and is
> what the replacement is built on. Only the SOURCE OF THE CLI changed.

**Real dependency of `apps/desktop`, pinned exact:
`"@agentclientprotocol/claude-agent-acp": "0.63.0"` (no caret — the plan names
adapter drift as risk #2). Bundled WITHOUT the SDK's optional per-platform
packages, and pointed at the user's own installed Claude Code through
`CLAUDE_CODE_EXECUTABLE`.**

Measured on this machine, 2026-08-21:

| Thing | Size | Source |
| --- | --- | --- |
| `@agentclientprotocol/claude-agent-acp@0.63.0` | 576 KB | `du -sh node_modules/.bun/@agentclientprotocol+claude-agent-acp@0.63.0*` |
| `@anthropic-ai/claude-agent-sdk@0.3.220` (JS) | 4.1 MB | same |
| `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.220` (vendored CLI) | **245 MB** | same — an `optionalDependency`, therefore omittable |
| Staged tree actually shipped (4 packages) | **16 MB** | `bun run stage:acp-adapter && du -sh .acp-adapter` |

- **The CLI comes from the user's machine.** With the platform package absent
  the adapter says so itself, verbatim: `Claude native binary not found for
  darwin-arm64. Reinstall @anthropic-ai/claude-agent-sdk without
  --omit=optional, or set CLAUDE_CODE_EXECUTABLE.` So `CLAUDE_CODE_EXECUTABLE`
  is the seam. The desktop shim resolves it and puts it in the child env
  (`AcpSessionOptions.env`, which `spawnAcpChildEnv` overlays verbatim).
- **How the CLI is located** — `main/lib/acp-host/claude-executable.ts`, a pure
  function over injected IO so the not-found path is unit-testable:
  1. `CLAUDE_CODE_EXECUTABLE` if already set and executable. A set-but-broken
     override does NOT fall through to a search — silently running a different
     CLI than the one named is worse than failing.
  2. `PATH`, **skipping ADE's own wrapper**: any `~/.superset/bin`, `~/.ade/bin`
     or `~/.ade-*/bin` entry, and any candidate whose first 512 bytes contain
     `agent-wrapper`. The wrapper `exec`s the real binary with
     `--settings <ade hooks settings>` appended, which registers the pane-status
     hook set — that would hand the ACP pane a second status writer, in direct
     conflict with D5.
  3. Well-known install roots (`~/.local/bin/claude`, `~/.claude/local/claude`,
     `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`). Electron's `PATH` when
     the app is opened from Finder is the truncated launchd one, so a `claude`
     every terminal can see is routinely invisible to the app.
- **What the user sees when there is no `claude`:** `acpChildEnv()` throws
  `acp-claude-not-found` (a new `AcpErrorCode`) **before the spawn**, carrying
  a message naming the install command, the URL, and the env-var escape hatch.
  It renders in `AcpStatusLine` like every other coded failure. Failing at the
  spawn instead would surface as a 15 s startup timeout with no cause. There is
  no fallback to a bundled CLI, because there is no bundled CLI.
- **Packaging:** `scripts/stage-acp-adapter.ts` walks the adapter's
  `dependencies` (and only `dependencies` — that is exactly the set that
  excludes every optional platform package), dereferences bun's isolated-linker
  symlinks, and materializes `.acp-adapter/node_modules/`. One
  `extraResources` entry maps it to `Resources/node_modules`. The script exits
  non-zero and names the missing entry rather than warning — a build that
  degrades gracefully past a missing input ships the feature silently absent.
  Wired into `prebuild`, `prepackage` and `build:win`.
- **Dev vs packaged resolution:** `app.isPackaged ?
  join(process.resourcesPath, "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js")
  : join(app.getAppPath(), "node_modules/.../dist/index.js")`. `dist/index.js`
  is the package's `bin`; `main` is `dist/lib.js`, the library. Both branches
  are a filesystem join rather than a module resolution, because the main
  bundle is CJS and `import.meta.url` is unavailable for `createRequire` —
  `app.getAppPath()` is the same anchor the terminal-host shim uses.
- The dependency lives in `apps/desktop`, not `packages/server-core`:
  server-core never `require`s the adapter (it spawns a path it is handed), and
  putting the dep where the resolver is registered keeps the Electron-free
  contract intact. server-core already pins `@agentclientprotocol/sdk@1.3.0`.

**Verified against the STAGED tree, not the repo** (2026-08-21): spawning
`.acp-adapter/.../dist/index.js` under plain node answers `initialize`, and
then `session/new` **fails** with the vendored-binary message when
`CLAUDE_CODE_EXECUTABLE` is unset and **succeeds** (real `sessionId`, real mode
list including `bypassPermissions`) when it points at
`/Users/kylewelch/.local/bin/claude` (Claude Code 2.1.238).

<details>
<summary>Original D1, superseded 2026-08-21 — preserved for its packaging reasoning</summary>

**Real dependency of `apps/desktop`, pinned exact: `"@agentclientprotocol/claude-agent-acp": "0.63.0"`
(no caret — the plan names adapter drift as risk #2). Resolved on disk, never
fetched at runtime.**

- Dev / unpackaged: entry =
  `join(dirname(require.resolve("@agentclientprotocol/claude-agent-acp/package.json")), "dist/index.js")`.
  Resolve via `package.json`, not the bare specifier — the package `main` is
  `dist/lib.js` (the library), while the spawnable adapter is the `bin` target
  `dist/index.js`, and an exports map could block a bare subpath resolve.
- Packaged app: the desktop bundle is built by electron-vite; runtime
  `node_modules` reach the app only through the `extraResources` copies in
  `apps/desktop/electron-builder.ts` (precedent: `libsql`, `friendly-words`,
  etc., each copied `from: "node_modules/X"` `to: "node_modules/X"`). Follow
  that precedent: copy `node_modules/@agentclientprotocol` **and the adapter's
  transitive runtime tree** into resources. The packaged resolver returns
  `join(process.resourcesPath, "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js")`,
  branching on `app.isPackaged`. This sidesteps `app.asar` entirely — the child
  script and all its `require`s live as plain files under
  `Contents/Resources/node_modules/`, where Node's normal sibling resolution
  finds them; no asar patching, no `asarUnpack`, and it works identically when
  the exec path is plain `node`.
- **Cost, measured (2026-08-21, from the Phase 0 install tree in
  `~/.trash-2026-08-21-agent-canvas/npx-claude-agent-acp/`): the adapter itself
  is 576 KB, but its dependency `@anthropic-ai/claude-agent-sdk@0.3.220` is
  ~260 MB** (it vendors the Claude Code CLI and per-platform ripgrep binaries),
  and the full transitive tree lands near 300 MB of installer weight. Accepted
  for Phase 2: pinned-and-offline is the plan's own requirement, and every
  alternative is worse (a runtime `npx` fetch reintroduces network + drift; the
  user's global install is unpinned; bundling the SDK through electron-vite
  will not survive its native binaries). File the slimming (strip
  other-platform vendored binaries from the copy) as a follow-up, not Phase 2.
- Derive the extraResources list from `bun pm ls` of the adapter's subtree at
  implementation time — do not hand-maintain a package list that drifts.
- The dependency lives in `apps/desktop`, not `packages/server-core`:
  server-core never `require`s the adapter (it spawns a path it is handed), and
  putting the dep where the resolver is registered keeps the Electron-free
  contract intact. server-core already pins `@agentclientprotocol/sdk@1.3.0`.

</details>

### D2 — Where the resolvers get registered

**A new shim module `apps/desktop/src/main/lib/acp-host/index.ts`, exactly
mirroring the terminal-host shim (`main/lib/terminal-host/client.ts:1-12`):
registration runs at module top level, and every desktop consumer imports
`acp-host` through this shim, so registration precedes first use by
construction.**

```ts
// apps/desktop/src/main/lib/acp-host/index.ts
setAcpBinaryPathResolver(resolveAcpAdapterEntry); // D1's dev/packaged branch
// Exec path: leave the default. process.execPath IS correct in the desktop
// main process (Electron binary), and spawnAcpChildEnv() already adds
// ELECTRON_RUN_AS_NODE=1 whenever the exec path is process.execPath — that is
// what Phase 1's seam was built for. Register no exec resolver; registering
// "node" here would depend on the user's PATH for no benefit.
export function acpChildEnv(): Record<string, string> // D1: CLAUDE_CODE_EXECUTABLE,
                                                      // throws acp-claude-not-found
export * from "@ade/server-core/acp-host";
```

- The ACP tRPC router (D-router, §3) imports the host **only through this
  shim**. That is the whole "created before registration" answer: the only code
  path that can create a session is the router, the router cannot load without
  the shim, and the shim registers at import time. There is no window in which
  a pane exists but the resolver does not.
- Belt-and-braces: if the invariant is ever broken by refactoring,
  `createSession` rejects with `acp-binary-unresolved` (Phase 1 guarantees the
  message names the fix), and the pane renders that message in its status line
  (§6) — a loud, attributable failure, not a hang.
- `disposeAll()` is added to the existing `gracefulShutdown()` path that
  `before-quit` awaits (`main/index.ts:234-266`), alongside the terminal
  daemon's teardown, so app quit runs the Phase 1 teardown ladder for every
  live adapter child.

### D3 — `AcpPaneState` on `Pane`, persistence, and the store version

**`Pane` gains one optional sub-state object, matching the
`fileViewer`/`browser`/`devtools` pattern in `shared/tabs-types.ts:133-151`:**

```ts
// shared/tabs-types.ts
export interface AcpPaneState {
 /** Workspace root the session runs in; also the fs sandbox root. */
 cwd: string;
 /**
  * ACP-minted session id of the LAST session this pane ran. Persisted for
  * Phase 6 resume; Phase 2 writes it and never reads it back (a fresh
  * session is created on every mount — see D6).
  */
 acpSessionId?: string;
}
// Pane gains:  acp?: AcpPaneState;
// PaneType gains "acp".
```

- **Persists:** pane identity, `type: "acp"`, `cwd`, `acpSessionId`. That is
  what lets a restarted app re-open the pane *as an ACP pane in the right
  directory*, and what Phase 6 needs to attempt a resume.
- **Does not persist:** the transcript, in-flight state, status, errors. The
  transcript lives in a renderer-memory store (§6) — writing every streamed
  chunk into a `persist`-backed zustand store would rewrite storage on every
  token and bloat it without bound; durable transcripts are Phase 6's problem,
  via `loadSession`, where the CLI already owns the history.
- **Store version 8 → 9** (`stores/tabs/store.ts:1854-1858`), with an identity
  migration for v8 state (the new field is optional, so no transform is
  needed). The bump exists to obey the repo's stated convention for persisted
  pane sub-state and to give any future non-optional change to `acp` a
  boundary to migrate from; the migration test (§8) pins that v8 state passes
  through unchanged.

### D4 — How protocol updates reach the renderer

**One tRPC subscription per pane, `acp.events`, returning
`@trpc/server/observable` fed by EventEmitters — the `notifications.ts:34-80`
template, with the terminal router's per-pane input shape. No batching.**

Wire union (defined in the router file, exported for the renderer via
`AppRouter` inference):

```ts
export type AcpPaneEvent =
 | { type: "update"; update: AcpSessionUpdate }        // from AcpHost `update:${paneId}`
 | { type: "turn_end"; stopReason: string }            // emitted by the prompt mutation on resolve
 | { type: "turn_error"; message: string }             // emitted by the prompt mutation on reject
 | { type: "session_exit"; code: number | null; signal: string | null; expected: boolean } // `exit:${paneId}`
 | { type: "session_error"; message: string };         // `error:${paneId}`
```

- **CORRECTED 2026-08-21 during implementation.** The design said the
  subscription attaches its four listeners directly to `getAcpHost()`. That
  cannot work: `AcpHost.removePaneListeners()` removes ALL of a pane's
  listeners when its session exits or is disposed — correct for the host, since
  a dead generation's listeners must not receive the next generation's events,
  but it means a directly-attached subscription is destroyed by the very event
  that tells the pane its session died. D6's "New session" button would then
  produce a live child whose every message is dropped. **What shipped:** the
  router bridges `update:` / `exit:` / `error:` into a router-local emitter and
  re-installs that bridge inside `ensureSession` (the only thing that can start
  a generation); the subscription attaches ONE listener to the router-local
  emitter and its teardown detaches exactly that one. Asserted by
  `acp.test.ts` → "survives a session death and delivers the NEXT session's
  updates", which fails against the design-as-written.
  EventEmitter listeners can attach before the session exists, so subscribing
  before `ensureSession` resolves is safe.
- **`turn_end` / `turn_error` are synthetic**: the `prompt` mutation emits them
  on `acpTurnEmitter` when `host.prompt()` settles. Ordering is sound because
  all update frames for a turn arrive on the child's stdout before the
  `session/prompt` response frame, and the SDK dispatches in order — so every
  `update` for the turn has been emitted before the promise settles. This
  gives the renderer an in-stream turn boundary without racing the mutation's
  own resolution across a second IPC channel.
- **No batching, deliberately.** The terminal batches (`data-batcher.ts:15-20`,
  16 ms / 200 KB) because a PTY can burst megabytes of raw bytes. ACP
  `agent_message_chunk`s are already coalesced by the model stream into small,
  low-rate text deltas (tens of events/second at worst), and each IPC message
  is a few hundred bytes — batching would add latency and a coalescing-bug
  surface for a load that does not exist. Revisit in Phase 3 only if tool-call
  update volume measurably changes the picture; note it there, don't pre-build.
- **Accumulation is a pure renderer reducer** (`reduceAcpEvent` in
  `AcpPane/transcript.ts`): on prompt send the renderer appends the user
  message and opens an assistant message; each `agent_message_chunk` appends to
  the open message; `turn_end` closes it (recording `stopReason`); a chunk
  arriving with no open message opens one (unsolicited output is displayed,
  never dropped); `session_exit`/`session_error` close the open message and
  append a divider entry. All other update kinds are counted but not rendered
  in Phase 2 — the reducer keys on `update.kind`, so Phase 3 adds members, not
  restructuring. Pure function → unit-tested without the app (§8).

### D5 — How status reaches `setPaneStatus`

**In-band, renderer-side: a `useAcpPaneStatus` hook inside `AcpPane` is the
single writer of `setPaneStatus` (`store.ts:885-896`) for ACP panes.** Mapping:
prompt sent → `"working"`; `turn_end` → `"review"` (the existing
`acknowledgedStatus` machinery downgrades it to idle when the user looks);
`turn_error` / `session_exit` / `session_error` → `"idle"` plus the pane's own
error line (§6) — `"permission"` is reserved for a genuine permission block,
which cannot occur in Phase 2's auto-approve policy and belongs to the future
`"prompt"` policy.

No collision with the hook listener, by construction rather than by luck: the
HTTP hooks path (`main/lib/notifications/server.ts:184-203` →
`useAgentHookListener.tsx:254-329`) is keyed by a paneId that the **terminal**
stack injects into its child env when it creates a terminal session; the ACP
host injects no such variable (`spawnAcpChildEnv` = safe inherited base +
caller env, and the acp-host caller passes none), so the CLI running under the
adapter never reports to the hooks server under an ACP paneId and the listener
never writes to an ACP pane. **Implementation must verify this, not inherit
it:** grep the env var name the hooks server keys on and assert it is absent
from `spawnAcpChildEnv()` output in a unit test — that assertion is what keeps
the two status writers disjoint if someone later widens the child env.

**VERIFIED 2026-08-21, and the assumption was WRONG.** `buildSafeEnv`
allowlists the whole `SUPERSET_` PREFIX (`terminal/env.ts` `ALLOWED_PREFIXES`),
so `SUPERSET_PANE_ID` / `SUPERSET_TAB_ID` / `SUPERSET_WORKSPACE_ID` present in
the HOST process's own environment are inherited verbatim by the adapter child
— which is exactly the case when Argus is launched from inside an Argus
terminal pane, i.e. every dev run. The Claude Code under the adapter would then
report every turn to the hooks server under the OUTER pane's id. **Fix:**
`spawnAcpChildEnv` now strips `ACP_STRIPPED_HOOK_ENV_VARS` **after** the caller
overlay, so neither the inherited environment nor a future caller that widens
`env` can reintroduce them. Three of the four assertions in
`spawn-env.test.ts` → "hook-identity env disjointness (D5)" failed before that
change.

### D6 — Session lifecycle vs pane lifecycle

- **Create:** lazily, on first mount of `AcpPane` — the component calls the
  `ensureSession` mutation with `{ paneId, cwd }`. Idempotent end to end:
  Phase 1's `pendingSessions` dedupe absorbs double-mount (React StrictMode,
  mosaic re-mounts), and the router returns the live session's info if one
  already exists. On success the renderer writes `acpSessionId` into
  `pane.acp` (D3). Creating the session at pane-creation time instead would
  spawn a 300 MB-tree child for panes restored into background tabs nobody
  opens; mount-time is the demand signal.
- **Pane close / tab close:** the store's `removePane`/`removeTab` paths
  already sweep panes and call `killTerminalForPane` for `type === "terminal"`
  (`store.ts:816`, plus the other `killTerminalForPane` call sites at
  `store.ts:250,424` — mirror every one). Add a sibling
  `disposeAcpForPane(paneId)` in
  `stores/tabs/utils/acp-cleanup.ts`, the exact shape of
  `terminal-cleanup.ts:6-10` (standalone `electronTrpcClient`, fire-and-forget
  with a `console.warn` on failure), invoked for `type === "acp"` in the same
  sweeps. Phase 1's `disposeSession` is idempotent and resolves for
  already-gone sessions, so double-dispose is harmless.
- **App quit:** `disposeAll()` inside `gracefulShutdown()` (D2). Same-process
  main means there is no orphan window between renderer death and host
  teardown.
- **Dead session:** on `session_exit`/`session_error` the pane keeps its
  transcript, appends a divider ("Session ended — exit code N" / the
  `acp-*`-coded message), sets status idle, disables the composer, and shows a
  **New session** button that calls `ensureSession` again (Phase 1 removes a
  dead session from its registry, so the call creates a fresh child; the old
  transcript stays above the divider). No auto-restart — Phase 1 explicitly
  left restart as a product decision, and the product decision here is: the
  user clicks.
- **App restart:** the pane is restored as an ACP pane in the right cwd with
  an **empty transcript and a brand-new session** — stated plainly in §7; the
  persisted `acpSessionId` is written for Phase 6 and deliberately not used.

### D7 — The `"acp"` render branch, and killing the silent-terminal trap

**Add an explicit `pane.type === "acp"` branch to the if-chain in
`TabsContent/TabView/index.tsx:134-219` rendering `<AcpPane />` — and convert
the chain's trailing bare fallback into an explicit
`pane.type === "terminal"` branch followed by a final default that renders a
visible `UnknownPaneType` placeholder** ("Unknown pane type: {type}" with the
paneId, plus a `console.error`) **and carries a compile-time exhaustiveness
check** (`const _exhaustive: never = pane.type satisfies never` in the default
arm, or the repo-idiomatic equivalent). Two independent guards: the `never`
check makes "added a PaneType, forgot the renderer" a type error at build
time, and the placeholder makes any runtime leak (stale persisted state,
future type added behind a cast) loudly visible instead of silently spawning a
terminal in the agent's worktree. Terminal panes keep rendering exactly as
before — the change narrows the default, it does not touch the terminal path.

---

## 2. File list

New, main process:

| File | Owns |
| --- | --- |
| `apps/desktop/src/main/lib/acp-host/index.ts` | D2 shim: resolver registration + re-export + `acpChildEnv()`. |
| `apps/desktop/src/main/lib/acp-host/claude-executable.ts` | D1 (overridden): locate the user's Claude Code; the not-found message. |
| `apps/desktop/scripts/stage-acp-adapter.ts` | D1 (overridden): stage the adapter tree for `extraResources`, minus the vendored CLI. |
| `apps/desktop/src/lib/trpc/routers/acp.ts` | `createAcpRouter()` — the whole surface in §3, plus `AcpPaneEvent` and the `acpTurnEmitter`. |

New, renderer:

| File | Owns |
| --- | --- |
| `renderer/.../TabsContent/TabView/AcpPane/AcpPane.tsx` (+ `index.ts` barrel, matching `DevToolsPane`) | The pane: subscription wiring, layout of the three children. |
| `AcpPane/AcpMessageList.tsx` | Scrollback of transcript entries; sticks to bottom while streaming. |
| `AcpPane/AcpComposer.tsx` | Textarea; Enter sends, Shift+Enter newline; disabled while a turn is in flight; Esc / Stop button → `cancel`. |
| `AcpPane/AcpStatusLine.tsx` | One line: session state, streaming indicator, error text, the New-session button when dead. |
| `AcpPane/transcript.ts` | `AcpTranscript` types + pure `reduceAcpEvent` reducer (D4) + the per-pane in-memory transcript store (non-persisted zustand map keyed by paneId; entry deleted on pane removal). |
| `AcpPane/useAcpPaneStatus.ts` | D5 status mapping; sole `setPaneStatus` writer for ACP panes. |
| `renderer/stores/tabs/utils/acp-cleanup.ts` | `disposeAcpForPane` (D6). |
| `renderer/stores/tabs/migrations/v9-acp.ts` | `TABS_STORE_VERSION` + the named v8→v9 step (D3), so the bump is assertable. |

Modified:

| File | Change |
| --- | --- |
| `apps/desktop/src/shared/tabs-types.ts` | `PaneType` += `"acp"`; `AcpPaneState`; `Pane.acp?`. |
| `apps/desktop/src/lib/trpc/routers/index.ts:34-67` | Mount `acp: createAcpRouter()`. |
| `renderer/stores/tabs/utils.ts` | `createAcpPane(tabId, cwd)` factory beside `createBrowserPane:250-271` (name "ACP Session", `status: "idle"`, `acp: { cwd }`). |
| `renderer/stores/tabs/store.ts` | Store action to add an ACP pane (mirror the browser-pane call sites); `disposeAcpForPane` in every `killTerminalForPane` sweep; version 9 + migration. |
| `.../TabView/index.tsx` | D7 branch + narrowed default. |
| `main/index.ts` | `disposeAll()` in `gracefulShutdown()`. |
| `apps/desktop/package.json` | The pinned adapter dependency (D1). |
| `apps/desktop/electron-builder.ts` | ONE extraResources entry for the staged adapter tree (D1, overridden). The canary/win configs call `createConfig()`, so they inherit it — no separate edits. |
| `apps/desktop/package.json` scripts + `.gitignore` | `stage:acp-adapter` wired into `prebuild`/`prepackage`/`build:win`; `.acp-adapter/` ignored. |
| `packages/server-core/src/acp-host/binary-resolver.ts` | `ACP_STRIPPED_HOOK_ENV_VARS` — D5's disjointness, enforced rather than assumed (see D5). |
| `packages/server-core/src/acp-host/errors.ts` | `acp-claude-not-found` (D1, overridden). |
| `renderer/stores/tabs/types.ts` | `setAcpSessionId` action; `SplitPaneWithTypeOptions.cwd`. |
| `.../GroupStrip/GroupStrip.tsx` + `AddTabButton.tsx` | The "ACP Session" entry, next to Browser/Note. Absent (not broken) when the workspace has no worktree path. |
| Whatever menu/command exposes "new browser pane" today | An adjacent "New ACP session" entry that calls the store action with the tab's workspace cwd — find it by the `createBrowserPane` call sites in `store.ts`; expose it in the same place, same idiom. |

## 3. tRPC router surface

All inputs zod-validated; all keyed by `paneId`. `createAcpRouter()` takes an
optional `{ host?: AcpHost }` (default `getAcpHost()` from the D2 shim) so unit
tests inject a fake without touching the singleton.

| Procedure | Kind | Input | Output / behavior |
| --- | --- | --- | --- |
| `ensureSession` | mutation | `{ paneId, cwd }` | Live session exists → its `{ acpSessionId, state }`. Else `host.createSession({ paneId, cwd })` (permission policy defaulted, auto-approve). Errors reject with the Phase 1 `acp-*`-coded message intact. |
| `prompt` | mutation | `{ paneId, text }` | `host.prompt()`; on resolve emits `turn_end` (stopReason) on `acpTurnEmitter`, on reject emits `turn_error`, then returns/rethrows. Returns `{ stopReason }`. |
| `cancel` | mutation | `{ paneId }` | `host.cancel()`; never throws for idle/gone. |
| `dispose` | mutation | `{ paneId }` | `host.disposeSession()`; idempotent. |
| `state` | query | `{ paneId }` | `host.getSessionInfo() ?? null` — remount reconciliation ("is my session still alive?"). |
| `events` | subscription | `{ paneId }` | `observable<AcpPaneEvent>` per D4; teardown detaches all listeners. |

Not exposed in Phase 2: `setConfigOption`, `setMode` (Phase 4), anything
resume/list (Phase 6). Adding them later is adding procedures, not changing
these.

Renderer usage is the house idiom: `trpc.acp.events.useSubscription({ paneId },
{ onData, onError })`; mutations via the generated hooks; `AppRouter` stays
inferred, no hand-written client types.

## 4. Renderer component tree (minimal, final for this phase)

```
AcpPane
├── AcpMessageList        user/assistant entries + dividers, plain text, auto-scroll
├── AcpStatusLine         "starting… / ready / streaming… / <error> [New session]"
└── AcpComposer           textarea + Send / Stop
```

Transcript entries render as plain text (whitespace-preserving). No markdown
rendering, no virtualization — both are Phase 3 concerns and neither is needed
to verify text in / text out.

## 5. What Phase 2 ignores on purpose

`agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`,
`available_commands_update`, `config_option_update`, `current_mode_update`,
`session_info_update`, `usage_update`, `{ kind: "unknown" }` — all flow through
the subscription untouched (the wire carries the full `AcpSessionUpdate`
union) and the reducer counts-but-does-not-render them. Phase 3–5 are
therefore renderer-only work against an already-complete stream: no router
change, no host change, no store change.

## 6. Error surfacing

Every `acp-*`-coded message from Phase 1 lands verbatim in `AcpStatusLine` —
`ensureSession` rejection (spawn/binary/startup-timeout), `turn_error`,
`session_error`, `session_exit` — **plus `acp-claude-not-found`, added by the
D1 override**, which is raised before the spawn and names the install command,
the URL and the `CLAUDE_CODE_EXECUTABLE` escape hatch. That one matters most:
it is the only failure a correctly-installed Argus can hit on a machine that is
simply missing Claude Code, and the design's requirement is that it renders as
a readable instruction rather than a hang or a raw code. The pane never renders blank on failure, and
never falls back to a terminal (D7). `acp-prompt-in-flight` cannot be produced
by the UI (the composer disables while a turn runs) but is still displayed if
it ever arrives — a guard that only the UI enforces is not a guard.

## 7. Phase verification (the plan's own gate)

1. **The check:** create an ACP pane in a workspace tab, send
   `reply with exactly: OK`, see `OK` appear as assistant text. Then close the
   pane and confirm `pgrep -f claude-agent-acp` is empty.
2. **Prove the check fires (known-bad first):** temporarily point the binary
   resolver at a nonexistent path — the pane must show the
   `acp-spawn-failed`/`acp-binary-unresolved` message in its status line. A
   blank pane, a hung "starting…", or a terminal appearing means the failure
   path is broken and the OK check is not trustworthy.
   **Added by the D1 override:** run once with `CLAUDE_CODE_EXECUTABLE` set to
   a nonexistent path — the pane must show the `acp-claude-not-found` message
   naming the install command, immediately, not after a 15 s startup timeout.
3. **Prove the D7 trap is armed:** with the `"acp"` branch temporarily
   commented out, an ACP pane must render the `UnknownPaneType` placeholder,
   never a terminal (and the build must fail on the exhaustiveness check —
   confirm both, they guard different failure modes).
4. **Restart honesty, stated in the phase report as measured:** quit and
   relaunch with an ACP pane open. Expected Phase 2 behavior — the pane comes
   back as an ACP pane in the same cwd with an **empty transcript and a new
   session**. The pane does **not** survive restart in any conversational
   sense; that is Phase 6 (`loadSession`/`resumeSession`), and the report says
   so plainly rather than papering over it.

## 8. Test plan

Runner: `bun test`, co-located, tab-indented. Gates: package-scoped typecheck
and directory-scoped lint (never root `lint:fix`).

**Unit-testable without the app:**

| Test | Asserts |
| --- | --- |
| `transcript.test.ts` | Reducer: chunk accumulation into the open message; open-on-stray-chunk; `turn_end` closes with stopReason; exit/error append divider and close; non-rendered kinds counted, never thrown on, `unknown` included. |
| `useAcpPaneStatus` mapping (pure fn extracted) | send → working; turn_end → review; error/exit → idle. |
| `acp.router.test.ts` (fake `AcpHost` injected) | `ensureSession` idempotence (live-session short-circuit); `prompt` emits `turn_end` after resolution / `turn_error` on reject, in-stream ordering after the fake's updates; subscription teardown detaches every listener (listener counts return to baseline); `dispose`/`cancel` forward and never throw for gone panes. |
| Store migration test | `TABS_STORE_VERSION === 9`; v8 persisted state → v9 byte-identical; an `"acp"` pane's sub-state round-trips. |
| `createAcpPane` factory test | Shape matches `Pane`, `acp.cwd` set, type `"acp"`. |
| Env-disjointness test (D5) | The hooks server's paneId env var name is absent from `spawnAcpChildEnv()` output — from an INHERITED env, from a caller-supplied env, and in the real spawn call's options. |
| `claude-executable.test.ts` (D1, overridden) | No `claude` anywhere → null; an ADE wrapper is never chosen (dir rule AND header-marker rule); a bad override does not silently fall through; the not-found message names the install command. |
| Cleanup sweep test | `removePane`, `removeTab` AND `updateTabLayout` on an `"acp"` pane call `disposeAcpForPane` (module mock); a terminal pane calls only `killTerminalForPane`; a file-viewer calls neither. All three call sites, because "someone added a fourth `killTerminalForPane` site" is the failure this guards. |

**Genuinely needs the running app** (dev run first, packaged build before the
phase is called done):

- The §7 sequence end to end — real spawn under the Electron binary
  (`ELECTRON_RUN_AS_NODE` path), real IPC subscription, real adapter, Kyle's
  real login.
- Packaged-app resolution: the extraResources copy actually contains the
  adapter and its tree, and `process.resourcesPath` resolution finds it — this
  is exactly the "verify the DEPLOYED artifact" class; the repo being right
  proves nothing about the installer. **Partly discharged 2026-08-21:** the
  STAGED tree (`.acp-adapter/`, the exact bytes `extraResources` copies) was
  driven directly over stdio and completed `initialize` + `session/new` against
  Claude Code 2.1.238. What is still unverified is that electron-builder puts
  it where `process.resourcesPath` looks — that needs a real packaged build.
- Quit with a live session → adapter process tree gone (Phase 1's ladder,
  now driven from `before-quit`).

## 9. Out of scope (Phase 2)

Rich rendering of any update kind beyond `agent_message_chunk`; the control
bar and `setConfigOption`/`setMode` exposure; slash palette; ACP as default
view; resume/`loadSession` and any use of the persisted `acpSessionId`;
transcript persistence; markdown rendering and list virtualization; a
`"prompt"` permission policy and the `"permission"` status; IPC batching;
Windows validation (plan risk #5, gated before Phase 6); adapter-tree size
slimming (filed in D1); multi-session per pane.
