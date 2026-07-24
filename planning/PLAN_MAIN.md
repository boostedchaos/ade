---
type: reference
tags: [repo/papyrus-ade]
up: "[[papyrus-ade]]"
---
# Papyrus — OS-Agnostic Web App Plan

**Goal:** Turn the ADE fork (macOS-only Electron app) into **Papyrus**: a self-hosted, browser-based agentic development environment usable from a Windows laptop, a Mac, and an iPhone — one server, any screen.

**Status:** Plan drafted 2026-07-09; broken into per-phase docs 2026-07-10. Implementation starting with Phase 0.

---

## 1. The core realization: this can't be "just a webapp" — and that's fine

ADE is not a UI. It orchestrates real local resources: git repositories/worktrees, PTY sessions running `claude`/`codex`/`opencode` CLIs, SQLite state, and agent memory files on disk. A browser cannot own any of that.

So "OS-agnostic" means **client–server**:

```
┌───────────────── your devices ─────────────────┐
│  Windows laptop      Mac           iPhone      │
│    Chrome/Edge      Safari       Safari (PWA)  │
└─────────┬──────────────┬──────────────┬────────┘
          │   HTTPS + WSS · tRPC (httpBatchLink + wsLink) · token auth
          ▼
  papyrus-server  (Node daemon on ONE machine — the Windows laptop
  │                to start; later a Mac mini / home server / VPS)
  ├─ tRPC routers: agents, teams, sessions, terminal, files, changes, settings
  ├─ agent core: repos/worktrees, Hermes memory scaffolding, runtime bridges
  ├─ local-db (SQLite + Drizzle)
  ├─ provider keys, encrypted at rest
  └─ terminal-host daemon (node-pty; unix socket / Windows named pipe)
       └─ claude / codex / opencode CLIs, one per session, in agent worktrees
```

The server runs where the CLIs and repos live. Every device is just a browser pointed at it. On the Windows laptop itself, `http://localhost:7777` **is** the Windows app — this plan solves Windows support and iPhone access with the same move.

## 2. Why the fork is unusually well set up for this

The audit of the codebase found the hard architectural work is already done upstream:

1. **The renderer is already a web app.** `apps/desktop/src/renderer` is React 19 + TanStack Router + xterm.js (webgl/fit/search/clipboard addons) + zustand + react-query + Monaco + Tailwind. Nothing about it is inherently Electron except its transport and a small preload surface.
2. **All renderer↔main communication is tRPC.** The renderer talks to the main process exclusively through tRPC over `trpc-electron`'s `ipcLink` (`src/renderer/lib/trpc-client.ts`), plus a thin `contextBridge` surface (`App`, `ipcRenderer`, `webUtils` — `src/preload/index.ts:62-64`). Swapping `ipcLink` → `httpBatchLink` + `wsLink` is the designed-in seam. Subscriptions already use observables (required by trpc-electron), which standard tRPC-over-WebSocket also supports — minimal churn.
3. **Terminals already live in a detached daemon, not in the app.** `src/main/terminal-host/` is a separate process listening on a unix socket (`~/.superset/terminal-host.sock`, chmod 600 — `terminal-host/index.ts:61`), with persistent sessions, attach/detach, cold restore, and scrollback history. Sessions survive app restarts *by design* — exactly the semantics a flaky mobile connection needs.
4. **A runtime abstraction anticipating this exists.** `src/main/lib/workspace-runtime/types.ts` defines `WorkspaceRuntime` explicitly scoped for "local daemon today, or cloud/SSH in the future," with a registry designed so backends can coexist.
5. **The agent core is pure Node.** Agent lifecycle (`agent-home.ts`, `agent-init.ts`, `agent-repo.ts`, `agent-scaffold.ts`, `agent-setup/`, `agent-worktree.ts`, `agent-memory-backfill.ts`), local-db (better-sqlite3/libsql + Drizzle), terminal env/port management — none of it touches Electron APIs. Storage layout: `~/.ade/agents/<id>/{worktree, memory, .codex}`.

