# Control-plane socket protocol (Phase 0 decision)

Decided 2026-08-09. This is the wire contract for `packages/control-plane`
and `packages/cli`. It deliberately mirrors the terminal-host daemon
(`packages/server-core/src/terminal-host/daemon.ts`) — same transport, same
auth shape, same framing — so there is one socket idiom in the codebase.

## Transport

- Unix socket `~/.ade/control.sock`; win32 `\\.\pipe\ade-control-<user>`.
  Path selection follows `terminal-host/socket-path.ts` conventions.
- NDJSON both directions: exactly one JSON object per `\n`-terminated line.
- Token file `~/.ade/control.token`, mode 0600, 32 random bytes hex,
  regenerated on every app launch (differs from terminal-host, which reuses
  its token — a control socket that can drive the whole app gets a fresh
  token per launch, per SPEC Security constraints).

## Handshake

First line from client MUST be:

```json
{"id":"1","cmd":"hello","token":"<hex>","client":"ade-cli/0.4.0"}
```

Server replies `{"id":"1","ok":true,"result":{"protocol":1,"app":"0.4.0"}}`
or `{"id":"1","ok":false,"error":{"code":"AUTH_FAILED","message":"…"}}` and
closes. Any non-hello first message → `AUTH_REQUIRED`, close. The token is
never logged (redaction pattern reused from daemon.ts log()).

## Requests / responses

```json
{"id":"<client-chosen string>","cmd":"<command>","args":{…}}
{"id":"…","ok":true,"result":{…}}
{"id":"…","ok":false,"error":{"code":"<CODE>","message":"…"}}
```

- `id` is echoed verbatim; clients may pipeline.
- Command names are the CLI verbs kebab-cased 1:1 (`new-pane`,
  `list-workspaces`, `agent-event`, `tmux-compat` never appears on the wire —
  the shim calls ordinary commands).
- Error codes (closed set): `AUTH_FAILED`, `AUTH_REQUIRED`, `BAD_REQUEST`,
  `NOT_FOUND` (target resolution failed), `UNSUPPORTED` (e.g. win32
  claude-teams), `RENDERER_UNAVAILABLE` (no window to run a layout op),
  `TIMEOUT` (renderer bridge did not answer in 10 s), `INTERNAL`.

## Target resolution (server-side)

Every command taking a target accepts one of:

- UUID (paneId / tabId / workspaceId as appropriate)
- ref string: `workspace:<n>`, `tab:<n>`, `pane:<n>` — n is the 1-based
  position in current UI order at resolution time (not stable across layout
  changes; documented as such in CLI help)
- `focused` — the currently focused entity of that kind

Resolution happens in main; the CLI never resolves.

## Events

A `{"cmd":"subscribe","args":{"kinds":["*"]}}` request flips the connection
into stream mode after one `{ok:true}` ack. Server then pushes:

```json
{"event":"<kind>","ts":"<ISO8601>","data":{…}}
```

Kinds (v1): `pane-created`, `pane-closed`, `pane-focused`,
`agent-state-changed` (`{surfaceId, workspaceId, from, to}`),
`notification` (`{id, title, body, paneId, unread}`).
Unknown kinds are ignored by clients (forward compatibility). A subscribed
connection accepts no further requests; `ade events` opens a dedicated
connection and reconnects with backoff on drop.

## Renderer bridge

Layout commands (`new-pane`, `new-split`, `split-off`, `focus-pane`,
`move-pane`, `close-pane`, `new-tab`, `focus-workspace`, `jump-to-unread`)
are forwarded main→renderer over the existing IPC event channel to a single
dispatcher `renderer/stores/tabs/control-plane-bridge.ts`, which calls the
existing store actions and answers `{requestId, result|error}`. 10 s
timeout → `TIMEOUT`. Terminal I/O (`send`, `send-key`, `read-screen`,
`capture-pane`) goes main→terminal-host daemon directly, no renderer hop.

## Deliberate divergences from the terminal-host daemon (recon 2026-08-09)

- Daemon responses use `payload`; this protocol uses `result` (SPEC's explicit
  shape). Daemon events use a second socket with `role: control|stream`; this
  protocol upgrades one connection via `subscribe`. Both differences are
  deliberate — a one-shot `ade list-panes` must not need two sockets.
- Daemon token is persistent (`ensureAuthToken` reuses the file). Control
  token is per-launch: unconditional `writeFileSync` on app start, never
  `if (!existsSync)`.
- Daemon copy-pastes its auth check into every handler. Control plane wraps
  all handlers in one auth middleware — a handler must not be reachable
  unauthenticated by construction.
- Tests: any test touching the control socket MUST isolate via its own
  `SUPERSET_WORKSPACE_NAME` prefix (daemon test idiom) or it connects to the
  live app.

## Feature 2 amendment (recon 2026-08-09)

ADE already installs Claude Code hooks via `~/.ade/hooks/claude-settings.json`
forced with `claude --settings` (agent-wrappers), POSTing to the main-process
notification server, normalised by `mapEventType`, already driving
`setPaneStatus`. Feature 2 EXTENDS that pipeline (single writer of
PaneStatus): `ade hooks setup claude` manages ADE's own hooks file (backup
still applies to that file), `ade agent-event` feeds the same ingest path,
and the spec's "merge ~/.claude/settings.json" step is dropped. Existing
`SUPERSET_PANE_ID`/`SUPERSET_WORKSPACE_ID` env stays; `ADE_SURFACE_ID`/
`ADE_WORKSPACE_ID` are added as aliases carrying the same values.

## CLI exit codes

`0` ok · `1` command error (server returned ok:false) · `2` usage /
unsupported platform · `3` ADE app not running (no control socket).
