# Phase 1 Design — `packages/server-core/src/acp-host/`

Status: DESIGN — implement from this document. Author: Fable (architect). Date: 2026-08-21.

Scope: the main-process/server side of the ACP integration only. One long-lived
`claude-agent-acp` child process per pane, ACP (JSON-RPC over NDJSON on stdio),
a typed event stream, and request methods. No UI, no tRPC router, no pane type —
those are Phase 2.

All protocol facts below come from the working spike (`planning/spikes/`) and are
ground truth. All repo-convention citations were verified by recon; follow them.

---

## 1. File list

All under `packages/server-core/src/acp-host/`:

| File | Owns |
| --- | --- |
| `index.ts` | Barrel: named re-exports + separate `export type { … }` (style: `workspace-runtime/index.ts:16-31`). |
| `types.ts` | Every exported type: session updates, config options, permission policy, events, options objects. No runtime code. |
| `acp-connection.ts` | The wire: wraps `@agentclientprotocol/sdk` `ndJsonStream` + `client(...)` builder around a child's stdio; implements the five client-side methods; surfaces typed callbacks. Knows nothing about panes. |
| `acp-session.ts` | One pane's lifecycle: spawn → initialize → session/new → ready; prompt/cancel/config/mode methods; teardown ladder; dead-child handling. Owns exactly one child process and one `AcpConnection`. |
| `acp-host.ts` | `AcpHost` manager: registry keyed by paneId, `pendingSessions` dedupe, spawn-concurrency cap, per-pane event fan-out, `disposeAll()`. |
| `binary-resolver.ts` | The Electron-free seam for locating the `claude-agent-acp` entry script (mirrors `terminal-host/client.ts` resolver hooks). |
| `permission.ts` | `PermissionPolicy` type, the auto-approve handler, and the mode↔policy mapping. |
| `config-options.ts` | Config-option cache + client-side validation (because server writes lie). |
| `*.test.ts` | Co-located `bun:test` unit tests per file (see §9). |

New explicit exports entry in `packages/server-core/package.json`:
`"./acp-host": "./src/acp-host/index.ts"` (the wildcard would work, but the
terminal stack gets explicit entries; match it).

Reused, not created: `packages/server-core/src/tree-kill.ts`
(`treeKillWithEscalation`, `isProcessAlive`). No new JSON-RPC helper — the SDK
provides the RPC layer; the existing NDJSON parser in `terminal-host/client.ts`
is for the daemon protocol and is NOT reused here (the SDK owns framing).

No logger module. Convention: bracketed `console.log/warn/error` with prefix
`[AcpSession <paneId>]` / `[AcpHost]`, debug lines gated by a module-top const
`DEBUG_ACP = process.env.SUPERSET_ACP_DEBUG === "1"` (pattern: `client.ts:74`).

---

## 2. Public surface

Everything below is exported from `index.ts`. Signatures only; bodies are the
implementer's job.

