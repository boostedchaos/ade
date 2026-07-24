---
type: reference
tags: [repo/papyrus-ade]
up: "[[Repos/papyrus-ade/planning/PLAN_MAIN|PLAN_MAIN]]"
---
# Phase 2 — `apps/webui`: the browser client (~5–8 days)

Turn the desktop renderer into a browser SPA served by papyrus-server.
**Milestone M1 lives here: the full app in Chrome on the Windows laptop —
this IS the "Windows app."**

## 1. Scaffold `apps/webui`

Vite React SPA seeded from `apps/desktop/src/renderer/` (`screens/`,
`routes/`, `stores/`, `components/`, `hooks/`, `providers/`, `react-query/`,
`lib/`, `assets/`, `globals.css`). Strategy: **copy-then-dedupe** — copy to
keep momentum, converge on a shared `packages/webui-core` (or similar) by
phase end so desktop and web don't drift. TanStack Router works unchanged in
a browser (it's a web router already).

## 2. Transport swap (the designed-in seam)

`apps/desktop/src/renderer/lib/trpc-client.ts` is the one-file swap point:

```ts
// desktop (today):        links: [sessionIdLink(), ipcLink({ transformer: superjson })]
// webui:                  links: [sessionIdLink(), splitLink({
//                            condition: op => op.type === 'subscription',
//                            true:  wsLink({ client: wsClient, transformer: superjson }),
//                            false: httpBatchLink({ url: '/trpc', transformer: superjson,
//                                                   headers: () => authHeader() }) })]
```

Both the React-hooks client and the imperative proxy client
(`electronTrpcClient`) swap identically. `sessionIdLink` is kept — the server
still uses it to scope per-tab state.

## 3. `shell` capability interface

The renderer's Electron dependencies are small and enumerable:

- **Preload surface** (`src/preload/index.ts:62-64`): `App`, `ipcRenderer`,
  `webUtils`. Define a `ShellCapabilities` interface; the web impl maps to
  `window.open` (external links), Notification API, no-ops (tray/dock/menu),
  browser fullscreen (window controls), `<input type=file>` (webUtils paths).
- **Shell routers** (window/menu/hotkeys/auto-update/permissions/ringtone/
  external/browser): web client hides those UI affordances behind the same
  capability flags rather than stubbing every call.
- Grep-audit the renderer for any other `window.App` / `ipcRenderer` touches
  and route them through the interface.

## 4. Terminal in the browser

- xterm.js already renders in the renderer; keep the tRPC WS subscription
  shape (data/exit/disconnect events per pane — the `TerminalEventSource`
  invariant: subscriptions do NOT complete on exit).
- Renderer fallback chain: webgl → canvas → dom (Safari/iOS GPU quirks);
  drop the ligatures addon on web if it misbehaves.
- **Reconnect discipline** (the mobile-critical piece, built here on desktop
  browser first): on WS drop → resubscribe → `createOrAttach` returns
  scrollback history → replay into the same xterm instance. The daemon
  already has attach/detach + history (`terminal-host/session.ts`); this is
  UI work, not protocol work.

## 5. Login + serving

- Login screen: paste token once → `localStorage`; `authHeader()` attaches it
  to HTTP; WS attaches via query param or first-message auth.
- papyrus-server serves the built SPA (static + SPA fallback) on the same
  port — one process, one origin, no CORS.

## Checklist

- [ ] Scaffold `apps/webui` (Vite) seeded from the desktop renderer
- [ ] Swap `ipcLink` → `httpBatchLink` + `wsLink` (+ keep `sessionIdLink`) in both clients
- [ ] `ShellCapabilities` interface + web impl; renderer audited for stray `window.App`/`ipcRenderer`
- [ ] Shell-router UI affordances hidden behind capability flags on web
- [ ] Terminal over WS subscription; webgl → canvas → dom fallback
- [ ] Reconnect + scrollback replay on WS drop
- [ ] Token login screen; token persisted per device
- [ ] Server serves the built SPA same-origin
- [ ] Copy-then-dedupe converged: shared UI code extracted, desktop still green

**Exit (Milestone M1):** on the Windows laptop, `papyrus serve` + Chrome at
`localhost:7777` gives the full ADE workflow — create team/agent, sessions
spawn, model bar works, Agent Files panel live.

## Related

- [[Repos/papyrus-ade/planning/PLAN_MAIN|PLAN_MAIN]]
- [[Repos/papyrus-ade/planning/PHASE_1|PHASE_1]]
- [[Repos/papyrus-ade/planning/PHASE_3|PHASE_3]]
