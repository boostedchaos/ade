# Mission Control — Phase 0 recon at HEAD

Verified 2026-08-09 against branch `mission-control`, HEAD
`791f6ae19ccd298c06374fb73927c40bb909c869`. Re-verifies every `file:line`
claim in `SPEC.md` § "Ground truth already verified" (written against
`302d183`), then extracts the five detail areas the control-socket design
depends on.

Every line number below was read at this HEAD. Line numbers move; the
symbol names are the durable part.

## 1. Claims table

| # | Claim (SPEC.md) | Verdict | Current location / note |
|---|---|---|---|
| 1 | Mosaic root + `renderPane` switch in `TabView/index.tsx` | **CONFIRMED (with a wording correction)** | `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/index.tsx:134` defines `renderPane`; passed as `renderTile={renderPane}` at `:244`. It is **not a `switch`** — it is a chain of `if (paneInfo.type === …)` early returns (`file-viewer` at `:147`, `webview` at `:172`, then terminal/devtools). Anyone adding a pane type must add an `if` branch, not a `case`. |
| 2 | `PaneType = terminal \| webview \| file-viewer \| devtools` in `shared/tabs-types.ts` | **CONFIRMED** | `apps/desktop/src/shared/tabs-types.ts:11-15`, exactly those four members. |
| 3 | `PaneStatus = idle \| working \| permission \| review` (same file) | **CONFIRMED** | `apps/desktop/src/shared/tabs-types.ts:24`. Also present and useful: `ActivePaneStatus` (`:27`), a status-priority map (`:30-38`), a status-merge helper (`:45-47`), `highestStatus` over an iterable (`:59-61`), `acknowledgedStatus` (`:84`), and `status?: PaneStatus` on the pane record (`:142`). |
| 4 | One Zustand store `renderer/stores/tabs/store.ts`, ~1,900 lines | **CONFIRMED** | `apps/desktop/src/renderer/stores/tabs/store.ts`, **1,909 lines**. |
| 5 | Store action `splitPaneVertical` | **CONFIRMED** | `store.ts:1061`. |
| 6 | Store action `splitPaneHorizontal` | **CONFIRMED** | `store.ts:1119`. |
| 7 | Store action `splitPaneAuto` | **CONFIRMED** | `store.ts:1177` (delegates to vertical/horizontal at `:1179`/`:1181` based on tile dimensions). |
| 8 | Store action `movePaneToTab` | **CONFIRMED** | `store.ts:1185`, delegating to the pure reducer in `renderer/stores/tabs/actions/move-pane.ts` (imported at `store.ts:9`, which also exports `movePaneToNewTab`). |
| 9 | Store action `addTabWithMultiplePanes` | **CONFIRMED** | `store.ts:155`. |
| 10 | `preset-launch.ts` launch plans | **CONFIRMED** | `apps/desktop/src/renderer/stores/tabs/preset-launch.ts`, 37 lines, exporting `getPresetLaunchPlan`. Smaller than the phrase "launch plans" suggests — it is a mode→plan mapper, not a launcher. |
| 11 | Terminal sessions keyed by paneId in `lib/trpc/routers/terminal/terminal.ts` | **CONFIRMED** | `apps/desktop/src/lib/trpc/routers/terminal/terminal.ts:44` says so in the file's own header comment ("Sessions are keyed by paneId and linked to workspaces for cwd resolution"); `paneId` is the input key throughout (`:240`, `:281`, `:289`, `:306`, `:321`, `:338`), and events are emitted on `exit:${paneId}` / `error:${paneId}` (`:257`, `:267`). |
| 12 | PTY daemon at `packages/server-core/src/terminal-host/daemon.ts` | **CONFIRMED** | 861 lines. |
| 13 | NDJSON over `~/.ade/terminal-host.sock` | **CONFIRMED** | Path built in `packages/server-core/src/terminal-host/socket-path.ts:45` (`join(homedir(), SUPERSET_DIR_NAME, "terminal-host.sock")`); NDJSON parser at `daemon.ts:121-160`, writer at `daemon.ts:162-167`. |
| 14 | Named pipe on win32 | **CONFIRMED** | `socket-path.ts:34-44`: `\\.\pipe\<dir-without-dot>-terminal-host-<sanitized-user>`. |
| 15 | Token-authed | **CONFIRMED, with one divergence from the spec's plan** | Token at `~/.ade/terminal-host.token`, `daemon.ts:73`; created 32 random bytes hex, mode `0600`, `daemon.ts:100-111`. **It is NOT regenerated per launch** — `ensureAuthToken` reuses an existing file (`daemon.ts:101-103`). SPEC.md says the control token should be "regenerated per app launch"; that is a deliberate *departure* from the pattern being reused, not a copy of it. See §2.2. |
| 16 | `@xterm/headless` mirror per session (scrollback survives restarts) | **CONFIRMED** | `packages/server-core/src/terminal-host/headless-emulator.ts:11-12` imports `SerializeAddon` from `@xterm/addon-serialize` and `Terminal` from `@xterm/headless`; addon loaded at `:88-89`, snapshot produced at `:227`. One emulator per session: `session.ts:102`, constructed at `session.ts:157`. |
| 17 | `MAX_CONCURRENT_SPAWNS = 3` in `terminal-host/terminal-host.ts` | **CONFIRMED** | `packages/server-core/src/terminal-host/terminal-host.ts:34`, consumed as `new Semaphore(MAX_CONCURRENT_SPAWNS)` at `:61`. (Stale copies of the old value are also compiled into `apps/desktop/dist/main/terminal-host.js` — a build artifact, ignore it.) |
| 18 | `AGENT_PRESET_COMMANDS` in `packages/shared/src/agent-command.ts` | **CONFIRMED** | `packages/shared/src/agent-command.ts:88`, `Record<AgentType, string[]>` built by `getAgentPresetCommands()`; consumed at `:147`. Package name is `@superset/shared`, not `@ade/shared`. |
| 19 | Wrappers in `packages/server-core/src/agent-setup/` | **CONFIRMED** | Directory exists with 12 source files + `templates/`. Mechanism detailed in §3. |
| 20 | Resume by typing `claude --resume <id>` into the PTY, in `useTerminalLifecycle.ts` | **CONFIRMED** | `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/hooks/useTerminalLifecycle.ts` — two sites: cold-restore path writes `claude --resume ${sessionId} --dangerously-skip-permissions` at `:320`, initial-mount path at `:500`. |
| 21 | Schema at `packages/local-db/src/schema/schema.ts`, `workspaces` at :97 | **CONFIRMED** | `export const workspaces = sqliteTable(` is exactly at `schema.ts:97`. |
| 22 | `workspaces` has ADE's `runtime` column | **CONFIRMED** | `schema.ts:139`: `runtime: text("runtime").$type<AgentRuntime>()`. |
| 23 | `worktrees` at :67 | **CONFIRMED** | `export const worktrees = sqliteTable(` is exactly at `schema.ts:67`. |
| 24 | Local-db host hooks must be imported before any server-core import in `main/index.ts` | **CONFIRMED** | `apps/desktop/src/main/index.ts:1-5` — a four-line comment stating the rule, then the bare side-effect import `import "./lib/local-db/register-host-hooks";` at `:5`, ahead of every other import. The comment explicitly notes the bare-import form is what keeps Biome's import sorter from moving it. |
| 25 | tRPC routers at `apps/desktop/src/lib/trpc/routers/` | **CONFIRMED** | 27 entries. Directly relevant neighbours: `terminal/`, `notifications.ts`, `browser/`, `sync/`, `ui-state/`, `workspaces/`, `menu.ts`. |
| 26 | Two parallel-session modes (N worktree workspaces, or N panes in one workspace) | **CONFIRMED** (structural, not a file:line claim) | `worktrees` + `workspaces.worktreeId` (`schema.ts:73-75`, "Only set for type=worktree") give mode one; paneId-keyed terminals in one tab give mode two. |