```ts
// types.ts ----------------------------------------------------------------

/** Discriminated union of sessionUpdate notifications, one member per kind. */
export type AcpSessionUpdate =
	| { kind: "agent_message_chunk"; text: string }
	| { kind: "agent_thought_chunk"; text: string }
	| { kind: "tool_call"; /* raw payload fields */ }
	| { kind: "tool_call_update"; /* raw payload fields */ }
	| { kind: "plan"; /* raw payload fields */ }
	| { kind: "available_commands_update"; /* raw */ }
	| { kind: "config_option_update"; options: AcpConfigOption[] }
	| { kind: "current_mode_update"; modeId: string }
	| { kind: "session_info_update"; /* raw */ }
	| { kind: "usage_update"; /* raw */ };
// Members carry the adapter's payload shape verbatim from the spike transcript;
// implementer types them from the recorded frames, avoids `any`, and adds an
// `{ kind: "unknown"; raw: unknown }` catch-all. See the correction below for
// what that catch-all does and does not protect against.

export interface AcpConfigOption {
	id: string;
	/** Declared legal values, from session/new. Empty/absent = free-form. */
	values?: { id: string; label?: string }[];
	currentValue?: string;
}

export type PermissionPolicy = "auto-approve" | "prompt"; // Phase 1 ships auto-approve only.

export interface AcpSessionOptions {
	paneId: string;
	cwd: string;                       // workspace root; also the fs/* sandbox root
	permissionPolicy?: PermissionPolicy; // default "auto-approve"
	spawnProcess?: SpawnProcess;       // test seam, default node:child_process spawn
	env?: Record<string, string>;
}

/** Same shape as terminal-host/session.ts:55-59. */
export type SpawnProcess = (
	command: string,
	args: string[],
	options: SpawnOptions,
) => ChildProcess;

export interface AcpPromptResult {
	stopReason: string; // from session/prompt response
}

export interface AcpSessionInfo {
	paneId: string;
	acpSessionId: string;
	state: "starting" | "ready" | "prompting" | "terminating" | "dead";
	modes: unknown;                 // as returned by session/new
	configOptions: AcpConfigOption[]; // cached, see §7
}

// acp-host.ts -------------------------------------------------------------

/** Per-pane namespaced events, mirroring daemon-manager.ts:195 / client.ts:193-201. */
export interface AcpHostEvents {
	[key: `update:${string}`]: (update: AcpSessionUpdate) => void;
	[key: `exit:${string}`]: (info: { code: number | null; signal: string | null; expected: boolean }) => void;
	[key: `error:${string}`]: (err: Error) => void;
}

export class AcpHost extends EventEmitter {
	/** Idempotent per pane: a second call while starting returns the pending promise (pendingSessions dedupe, daemon-manager.ts:35). */
	createSession(options: AcpSessionOptions): Promise<AcpSessionInfo>;

	/** Resolves when the turn ends (stopReason). Streamed content arrives via `update:${paneId}` events, not the return value. */
	prompt(paneId: string, text: string): Promise<AcpPromptResult>;

	/** session/cancel for the in-flight turn. No-op if idle. */
	cancel(paneId: string): Promise<void>;

	/** Validates locally first (§7); throws on an illegal value instead of sending it. */
	setConfigOption(paneId: string, optionId: string, value: string): Promise<void>;

	setMode(paneId: string, modeId: string): Promise<void>;

	getSessionInfo(paneId: string): AcpSessionInfo | undefined;
	listSessions(): AcpSessionInfo[];

	/** Full teardown ladder (§3). Idempotent. */
	disposeSession(paneId: string): Promise<void>;

	/** Parallel disposeSession over the registry; used at server shutdown. */
	disposeAll(): Promise<void>;
}

/** Singleton accessor, pattern terminal/daemon/index.ts:6-13. */
export function getAcpHost(): AcpHost;

// binary-resolver.ts ------------------------------------------------------
export function setAcpBinaryPathResolver(resolver: () => string): void;
/** Throws a named, actionable Error if no resolver registered (client.ts:1221-1229). */
export function getAcpBinaryPath(): string;

/** Which executable runs the script. Mirrors setDaemonExecPathResolver. */
export function setAcpExecPathResolver(resolver: () => string): void;
/** Defaults to process.execPath — unregistered is not an error here. */
export function getAcpExecPath(): string;
/** Child env: safe inherited base + caller's env + ELECTRON_RUN_AS_NODE (§3). */
export function spawnAcpChildEnv(
	execPath: string,
	callerEnv: Record<string, string> | undefined,
	inherited?: Record<string, string>,
): Record<string, string>;
```

`AcpSession` and `AcpConnection` are internal (exported for tests via the module,
not through the barrel).

Cancellation is timers plus boolean/timestamp guards, matching the subsystem.
**No AbortSignal anywhere**, and no field named `signal` except POSIX signals —
the repo has no AbortSignal convention and `signal` already means POSIX here.

---

## 3. Process lifecycle

### Startup (inside `AcpSession.start()`)

1. `getAcpBinaryPath()` — throws before any spawn if the seam is unregistered.
2. `spawnProcess(getAcpExecPath(), [binaryPath], { cwd, env: spawnAcpChildEnv(...), stdio: ["pipe","pipe","pipe"] })`.
   The binary is a Node entry script; **which runtime runs it is a host-app
   decision, not an assumption made here** (§6). `getAcpExecPath()` defaults to
   `process.execPath` and is overridable through `setAcpExecPathResolver`.
   The child env is built by `spawnAcpChildEnv(execPath, options.env)`:
   `buildSafeEnv(process.env)` as the base so the child always has `PATH` and
   `HOME`, the caller's own `env` overlaid verbatim on top, and
   `ELECTRON_RUN_AS_NODE=1` added whenever the exec path IS `process.execPath`.
   stderr is line-buffered to `console.warn("[AcpSession <paneId>] stderr: …")`.

   **Corrected 2026-08-21.** This step originally hardcoded `process.execPath`
   and passed `options.env` straight through, which contradicted §6 one page
   later and shipped two real defects: in the desktop app the child came up as
   an Electron *browser* process that never exits (measured on Electron 40.2.1:
   alive at 5 s, versus 68 ms with the flag), and under `apps/server` — which
   runs on bun — `process.execPath` is the bun binary, the same breakage the
   terminal daemon already works around
   (`apps/server/src/routers/terminal.ts:32`).
