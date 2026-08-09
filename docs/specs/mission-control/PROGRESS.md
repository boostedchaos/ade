# Mission Control build — progress / resume state

Branch: `mission-control` off main (base `791f6ae`, spec commit atop `302d183`).
Orchestrator: Fable (architect only); execution via parallel Opus 5 subagents.

## Current phase

**Phase 1 — Control plane + CLI core** (dispatching, 2026-08-09).
Phase 0 complete except probe (still running; only gates Phase 4).

- [x] Branch created, base verified (`302d183` is ancestor of HEAD)
- [x] Socket schema + amendments → `PROTOCOL.md` (this dir)
- [x] Ground truth re-verified at HEAD: 26/26 CONFIRMED, 0 drift → `RECON-HEAD.md`
- [x] Package scaffolds `@ade/control-plane`, `@ade/cli` (bun install clean, no lockfile change)
- [ ] Agent-teams logging probe (claude 2.1.226) → agent `probe` running → `probe/`

Key design amendments from recon (detail in PROTOCOL.md):

- Feature 2 = extend existing hook pipeline (`~/.ade/hooks/claude-settings.json`
  - `--settings` + notification server + useAgentHookListener); NO
  ~/.claude/settings.json merge. SUPERSET_PANE_ID stays; ADE_SURFACE_ID aliased.
- Control token per-launch (unconditional write); auth via wrapper middleware.
- Phase 1 must verify main's tabsState mirror — reads may skip renderer bridge.
- Phase 6 note: docs/releasing-mac.md wants SUPERSET_WORKSPACE_NAME unset for
  public artifacts; spec gate 6 bakes `default`. Two artifacts/two purposes —
  state which was produced, don't reconcile.

## Agent assignments

| Agent | Task | Output |
|---|---|---|
| recon | Re-verify spec ground truth at HEAD + extract socket/PATH/IPC/test/build patterns | docs/specs/mission-control/RECON-HEAD.md |
| probe | Static+dynamic agent-teams tmux vocabulary capture | docs/specs/mission-control/probe/ |

## Open items

- Hybrid harness clause: decide after probe whether one mechanical lane runs via agent teams.

## Resume notes

If resuming cold: read SPEC.md (contract), PROTOCOL.md (wire schema),
RECON-HEAD.md (verified file:line at HEAD), probe/PROBE-CONTRACT.md
(tmux-compat contract). Phases 1–6 per SPEC "Phases" section; commit at
every phase boundary.
