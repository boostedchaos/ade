# Upstream Harvest Ledger

Standing triage ledger for selectively harvesting commits from the original
`superset-sh/superset` project into this fork (`boostedchaos/ade-windows-port`).

## Purpose

The fork is caught up with its direct parent (`per-simmons/damon-ade`: 0 commits
behind) but the original `superset-sh/superset` has moved **3,134 commits** ahead
of the fork's v0.1.0 merge base (upstream now at desktop v1.15.0). That delta
holds **488 `feat(desktop)` + 628 `fix(desktop)`** commits — crash-hardening,
terminal-fidelity, and UX work relevant to this port.

A wholesale merge/rebase is **off the table**: upstream went cloud-connected
(relay, hosts, sign-in, Electric sync, telemetry backends) and this fork
deliberately diverged. The strategy is **harvest-don't-adopt**: a triaged,
repeatable, cherry-pick-only program.

## Method (run quarterly)

1. List candidate commits:
   `git log HEAD..superset/main -- apps/desktop packages/…` filtered to
   `feat(desktop|terminal)` / `fix(desktop|terminal)` prefixes.
2. Triage each into **pick / adapt / skip**.
3. **Exclusion rule (auto-skip):** anything touching relay, hosts, sign-in,
   cloud-connect, Electric sync, or telemetry backends is out of scope — the
   fork does not carry that infrastructure, so those picks neither apply nor
   belong.
4. Cherry-pick with provenance: `git cherry-pick -x <hash>` (the `-x` trailer
   records the source commit). One pick per commit.
5. **Gate:** `bun run typecheck` must pass after every kept pick. A pick that
   breaks typecheck and cannot be confidently fixed is reverted/skipped.
6. Where upstream restructured paths, a pick becomes a small manual
   re-implementation ("adapted") — or is skipped if the target structure is
   absent and re-porting is not confidently doable.
7. Record the outcome for every candidate in the table below.

### Structural note (2026-07-14)

The fork is a **squashed single "Initial commit"** — it shares **no merge-base**
with `superset/main`. Cherry-pick still works (each commit is diffed against its
own parent), but many upstream paths **do not exist** in the fork because it
predates upstream's v2 UI and cloud restructure. Verified missing at harvest
time: `_dashboard/v2-workspace/*` (entire v2 workspace UI), `renderer/lib/jwt-refresh`,
`routes/sign-in/hooks/useSessionRecovery`, `CollectionsProvider/dashboardSidebarLocal`,
`agent-session-orchestrator/adapters/terminal-adapter.ts`,
`renderer/lib/terminal/terminal-runtime.ts`, `packages/host-service/src/terminal/env.ts`,
`packages/shared/src/agent-models.ts`. A pick whose primary target is missing is
skipped, not force-fitted.

## Tier-1 candidate ledger (2026-07-14 pass)

| Upstream commit | PR | Subject | Category | Status | Local hash |
| --- | --- | --- | --- | --- | --- |
| `3f68f39bd` | #5512 | heal malformed persisted pane layouts instead of crashing | Stability / crash | _pending_ | — |
| `4c99602f6` | #5518 | stop broken-session auth request storms (Electric token refresh + get-session poller) | Stability / auth | _pending_ | — |
| `54335e561` | #5574 | augment PATH for host-service so git resolves under truncated login-shell PATH | Fix / shell-env | _pending_ | — |
| `3a14299f6` | #5560 | create worktree attachment dirs recursively on agent launch | Fix / worktree | _pending_ | — |
| `3908c81dc` | #5642 | native-fidelity terminal wheel scrolling (custom xterm handler + kitty identity) | Feature / terminal | _pending_ | — |
| `b6a07bf37` | #5652 | terminal connection status indicator with diagnosis popover | Feature / terminal UX | _pending_ | — |
| `bd49bb93e` | #5648 | ⌘F search in the v2 changes pane | Feature / UX | _pending_ | — |
| `45ead3219` | #5552 | first-class Mistral Vibe coding agent | Feature / agent | _pending_ | — |

Status values: **picked** (applied cleanly), **adapted** (applied with manual
conflict resolution / re-port), **skipped** (with reason). Order attempted:
crash fixes → small fixes → terminal fidelity → UX features.

## Dependency changes

_None yet — recorded here if a kept pick alters `package.json` / `bun.lock`._