3. Wrap stdio: `ndJsonStream(child.stdin, child.stdout)` →
   `client({ name: "argus" }).onRequest(…).onNotification(…).connectWith(stream, cb)`.
   Register exactly the five client-side methods (§ handlers below).
4. `initialize` request.
5. `session/new` → record `acpSessionId`, `modes`, `configOptions` (seed the
   config cache, §7). Set the session mode to match the permission policy (§8).
6. State → `ready`; `createSession` resolves with `AcpSessionInfo`.

Steps 4–5 run under a single startup timeout (`ACP_STARTUP_TIMEOUT_MS = 15_000`,
module-top const). On timeout: run the teardown ladder, reject `createSession`.

Spawn concurrency: cap simultaneous *startups* (not live sessions) with the
`resolveMaxConcurrentSpawns()` pattern from `terminal-host.ts:43-57` — own env
var `SUPERSET_ACP_MAX_CONCURRENT_SPAWNS`, default 5, malformed value falls back
to the default with a `console.warn`, never throws.

### Client-side handlers

- `sessionUpdate` (notification): map to `AcpSessionUpdate`, host re-emits as
  `update:${paneId}`. Unknown kinds become `{ kind: "unknown", raw }` plus one
  debug log — never a throw.
- `requestPermission`: delegate to the session's permission handler (§8).
- `fs/read_text_file` / `fs/write_text_file`: implement with `node:fs/promises`,
  paths resolved against the session `cwd` and **rejected if the resolved real
  path escapes it** (defense in depth; the agent normally has bypass anyway).
- `extNotification`: **NOT implemented, by decision (2026-08-21).**
  `@agentclientprotocol/sdk@1.3.0` offers no supported catch-all. The builder's
  `onNotification(method, parser, handler)` requires a KNOWN method name, and
  the only whole-class hook is `extNotification?` on the legacy `Client`
  interface, which the SDK itself marks
  `@deprecated Prefer client().onNotification(...) for custom notifications`
  (`dist/acp.d.ts:1520`). Reaching past that into SDK internals is out of
  bounds. When a specific ext notification acquires a consumer, register it by
  name with a parser — that is the supported route.

### Teardown ladder (`dispose()`)

Idempotent via the two existing guards: a `disposed` boolean checked at the top
of every public method (`session.ts:108,379,…`) and a `terminatingAt` timestamp
set **before** any signal is sent (`session.ts:862-867`).

1. Set `terminatingAt`, state → `terminating`.
2. If a turn is in flight, `session/cancel` (best-effort, 1 s cap).
3. `session/close` (best-effort, 1 s cap), then destroy stdin.
4. `treeKillWithEscalation({ pid, signal: "SIGTERM", escalationTimeoutMs: 2000 })`
   (`tree-kill.ts:24`).
5. Fail-safe: arm a `KILL_TIMEOUT_MS = 5000` timer when teardown starts
   (`terminal-host.ts:35,253-280`); if the session is still terminating when it
   fires, force-dispose — drop listeners, delete the registry entry, log.
6. On confirmed exit: emit `exit:${paneId}` with `expected: true`, remove from
   registry, remove pane listeners.

**`expected` means the ladder ran AND worked**, not merely that it ran. A
force-dispose over a child that never died, or a `treeKillWithEscalation` that
could not confirm the kill, reports `expected: false` — reporting `true` there
is exactly how a leaked process stays invisible.

**Every in-flight RPC is failed with `acp-session-disposed`** as the connection
goes down (step 3), so §5's promise holds on the dispose path and not only on
the death path. Without it the caller gets the SDK's uncoded "ACP connection
closed", which nothing can branch on.

**A spawn that never happened has nothing to wait for.** Node emits `error` and
`close` — never `exit` — for a failed spawn, and leaves `pid` undefined. The
`error` handler records the cause (with the exec path in the message), marks the
child gone and releases the exit waiters; otherwise teardown blocks for the full
`KILL_TIMEOUT_MS` and then reports the wrong reason.

