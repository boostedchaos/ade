# Windows Port Improvement Plan

2026-07-12. Based on a three-track audit (platform code, build/CI/release, docs/UX) of
`boostedchaos/ade-windows-port` at commit `85c221c`.

**Overall verdict:** the runtime port is solid — no outright-broken Windows code paths were
found. Shell selection, ConPTY signals, env canonicalization, `.cmd` shims, DPAPI key storage,
path canonicalization at the security boundary, and native-binary staging are all deliberate
and correct. The remaining work is concentrated in four areas: docs that still describe the
macOS/upstream project, no first-run prerequisite detection, no signing/auto-update on
Windows, and Windows CI that runs only 5 hand-picked test files.

Phases are ordered by impact-per-hour. Each is shippable independently.

---

## Phase 1 — Fix the docs that are wrong (≈1 hour, zero risk)

These actively mislead anyone (human or agent) touching the repo.

1. **README "Build from source" clones the wrong repo** (`README.md:38-45`): points at
   `per-simmons/damon-ade.git` (upstream, no Windows pipeline) and has a literal `cd REPO`
   placeholder. Change to clone this fork, `cd ade-windows-port`, and add the Windows build
   path: `bun install` (with `ADE_SKIP_INSTALL_APP_DEPS=1` note), `bun run build:win`.
2. **README keychain claim is false on Windows** (`README.md:90`): "encrypted with the macOS
   keychain" → "your OS credential store (DPAPI on Windows, Keychain on macOS)". The code
   (`provider-keys.ts`) already does the right thing; only the copy lies.
3. **README Git prerequisite is macOS-only** (`README.md:53`): `xcode-select --install` →
   add `winget install Git.Git` / git-scm.com for Windows.
4. **AGENTS.md describes a different project** (the Superset web monorepo — Next.js, Neon,
   Drizzle; none of it exists here). CODEX.md and WARP.md are `@AGENTS.md` so they inherit the
   damage. Rewrite AGENTS.md as an accurate brief of this repo (Electron desktop app,
   Bun + turbo, `apps/desktop`, Windows build pipeline, test commands).
5. **CONTRIBUTING.md routes issues to upstream** (`CONTRIBUTING.md:1`) and
   **`apps/desktop/package.json` `repository.url` still points at `per-simmons/damon-ade`**.
   Point both at `boostedchaos/ade-windows-port`.
6. **Document Windows data locations** (nowhere today, bad for a "local-first" product):
   settings DB under `%APPDATA%\ADE`, agent homes/worktrees/memory under
   `C:\Users\<you>\.superset`. Add to README and state the concrete path in `docs/memory.md`
   (which currently only says "outside the git worktree").
7. **Delete `docs/mastracode-fork-workflow.md`** (Superset-internal, unix-only, linked as
   authoritative from AGENTS.md).

## Phase 2 — First-run prerequisite detection (≈half a day, highest UX win)

The most likely fresh-Windows failure: no proactive check that git or any agent CLI exists.

- Missing git currently throws at first git operation (`workspaces/utils/git.ts:163,1151`).
- **A missing agent CLI (claude/codex/opencode) isn't validated at all** — the PTY spawns it
  and the user gets a raw "not recognized" inside the terminal tab.

Fix: before spawning a session, resolve the runtime CLI with the existing PATH+PATHEXT
resolver (`external/helpers.ts:60-90` already does this correctly for `.cmd`/`.bat` shims).
If unresolved, show a dialog naming the missing tool and the install command
(`npm i -g @anthropic-ai/claude-code`, etc.) instead of a dead terminal. Do the same for git
at app start (one `where git` equivalent, cached). Also give
`safeStorage.isEncryptionAvailable() === false` (`provider-keys.ts:42`) a friendly message
while in there.

## Phase 3 — Distribution: auto-update, then signing (≈half a day + an external decision)

1. **Enable auto-update on Windows.** It's code-gated off twice in `auto-updater.ts`:
   `AUTO_UPDATE_ENABLED = false` and `IS_AUTO_UPDATE_PLATFORM = mac || linux`. The packaging
   side is already compatible: NSIS target, `electron-updater` present, `latest.yml`
   generated, publish repo already `boostedchaos/ade-windows-port`. Include win32 in the
   platform gate, flip the flag, and fix the release workflow gaps: stable-named copies for
   `.exe`/`.zip` (release job currently only handles `.dmg`/linux) and make the `latest.yml`
   upload `if-no-files-found: error`. Also fix stale RELEASE.md manifest URLs (still
   `per-simmons/damon-ade`, mac/linux only).