**Score: 26 of 26 CONFIRMED, 0 DRIFT.** Two claims are confirmed but
carry corrections that matter for the build, flagged inline above and
repeated at the end:

- Claim 1 — `renderPane` is an `if`-chain, not a `switch`.
- Claim 15 — the terminal-host token is **persistent**, not per-launch. The
  spec's per-launch control token is a new behaviour, not "the same pattern".

Judgment calls I made while verifying: I treated a claim as CONFIRMED when
the symbol exists at the named path with the named behaviour even if the
spec's prose describes it loosely (e.g. "switch"), and noted the
correction rather than calling it DRIFT — the executor's risk is acting on
the prose, and the note covers that.

---

## 2. Terminal-host daemon socket / token / framing pattern

This is the pattern `packages/control-plane` is told to reuse. It is
worth copying almost verbatim; the notes mark where the spec deliberately
diverges.

### 2.1 Socket path selection (unix vs win32)

`packages/server-core/src/terminal-host/socket-path.ts` is a small,
self-contained module — the control plane should get a sibling
(`control-socket-path.ts`) rather than parameterising this one.

```ts
// socket-path.ts:33-46
export function getTerminalHostSocketPathFor(dirName: string): string {
 if (process.platform === "win32") {
  let rawUser = "";
  try { rawUser = userInfo().username; }
  catch { rawUser = process.env.USERNAME || process.env.USER || "user"; }
  const user = rawUser.replace(/[^A-Za-z0-9-]/g, "-") || "user";
  const base = dirName.replace(/^\./, "");
  return `\\\\.\\pipe\\${base}-terminal-host-${user}`;
 }
 return join(homedir(), dirName, "terminal-host.sock");
}
```

