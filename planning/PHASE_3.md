---
type: reference
tags: [repo/papyrus-ade]
up: "[[Repos/papyrus-ade/planning/PLAN_MAIN|PLAN_MAIN]]"
---
# Phase 3 — Remote access + iPhone (~2–4 days)

Same app, reachable from the phone. Two halves: the network path (easy,
mostly documentation) and iOS Safari terminal ergonomics (the real work).
**Milestone M2 lives here.**

## 1. Network path

- **Blessed path — Tailscale (D8):** `tailscale serve` in front of the server
  port gives TLS + tailnet-only auth for free; the server never leaves
  `127.0.0.1`. Test from iPhone on cellular (tailnet, not LAN). Document the
  three commands in README.
- **Documented alternative — LAN + Caddy:** bind LAN + Caddy TLS in front;
  adapt the quarantined `Caddyfile.example`. For people who won't run
  Tailscale.
- **Never raw-internet.** Token auth is the second factor, not the first.

## 2. PWA shell

- Manifest: name/icons/`display: standalone`/theme color; apple-touch-icon
  set; `viewport-fit=cover` + safe-area insets (the terminal must not sit
  under the home indicator).
- Minimal service worker: cache the app shell for instant launch; **network-
  only for tRPC** (never cache API); offline page that says "server
  unreachable" rather than a broken UI.

## 3. iOS Safari terminal ergonomics (the real work)

Known-solvable — Blink, a-Shell, and code-server all shipped it — but budget
real device time:

- **Software keyboard**: xterm's hidden-textarea focus quirks on iOS —
  focus shim so tapping the terminal reliably raises the keyboard, and the
  viewport scrolls the active row above the keyboard (`visualViewport` API).
- **Key bar**: on-screen strip above the keyboard — `Esc · Tab · Ctrl · ↑ ↓
  ← → · ⏎` (the Blink/a-Shell pattern). Ctrl is sticky (tap Ctrl, tap C ⇒
  ^C). This is what makes driving `claude` from a phone actually usable.
- **Socket suspension**: iOS kills background WS aggressively. On
  `visibilitychange` → visible: resubscribe + replay scrollback (the Phase-2
  reconnect path — here it earns its keep). Sessions survive because the
  daemon owns them, not the client.
- **Responsive layout**: two-level rail → hamburger drawer; session tabs →
  swipeable strip; Agent Files panel → bottom sheet; touch targets ≥ 44px.

## Checklist

- [ ] Tailscale Serve path tested from iPhone (cellular) + documented
- [ ] LAN + Caddy alternative documented (adapted `Caddyfile.example`)
- [ ] PWA manifest + apple-touch-icons + `viewport-fit=cover` + safe-area insets
- [ ] Service worker: shell cached, tRPC network-only, offline page
- [ ] Keyboard focus shim; active row stays visible above keyboard
- [ ] Key bar with sticky Ctrl (Esc/Tab/Ctrl/arrows/Enter)
- [ ] Resubscribe + replay on `visibilitychange`
- [ ] Responsive layout: drawer, swipe tabs, files-as-sheet, 44px targets
- [ ] Lock phone mid-session → unlock → terminal alive with history intact

**Exit (Milestone M2):** from the iPhone over Tailscale: open Papyrus from
the home screen, attach to a running session, send a prompt to an agent,
watch output live; survives lock/unlock without a dead terminal.

## Related

- [[Repos/papyrus-ade/planning/PLAN_MAIN|PLAN_MAIN]]
- [[Repos/papyrus-ade/planning/PHASE_2|PHASE_2]]
- [[Repos/papyrus-ade/planning/PHASE_4|PHASE_4]]
