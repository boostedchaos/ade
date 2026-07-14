# Windows Port Improvement Plan

2026-07-12, revised 2026-07-13 after a cross-AI review (Codex CLI, gpt-5.6-sol) verified the
plan against the code and corrected several claims. Original three-track audit at `85c221c`.

**Overall verdict:** the terminal/PTY/shim engineering is solid, and the port already ships
more first-run infrastructure than the first audit credited (runtime/git detection, install
dialogs, shim missing-binary messages). The one genuinely **broken** first-party Windows path
is agent command construction (below). Remaining work: distribution (signing/auto-update),
CI coverage, and shell-semantics hardening.

## Status

- **Phase 1 (docs) — DONE** (commits `1396315`..`831c51a`), plus a corrective commit
  (`5b36838`): the data-location section originally said `~/.superset` / `%APPDATA%\ADE`;
  the real location for everything is `~/.ade` (`SUPERSET_HOME_DIR`, redirected Electron
  `userData`).
- **Phase 2 (first-run UX) — DONE, rescoped** (commit `6248a7b`). The original phase
  ("no prerequisite detection") overstated the gap: `computeRuntimeAvailability` +
  `BinaryInstallDialog` + NewAgentModal git preflight + the shim's missing-binary message
  already exist. What was actually missing and is now fixed: Windows-correct git install
  info (was `xcode-select --install`), the NewAgentModal banner hardcoding macOS copy,
  session-launch failures swallowed into `console.error` (now toasted at
  `launchPresetCommand`, the funnel for all launches), and a vague safeStorage error.
  Deliberately NOT added: a `createOrAttach` guard — the PTY spawns a shell, not the agent
  CLI, so a main-process block would be wrong-layer; the shim message is the designed
  fallback.

## Phase A — Fix POSIX-only agent commands — DONE 2026-07-13

Implemented as platform-aware command strings rather than main-process env injection: the
model bar can run an OpenRouter model in a workspace whose stored runtime differs, and
`createOrAttach` only carries the workspace runtime, so injecting env in main would have
required threading a per-session runtime through the terminal-host protocol. On win32 the
builders emit PowerShell (`$env:` statements; literal here-string for prompts) — valid in
both pwsh 7 and Windows PowerShell 5.1, verified by executing generated commands in both.
POSIX output is byte-identical to before. Known ceiling: a cmd.exe-only session (no
PowerShell resolvable) still can't run these; win32 shell resolution always finds
powershell.exe in practice.

Original finding, for the record:

`packages/shared/src/agent-command.ts` builds the Kimi / MiniMax / GLM launch commands with
POSIX env-prefix syntax (`ANTHROPIC_BASE_URL="…" ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY"
claude …`) and task-prompt launches with `$(cat <<'EOF' …)` heredocs. These strings are
written verbatim into the session's shell — PowerShell/cmd on Windows — where both constructs
fail. The model bar's OpenRouter models (a headline README feature) and task-prompt agent
launches are broken on Windows.

Fix direction: stop encoding env vars in the command string — inject them into the terminal
env at session creation (the env-injection path already exists for `OPENROUTER_API_KEY`),
and build the prompt-passing per shell (PowerShell here-string / temp file) or pass via
stdin. Prefer structured {command, args, env} over quoted shell strings.

## Phase B — Distribution: signing + auto-update as one unit — RESOLVED 2026-07-13 (signing skipped)

Revised from the original Phase 3 after review: an unsigned *self-updating* binary is a
worse trust posture than an unsigned download, so signing should land before or atomically
with enabling the updater, not as an optional later step.

**Decision 2026-07-13:** signing skipped — the port is personal-use; $120/yr (Azure
Artifact Signing, née Trusted Signing, $9.99/mo, verified current) isn't justified, and
SignPath OSS eligibility for a fork is uncertain. Per the trust-posture rule above,
**auto-update therefore stays gated off** (`AUTO_UPDATE_ENABLED` /
`IS_AUTO_UPDATE_PLATFORM` untouched). Revisit both together before any wider
distribution. The release plumbing below was fixed anyway:

1. Code signing — SKIPPED by decision (see above).
2. Enable auto-update on Windows — DEFERRED with signing, as one unit.
3. Release plumbing — DONE:
   - **Windows canary builds ignore `electron-builder.canary.ts`** — fixed:
     `electron-builder.canary.ts` is now a target-aware factory (`createCanaryConfig`),
     `electron-builder.canary.win.ts` layers canary overrides on the `"win"` target's
     `.win32-natives` staging, and `build-desktop.yml` takes a `win_package_script`
     input (`package:win:canary` from the canary workflow). **CI-verified** (dispatched
     canary run 29285813748 on `281700d`): Windows job green end-to-end, artifacts now
     `ADE-Canary-0.1.0-canary.<ts>-x64.exe/.zip` (previously stable-named), manifest
     uploaded under the new glob. Note: only `latest.yml` is generated — electron-builder
     derives the channel from `publish.channel` (unset), not the prerelease version
     suffix; fine while the updater is off, revisit if updates are ever enabled.
   - **Pre-existing, NOT from this phase:** the canary macOS build job fails on every
     run (also on `85c221c` runs predating Phase B) inside electron-builder's dependency
     collection — "bun does not support any CLI for dependency tree extraction" → NPM
     collector finds no node_modules → "apps/desktop not a file". The `Update Canary
     Release` job is therefore always skipped, so no canary release gets published from
     any platform. macOS-build backlog item, out of Windows-port scope.
   - Windows update-manifest upload now grabs every channel manifest
     (`release/*.yml` minus `builder-debug.yml`) with `if-no-files-found: error`
     (was `latest.yml` + `warn`). Packaged `app-update.yml` validation deferred with
     the updater.
   - RELEASE.md fixed: URLs → `boostedchaos/ade-windows-port`, Windows manifest added,
     signing/auto-update decision recorded, "run create-release.sh from Git Bash" noted
     (covers Phase E.3).

## Phase C — Windows CI coverage — DONE 2026-07-13, CI-verified

windows-ci run 29271387357 (commit `08236dd`) is green end-to-end on the pinned toolchain:
typecheck → full 955-test suite vs baseline → packaged build → natives smoke → app-init
smoke. The first run flagged exactly one runner-vs-local baseline delta (createWorktree
hook tolerance), which the ratchet named precisely — added to the baseline as designed.

1. `pull_request: branches: [main]` trigger added to `windows-ci.yml`.
2. Toolchain aligned: `build-desktop.yml` bumped from setup-bun v1 / Bun 1.3.2 to v2 / 1.3.6
   (matches root `packageManager` and windows-ci). Inherited deploy-* web workflows left
   untouched (out of the port's CI scope).
3. **The test hang was root-caused — both prior diagnoses were wrong.** Not ConPTY (original
   commit) and not `Promise.race` (cross-AI review): under bun's Windows test runner, an
   **unref'd timer that is the only pending event-loop handle never fires**, and a fully
   quiescent hang is also invisible to bun's per-test `--timeout`. One-line repro pinned it;
   fixed by dropping the defensive `unref()` in `terminal/reconcile.ts` (the timer is
   cleared on settle, so nothing can leak). With that fix the FULL desktop suite completes
   on Windows: 955 tests / 63 files in ~20s, 876 pass, 78 known failures — deterministic
   across runs.
4. CI now runs the full suite behind a **failure ratchet** (`scripts/check-win-tests.ts` +
   `scripts/win-test-baseline.txt`, `bun run test:win`): bun test has no exclude flag, so
   instead of an allow-list, everything runs and only NEW failures fail CI; newly-passing
   tests are reported for baseline pruning. Verified locally in both directions. Caveat:
   baseline generated on a local Win11 box — the first windows-latest run may need a
   baseline touch-up (the script prints the exact lines).
5. Packaged smoke deepened to app level: the boot smoke now redirects `USERPROFILE` to a
   scratch dir and asserts `local.db` is created under `.ade` — real main-process init
   through better-sqlite3 inside the packaged app, not just "process alive for 20s".

Backlog surfaced by the full-suite run (future work, not blocking):

- Terminal-host daemon tests fail with `connect ENOENT …\.superset-test\terminal-host.sock`
  — the test harness assumes a Unix socket path; needs the named-pipe transport the
  production daemon uses. Fixing this unlocks real daemon/session coverage in CI (the
  original C.4 ambition).
- Most of the 78 baseline failures assert macOS behavior (`getAppCommand` `open -a`,
  static-ports, setup/teardown paths) — candidates for platform-gating so the baseline
  shrinks toward zero.

## Phase D — Shell-semantics hardening — DONE 2026-07-13

1. `&&` chains — fixed with BOTH approaches (join + per-platform keys):
   `buildTerminalCommand` (the one joiner for workspace setup AND tab presets) now joins
   with `; if (-not $?) { throw "command failed" };` on Windows — valid in WinPS 5.1 and
   pwsh 7, fail-fast, and `throw` keeps the interactive pane alive (verified by executing
   both join forms in both shells, fail and success paths). `teardown.ts` joins with
   `; if (-not $?) { exit 1 };` when the resolved shell is PowerShell (it runs under
   `-Command`, so `exit` propagates the failure code); cmd/POSIX keep `&&`. Platform
   detection reuses Phase A's dual-probe `IS_WINDOWS` (now exported from
   `@superset/shared/agent-command`). Known ceiling, same as Phase A: a cmd.exe-only
   PANE would get the PS join — out of scope, powershell.exe always resolves.