Three helpers travel with it and must be mirrored, because every one of
them no-ops on win32 and callers rely on that:

- `isNamedPipePath(p)` — `socket-path.ts:48-50`, `p.startsWith("\\\\.\\pipe\\")`.
- `removeSocketFile(p)` — `socket-path.ts:53-60`, unlink stale socket; no-op for pipes.
- `chmodSocketFile(p, 0o600)` — `socket-path.ts:63-70`, no-op for pipes.

The module header (`socket-path.ts:6-27`) carries the security reasoning
and should be read before writing the control-socket equivalent. Its key
claim, which the control plane inherits wholesale: **a win32 named pipe's
DACL is libuv's default and grants `FILE_GENERIC_READ` to Everyone and
Anonymous.** Node's `net` API exposes no way to tighten it, so on Windows
the *only* access boundary is the application-layer token. That is why
"never relax the token check" in SPEC.md's security section is load-bearing
rather than belt-and-braces.

`SUPERSET_DIR_NAME` (from `packages/server-core/src/constants`) is what
makes the path workspace-scoped (`~/.ade` vs `~/.ade-default` vs
`~/.ade-<worktree>`). The control socket must use the same constant or
Kyle's daily app and an agent worktree app will fight over one socket.

### 2.2 Token file: creation and permissions

```ts
// daemon.ts:73
const TOKEN_PATH = join(SUPERSET_HOME_DIR, "terminal-host.token");

// daemon.ts:100-111
function ensureAuthToken(): string {
 if (existsSync(TOKEN_PATH)) {
  return readFileSync(TOKEN_PATH, "utf-8").trim();   // reuses existing
 }
 const token = randomBytes(32).toString("hex");         // 64 hex chars
 writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
 log("info", "Generated new auth token");
 return token;
}

// daemon.ts:113-115
function validateToken(token: string): boolean { return token === authToken; }
```

The containing directory is created/repaired to `0700` before anything
else in `startServer` (`daemon.ts:679-689`), and the socket is chmod'ed to
`0600` inside the `listen` callback (`daemon.ts:763-770`), followed by a
`0600` PID file at `daemon.ts:772`.

**Divergences the control plane must decide deliberately, not inherit:**

1. **Per-launch regeneration.** SPEC.md asks for a control token
   regenerated per app launch. The daemon does the opposite on purpose —
   its token must survive daemon restarts so reconnecting clients keep
   working. For the control plane, per-launch is fine *because a CLI
   invocation always re-reads the file*, but the writer must
   `writeFileSync` unconditionally (not `if (!existsSync)`), and must do so
   with `{ mode: 0o600 }` on a path inside the already-`0700` dir.
2. **`validateToken` is a plain `===`.** That is a timing-comparison on a
   secret. It is acceptable here only because the socket is already
   owner-restricted on POSIX; on the control socket, which SPEC.md notes
   "executes commands with the user's full power," prefer
   `crypto.timingSafeEqual` over copying the `===`.

### 2.3 Auth handshake message shape

Two sockets per client, distinguished by `role`, sharing one `clientId`
(`types.ts:139-152`):

```ts
interface HelloRequest  { token: string; protocolVersion: number;
                          clientId: string; role: "control" | "stream"; }
interface HelloResponse { protocolVersion: number; daemonVersion: string;
                          daemonPid: number; }
```

`PROTOCOL_VERSION = 2` (`types.ts:10`); `DAEMON_VERSION = "1.0.0"`
(`daemon.ts:65`).

The `hello` handler (`daemon.ts:246-310`) validates in this order, and the
order is the contract: protocol version → token → non-empty `clientId` →
valid `role`, with distinct error codes `PROTOCOL_MISMATCH`, `AUTH_FAILED`,
`INVALID_HELLO`. On success it sets `clientState.authenticated = true`
(`:276`) and registers the socket in the module-level
`clientsById: Map<string, {control?, stream?}>` (`daemon.ts:205`,
registration `:282-297`) — **replacing** any existing socket for that
`clientId`+`role` and destroying the old one (`:285-292`), specifically to
prevent ghost connections re-introducing backpressure.

Every other handler re-checks two things, and both are needed:

```ts
// e.g. daemon.ts:312-320
if (!clientState.authenticated) {
 sendError(socket, id, "NOT_AUTHENTICATED", "Must authenticate first"); return;
}
if (clientState.role !== "control") {
 sendError(socket, id, "INVALID_ROLE", "createOrAttach requires control"); return;
}
```

`NOT_AUTHENTICATED` appears in eleven handlers (`daemon.ts:314, 353, 409,
424, 449, 465, 480, 496, 510, 525`). This is per-handler, not middleware —
a control-plane handler that forgets it is silently open. Consider a
wrapper function in the new package so the check cannot be omitted.