**`disposeSession` must reach a pane that is still STARTING.** `pendingSessions`
holds the `AcpSession` alongside its promise, because a `Promise<AcpSessionInfo>`
is not something you can kill; reading the live registry alone makes the dispose
a no-op and leaks the child. `disposeAll` covers both maps.

### Unexpected child death (mid-turn or idle)

The child's `exit` event with no `terminatingAt` set is unexpected:

- Reject the in-flight `prompt()` promise (if any) with
  `Error("acp-session-died: claude-agent-acp for pane <paneId> exited (code <c>, signal <s>) mid-turn")`.
- Fail all other pending RPC calls the same way (the SDK connection is torn down).
- Emit `error:${paneId}` with that Error, then `exit:${paneId}` with
  `expected: false`.
- State → `dead`, remove from registry, **and remove the pane's listeners on the
  way out**. `disposeSession` cannot do this cleanup for a dead session — its
  registry lookup already returns nothing, so it returns early and its `finally`
  never runs, and the next session on that pane would feed the dead
  generation's listeners. The same removal runs when `start()` fails.
- A session that never reached `ready` does **not** emit `exit:${paneId}`: it
  was never a pane the caller had, and the `createSession` rejection is its
  report.
- **No auto-restart in Phase 1** — the caller (Phase 2 UI) decides whether to
  create a fresh session; restart policy is a product decision, not a transport
  one.

---

### Correction (2026-08-21): what the `unknown` catch-all actually covers

This document originally justified `{ kind: "unknown", raw }` as protection
against a `claude-agent-acp` version bump adding a new `sessionUpdate` kind.
**It cannot do that**, and the claim is withdrawn.

The SDK validates an inbound `session/update` against a **closed** zod union
before dispatching it, so a kind the schema does not know never reaches
`mapSessionUpdate` at all. Measured over the real SDK
(`acp-connection.test.ts`, "the inbound union is CLOSED"): sending
`{ sessionUpdate: "invented_by_a_future_adapter" }` produces **no** update — the
SDK logs `Error handling notification … { code: -32602, message: "Invalid
params" }` listing every union branch it tried, drops the notification, and
**the connection survives** (the next legal update still arrives).

So the fallback's real, narrower job is the kinds the SDK's schema DOES know
and our mapper does not: `user_message_chunk`, `plan_update`, `plan_removed`.
That is worth having — it is why an unmapped-but-valid kind is a silent
no-consumer event rather than a throw — it is just not version-bump insurance.
Genuine version-bump safety would require the SDK's schema to move first;
the integration test in §9 remains the tripwire for that.

## 4. Id spaces: paneId is the key, acpSessionId is a field

Registry keyed by `paneId`, exactly like the terminal stack
(`daemon-manager.ts:178,201,266`). But unlike the terminal stack, `sessionId !==
paneId` here: the ACP server mints its own `sessionId` in `session/new` and we
cannot choose it. Decision:

- **Callers speak paneId only.** Every public method and every event name uses
  paneId. Phase 2 never sees an ACP session id.
- `acpSessionId` lives as a field on the session record (surfaced read-only in
  `AcpSessionInfo`) because `session/resume`, `session/set_config_option` etc.
  need it on the wire, and future resume-across-restart work will need to
  persist it.

Reason: one id space at the API boundary keeps Phase 2 identical in shape to the
terminal integration it sits beside; the translation lives in exactly one place
(`AcpSession`), which is also the only place that talks ACP.

---

## 5. Error model

Plain `Error` with descriptive, code-prefixed messages — the repo's cross-process
convention is string codes turned into `new Error(\`${code}: ${message}\`)`
(`terminal/errors.ts` is the single custom-class precedent; we do not add
another class). Codes are stable strings so Phase 2 can branch on
`err.message.startsWith(code)`:

| Code | When | What the caller sees |
| --- | --- | --- |
| `acp-binary-unresolved` | `getAcpBinaryPath()` with no registered resolver | `createSession` rejects with the actionable message ("call setAcpBinaryPathResolver during app bootstrap"). |
| `acp-spawn-failed` | spawn error / immediate exit before initialize | `createSession` rejects; child stderr tail included in the message. |
| `acp-startup-timeout` | initialize/session-new exceeded `ACP_STARTUP_TIMEOUT_MS` | `createSession` rejects; teardown already ran. |
| `acp-session-not-found` | any method on an unknown paneId | Method rejects synchronously-fast. |
| `acp-session-disposed` | method on a disposed/terminating session | Method rejects (disposed guard). |
| `acp-session-died` | child exited unexpectedly | In-flight `prompt()` rejects; `error:${paneId}` then `exit:${paneId}` (`expected:false`). |
| `acp-invalid-config-value` | `setConfigOption` value not in declared `values` | Rejects locally; nothing sent (§7). |
| `acp-invalid-mode` | `setMode` id not in `session/new`'s `availableModes` | Rejects locally; nothing sent (§8). |
| `acp-prompt-in-flight` | `prompt()` while a turn is already running | Rejects; the running turn is untouched (§3). |
| `acp-rpc-error` | ACP server returned a JSON-RPC error | The originating method rejects with server code + message appended. |

