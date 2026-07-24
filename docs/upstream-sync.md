# Upstream sync strategy

This repo (`boostedchaos/ade-windows-port`) is a Windows port fork. This documents
how to pull changes down from upstream without wrecking the port.

## Remotes

```
origin     https://github.com/boostedchaos/ade-windows-port.git   (this fork)
upstream   https://github.com/per-simmons/damon-ade.git           (fork parent)
```

Fork chain: `superset-sh/superset` → `per-simmons/damon-ade` → this repo.
Sync from `upstream` (the direct parent), not from superset.

If `upstream` is missing after a fresh clone:

```sh
git remote add upstream https://github.com/per-simmons/damon-ade.git
git fetch upstream
```

## Merge base (as of 2026-07-13)

- Merge base = `8dd78d3` **"ADE 0.1.0 — initial public release"** (tagged `v0.1.0`,
  upstream, 2026-07-06). Every port commit sits on top of this.
- Divergence: **0 behind / 30 ahead**. `upstream/main` has not advanced past the
  0.1.0 release commit — it *is* the merge base. So there is nothing to pull today;
  a `git merge upstream/main` right now is a no-op.

Re-check anytime with:

```sh
git fetch upstream
git rev-list --left-right --count upstream/main...main   # <behind>  <ahead>
git log -1 $(git merge-base main upstream/main)          # current merge base
```

## Merge, not rebase

**Use `git merge upstream/main`. Do not rebase the port onto upstream.**

Why:

- The port touches terminal hosting, permissions, menus, agent setup, the renderer,
  and packaging/CI. A rebase replays all 30 commits over the new base and can raise
  the *same* conflict 30 times across those subsystems — merge resolves each conflict
  once.
- Commits are already published (the `desktop-canary` release + `origin/main`).
  Rebasing rewrites their SHAs; anything already built/released points at history
  that would no longer exist.

Rebase is only reasonable while a *small, unpushed* topic branch is still local. The
mainline port is neither.

## Procedure when upstream advances

```sh
git fetch upstream
git switch main
git switch -c sync/upstream-$(date +%Y%m%d)   # never merge straight onto main
git merge upstream/main
```

Then, before merging the sync branch back:

1. Resolve conflicts. Expect them in the port's hot spots — grep the diff for the
   platform seams: `IS_WINDOWS` / `agent-command`, `terminal/` (ConPTY, reconcile),
   `electron-builder*.ts`, `window.ts`, and the `.github/workflows/`.
2. `cd apps/desktop && bun run typecheck`
3. `cd apps/desktop && bun run test:win` — ratchet must report **no new failures**
   vs `scripts/win-test-baseline.txt`.
4. Sanity-check a packaged build in CI (windows-ci), since the local box can't
   produce a packaged build (pinned-Bun native-payload issue — see the plan doc).
5. Merge the sync branch into `main`, push.

## Do-not-break list on a sync

These are deliberate port decisions upstream may "helpfully" revert — keep them:

- No `.ps1` shims (only `.cmd`); PowerShell needs canonical-uppercase env keys.
- `buildTerminalCommand` / `teardown` PowerShell join semantics (no bare `&&`).
- Platform-aware agent command builders (`$env:` presets, PS here-strings).
- The un-`unref()`'d timer in `terminal/reconcile.ts` (fixes the bun-Windows test hang).
- Auto-update stays gated off until Windows signing lands.

## 2026-07-24 — second upstream: CameronCrow/papyrus-ade

This fork now incorporates `CameronCrow/papyrus-ade` main (97 commits merged
2026-07-24, both CI workflows green @ `a611894`): server-core extraction,
headless `ade-server` + browser webui, team dashboard, agent mail, terminal
perf. Papyrus branding was reverted tree-wide (ADE name, `.ade` dirs,
`@ade/*` package scope, `ADE_*` env vars) and their personal `.claude`
workforce hooks + graphify artifacts were dropped — see NOTICE for the
attribution chain.

Consequences for future syncs:

- **Watch BOTH upstreams.** `per-simmons/damon-ade` is dormant (main unmoved
  since the 0.1.0 squash); `CameronCrow/papyrus-ade` is active. Future pulls
  from papyrus will conflict with the un-rebrand — expect mechanical
  `papyrus→ade` renames on every file taken (`@papyrus/`→`@ade/`,
  `.papyrus`→`.ade`, `PAPYRUS_*`→`ADE_*`, `Papyrus`→`ADE`) plus their
  `.claude/` hooks and `graphify-out/` re-appearing (delete on sight and
  VERIFY the deletion landed — a suppressed-stderr `git rm` failed silently
  once).
- Their `planning/` docs were kept as-is (their design history; not swept).
- Their `webui` typecheck is red by their own bar — `ade-ci.yml` builds webui
  but does not typecheck it; don't "fix" CI by adding that gate blindly.