### 2.4 NDJSON request/response framing

Wire types, `types.ts:269-296`:

```ts
interface IpcRequest        { id: string; type: string; payload: unknown; }
interface IpcSuccessResponse{ id: string; ok: true;  payload: unknown; }
interface IpcErrorResponse  { id: string; ok: false; error: { code: string; message: string }; }
```

Note the shape difference from SPEC.md, which proposes
`{id, ok, result}`. The existing pattern uses **`payload`**, not `result`,
on both request and response. Match `payload` — the CLI and the daemon
client will then share mental model and any future merge of the two
protocols stays cheap.

Parser (`daemon.ts:121-160`): a per-socket `NdjsonParser` accumulating a
string buffer, splitting on `\n`, skipping blank lines, `JSON.parse` per
line, and on parse failure logging a **truncated (100 char) and
regex-redacted** preview (`daemon.ts:137-151`) — the redaction regex strips
anything shaped like `token|secret|password|key|auth: <value>`. Copy that
redaction; the control socket carries a token in its very first line, and
a malformed hello would otherwise log it.

Writer (`daemon.ts:162-175`): `socket.write(JSON.stringify(x) + "\n")`,
with `sendSuccess(socket, id, payload)` / `sendError(socket, id, code,
message)` convenience wrappers.

One production wrinkle worth reusing: high-frequency writes suppress their
responses, keyed by an `id` prefix — `const isNotify = id.startsWith("notify_")`
(`daemon.ts:363`), and the success reply is skipped for those
(`daemon.ts:367-369`) "to avoid saturating the socket and dropping input
under load." If `ade send` is ever used in a tight loop, the control plane
will want the same escape hatch.

Full request vocabulary is enumerated as a type map at `types.ts:349-364`:
`hello, createOrAttach, write, resize, detach, signal, kill, killAll,
listSessions, clearScrollback, shutdown`.

### 2.5 How events / streams are pushed

Unsolicited messages are a distinct envelope (`types.ts:301-306`):

```ts
interface IpcEvent { type: "event"; event: string; sessionId: string; payload: unknown; }
```

with payload variants `TerminalDataEvent {type:"data", data}`,
`TerminalExitEvent {type:"exit", exitCode, signal?}`, and
`TerminalErrorEvent {type:"error", error, code?}` (`types.ts:311-333`).

Delivery is **role-based, not subscription-based** — this is the single
biggest structural difference from SPEC.md's design, which turns a
long-lived `subscribe` request into a stream on the same connection.
Here, the client opens a second socket with `role: "stream"`, and the
daemon writes events only to stream sockets:

```ts
// daemon.ts:211-235 (abridged)
function broadcastEventToAllStreamSockets(event: IpcEvent): void {
 const message = `${JSON.stringify(event)}\n`;
 for (const [clientId, sockets] of clientsById.entries()) {
  const streamSocket = sockets.stream;
  if (!streamSocket) continue;
  try { streamSocket.write(message); }
  catch { /* destroy + de-register the broken socket */ }
 }
}
```

Per-session (rather than broadcast) delivery is resolved through
`getStreamSocketForClient(clientState)` (`daemon.ts:237-243`), which looks
up the stream socket paired to the control socket's `clientId`. Note that
`createOrAttach` **fails** with `STREAM_NOT_CONNECTED` if the stream
socket is not up yet (`daemon.ts:326-335`) — the two sockets are a hard
pairing, not an optimisation.

Client side (`packages/server-core/src/terminal-host/client.ts`): one
`clientId = randomUUID()` per client (`:220`), token read from
`~/.ade/terminal-host.token` with an explicit "daemon may not be running"
error when absent (`:724-728`), then `authenticateControl` (`:738-746`,
`role: "control"`) and `authenticateStream` (`:759+`, `role: "stream"`) over
two `connect(SOCKET_PATH)` calls (`:484`, `:524`).

**Design recommendation for the control socket:** `ade events` and
`ade send` in the same CLI process is the exact case the two-socket split
was built for, but a one-shot `ade list-panes` should not have to open two
sockets. Simplest reconciliation: keep the `role` field in the hello (so the
shapes match) but make `role: "control"` sufficient on its own, and treat
`subscribe` on a control socket as an upgrade that starts pushing `IpcEvent`
frames on that same connection. Document that choice in the schema note
Phase 0 is asked to write.

---

## 3. agent-setup PATH injection (where the `ade` bin goes)

There is no single "inject PATH" function; there are **three** mechanisms,
and `ade` needs to land in the one shared directory all of them point at.

**The directory** — `packages/server-core/src/agent-setup/paths.ts:4`:

```ts
export const BIN_DIR = path.join(SUPERSET_HOME_DIR, "bin");   // ~/.ade[-ws]/bin
```

also exported publicly as `getSupersetBinDir()`
(`packages/server-core/src/agent-setup/index.ts:122-124`).

