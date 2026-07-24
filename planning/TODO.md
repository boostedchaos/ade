---
type: reference
tags: [repo/papyrus-ade]
up: "[[papyrus-ade]]"
---
# Papyrus TODO

Working checklist for the OS-agnostic build-out. Source of truth for scope: [PLAN_MAIN.md](PLAN_MAIN.md); per-phase detail in [PHASE_0](PHASE_0.md)–[PHASE_5](PHASE_5.md).

## Phase 0 — Fork groundwork & rebrand ([PHASE_0.md](PHASE_0.md))
- [x] Append Papyrus modification block to NOTICE (keep Superset → ADE chain, LICENSE.md, THIRD-PARTY-NOTICES.md untouched)
- [x] Rename user-facing strings ADE → Papyrus; decided `~/.papyrus` with one-time migration from `~/.ade` (app-environment.ts)
- [x] Quarantine `apps/{web,api,mobile,admin,marketing,streams}` from the workspace graph (explicit workspaces list; cloud dev/db scripts removed; fly.toml dropped). Note: packages/{db,auth,chat,chat-mastra} stay — desktop imports them directly; re-audit in Phase 1.
- [x] Rewrite README for Papyrus + target architecture

## Phase 1 — papyrus-server (headless core) ([PHASE_1.md](PHASE_1.md))
- [x] **SPIKE PASSED (2026-07-10):** node-pty (prebuilt) + ConPTY on Windows ran cmd.exe (ANSI/resize/exit codes), `claude -p` (exit 0), and interactive claude TUI (repaint on resize, clean Ctrl-C) — GO
- [x] Scaffold `apps/server` (`papyrus serve --port 7777 --bind 127.0.0.1`; config file `~/.papyrus/server.json`; smoke-tested headless on Windows incl. WS subscription + auth rejection)
- [ ] Extract main-process business logic → `packages/server-core` (agent-*, terminal, terminal-host, workspace-runtime, local-db)
  - [x] Package created with the strangler pattern: modules move to `packages/server-core/src`, desktop keeps `export *` shims at the old paths (zero import churn; main build bundles workspace TS deps already)
  - [x] Leaf modules moved: `constants`, `env.shared`, `app-environment`, `terminal-escape-filter` (+tests), `terminal-history`, `tree-kill`, `data-batcher`
  - [x] Env-builder cluster moved: `agent-home`, `agent-setup/{paths,shell-wrappers}`, `terminal/env` (+102 tests; two Windows-portability test fixes). Exports map simplified to `./*` wildcard.
  - [x] Terminal cluster: `terminal-host/` (daemon+client, named pipe on win32), `terminal/` manager (host-hooks seam for analytics/UI-state/DB; dev-reset stays desktop), `workspace-runtime/`
  - [x] Agent cluster: `agent-*` modules (init/repo/scaffold/worktree/memory-backfill/config/setup), `local-db` (host-hooks for migrations dir + fatal dialog), `workspace-init-manager`, `feature-flags`, `user-profile` (223/223 pkg tests green on Windows)
  - [ ] Still desktop-side (Electron-bound or pending): `provider-keys` (awaits SecretStore wiring), `app-state`, `analytics`, `static-ports`, `resource-metrics`, `sync`, `scheduler`, `sanitize`, `project-icons`, shell modules
- [x] `SecretStore` interface + file-key impl (AES-256-GCM, 6 tests); safeStorage impl wires up when provider-keys moves
- [~] Split routers: server exposes `agents` (categories+agents+init progress), `terminal`, `health` as thin shells over server-core (option b per PHASE_1 §2b — isolated linker forbids sharing one t across packages). Remaining core routers (filesystem, changes, config, settings, ports, sync, cache, utils, resource-metrics, browser-history) land as Phase 2 needs them
- [ ] Serve core routers over HTTP + WS (tRPC v11, superjson, observables) — transport layer DONE (health router proves HTTP query + WS observable subscription); core routers land with the server-core extraction
- [x] Bearer-token auth middleware; token minted to `~/.papyrus/token` on first run (constant-time compare; WS verified at upgrade)
- [x] Windows: named pipe for terminal-host, chmod guards, better-sqlite3 (prebuild) + agent git repos verified. NOTE: server + daemon MUST run under Node — bun cannot load better-sqlite3 on Windows and breaks node-pty's conin socket; both ship as esbuild CJS bundles (`apps/server/scripts/build.ts`)
- [x] Desktop app consumes server-core in-process via shims (typecheck + full compile green after every extraction wave)
- [x] Headless smoke test on Windows: auth (HTTP+WS) → terminal over named pipe → create category → create agent (repo + memory scaffold) → terminal streamed from inside the agent worktree → SMOKE OK (`apps/server/scripts/smoke.ts`); macOS run still pending