What is genuinely Electron/macOS-bound (and gets shimmed or dropped): window/menu/tray/dock, Notification Center, global hotkeys, Apple-events & local-network permissions, auto-updater, ringtones/sounds, window-state, and `safeStorage` (OS keychain) in `provider-keys.ts`.

## 3. What we will NOT build on

The repo still carries upstream Superset's **cloud product**, untouched by the ADE fork: `apps/web` (Next.js 16 multi-tenant dashboard: better-auth, Neon Postgres via `packages/db`, Slack/GitHub/Linear integrations, PostHog/Sentry), `apps/api`, `apps/mobile` (Expo + better-auth + electric-sql), `apps/admin`, `apps/marketing`, `apps/streams`, plus `Caddyfile.example`/`fly.toml` deploy leftovers.

**Decision: do not adapt these.** They implement the multi-tenant hosted model ADE deliberately removed. The new web UI comes from the **desktop renderer** (which is the actual ADE product), not from old `apps/web`. The leftovers get quarantined in Phase 0 and deleted once we're confident nothing shared is still imported from them.

## 4. Key decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Client–server: headless `papyrus-server` + browser SPA | Browsers can't own PTYs/git/disk; server runs where CLIs live |
| D2 | Extract the existing main-process code into the server; don't rewrite | The tRPC routers under `apps/desktop/src/lib/trpc/routers/` *are* the API; business logic is already Electron-free |
| D3 | New `apps/server` + `apps/webui`; quarantine old Superset cloud apps | Old `apps/web` is the wrong product (multi-tenant cloud) |
| D4 | Transport: tRPC v11 `httpBatchLink` + `wsLink`, superjson, observables kept | Matches trpc-electron semantics; one-file swap on the client |
| D5 | Server runtime: **Node LTS** (not Bun) for v1 | node-pty + better-sqlite3 are native modules proven on Node/Windows (ConPTY); Bun stays as package manager/tooling |
| D6 | Windows terminal-host IPC: named pipe `\\.\pipe\papyrus-terminal-host-<user>` | `node:net` supports named pipes with the same API as unix sockets; guard the `chmodSync` (pipes don't chmod) |
| D7 | Auth v1: single bearer token, generated at server init, entered once per device; bind `127.0.0.1` by default | Single-user product; simplest thing that is actually safe. Passkeys later if ever |
| D8 | Remote access: **Tailscale as the blessed path** (Serve gives TLS for free); LAN + Caddy as documented alternative; never raw-internet | Zero-config TLS + WireGuard auth; matches "my devices" use case |
| D9 | iPhone = **PWA** of the same web UI, not a native app | One codebase; `apps/mobile` is stock Superset anyway. Native wrapper only if PWA ergonomics fail |
| D10 | Provider keys at rest: encrypted file with a server-local key file (0600), replacing Electron `safeStorage` | OS-agnostic; honest about threat model (protects against file exfil, not root on the server box) |
| D11 | Keep the Electron app building throughout; it becomes a thin shell over the same server + UI later (optional) | No burned bridges; migration not big-bang |

## 5. Phase index

Detailed working docs live in per-phase files; this table is the map.

| Phase | File | Summary | Exit |
|-------|------|---------|------|
| 0 | [PHASE_0.md](PHASE_0.md) | **Fork groundwork & rebrand** — NOTICE chain + Papyrus block, ADE → Papyrus rename, `~/.papyrus` migration, quarantine Superset cloud apps, README. | Repo builds, legally tidy, lean |
| 1 | [PHASE_1.md](PHASE_1.md) | **papyrus-server** — node-pty/ConPTY Windows spike (go/no-go, runs first), extract `packages/server-core`, core/shell router split, tRPC over HTTP+WS, token auth, Windows named pipe. | Headless core on Windows + macOS, smoke test green |
| 2 | [PHASE_2.md](PHASE_2.md) | **apps/webui** — Vite SPA from the desktop renderer, ipcLink → httpBatchLink+wsLink swap, ShellCapabilities interface, terminal over WS with reconnect+replay, token login, SPA served same-origin. | **M1: full app in a browser on Windows** |
| 3 | [PHASE_3.md](PHASE_3.md) | **Remote + iPhone** — Tailscale Serve (blessed) / Caddy (alt), PWA manifest + service worker, iOS keyboard shim + key bar, visibilitychange resubscribe, responsive layout. | **M2: iPhone over Tailscale, survives lock/unlock** |
| 4 | [PHASE_4.md](PHASE_4.md) | **Parity & hardening** — provider-keys at rest, web notifications, viewer parity, mirror-readonly multi-attach, security pass, Windows+macOS CI. | Daily-drivable everywhere, no Electron required |
| 5 | [PHASE_5.md](PHASE_5.md) | **Optional endgame (triggered, not scheduled)** — Electron thin shell, Capacitor wrapper, multi-server via `WorkspaceRuntimeRegistry`. | — |

## 6. Risks & open questions

| Risk | Mitigation |
|------|-----------|
| node-pty/ConPTY quirks with agent CLIs on Windows (resize, ANSI, ctrl-c) | Spike in Phase 1 week 1: spawn `claude` under node-pty on Windows before anything else — it's the highest-information experiment |
| iOS Safari + xterm.js keyboard/IME jank | Known-solvable (Blink, code-server, a-Shell all shipped it); key-bar + focus shim; budget real device time in Phase 3 |
| Hidden Electron imports in "pure" modules discovered during extraction | The `SecretStore`-style interface pattern per offender; Phase 1 exit test is headless boot, which flushes them all out |
| Old Superset packages (`packages/db`, `packages/auth`, durable-streams) entangled in shared code | Quarantine in Phase 0 is compile-checked; delete only after M1 |
| WS terminal throughput via JSON/superjson feels laggy | Acceptable for v1 (it's the current IPC shape); Phase 4 option: dedicated binary WS channel for pane bytes |
| Mobile Safari kills background sockets → "dead" sessions | Sessions are daemon-persistent by design; reconnect+replay is pure client work (Phase 2/3) |
| License drift: accidentally offering hosted Papyrus to others | ELv2 forbids third-party hosted service; fine for self-host + distribution. Note in README/CONTRIBUTING |

**Open questions (decide by end of Phase 1):**
1. Data dir migration `~/.ade` → `~/.papyrus`: one-time move on first server boot, or keep `~/.ade`?
2. Multi-attach semantics (Phase 4): mirror all clients vs single-writer takeover?
3. Does the Kimi/MiniMax/GLM model bar (Claude Code + OpenRouter) work unchanged on a Windows-hosted server? (Should — it's env-var injection — verify in Phase 1.)

## 7. Effort summary

| Phase | Estimate | Milestone |
|-------|----------|-----------|
| 0 — Groundwork | 0.5–1 d | Clean, legal, lean repo |
| 1 — papyrus-server | 4–7 d | Headless core on Windows + macOS |
| 2 — webui | 5–8 d | **M1: full app in a browser on Windows** |
| 3 — Remote + iPhone | 2–4 d | **M2: iPhone over Tailscale** |
| 4 — Parity/hardening | 4–6 d | Daily-drivable everywhere |
| **Total to M2** | **~12–20 dev-days** | |

Sequencing note: Phase 1's Windows node-pty spike is the go/no-go gate — run it first. Everything else is well-trodden ground.

## Related

- [[Repos/papyrus-ade/planning/TODO|TODO]]
- [[Repos/papyrus-ade/planning/PHASE_0|PHASE_0]]
- [[Repos/papyrus-ade/planning/PHASE_1|PHASE_1]]
- [[Repos/papyrus-ade/planning/PHASE_2|PHASE_2]]
- [[papyrus-ade]]
