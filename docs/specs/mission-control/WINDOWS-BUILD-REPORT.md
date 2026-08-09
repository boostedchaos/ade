# Mission Control on Windows — build report

Date: 2026-08-09 · Branch: `windows-0.4` (target release tag `windows-v0.4.0`) ·
Base: `081fe26` (main @ `0.4.0`, mac-v0.4.0 already merged) · Final code SHA
(phases 0–4): `12dbcf5` · Phase-5 docs: this commit · Orchestration: Fable
architect + Opus executors; Codex CLI cross-check; adversarial verifier before
ship.

The macOS 0.4.0 build shipped Mission Control from the shared `main`. This build
is **platform-gap work + release for Windows**, not commit porting — the feature
code already lives on `main`. Each phase closes a Windows-specific gap or a
Windows CI failure.

## What shipped, per phase

### Phase 0 — server-core CRLF skill reader (`f5bf132`)

The newer "ADE CI" workflow failed on `windows-latest` only: one server-core
test, `readAdeWorkspaceSkill`, reading the bundled `ade-workspace` skill.

**Root cause (proven locally):** the reader compared/served the skill file with
its on-disk line endings. On Windows the checked-out file has CRLF, so the read
content did not match the LF-normalized expectation. Fix normalizes CRLF → LF in
the reader. Proven by forcing CRLF on the fixture locally and watching the test
flip red→green with the fix.

### Phase 1 — Windows taskbar attention badge (`f33d5ef`)

macOS renders unread attention counts on the Dock (`app.dock.setBadge`, guarded
`PLATFORM.IS_MAC` in `apps/desktop/src/main/windows/main.ts`). Windows had
nothing.

Added a Windows overlay path in the same `setAttentionDeps` block:
`setOverlayBadge(count)` builds a red-disc overlay PNG (`overlay-badge.ts`,
counts 1–9 and `9+`) and calls `window.setOverlayIcon(image, description)`;
cleared to `setOverlayIcon(null, "")` at zero. `flashAttention()` calls
`window.flashFrame(true)` when a new attention arrives and the window is not
focused (Electron auto-clears on focus). Both are `PLATFORM.IS_WINDOWS`-gated and
`window.isDestroyed()`-guarded; macOS Dock path unchanged.

### Phase 2 — real `ade cli install` on Windows (`08397eb`)

`ade cli install` previously refused Windows. Implemented the Windows path in
`packages/cli/src/commands/cli-install.ts` (`runWinInstall`): adds `~/.ade\bin`
(where the app writes `ade.cmd` on boot) to the user PATH in
`HKCU\Environment\Path`, via the `Microsoft.Win32.Registry` .NET API.

Correctness details that the code exists to get right:

- Reads with `DoNotExpandEnvironmentNames` and writes back with the value's
  **original kind** (`REG_EXPAND_SZ` vs `REG_SZ`), so unexpanded `%VAR%` entries
  are preserved and PATH is never flipped to a fully-expanded `REG_SZ`.
- Never `setx` (truncates PATH at 1024 chars); writes the registry value
  directly.
- Idempotent — re-running detects the existing literal entry (case-insensitive,
  trailing-separator tolerant) and no-ops.
- Broadcasts `WM_SETTINGCHANGE` (via a throwaway `[Environment]::Set...` User-var
  round-trip) so new shells pick it up; help documents the manual removal path.
- Also platform-gated the mac-only cli tests so the cli suite is 0-fail on
  Windows; changed a `/tmp/shot.png` help example to `./shot.png`.

### Phase 3 — token-file ACL hardening + DACL spike (`12dbcf5`)

Hardened the control token at write time: on win32, `icacls <file>
/inheritance:r /grant:r <user>:F` (best-effort) so only the owner can read
`~/.ade\control.token`. Added a win32 token test. Comments at both pipe listen
sites record the ruling: the pipe uses the **default DACL** (other accounts get
read-only), never `readableAll`/`writableAll`.

