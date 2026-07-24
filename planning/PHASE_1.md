---
type: reference
tags: [repo/papyrus-ade]
up: "[[Repos/papyrus-ade/planning/PLAN_MAIN|PLAN_MAIN]]"
---
# Phase 1 — Extract `papyrus-server` (headless core) (~4–7 days)

The center of gravity: make the Electron main process's brain run as a plain
Node daemon on Windows + macOS. Decisions in play: D2 (extract, don't
rewrite), D4 (tRPC HTTP+WS), D5 (Node LTS), D6 (named pipe), D7 (token auth),
D10 (SecretStore) — see [PLAN_MAIN.md](PLAN_MAIN.md) §4.

## 0. THE SPIKE — node-pty + ConPTY on Windows (go/no-go gate, run first)

Highest-information experiment in the whole plan. A bare Node script (no
Electron, no repo code) on the Windows laptop that:

1. Spawns `claude` (and `pwsh`/`cmd` as controls) via node-pty under ConPTY.
2. Verifies: ANSI/VT output renders (colors, cursor movement, alt-screen),
   `resize()` reflows, Ctrl-C interrupts the CLI without killing the daemon,
   exit codes propagate, UTF-8 survives.
3. Verifies the daemon topology: parent process exits, PTY subprocess keeps
   running (matches `terminal-host/pty-subprocess.ts` design), reattach gets
   scrollback.

If `claude` won't run interactively under ConPTY, the fallback ladder is:
try Windows Terminal's ConPTY feature flags → try WSL2-hosted server (the
server runs in WSL, browsers connect the same way) → reassess. **Do not start
extraction until this passes.**

## 1. Scaffold `apps/server`

- Entry: `papyrus serve --port 7777 --bind 127.0.0.1` (bind default is
  localhost — D7; Tailscale handles remote in Phase 3 without changing this).
- Node LTS runtime (D5): node-pty + better-sqlite3 native prebuilds are
  proven on Node/Windows; Bun stays as package manager/tooling only.
- Config file `~/.papyrus/server.json` (port, bind, data dir override);
  flags win over file.

## 2. Extract `packages/server-core` from `apps/desktop/src/main/lib/`

Move, don't rewrite. Inventory of `src/main/lib/` by destination:

**→ server-core (Electron-free already, or nearly):**
`agent-config/`, `agent-home.ts`, `agent-init.ts`, `agent-memory-backfill.ts`,
`agent-repo.ts`, `agent-scaffold.ts` (+ test), `agent-setup/`,
`agent-worktree.ts`, `app-environment.ts`, `local-db/`, `terminal/`,
`terminal-host/` (daemon + client), `terminal-history.ts`,
`terminal-escape-filter.ts` (+ test), `workspace-runtime/`, `static-ports/`,
`resource-metrics/`, `sync/`, `scheduler/`, `sanitize/`, `tree-kill.ts`,
`data-batcher.ts`, `workspace-init-manager.ts`, `project-icons.ts`,
`feature-flags.ts`, `user-profile.ts`.

**→ server-core behind an interface:**
`provider-keys.ts` (+ test) — introduce `SecretStore`:
`{ encrypt(buf), decrypt(buf), isAvailable() }`. Electron impl wraps
`safeStorage`; server impl uses an AES key in `~/.papyrus/secret.key`
(0600 / owner-ACL on Windows) per D10.

**stays in Electron main (shell):**
`menu.ts`, `menu-events.ts`, `tray/`, `dock-icon.ts`, `notifications/`,
`notification-sound.ts`, `custom-ringtones.ts`, `sound-paths.ts`,
`hotkeys-events.ts`, `auto-updater.ts`, `apple-events-permission.ts`,
`local-network-permission.ts`, `window-state/`, `browser/`, `extensions/`,
`device-info.ts`, `analytics/`, `app-state/`, `test-server/` (audit
case-by-case; default shell).

Hidden-Electron-import discipline: the Phase-1 exit test is *headless boot*,
which flushes out every offender; each one gets the `SecretStore` treatment
(small interface, two impls) rather than a conditional import.

### 2a. Terminal-cluster findings (scouted 2026-07-10 — read before moving it)

