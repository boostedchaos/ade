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

## Phase B — Distribution: signing + auto-update as one unit

Revised from the original Phase 3 after review: an unsigned *self-updating* binary is a
worse trust posture than an unsigned download, so signing should land before or atomically
with enabling the updater, not as an optional later step.

1. Code signing (Azure Trusted Signing or similar; verify current pricing independently).
2. Enable auto-update on Windows: `AUTO_UPDATE_ENABLED` + `IS_AUTO_UPDATE_PLATFORM` in
   `auto-updater.ts` both gate it off. Packaging is already compatible (NSIS,
   electron-updater, `latest.yml`, publish repo correct).
3. Release plumbing found by review:
   - **Windows canary builds ignore `electron-builder.canary.ts`** — `package:win`
     hardcodes `electron-builder.win.ts` (`build-desktop.yml:213`), so canaries miss the
     canary appId/name/artifacts. Fix before enabling updates.
   - Validate packaged `resources/app-update.yml`; upload every generated channel manifest
     (`if-no-files-found: error`). Stable-named `.exe`/`.zip` copies are convenience only,
     not an updater requirement.
   - Fix stale RELEASE.md manifest URLs (still `per-simmons/damon-ade`, mac/linux only).

## Phase C — Windows CI coverage

1. **Add a `pull_request` trigger to `windows-ci.yml`** — it currently runs only on push to
   main + manual dispatch, so Windows regressions can merge unseen. Cheapest high-value CI
   change.
2. Align toolchain drift: release build uses Bun 1.3.2 / setup-bun v1; windows-ci and root
   package use Bun 1.3.6 / setup-bun v2.
3. Widen the unit run from the 5-file allow-list to full-suite-minus-skip-list. Note: the
   excluded `reconcile-timeout.test.ts` hang is a bun-runner/`Promise.race` timing issue,
   NOT ConPTY (review corrected the original diagnosis) — root-cause it as such.
4. Deepen the packaged smoke test at the **application** level: today CI proves natives
   load and a raw node-pty shell echoes; what's untested is ADE's own terminal daemon /
   session wiring. Drive one real session end-to-end.

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
D → E.