**Mechanism 1 — POSIX shell rc wrappers (the primary path).** ADE points
the PTY's shell at its own `ZDOTDIR`/rc files
(`agent-setup/shell-wrappers.ts`, `createZshWrapper` at `:90`,
`createBashWrapper`, `createFishWrapper`), and every one of those generated
rc files ends with the same two emitted blocks:

```ts
// shell-wrappers.ts:73-81
function buildPathPrependFunction(binDir: string): string {
 return `_superset_prepend_bin() {
  case ":$PATH:" in
    *:"${binDir}":*) ;;
    *) export PATH="${binDir}:$PATH" ;;
  esac
}
_superset_prepend_bin`;
}

// shell-wrappers.ts:67-71
function buildShimFunctions(binDir: string): string {
 return SHIMMED_BINARIES.map((name) => `${name}() { "${binDir}/${name}" "$@"; }`).join("\n");
}
```

emitted into `.zshrc` (`:122-123`), `.zlogin` (`:175-176`), and the bash
wrapper (`:141-142`) — deliberately re-applied in `.zlogin` so that mise,
nvm, or a user `PATH` export in `.zlogin` cannot shadow them
(comment at `:130-134`).

**This is the hook to use: `BIN_DIR` is already prepended to every agent
terminal's `PATH`.** Dropping an `ade` executable into `BIN_DIR` requires
no change to `shell-wrappers.ts` at all — `ade` will resolve in every agent
pane the moment the file exists. Do **not** add `ade` to `SHIMMED_BINARIES`;
that list exists to intercept *third-party* binaries (`claude`, `codex`, …)
with wrapper scripts, and a shell function named `ade` would only add a
failure mode.

**Mechanism 2 — win32 `getShellEnv`.** Windows has no rc files, so the
prepend happens in the spawn env instead
(`shell-wrappers.ts:185-201`): it returns `{ PATH: "<BIN_DIR>;<existing>" }`,
reading `process.env.PATH ?? process.env.Path`. Same conclusion — a
`ade.cmd` in `BIN_DIR` is on PATH for free.

**Mechanism 3 — fish.** `--init-command` with a list-aware prepend
(`shell-wrappers.ts:223-229`), again pointed at `BIN_DIR`.

**Where to write the file.** `setupAgentHooks()`
(`agent-setup/index.ts`, the `create*` sequence at `:91-109`) is the
one-time-per-launch materialiser; add a `createAdeCliBin()` there. Every
writer in this package uses the same `writeFileIfChanged(path, content,
mode)` idempotency helper (e.g. `notify-hook.ts:20-38`) — match it, because
`setupAgentHooks` runs on every app boot and unconditional writes would
churn mtimes and defeat the "if changed" logging. On Windows, follow the
existing `.cmd`/`.ps1`-shim-plus-shared-node-launcher pattern
(`createShimRuntime`, `agent-setup/index.ts:93-95`;
`agent-wrappers-common.ts:161`, `:246`) rather than inventing a fourth.

### 3.1 Large overlap the spec does not account for

While tracing this I found that **most of Feature 2 already exists**, under
different names. This is the single most consequential recon result and is
expanded in the "top 3" section, but the file:line evidence belongs here:

- Every PTY spawn **already** carries pane/workspace identity —
  `packages/server-core/src/terminal/env.ts:530-540`:
  `SUPERSET_PANE_ID`, `SUPERSET_TAB_ID`, `SUPERSET_WORKSPACE_ID`,
  `SUPERSET_WORKSPACE_NAME`, `SUPERSET_WORKSPACE_PATH`, `SUPERSET_ROOT_PATH`,
  `SUPERSET_PORT` (the notifications port), `SUPERSET_ENV`, and
  `SUPERSET_HOOK_VERSION`. SPEC.md's proposed `ADE_SURFACE_ID` /
  `ADE_WORKSPACE_ID` injection is `SUPERSET_PANE_ID` / `SUPERSET_WORKSPACE_ID`
  under a new name.
- ADE **does not merge into `~/.claude/settings.json`.** It writes its own
  settings file at `~/.ade/hooks/claude-settings.json`
  (`agent-wrappers-claude-codex-opencode.ts:14`, `:32-34`, content at
  `:67-84`) and forces Claude Code to use it by having the wrapper exec
  `claude --settings <that file>`
  (`agent-wrappers-claude-codex-opencode.ts:115`; the same `extraArgs` are
  declared at `agent-setup/index.ts:59`).
  Hooks registered today: `UserPromptSubmit`, `Stop`, `PostToolUse`,
  `PostToolUseFailure`, `PermissionRequest`. Each command is wrapped by
  `quietNotifyCommand` (`:62-66`) appending `>/dev/null 2>&1` — the comment
  at `:49-61` explains why that redirection is mandatory: Claude Code
  injects a `UserPromptSubmit` hook's **stdout back into the conversation**.
  Any new hook command MUST be wrapped the same way.