The daemon is *not* import-clean; the surface alias-grep undercounts because
it uses relative imports:

- `terminal-host/session.ts` imports `../lib/terminal/env` (**buildSafeEnv**,
  ~700-line env builder + tests) and `../lib/agent-setup/shell-wrappers`
  (**getShellArgs**) — the daemon drags the env-builder + shell-wrapper
  subtree with it. Map their transitive deps before the move.
- `lib/terminal-host/client.ts` imports **`{ app } from "electron"`** — needs
  a tiny shim/injection (likely app-lifecycle or path use) before it can move.
- `lib/terminal/index.ts` imports `getProviderKey` (safeStorage) → inject a
  provider-key lookup instead (SecretStore seam).
- `lib/terminal/daemon/daemon-manager.ts` + `dev-reset.ts` import `appState`
  (lowdb UI-state store, drags shared/hotkeys+tabs+themes) → inject the one
  or two values they actually read.
- Everything else the daemon+client touch (`constants`, `env.shared`,
  `app-environment`, `terminal-history`, `tree-kill`,
  `terminal-escape-filter`) is **already in server-core** — shims resolve.

Suggested order: (1) extract `terminal/env.ts` + `agent-setup/shell-wrappers`
subtree, (2) de-electronify `client.ts` + the three injection points,
(3) move daemon+client wholesale, (4) repoint the two electron-vite entries
(`terminal-host`, `pty-subprocess`) at the package source, (5) named pipe
(D6) in the moved daemon.

### 2b. Router-split findings (scouted 2026-07-10 — the execution map)

Everything routers need from `main/lib/*` now resolves through server-core
shims, so the remaining coupling is small and enumerated:

- **Direct `electron` imports in core routers (5 sites):**
  `projects/projects.ts` (dialog + BrowserWindow type — folder picker),
  `settings/index.ts` (app — likely version/paths), `filesystem/index.ts`
  (shell — reveal in file manager), `cache/index.ts` (session — cache
  clearing). Each becomes a capability on the tRPC **context** (per §3
  context design) with desktop/web implementations, or moves the procedure
  to the shell router where it genuinely is desktop-only (cache/session is
  probably shell).
- **`main/lib/analytics` (×4), `app-state` (×2+2 schemas), `project-icons`
  (×3), `custom-ringtones`, `provider-keys` (×1)** — analytics becomes a
  context capability (no-op on server); app-state usages need case-by-case
  review (UI state vs business state); project-icons is file-based and can
  move to server-core; provider-keys waits on the SecretStore wiring.
- Everything else the routers import (`local-db` ×14,
  `workspace-init-manager` ×5, `workspace-runtime` ×3, `feature-flags`,
  `agent-init`, `agent-home`, `terminal*`) is **already in server-core**.

Mechanics: move routers to `packages/server-core/src/routers/<name>`,
replacing the `lib/trpc` import with a package-local `trpc.ts` (initTRPC +
superjson + a `ServerCoreContext` carrying capabilities). apps/server
mounts them directly.