`cancel()` and `disposeSession()` never throw for "already gone" — they resolve.

---

## 6. Binary-resolution seam (Electron-free contract)

`server-core` must not know whether it runs under Electron or `apps/server`
(contract; pattern `terminal-host/client.ts:81-116`). `binary-resolver.ts` holds
a module-level resolver registered at bootstrap:

- Electron app registers a resolver that locates the packaged
  `@agentclientprotocol/claude-agent-acp` entry inside its resources.
- `apps/server` (and tests) register one that resolves via
  `require.resolve("@agentclientprotocol/claude-agent-acp")` or a fixture path.
- `getAcpBinaryPath()` with nothing registered throws `acp-binary-unresolved`
  with the fix in the message (`client.ts:1221-1229` shape).

No `process.execPath` assumptions beyond "spawn the script under the current
Node-compatible runtime"; no dist-layout paths anywhere in `acp-host/`.

---

## 7. Config options: writes lie, so validate before and cache after

Spike ground truth: an invalid `session/set_config_option` value is ACCEPTED,
returns success, and silently downgrades to `default`; `config_option_update`
does NOT arrive during a normal prompt turn; `session/resume` returns current
`configOptions`, `session/list` does not.

Design (all in `config-options.ts`, owned per-session):

1. **Seed**: cache the `configOptions` array from `session/new`, including each
   option's declared `values`.
2. **Gate**: `setConfigOption` validates locally against the cached declaration.
   Unknown option id, or a value outside a declared `values` list →
   `acp-invalid-config-value`, and **nothing is sent**. This is the primary
   defense, because the server-side success is meaningless.
3. **Write + optimistic cache**: on local validation pass, send
   `session/set_config_option`, then update the cache to the value we sent.
4. **Reconcile**: any `config_option_update` notification overwrites the cache
   wholesale — it is the only unsolicited truth signal we get.
5. **Read-back**: `session/resume` is the only verified on-demand read. Phase 1
   does not resume mid-session, so there is no per-write read-back call; the
   local gate in step 2 is what prevents the silent-downgrade class. Document in
   code that a future resume path must re-seed the cache from the
   `session/resume` response.

`getSessionInfo().configOptions` serves the cache; it is labeled cached state,
not a live read.

---

## 8. Permission policy

Kyle's decision: auto-approve by default, exposed as a policy setting; switching
to prompting must change the **mode**, not just the callback (the adapter
defaults to `permissionMode: bypassPermissions` and never consults `canUseTool`
in that mode).

- `AcpSessionOptions.permissionPolicy` defaults to `"auto-approve"`.
- Policy → mode mapping lives in `permission.ts`:
  - `"auto-approve"` → session runs in `bypassPermissions` mode (the adapter
    default; we set it explicitly via `session/set_mode` at startup rather than
    relying on the default staying put).
  - `"prompt"` (future) → `session/set_mode` to the non-bypass mode from the
    `modes` list returned by `session/new`, so `requestPermission` actually
    fires.
- The `requestPermission` client handler is implemented in Phase 1 regardless of
  policy, delegating to a pluggable handler:

```ts
export type PermissionHandler = (req: AcpPermissionRequest) => Promise<AcpPermissionOutcome>;
export const autoApprovePermissionHandler: PermissionHandler; // logs one debug line, approves
```

`setMode` validates against `session/new`'s `availableModes` before sending, the
same gate `setConfigOption` applies — and it matters more here, because the
permission policy IS the mode. Phase 0 proved this adapter accepts illegal
config values silently and nothing establishes `session/set_mode` differs. When
the adapter declares no modes at all there is nothing to validate against, and
the write goes out unchecked rather than being refused on a guess.