- The hooks do not talk to a socket — they make an **HTTP GET to
  `localhost:<DESKTOP_NOTIFICATIONS_PORT>/hook/complete`**, handled at
  `apps/desktop/src/main/lib/notifications/server.ts:103`. It reads
  `paneId, tabId, workspaceId, sessionId, eventType, env, version` from the
  query string, rejects dev/prod cross-talk (`:113-120`), normalises the
  event through `mapEventType` (`map-event-type.ts`, collapsing ~13 vendor
  event names into `Start | Stop | PermissionRequest`), resolves the target
  pane with a fallback chain paneId → tabId → workspace's active tab's
  focused pane (`server.ts:54-100`), and emits `AGENT_LIFECYCLE` on
  `notificationsEmitter` (`:167`).
- The renderer already turns those into `PaneStatus`:
  `renderer/stores/tabs/useAgentHookListener.tsx` calls
  `state.setPaneStatus(paneId, "working")` (`:254`), `"permission"` (`:256`),
  `"idle" | "review"` depending on tab visibility (`:273`), and clears
  transient statuses for unmounted panes (`:322-330`). Its header comment
  (`:22-39`) documents the known gap — no hook fires on tool failure — which
  is precisely the "stuck state" SPEC.md's transcript-corrector is for.

None of this makes Feature 2 unnecessary. It makes Feature 2 an
*upgrade of an existing pipeline* (add `SessionStart`/`SessionEnd`,
add a durable `AgentSession` record, add the transcript corrector, keep the
existing hook transport) rather than a greenfield build. Building it
greenfield would produce two hook systems writing conflicting
`PaneStatus` values into the same store.

---

## 4. main ↔ renderer event flow

**Transport.** tRPC over Electron IPC via `trpc-electron`:
`createIPCHandler` in `apps/desktop/src/main/windows/main.ts:15`
(instance held at `:46`, created at `:181`); the renderer side is exposed
by `exposeElectronTRPC()` in `apps/desktop/src/preload/index.ts:60`, which
the file's own comment insists must run **before** any `contextBridge`
call. Client is `createTRPCReact<AppRouter>()`
(`apps/desktop/src/lib/trpc/index.ts:18`), superjson transformer
(`:11`).

**Main → renderer (the channel the control plane needs).** The pattern is
a main-process `EventEmitter` wrapped in a tRPC `subscription` returning an
`observable`. The cleanest minimal example is the menu router, which is
worth copying nearly line-for-line:

```ts
// apps/desktop/src/lib/trpc/routers/menu.ts:14-35
export const createMenuRouter = () => router({
 subscribe: publicProcedure.subscription(() => observable<MenuEvent>((emit) => {
  const onOpenSettings = (section?: SettingsSection) =>
   emit.next({ type: "open-settings", data: { section } });
  menuEmitter.on("open-settings", onOpenSettings);
  return () => { menuEmitter.off("open-settings", onOpenSettings); };
 })),
});
```

consumed in the renderer as
`electronTrpc.menu.subscribe.useSubscription(undefined, {...})`
(`apps/desktop/src/renderer/routes/_authenticated/layout.tsx:53`).

Eleven subscriptions already exist on this pattern —
`notifications.ts:34`, `menu.ts:16`, `auto-update/index.ts:17`,
`terminal/terminal.ts:503` and `:560`, `workspaces/procedures/init.ts:117`,
`browser/browser.ts:84` and `:106`, `sync/index.ts:32`,
`ui-state/index.ts:411`, `ports/ports.ts:53`. The richest template for a
multi-event-type channel is `notifications.ts:16-30`, which models the
payload as a discriminated union keyed by a `NOTIFICATION_EVENTS` constant
and registers one handler per member.

**Renderer → main (the reply path).** Ordinary tRPC mutations. SPEC.md's
bridge needs a round trip — "forward the layout op, get back the resulting
paneId" — and tRPC observables are one-way, so the shape is: main emits
`{opId, op, args}` on a control-plane emitter → renderer's
`control-plane-bridge.ts` executes the store action → renderer calls a
`controlPlane.completeOp` mutation with `{opId, result}` → main resolves the
promise it parked under `opId` and writes the NDJSON response. Give that
parked promise a timeout; if no renderer window is open, nothing will ever
answer, and the CLI must get an error rather than hang.

**A shortcut already exists and should be checked before building the
bridge.** `main/lib/notifications/server.ts:54-100` reads renderer tabs
state **from the main process** — `tabsState.panes`, `activeTabIds`,
`focusedPaneIds` — via the app-state sync layer (`initAppState`,
`startAppStateWatcher`, `main/index.ts:30-31`; router at
`trpc/routers/sync/index.ts`). If that mirror is complete enough, the
read-only commands (`list-panes`, `list-tabs`, `list-workspaces`, handle
resolution for `focused`) can be served entirely from main with **no
renderer round-trip**, leaving the bridge to handle mutations only. Worth
30 minutes of verification at the start of Phase 1 — it removes latency and
a whole class of "no window open" failure from the most-used commands.