2. Per-platform config keys — `"setup.win"` / `"teardown.win"` added to `SetupConfig`;
   selection happens once in `loadSetupConfig`'s `readConfigFile`, so all consumers
   (workspace create ×7, init, teardown) get platform-correct lists with no call-site
   changes. macOS-authored configs keep working on mac; Windows users can supply native
   equivalents.
3. PATH shadowing by PowerShell profiles: unchanged by design — folds into future
   structured-invocation work, not a bolt-on check.

Verified: launch-command tests cover both join branches via an injectable `isWindows`
param (8/8 pass); full Windows suite ratchet clean (957 tests, no new failures — the 14
failing setup/teardown tests were already in the baseline, asserting POSIX behavior);
typecheck clean.

## Phase E — Polish + upstream — DONE 2026-07-13

1. **DONE.** Window controls: `WindowControls.tsx` buttons now 46×32 (`w-[46px] h-8`)
   with a maximize/restore glyph swap (`HiMiniStop` ↔ `HiMiniSquare2Stack`), driven by
   the existing `window.isMaximized` query + a renderer `resize` listener so the glyph
   stays correct after title-bar double-click / Win+Up / snap (not just button clicks).
   Kept the existing rounded in-toolbar style — the cluster sits inside the padded TopBar
   right group, not flush in the corner; true native-flush strip = a TopBar layout change,
   out of scope. Typecheck clean.
2. **DONE.** `upstream` remote added (`per-simmons/damon-ade`, the direct fork parent) and
   sync strategy documented in `docs/upstream-sync.md`. Merge base = `8dd78d3` (upstream
   `v0.1.0`, "ADE 0.1.0 — initial public release"); divergence **0 behind / 30 ahead** —
   `upstream/main` has not advanced past 0.1.0, so nothing to pull today. Decision:
   **merge, never rebase** (30 published commits across terminal/permissions/menus/agent/
   renderer/packaging — rebase would raise the same conflict 30× and rewrite released SHAs).
   Doc includes the re-check commands, the sync procedure, and a do-not-break list.
3. **DONE (Phase B).** Release scripts (`create-release.sh`, bash+gh+jq) documented as
   "run from Git Bash" in RELEASE.md during the Phase B pass.

## What NOT to do (unchanged, review-confirmed)

- Don't re-port the terminal/PTY/shim layer; the adversarial-review pass caught the subtle
  bugs and the native staging pipeline is the strongest part of the port.
- Don't add `.ps1` shims — their absence is a documented, correct decision.
- Don't put agent-CLI validation in `createOrAttach` — the PTY spawns a shell, not the CLI;
  gate at agent-launch entry points and keep the shim message as the fallback.

## Suggested order

A (broken feature) → C.1–C.2 (PR CI, cheap) → B (signing+updates together) → C.3–C.4 →
D → E. Status: **all phases done** — A, B (rescoped), C, D, E complete. E.1 (window
controls) + E.2 (upstream remote + `docs/upstream-sync.md`) shipped 2026-07-13; E.3
was covered by the Phase B RELEASE.md pass.
Backlog: the C.3 terminal-host named-pipe test transport. The canary macOS failure
(empty MAC_CERTIFICATE secret → CSC_LINK="" → electron-builder "not a file") is FIXED
and CI-verified: run 29288595270 on `a63f707` went green on all three platforms and
`Update Canary Release` published the desktop-canary prerelease (exe/zip/dmg/AppImage,
all canary-named, + latest/latest-mac/latest-linux manifests) — the first canary
release this fork has ever published.
