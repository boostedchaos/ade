# Upstream Harvest Ledger

Standing triage ledger for selectively harvesting commits from the original
`superset-sh/superset` project into this fork (`boostedchaos/ade`).

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
| `3f68f39bd` | #5512 | heal malformed persisted pane layouts instead of crashing | Stability / crash | **skipped** — target module absent (see S1) | — |
| `4c99602f6` | #5518 | stop broken-session auth request storms (Electric token refresh + get-session poller) | Stability / auth | **skipped** — exclusion rule + absent infra (see S2) | — |
| `54335e561` | #5574 | augment PATH for host-service so git resolves under truncated login-shell PATH | Fix / shell-env | **skipped** — missing helper, macOS-only (see S3) | — |
| `3a14299f6` | #5560 | create worktree attachment dirs recursively on agent launch | Fix / worktree | **skipped** — target file absent (see S4) | — |
| `3908c81dc` | #5642 | native-fidelity terminal wheel scrolling (custom xterm handler + kitty identity) | Feature / terminal | **skipped** — integration points absent (see S5) | — |
| `b6a07bf37` | #5652 | terminal connection status indicator with diagnosis popover | Feature / terminal UX | **skipped** — v2-workspace UI absent (see S6) | — |
| `bd49bb93e` | #5648 | ⌘F search in the v2 changes pane | Feature / UX | **skipped** — v2-workspace UI absent (see S6) | — |
| `45ead3219` | #5552 | first-class Mistral Vibe coding agent | Feature / agent | **skipped** — 28-file cross-cut, absent registry (see S7) | — |

Status values: **picked** (applied cleanly), **adapted** (applied with manual
conflict resolution / re-port), **skipped** (with reason). Order attempted:
crash fixes → small fixes → terminal fidelity → UX features.

## 2026-07-14 pass — outcome

**All 8 tier-1 candidates skipped. Zero picks landed.** Not a process failure —
the honest result of the fork's divergence. The report verified these commits
exist in `superset/main`'s log but did not validate them against the fork's
actual tree. The fork is a squashed single "Initial commit" with **no shared
merge-base**, and it predates upstream's **v2 workspace UI** and **cloud/sign-in
infrastructure**. In `git cherry-pick` terms, every candidate's primary target
came back **`DU` (deleted-by-us = the file does not exist in the fork)** rather
than a resolvable content conflict. Forcing these would mean re-implementing
against absent modules — outside harvest scope.

### Skip reasons (with manual-port pointers for a future deliberate pass)

- **S1 · #5512** — All three targets are absent (`DU`): the entire
  `CollectionsProvider/dashboardSidebarLocal` Zod-schema persistence module and
  `packages/panes/.../Tab/Tab.tsx`. The crash-heal logic is welded to upstream's
  sidebar-local persistence schema the fork doesn't carry. *Manual port:*
  reimplement layout-healing against the fork's own pane-persistence layer — a
  from-scratch effort, not a cherry-pick.
- **S2 · #5518** — Electric token refresh + get-session poller = cloud-connect /
  sign-in session infra, which the **exclusion rule** puts out of scope. Also the
  fork lacks `renderer/lib/jwt-refresh` and `routes/sign-in/hooks/useSessionRecovery`
  (both `DU`/new). Double reason to skip; no manual port recommended (the fork
  deliberately dropped the cloud session layer).
- **S3 · #5574** — Hunk inserts `augmentPathForMacOS(env)`, a helper that does
  not exist anywhere in the fork (confirmed `git grep`). The fork also rewrote
  `getProcessEnvWithShellPath` with Windows-aware `PATH`/`Path` casing and
  explicitly neutralizes the macOS-GUI truncated-PATH problem on win32, so this
  macOS-only fix targets a code path that does not apply to the Windows port.
  *Manual port (low value):* port `augmentPathForMacOS` and call it on the
  success path — macOS-only benefit.
- **S4 · #5560** — Only target `agent-session-orchestrator/adapters/terminal-adapter.ts`
  is absent (`DU`); the fork's agent-launch path is structured differently. The
  fix itself is tiny (recursive `mkdir` on attachment-dir creation at agent
  launch). *Manual port (worth a look):* find where the fork creates worktree
  attachment dirs on agent launch and add `{ recursive: true }` — but verify the
  fork isn't already recursive before porting.
- **S5 · #5642** — The new `packages/shared/src/terminal-wheel-handler/*` module
  would add cleanly (`A`), but its integration points are absent/diverged:
  `renderer/lib/terminal/terminal-runtime.ts` (`DU`),
  `packages/host-service/src/terminal/env.ts` (`DU`), `apps/web/.../WebTerminal.tsx`
  (`DU`), plus content conflicts in `packages/shared/src/constants.ts`,
  `packages/shared/package.json`, and **`bun.lock`**. Wiring the handler in is a
  re-implementation and drags a dependency/lockfile change. *Manual port:* land
  the standalone handler module, then wire it into the fork's own terminal
  runtime + host-service env.
- **S6 · #5652 & #5648** — Both target the `_dashboard/v2-workspace/$workspaceId/
  hooks/usePaneRegistry/...` tree, which **does not exist in the fork at all**
  (all `DU`; new files `A`). The fork predates upstream's v2 workspace pane UI.
  These are usable as **design references only** (as the deep-dive itself notes
  for #5652 feeding improvement 02), not as cherry-picks. *Manual port:* rebuild
  the feature against the fork's current workspace/terminal UI.
- **S7 · #5552** — 28 files, 22 content conflicts, spanning desktop, marketing,
  mobile, docs, host-service, and shared. `agent-wrappers.ts` exists (`UU`) but
  the agent-model registry it plugs into is absent/diverged: `agent-models.ts`,
  `builtin-terminal-agents.ts`, `desktop-agent-setup.ts`, and the host-service
  `events`/`agents` routers are all `DU`/`UU`. No confident resolution. *Manual
  port:* a dedicated feature task, not a harvest pick.

## Dependency changes

**None.** No pick landed, so `package.json` / `bun.lock` are unchanged from fork
HEAD. (Note: #5642, had it been pursued, would have added a `bun.lock` +
`packages/shared/package.json` change — recorded here for the next pass.)

## Integrator note

None of the attempted picks touched the files known to be in flight on other
branches (`daemon-manager.ts`, `index.ts`, `ChangesContent.tsx`, `port-scanner.ts`,
`git-operations.ts`) — no cross-branch merge collision from this pass.

## Next-pass guidance

The tier-1 list is exhausted for direct cherry-picking. Future passes should
either (a) triage **smaller, path-stable `fix(desktop)` commits** whose targets
still exist in the fork (util/helper-level fixes like shell-env, git plumbing),
or (b) treat the larger upstream features (v2 workspace, terminal fidelity,
agent registry) as **design references for native re-implementation**, tracked
as their own improvement items rather than harvest picks.