`prompt()` allows **one turn per session**. `session/cancel` cancels by
`sessionId`, so two overlapping prompts would share one cancel and the first
`finally` to run would reset the state while the other turn was still live; the
second call rejects with `acp-prompt-in-flight` instead.

Phase 1 wires `autoApprovePermissionHandler` only (defensive: if the adapter
ever consults it in bypass mode, behavior is still auto-approve). Phase 2 plugs
a prompting handler into the same seam **and** flips the mode via the policy
mapping — the seam alone is documented as insufficient.

---

## 9. Test plan

Runner: `bun test`, imports from `"bun:test"`, co-located files, tab-indented.
Gates: `bun run --cwd packages/server-core typecheck`, root `bun run lint:fix`.

### Unit tests (the seams that make them possible)

Seams: injectable `spawnProcess` (`SpawnProcess`, same as
`session.test.ts` / `spawn-limit.test.ts`), the resolver hook, and a
`FakeAcpChild` test helper — a scripted fake `ChildProcess` whose stdout replays
recorded NDJSON frames from the spike and whose stdin captures what Argus sends.
The SDK runs for real over the fake stdio, so framing and RPC correlation are
exercised, not mocked.

| Test file | Asserts |
| --- | --- |
| `binary-resolver.test.ts` | Unregistered → throws `acp-binary-unresolved` with actionable text; registered resolver wins; re-registration replaces. |
| `acp-connection.test.ts` | initialize/session-new handshake frames match the spike shape; each of the ten `sessionUpdate` kinds maps to the right union member; unknown kind → `{kind:"unknown"}` and no throw; fs read/write handlers hit the sandbox root and reject an escaping path; server JSON-RPC error → `acp-rpc-error` rejection on the caller. |
| `acp-session.test.ts` | Full startup happy path reaches `ready`; startup timeout tears down and rejects `acp-startup-timeout`; prompt resolves with stopReason while updates stream as events; cancel sends `session/cancel`; teardown ladder order (cancel → close → treeKill) and `terminatingAt` set before any signal; disposed guard rejects every method with `acp-session-disposed`; dispose is idempotent; KILL_TIMEOUT force-dispose fires when the fake child never exits. |
| `acp-session-death.test.ts` | Unexpected exit mid-turn rejects the in-flight prompt with `acp-session-died`, emits `error:` then `exit:{expected:false}`, removes registry entry; unexpected exit while idle emits the same pair without a rejection. |
| `acp-host.test.ts` | Registry keyed by paneId; double `createSession` for one pane returns the same pending promise (dedupe); events are per-pane namespaced (pane A's updates never fire pane B's listener); `disposeAll` disposes every session; unknown paneId → `acp-session-not-found`; singleton accessor returns the same instance. |
| `spawn-cap.test.ts` | Concurrency cap defers the N+1th startup; malformed env override falls back to default with a warn, never throws. |
| `config-options.test.ts` | Illegal value rejected locally with `acp-invalid-config-value` and **no frame sent** (assert on the fake child's stdin capture); legal value sent + cache updated; `config_option_update` overwrites the cache. |
| `permission.test.ts` | Policy mapping picks the right mode id from a `modes` fixture; auto-approve handler approves; `requestPermission` frame from the fake child gets an approval response. |

### Integration (genuinely needs the real binary)

One test, tagged/skipped unless `SUPERSET_ACP_INTEGRATION=1`: spawn the real
`@agentclientprotocol/claude-agent-acp@0.63.0`, run initialize → session/new →
dispose, assert `ready` was reached and the process tree is dead afterwards.
This is the only thing the fakes cannot prove: that the recorded frames still
match the shipped adapter. Prompting a real model is NOT in the suite (network,
cost, nondeterminism).

Honesty note for the implementer: the unit suite proves behavior against the
spike's recorded frames — an adapter version bump can invalidate the fixtures
while everything stays green. The integration test is the tripwire; run it on
any `claude-agent-acp` version change.

---

## 10. Out of scope for Phase 1

- UI, tRPC router, pane type, renderer anything (Phase 2).
- `session/resume`, `session/list`, `session/delete` as public API — the wire
  methods exist and `AcpSession` may use resume internally later, but no
  cross-restart persistence or resume UX now.
- Auto-restart of a dead child; retry/backoff policy.
- A `"prompt"` permission policy implementation (the seam ships, the handler
  does not).
- Multiple ACP sessions per pane; model/agent selection; auth flows.
- A logging framework, metrics, or telemetry beyond the console convention.
- Windows-specific process handling beyond what `tree-kill.ts` already does.