**Hard constraint discovered 2026-07-10:** the repo's bun `isolated`
linker gives each package its own zod/@trpc/server instances, so a shared
`t` across the package boundary breaks input inference (TS7031 across
every router — desktop routers' zod isn't the package t's zod).
Re-exporting server-core's `t` from desktop `lib/trpc` was tried and
reverted. Consequences: routers can't migrate one-at-a-time while merged
into the desktop tree. Viable paths: (a) move the ENTIRE router tree
(core + shell) into server-core in one wave — shell routers get their
Electron deps via context capabilities; desktop merges nothing, it just
mounts the package's `createAppRouter(capabilities)`; or (b) keep two
separate trees during transition: desktop untouched, apps/server builds
core routers in server-core against package-local t/zod (some temporary
duplication of thin router wrappers, zero desktop risk). (b) is the
momentum-preserving choice: the business logic is already extracted, so
server routers are thin zod+procedure shells over shared functions.

## 3. Split the router tree (`apps/desktop/src/lib/trpc/routers/`)

| Router | Side | Notes |
|---|---|---|
| `workspaces` (agents), `projects` (teams), `terminal`, `filesystem`, `changes`, `config`, `settings`, `ports`, `sync`, `cache`, `utils`, `resource-metrics`, `browser-history` | **core** | served over HTTP/WS |
| `ui-state` | **core** | server-persisted so UI state follows the user across devices; revisit if per-device state is wanted |
| `auth` | **core (reworked)** | becomes token verification (D7), not Superset auth |
| `window`, `menu`, `hotkeys`, `auto-update`, `permissions`, `ringtone`, `external`, `browser` | **shell** | Electron-only; web client stubs or hides |
| `notifications` | **shell now** | web impl via Notification API in Phase 4 |

Mechanically: `routers/index.ts` becomes two exported routers (`coreRouter`,
`shellRouter`) merged for Electron, core-only for the server. Context type
gains `{ runtimeRegistry, secretStore, authedDeviceId }`.

## 4. Serve it

- tRPC v11 standalone/Express adapter for HTTP + `ws` server for
  subscriptions; `superjson` transformer; **keep observables** (same
  semantics trpc-electron required, so router code doesn't change).
- Token auth middleware on every HTTP request and WS upgrade: token minted to
  `~/.papyrus/token` (0600) on first run, printed once to console. Constant-
  time compare. This is D7 — single-user, simplest safe thing.

## 5. Windows-proof the core

- **terminal-host IPC**: unix socket `~/.superset/terminal-host.sock` →
  platform switch: named pipe `\\.\pipe\papyrus-terminal-host-<username>` on
  win32 (D6). `node:net` has the same API for pipes; **guard the
  `chmodSync`** at `terminal-host/index.ts:61` (pipes don't chmod; pipe ACLs
  are per-user by default). Socket dir moves `~/.superset` → `~/.papyrus`.
- better-sqlite3 / libsql prebuilds load on Windows Node LTS (smoke it).
- Git worktree flows with Windows paths (`agent-worktree.ts`) — watch for
  hardcoded `/` joins and long-path issues (`core.longpaths`).
- `tree-kill.ts` / signal semantics: Windows has no POSIX signals; verify the
  kill/cleanup paths use taskkill-style fallbacks.

## 6. Keep the desktop app green

Wire Electron main to consume `packages/server-core` **in-process** (same
functions, ipcLink transport unchanged). Desktop builds and runs throughout
the extraction — D11, no big-bang.

## 7. Headless smoke test (exit gate)

Script (curl + a small WS client) against `papyrus serve` on **both** Windows
and macOS: mint token → create project/team → create agent (repo scaffold on
disk) → spawn terminal session → write `echo hi` → assert bytes stream back
→ detach → reattach → scrollback replays → kill session → cleanup.

## Checklist

- [ ] **SPIKE:** node-pty + ConPTY runs `claude` on Windows (resize, Ctrl-C, ANSI, exit codes, detached daemon) — go/no-go
- [ ] Scaffold `apps/server` with `papyrus serve --port 7777 --bind 127.0.0.1`
- [ ] Extract `packages/server-core` per inventory above; desktop consumes it in-process
- [ ] `SecretStore` interface + safeStorage (Electron) and file-key (server) impls
- [ ] Router split: `coreRouter` / `shellRouter`; context carries registry + secretStore
- [ ] HTTP + WS tRPC adapter, superjson, observables preserved
- [ ] Bearer-token middleware; token minted to `~/.papyrus/token` on first run
- [ ] Windows: named pipe for terminal-host, chmod guard, `~/.superset` → `~/.papyrus`
- [ ] Windows: better-sqlite3 prebuilds, git worktrees, tree-kill semantics verified
- [ ] Headless smoke test passes on Windows and macOS
- [ ] Open questions from PLAN_MAIN §6 resolved: data-dir migration (done Phase 0), OpenRouter model bar env-injection works from a Windows server

**Exit:** `papyrus serve` runs headless on Windows and macOS; the smoke
script can create an agent, spawn a session, and stream terminal bytes.

## Related

- [[Repos/papyrus-ade/planning/PLAN_MAIN|PLAN_MAIN]]
- [[Repos/papyrus-ade/planning/PHASE_0|PHASE_0]]
- [[Repos/papyrus-ade/planning/PHASE_2|PHASE_2]]
- [[Repos/papyrus-ade/planning/TODO|TODO]]
