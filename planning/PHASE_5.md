---
type: reference
tags: [repo/papyrus-ade]
up: "[[Repos/papyrus-ade/planning/PLAN_MAIN|PLAN_MAIN]]"
---
# Phase 5 — Optional endgame (unscheduled)

None of this blocks daily use; each item has a trigger condition. Do not
start any of it speculatively.

## 1. Electron as a thin shell

Collapse the desktop app to a wrapper around the same server + webui: tray,
native notifications, auto-update, spawning/supervising `papyrus serve`
locally. One codebase, three form factors (browser tab, PWA, desktop shell).
**Trigger:** maintaining renderer parity between desktop and webui becomes
annoying — the thin shell eliminates the fork entirely (D11's endpoint).

## 2. Native iOS wrapper (Capacitor)

**Trigger:** a PWA limitation actually bites — most likely real push
notifications (attention events while the phone is locked) or keyboard
quirks that can't be shimmed. Capacitor wraps the existing webui; no
second UI codebase.

## 3. Multi-server

Point one UI at multiple papyrus-servers (work machine + home machine).
The `WorkspaceRuntimeRegistry` seam
(`workspace-runtime/types.ts:214` — `getForWorkspaceId`) was designed for
exactly this: per-workspace runtime selection, backends coexisting.
Client-side it's a server-picker + per-server token store.
**Trigger:** a second always-on machine actually exists.

## Checklist

- [ ] (triggered) Electron thin shell over server + webui
- [ ] (triggered) Capacitor iOS wrapper
- [ ] (triggered) Multi-server via `WorkspaceRuntimeRegistry` + server picker

## Related

- [[Repos/papyrus-ade/planning/PLAN_MAIN|PLAN_MAIN]]
- [[Repos/papyrus-ade/planning/PHASE_4|PHASE_4]]
- [[Repos/papyrus-ade/planning/TODO|TODO]]