---

## 5. Test patterns

**Runner: `bun test`.** Root `package.json` `"test": "turbo test"`, which
fans out to per-package `"test": "bun test"`
(`apps/desktop/package.json`, `packages/shared/package.json:39`,
`packages/server-core/package.json:36`). A root `bunfig.toml` exists.
Windows has a separate gate: `apps/desktop` also defines
`"test:win": "bun scripts/check-win-tests.ts"`.

**Where the tabs-store tests live.** SPEC.md says "existing patterns in
`renderer/stores/tabs/*.test.ts`". There are three files, and the glob is
slightly wrong — one is a directory deeper:

- `apps/desktop/src/renderer/stores/tabs/preset-launch.test.ts`
- `apps/desktop/src/renderer/stores/tabs/utils.test.ts`
- `apps/desktop/src/renderer/stores/tabs/utils/resolve-notification-target.test.ts`

Import style is `bun:test` with named imports and a plain `describe`/`it`
tree testing **pure functions**, not the store itself:

```ts
// preset-launch.test.ts:1-8
import { describe, expect, it } from "bun:test";
import { normalizeExecutionMode } from "@superset/local-db/schema/zod";
import { getPresetLaunchPlan } from "./preset-launch";

describe("normalizeExecutionMode", () => {
 it("returns new-tab for new-tab mode", () => {
  expect(normalizeExecutionMode("new-tab")).toBe("new-tab");
 });
```

Consequence for the build: the testable seam is a **pure function**, so
write `control-plane-bridge`'s op→store-action translation as a pure
reducer (the `actions/move-pane.ts` precedent) and test that, rather than
trying to mount the Zustand store.

**`skipIf(win32)` — the exact idiom**, used inline on `it`, not on
`describe`:

```ts
// packages/server-core/src/agent-setup/agent-wrappers.test.ts:100
it.skipIf(process.platform === "win32")("rewrites stale superset-notify.json with current hook path", () => {
```

Six occurrences in that file (`:100, 144, 169, 271, 322, 461`). A second
variant hoists the condition into a named constant, which reads better when
reused: `it.skipIf(SKIP_PTY_ON_MACOS_CI)(...)`,
`packages/server-core/src/terminal-host/session-lifecycle.test.ts:302`.

**Daemon-level integration tests already exist** and are the model for
control-socket tests: `packages/server-core/src/terminal-host/daemon.test.ts`
(462 lines) and `session-lifecycle.test.ts` (341 lines) both spin real
sessions with a `SUPERSET_WORKSPACE_NAME` set to a short isolation prefix
(`daemon.test.ts:110` uses `"tdmn"`, `session-lifecycle.test.ts:111` uses
`"tlfc"`) — that is how they get an isolated `~/.ade-<prefix>` and avoid
colliding with the developer's live daemon. **Any control-socket test must
do the same**, or it will connect to Kyle's running app.

---

## 6. Build / packaging

**Scripts** (`apps/desktop/package.json`):

- `prebuild` = `clean:dev && compile:app && copy:native-modules && validate:native-runtime`
- `compile:app` = `electron-vite build` with `NODE_OPTIONS=--max-old-space-size=8192`
- `build` = `electron-builder --publish never` with `CSC_IDENTITY_AUTO_DISCOVERY=false` (mac DMG)
- Windows leg: `build:win` → `prepare:win-natives` → `package:win`
  (`electron-builder.win.ts`) → `verify:win-package`
- `release:desktop` = `./apps/desktop/create-release.sh` (root script)

**The documented mac DMG procedure** is `docs/releasing-mac.md` and it
already encodes both traps SPEC.md gate 6 repeats:

```bash
git clone --branch main <repo> /private/tmp/ade-macbuild
cd /private/tmp/ade-macbuild && bun install
cd apps/desktop
env -u SUPERSET_WORKSPACE_NAME -u SUPERSET_ENV -u SUPERSET_PORT bun run prebuild
env -u SUPERSET_WORKSPACE_NAME bun run build
```

Artifacts land in `apps/desktop/release/` as `ADE-<version>-arm64.dmg` and
`ADE-<version>-arm64-mac.zip`. Smoke test is
`./release/mac-arm64/ADE.app/Contents/MacOS/ADE`, watching for
`[local-db] Migrations complete` (`docs/releasing-mac.md:32-38`). The build
is ad-hoc signed, not notarized.

**`SUPERSET_WORKSPACE_NAME` — where it is consumed:**