**DACL spike verdict:** Node exposes no API to restrict a *listener* pipe's DACL
(`nodejs/node#47086`, closed not-planned). Residual risk is **read-only
observation** by another local account — it cannot inject commands. Follow-up
filed as [issue #8](https://github.com/boostedchaos/ade/issues/8). The timeboxed
spike's compensating control is the token ACL above; no unsafe pipe flags used.

### Phase 4 — CI hardening

(Wired via draft PR #7 as the CI vehicle — control-plane + cli suites into the
Windows CI, packaged named-pipe `ade list-workspaces` smoke.) TODO: final
`windows-ci` / "ADE CI" run IDs + URLs — **orchestrator fills before ship.**

### Phase 5 — verification polish, docs, release notes (this phase)

- **Hook smoke (live, isolated).** Rendered the real Windows notify template
  (`packages/server-core/src/agent-setup/templates/notify-hook.template.mjs`,
  the file `notify-hook.ts` selects on `IS_WINDOWS` and writes as `notify.mjs`)
  exactly as `getNotifyScriptContent()` does, into a throwaway temp dir, and
  fired it the way Claude Code does — `node notify.mjs` (and `bun notify.mjs`)
  with the Notification JSON on stdin, `SUPERSET_*` env pointed at a throwaway
  HTTP server on an ephemeral port (NOT Kyle's ADE; `SUPERSET_WORKSPACE_NAME`
  scrubbed). **Result: PASS under both node and bun** — the hook dispatched
  `GET /hook/complete?…` (status 200) with `eventType=Notification` and every
  param (paneId/tabId/workspaceId/sessionId/message) propagated, and the
  JSON-escaped Windows `transcript_path` correctly un-escaped from `\\` to `\`.
  What remains for Kyle's UAT: the **visual** ring/overlay-badge/flash on the
  running app (not machine-verifiable headlessly).
- **Bun dependency check.** The launcher templates
  (`buildAdeBinScript` / `buildAdeBinCmd` in
  `packages/server-core/src/agent-setup/ade-cli-bin.ts`) **already** guard for a
  missing bun: POSIX `command -v bun`, Windows `where bun` → both print
  `ade: bun is required to run the ADE CLI and is not on PATH` and exit 2. No
  cryptic failure; no code change needed — documented the requirement in
  `WINDOWS.md` instead.
- **Docs:** new `WINDOWS.md` at repo root (referenced by
  `docs/releasing-windows.md`); `docs/mission-control.md` updated (Windows `cli
  install` supported + restart-shell note; taskbar overlay + flash in the badge
  section); `CHANGELOG.md` 0.4.0 entry linked to `windows-v0.4.0` with a Windows
  subsection; this report.

## Ship gates — results and the commands that produced them

### Suite baselines (each from its package cwd, pinned tsc by exit code)

- **desktop** — ratchet vs the Windows baseline: **61 fail vs baseline 79 = no
  new failures** (fewer, in fact). Judge by the diff, not the absolute count.
- **control-plane** — 193 pass / 82 skip / **0 fail**.
- **cli** — 198 pass / 91 skip / **0 fail** (was 17-fail before phase 2
  platform-gated the mac-only tests).
- **server-core** — 474 pass / 20 skip / **0 fail** (phase 0 fixed the
  `readAdeWorkspaceSkill` Windows failure).

TODO (orchestrator): paste the exact final `bun test` tails + pinned-tsc exit
codes for any package touched after this report, and confirm the desktop ratchet
against the same baseline commit.

### Gotchas proven along the way (durable)

- **`-EncodedCommand` stdout gotcha.** Windows PowerShell silently drops a
  multi-line script's stdout when piped to `-Command -`; the cli-install code
  encodes the whole script as UTF-16LE base64 via `-EncodedCommand` and passes
  dynamic values through `env` (read as `$env:…`), never string-interpolated.
- **bun `os.userInfo()` "unknown" gotcha.** Under bun on this box `os.userInfo()`
  can return `unknown` for the username; the icacls grant must resolve the real
  account rather than trusting that value blindly.
- **Live registry round-trip is byte-identical.** `ade cli install` read the real
  `HKCU\Environment\Path`, appended, wrote back, and a re-read restored the
  original bytes exactly (kind preserved) on removal — verified on this machine.
- **Live icacls evidence.** After hardening, the token file's inherited
  `CodexSandboxUsers` ACE was stripped (`/inheritance:r`), leaving only the
  owner's full-control ACE.

## Divergences from a naive port

- Feature code was NOT re-ported — mac-v0.4.0 already merged Mission Control to
  `main`; this build only adds the Windows-specific surface (overlay badge,
  Windows `cli install`, token ACL) and fixes Windows-only CI failures.
- No pipe-DACL restriction (impossible in Node per #47086) — compensated by
  token ACL + read-only default DACL; residual risk documented (#8).

## Deliberately NOT changed

- **`ade claude-teams` stays macOS-only** (exits 2 on Windows) — the tmux shim
  port is deferred by decision.
- macOS behavior untouched: the Dock badge path, the POSIX launcher, and every
  mac-gated branch are unchanged; the Windows overlay/flash is purely additive.
- Kyle's running ADE install and real data dirs (`~/.ade`, `~/.ade-default`,
  `~/.ade-Mabel`) — untouched by the hook smoke (throwaway temp dir + ephemeral
  port + scrubbed `SUPERSET_WORKSPACE_NAME`).
- Auto-update stays disabled; `latest.yml` is not published (see
  `docs/releasing-windows.md`).

## TODO slots — orchestrator fills before ship

- **Codex review round findings:** *(codex exec read-only pass after phases 1–5;
  list findings + resolutions)*
- **Adversarial verifier verdict:** *(fresh reviewer at xhigh over the full diff)*
- **Final CI run IDs/URLs:** *(windows-ci "ground truth" + "ADE CI" green on the
  release SHA)*
- **Release URL:** *(published `windows-v0.4.0` release + SHA256SUMS.txt)*

## Open follow-ups

- **Issue #6** — the detached terminal-host daemon can outlive the app across an
  upgrade (runs from the old bundle path); new terminals fail until it is
  killed. Documented in `WINDOWS.md` (quit app → kill `terminal-host.js` →
  relaunch).
- **Issue #8** — pipe DACL read-only-observation residual risk.
- Kyle's UAT (install replaces the running ADE): visual ring/overlay-badge/flash;
  `ade cli install` from a fresh terminal → `ade list-workspaces` answers.
