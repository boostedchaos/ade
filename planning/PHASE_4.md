---
type: reference
tags: [repo/papyrus-ade]
up: "[[Repos/papyrus-ade/planning/PLAN_MAIN|PLAN_MAIN]]"
---
# Phase 4 — Parity & hardening (~4–6 days)

Close the gap between "works" and "daily-drivable from all three devices
with no Electron install anywhere."

## 1. Secrets & keys

- Provider-keys encryption-at-rest on the server via the `SecretStore`
  file-key impl (D10): AES key in `~/.papyrus/secret.key`, 0600/owner-ACL.
  Honest threat model: protects against file exfiltration, not root on the
  server box.
- In-app key-entry flow on web (OpenRouter etc.) — currently desktop-only
  UI; port the settings screen.
- `papyrus token rotate` command; old token invalidated, new one printed.

## 2. Notifications

- "Session needs attention" events → Web Notification API (permission
  prompt on first attention event, not on load). Works on desktop browsers
  and Android; **iOS PWA push requires Web Push + user gesture** — defer
  real push; the Phase-3 badge/title-flash covers iOS v1.

## 3. Feature parity sweep

- File viewers: Monaco, markdown, diff views — all browser-native libs
  already; verify wiring end-to-end on web.
- Resource metrics per agent/session on web; kill/cleanup flows.
- **Multi-device attach policy**: daemon already supports multiple attaches;
  decide mirror vs takeover — **recommend mirror-readonly v1** (all clients
  see output; the most-recent-focus client gets the keyboard; explicit
  "take input" button elsewhere). Simplest correct thing; revisit if
  co-driving is ever wanted.

## 4. Security pass

- Rate-limit token attempts (trivial fixed-window is fine at n=1 user).
- Audit that the terminal-host pipe/socket is not network-reachable and its
  ACL is per-user (Windows pipe + unix socket).
- CSP on the SPA (`default-src 'self'`; explicit `connect-src` for WS).
- Confirm the server refuses non-localhost binds without an explicit flag.

## 5. CI

- GitHub Actions: build + test `packages/server-core`, `apps/server`,
  `apps/webui` on **windows-latest and macos-latest** (native-module
  prebuilds are exactly the thing CI catches).
- Headless smoke test (Phase 1 §7) runs in CI on both platforms.

## Checklist

- [ ] Provider keys encrypted at rest (file-key SecretStore); web key-entry flow
- [ ] `papyrus token rotate`
- [ ] Web Notification API for attention events (desktop/Android); iOS deferred
- [ ] Monaco / markdown / diff viewers verified on web
- [ ] Multi-device: mirror-readonly attach policy implemented
- [ ] Resource metrics + kill/cleanup on web
- [ ] Rate-limit login; pipe/socket reachability + ACL audit; CSP; bind guard
- [ ] CI green on Windows + macOS runners incl. smoke test
- [ ] Delete quarantined Superset apps for real (post-M1 confidence)

**Exit:** daily-drivable from Windows laptop, Mac, and iPhone; no Electron
install required anywhere.

## Related

- [[Repos/papyrus-ade/planning/PLAN_MAIN|PLAN_MAIN]]
- [[Repos/papyrus-ade/planning/PHASE_3|PHASE_3]]
- [[Repos/papyrus-ade/planning/PHASE_5|PHASE_5]]