## Phase 2 — apps/webui (browser client) ([PHASE_2.md](PHASE_2.md))
- [x] Scaffold `apps/webui` (Vite SPA) — ALIASES into the desktop renderer (single source of truth), not a copy
- [x] Swap ipcLink → httpBatchLink + wsLink (+ sessionIdLink) — src/trpc-client-web.ts, aliased over any */lib/trpc-client
- [x] `shell` capability interface: web impls for the preload surface (src/shell-web.ts — App/ipcRenderer/webUtils shims)
- [x] Terminal over WS subscription — live cmd.exe in the browser, bidirectional (server terminal router mirrors desktop paths over DaemonTerminalManager)
- [ ] Token login screen — DEFERRED (token in localStorage; probe injects it). Needed before M2 remote use.
- [ ] Reconnect + scrollback replay on WS drop — wsClient retry wired; explicit resubscribe+replay still to verify
- [x] papyrus-server serves the built SPA (static.ts, same origin, CSP mirrors desktop)
- [x] **M1 REACHED: full workflow in Chrome on Windows** — rail, model bar, Agent Files (scaffolded CLAUDE.md/opencode.json), live terminal echo (planning/m1-browser-terminal.png)

## Phase 3 — Remote access + iPhone ([PHASE_3.md](PHASE_3.md))
- [x] Tailscale Serve path documented (blessed path) — docs/remote-access.md (live test needs a second device)
- [x] LAN + Caddy alternative documented (adapt Caddyfile.example) — docs/remote-access.md
- [x] PWA manifest + service worker + apple-touch-icons — manifest.webmanifest, service-worker.js (shell cache + offline page, network-only /trpc), apple meta; both serve 200
- [x] Token login gate — src/login-gate.ts, Playwright-verified (no/wrong/right token)
- [ ] iOS keyboard: xterm focus shim + on-screen key bar (Esc/Tab/Ctrl/arrows) — NEEDS REAL iOS DEVICE; not safe to build blind into the shared renderer
- [ ] Resubscribe on visibilitychange — wsClient auto-retry wired; explicit visibility nudge + scrollback replay pending (verify with device)
- [ ] Responsive layout: rail → drawer, tabs → swipe strip, Agent Files → sheet — needs device/emulator verification
- [ ] **M2: drive an agent from the iPhone over Tailscale, survives lock/unlock** — BLOCKED on Cameron running it from his iPhone; server + PWA + docs are ready

## Phase 4 — Parity & hardening ([PHASE_4.md](PHASE_4.md))
- [ ] Provider-keys encrypted at rest + web OpenRouter key flow
- [ ] Web Notification API for attention events
- [ ] Verify Monaco/markdown/diff viewers on web
- [ ] Multi-device attach policy (mirror-readonly v1)
- [ ] Resource metrics + kill/cleanup on web
- [ ] Security pass: token rotation, login rate-limit, socket reachability audit, CSP
- [ ] CI on Windows + macOS runners

## Phase 5 — Optional ([PHASE_5.md](PHASE_5.md))
- [ ] Electron as thin shell over server + webui
- [ ] Capacitor iOS wrapper (only if PWA limits bite)
- [ ] Multi-server support via WorkspaceRuntimeRegistry

## Open decisions
- [x] `~/.ade` → `~/.papyrus` migration: YES — one-time renameSync on first boot (Phase 0)
- [ ] Multi-attach: mirror vs takeover
- [ ] Verify OpenRouter model bar works from a Windows-hosted server

## Related

- [[Repos/papyrus-ade/planning/PLAN_MAIN|PLAN_MAIN]]
- [[Repos/papyrus-ade/planning/PHASE_0|PHASE_0]]
- [[Repos/papyrus-ade/planning/PHASE_1|PHASE_1]]
- [[papyrus-ade]]
