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
     input (`package:win:canary` from the canary workflow). Verified by evaluating the
     config: canary appId/productName/artifactName + win32-natives staging + npmRebuild
     off + prerelease publish.
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

## Phase D — Shell-semantics hardening

1. Setup/teardown command chains: entries are joined with `&&` (`launch-command.ts:38`,
   `teardown.ts:39`). Modern cmd and pwsh 7 accept `&&`; **Windows PowerShell 5.1 — ADE's
   middle fallback shell — does not**, so multi-entry configs fail there even with valid
   Windows commands. Prefer per-platform config keys (`setup.win`) or shell-aware joining
   over the originally proposed POSIX-token warning heuristic.
2. macOS-authored `.superset/config.json` setup commands (`./setup.sh`, `chmod`) still fail
   under any Windows shell — per-platform keys cover this too.
3. PATH shadowing of the shim dir by PowerShell profiles: real but not trivially guardable
   from the main process (it can't observe post-profile resolution). Fold into the Phase A
   structured-invocation work rather than a bolt-on check.

## Phase E — Polish + upstream

1. Window controls: 46×32 caption-button sizing and a maximize/restore glyph swap
   (`WindowControls.tsx`).
2. Add `upstream` remote + document the sync strategy. Review caution: the port touches
   terminal hosting, permissions, menus, agent setup, renderer, and packaging — do NOT
   assume clean rebases; document the merge base and choose merge vs rebase deliberately.
3. Release scripts (`create-release.sh`) are bash+gh+jq — document "run from Git Bash" in
   RELEASE.md rather than rewriting.

## What NOT to do (unchanged, review-confirmed)

- Don't re-port the terminal/PTY/shim layer; the adversarial-review pass caught the subtle
  bugs and the native staging pipeline is the strongest part of the port.
- Don't add `.ps1` shims — their absence is a documented, correct decision.
- Don't put agent-CLI validation in `createOrAttach` — the PTY spawns a shell, not the CLI;
  gate at agent-launch entry points and keep the shim message as the fallback.

## Suggested order

A (broken feature) → C.1–C.2 (PR CI, cheap) → B (signing+updates together) → C.3–C.4 →
D → E. Status: A, B (rescoped), C done — next up is D (shell-semantics hardening),
then E (E.3 already covered by the Phase B RELEASE.md pass).