- **Baked at build time**: `apps/desktop/electron.vite.config.ts:87`,
  `"process.env.SUPERSET_WORKSPACE_NAME": defineEnv(...)` — a literal
  substitution, so **runtime env is ignored in a packaged build**.
  `docs/releasing-windows.md:69-77` states the same for the Windows leg.
- Schema/default: `packages/server-core/src/env.shared.ts:25`
  (`z.string().default("superset")`), read at `:41`, used to derive the
  workspace dir name at `:45`.
- Injected into every PTY: `packages/server-core/src/terminal/env.ts:533`.
- Set per-recipient for agent mail: `packages/server-core/src/agent-mail.ts:356`.
- Workspace setup/teardown shells: `.superset/lib/setup/steps.sh:97, 391`,
  `.superset/lib/teardown/steps.sh:133, 278`.
- CI: `.github/workflows/build-desktop.yml:103, 220, 342` set it to
  `superset`.

Note the mismatch worth flagging before Phase 6: `docs/releasing-mac.md`
says public artifacts must be built with it **UNSET** (app then uses
`~/.ade`), while SPEC.md gate 6 says to **bake `SUPERSET_WORKSPACE_NAME=default`**
so the artifact binds `~/.ade-default` and matches Kyle's daily app. Those
are different artifacts for different purposes — the spec's is a private
hand-off build, the doc's is a public release. Do not "fix" one to match the
other; just be explicit in the final report about which was produced.

---

## Top 3 facts most likely to change the control-plane design

**1. Feature 2 is 70% built, under different names — and building it fresh
would create two writers of `PaneStatus`.** Pane identity is already in
every PTY as `SUPERSET_PANE_ID`/`SUPERSET_WORKSPACE_ID`
(`packages/server-core/src/terminal/env.ts:530-535`); Claude Code hooks are
already installed — not by merging `~/.claude/settings.json` but by ADE
writing `~/.ade/hooks/claude-settings.json` and exec'ing
`claude --settings <it>`
(`agent-wrappers-claude-codex-opencode.ts:67-84`, `:115`); those hooks
already reach main over HTTP at `/hook/complete`
(`main/lib/notifications/server.ts:103`), get normalised by `mapEventType`,
and already drive `setPaneStatus(...)` in
`renderer/stores/tabs/useAgentHookListener.tsx:254-273`. Feature 2 should be
scoped as *extending* this pipeline (add `SessionStart`/`SessionEnd`, add the
durable `AgentSession` record and transcript corrector, keep the transport)
— and SPEC.md's "merge into `~/.claude/settings.json`, back it up first"
step should probably be dropped entirely, since ADE's mechanism never
touches the user's file. That also deletes a security constraint.

**2. The daemon's event delivery is a second *socket*, not a `subscribe`
request — and its response field is `payload`, not `result`.** SPEC.md
proposes a long-lived `subscribe` request that upgrades one connection to a
stream; the pattern it says to reuse instead pairs two connections by
`clientId` with `role: "control" | "stream"` (`types.ts:139-146`,
`daemon.ts:282-297`), broadcasts only to stream sockets
(`daemon.ts:211-235`), and hard-fails `createOrAttach` with
`STREAM_NOT_CONNECTED` when the pair is incomplete (`daemon.ts:326-335`).
Pick one deliberately in the Phase 0 schema note. Recommendation:
keep the `role` field for shape-compatibility but let `role: "control"`
stand alone and treat `subscribe` as an in-place upgrade — a one-shot
`ade list-panes` should not need two sockets. Either way use `payload`
(`types.ts:278-282`), not SPEC.md's `result`, and apply the
`NOT_AUTHENTICATED` check per handler via a wrapper, because in the daemon
it is copy-pasted into eleven handlers and omitting it silently opens a
command.

**3. Main may already be able to answer the read-only commands without any
renderer round-trip.** SPEC.md's premise is that "layout commands cannot run
in main (the tabs store is renderer state)," but
`main/lib/notifications/server.ts:54-100` reads `tabsState.panes`,
`tabsState.activeTabIds`, and `tabsState.focusedPaneIds` from the main
process through the app-state sync layer — which is exactly the data
`list-panes`, `list-tabs`, and `focused`-handle resolution need. If that
mirror is complete, the renderer bridge shrinks to mutations only, the
most-used commands lose a hop, and they keep working when no window has
focus. Verify this first thing in Phase 1; it is cheap to check and it
changes the shape of the bridge.

Two smaller corrections, repeated so they are not lost: `renderPane` is an
`if`-chain, not a `switch` (`TabView/index.tsx:134-244`) — a new pane type
needs a new `if`; and the terminal-host token is **persistent by design**
(`daemon.ts:100-111`), so SPEC.md's per-launch control token is a new
behaviour that must be written as an unconditional `writeFileSync`, not
inherited from `ensureAuthToken`'s `if (!existsSync)`.