2. **Code signing — a decision, not just a task.** Unsigned NSIS means SmartScreen "unknown
   publisher" forever, and unsigned updates are the weak link once auto-update is on.
   Cheapest viable path: Azure Trusted Signing (~$10/mo, works with electron-builder's
   `win.azureSignOptions`). If the port stays private/personal, skipping is defensible —
   but do it before any wider release.

## Phase 4 — Windows test coverage (≈1 day, the diagnostic one)

Windows CI (`windows-ci.yml`) runs only 5 hand-picked test files; the full desktop suite never
runs on Windows because `reconcile-timeout.test.ts` (terminal suite) hangs under bun on
Windows runners — worked around by exclusion (commit `8fe55c0`), never diagnosed.

1. Root-cause the hang (likely ConPTY teardown + bun test runner interaction, same family as
   the exit-code corruption CI already routes around with marker files).
2. Widen the Windows unit run to the full suite minus an explicit, commented skip-list —
   inverse of today's allow-list, so new tests run on Windows by default.
3. Deepen the packaged smoke test: today it's "natives load" + "alive after 20s". Add one
   real assertion of app health (tRPC/IPC ping or spawning an actual terminal session and
   seeing shell output) so a broken-but-running build fails CI.

## Phase 5 — Runtime hardening (small items, as-touched)

From the fragile list, in value order:

1. **macOS-authored `.superset/config.json` setup/teardown commands fail under
   PowerShell/cmd** (`setup.ts:44`, `teardown.ts:45-56`) — the highest real-world friction
   for repos brought over from a Mac. Minimum fix: detect obviously-POSIX commands
   (`./…`, `sh`, `chmod`, `&&` under cmd) on win32 and surface a clear warning naming the
   command. Optional later: per-platform keys (`setup.win`).
2. **Window-control polish**: caption buttons are 32×32 rounded instead of Windows-standard
   46×32, and the maximize button never switches to a restore glyph
   (`WindowControls.tsx:26-42`). Small, makes it feel native.
3. **PATH-shadowing of the shim dir**: agent interception relies on BIN_DIR being prepended
   in `getShellEnv` (`shell-wrappers.ts:189-201`); a user PowerShell profile that rewrites
   PATH silently bypasses memory/hooks. Cheap guard: after spawn, verify the resolved
   `claude` is the shim and warn if not.

Skipped deliberately (YAGNI): win32 ENOENT PATH-recovery retry parity (`shell-env.ts:162` is
darwin-only, but Windows has no GUI-minimal-PATH problem); MAX_PATH guards (Win11 long paths).

## Phase 6 — Upstream tracking (≈1 hour, prevents future pain)

The fork is 13 commits with no `upstream` remote and no documented merge strategy. Add
`upstream = per-simmons/damon-ade`, document the rebase/cherry-pick workflow (the Windows
work is well-isolated: mostly `apps/desktop` scripts + platform-gated branches, so rebases
should be clean), and optionally a weekly CI job that reports divergence count.

## Release tooling (fold into whichever phase touches it first)

`create-release.sh` / `release-canary.sh` are bash+gh+jq — not runnable from native Windows
shells. Don't rewrite them; they run fine from Git Bash (already a de-facto prerequisite).
Just document that in RELEASE.md. Rewrite only if a native-Windows release flow becomes a
real need.

---

## What NOT to do

- Don't re-port anything in the terminal/PTY/shim layer — the adversarial-review pass
  (`0b59a28`) already caught the subtle bugs (TOML literal strings across the cmd hop,
  JSON.stringify for backslash paths, `.ps1` removal, pwsh→powershell→cmd resolution).
- Don't add a `.ps1` shim "for completeness" — its absence is a documented, correct decision
  (execution-policy hard-fail with no fallback).
- Don't touch the native staging pipeline (`prepare-win-natives.ts`, `verify-win-package.ts`)
  except to keep versions derived from node_modules as it already does — it's the strongest
  part of the port.

## Suggested order

Phase 1 → 2 → 3.1 (auto-update) → 6 → 4 → 5, with 3.2 (signing) whenever the
public/private decision is made. Phases 1+2+6 together are roughly one focused day and
remove nearly all first-contact friction.
