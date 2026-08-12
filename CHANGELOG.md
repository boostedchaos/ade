# Changelog

Notable changes to Argus, which was called ADE until the rebrand landed on
`main` (2026-08-12, unreleased at the time of writing). Releases before 0.4.0
were recorded only as GitHub release notes — see the
[releases page](https://github.com/boostedchaos/ade/releases).

Every entry below still says "ADE" because that is the name those versions
shipped under. They are history and are left as written.

## Unreleased

### Changed

- **Renamed to Argus, with a full visual redesign.** The identity is one idea —
  the iris: an open ring with a pupil that is simultaneously the app mark and
  the per-agent status indicator, replacing every status dot, avatar and badge.
  - Two new themes, **Ink** (dark, now the default) and **Daylight** (light).
    Ember, monokai and one-dark stay registered as alternates. Ember keeps its
    `dark` id, so a persisted theme choice still resolves.
  - **IBM Plex Sans + Mono** bundled locally as `.woff2` (SIL OFL). Argus has
    no bold: only weights 300/400/500 are shipped, and font synthesis is off.
  - Status colors changed: `working` is now blue and `waiting on you` amber
    (they were amber and red). `review` gained its own green ring.
  - Three additive affordances, all reading signals the app already tracked:
    the rail shows WHY an agent is waiting, a blocked-session strip above the
    status bar jumps you to another agent that is blocked, and a blocked pane
    in Mission Control takes an amber ring instead of a red one.
  - `appId` is now `com.boostedchaos.argus`. **macOS treats this as a new
    application**: it will not auto-update over an existing ADE install. Install
    Argus once by hand and delete the old app. Agent data in `~/.ade` is
    untouched — it is keyed by workspace name, not by `appId`.
  - Deliberately NOT renamed: the `ade` CLI, the `ade` URL scheme, `~/.ade` on
    disk, and the `ade-server` package. Renaming any of them breaks existing
    installs and every agent skill that shells out to `ade`.

- **Codex runtime default model is now `gpt-5.6-terra` (medium reasoning)**,
  was `gpt-5.5` (high), in both launch presets in
  `packages/shared/src/agent-command.ts`. The model is a hardcoded CLI flag,
  so it overrides the user's `~/.codex/config.toml`; new
  [`docs/codex-runtime.md`](docs/codex-runtime.md) documents this, the
  interim live-install wrapper override, and the AGENTS.md pattern that
  gives Codex-runtime agents the same identity/memory/skills as
  Claude-runtime agents.

## 0.4.2 — 2026-08-11 (Windows)

### Fixed

- **Bare `ade` did not work in Windows agent panes.** ADE's panes default to Git
  Bash, and bash does not resolve `.cmd` files from a bare name — typing `ade`
  exited 127 while `ade.cmd` worked. The app now writes an extensionless
  `#!/bin/sh` launcher next to `ade.cmd` in `~/.ade\bin`, same contract and same
  staged entry, so bash panes and external Git Bash shells run plain `ade`.

## 0.4.1 — 2026-08-09 (Windows)

Two field bugs found running the packaged 0.4.0 on Windows. Both made `ade`
unusable, and both were invisible to CI, which ran the CLI straight out of a
writable checkout with `USERNAME` set — the two conditions a real install does
not have. The named-pipe smoke now reproduces both: it invokes the generated
`~/.ade\bin\ade.cmd` launcher and strips `USERNAME`/`USER` first.

### Fixed

- **`ade` from an installed build died with `EPERM`.** The launcher pointed at
  the CLI bundle inside `C:\Program Files\ADE`, and `bun` refuses to execute a
  script from a directory the user cannot write to — `error: EPERM reading …`,
  even though the file reads fine. The app now copies the bundle to
  `~/.ade\cli\index.mjs` on every boot (so upgrades refresh it) and points the
  launcher there. `ADE_CLI_ENTRY` still overrides it.
- **`ade` inside ADE's own agent panes reported "app is not running" (exit 3).**
  Agent terminals carried no `USERNAME` and no `USER`, and under `bun`
  `os.userInfo().username` answers the literal `"unknown"` instead of throwing —
  so the CLI dialled `\\.\pipe\ade-control-unknown` while the app listened on
  the pipe named for the real user. The app now injects its own user name into
  every agent terminal, and the CLI rejects `"unknown"` and falls back through
  the environment, `whoami`, and the `USERPROFILE` basename.

## 0.4.0 — 2026-08-09 ([mac-v0.4.0](https://github.com/boostedchaos/ade/releases/tag/mac-v0.4.0) · [windows-v0.4.0](https://github.com/boostedchaos/ade/releases/tag/windows-v0.4.0))

Both channels ship the same Mission Control feature set from one `main`. The
macOS release led; the Windows release adds the platform-specific pieces below.

### Added

- **`ade` command line (Mission Control).** A local command line that drives the
  running app: create, split, move, focus and close panes; type into terminals
  and read their screens; manage workspaces, tabs, todos and notifications; and
  stream app events as NDJSON. Every terminal pane ADE starts already has `ade`
  on its PATH; `ade cli install` puts it on yours. Full guide:
  [`docs/mission-control.md`](docs/mission-control.md).
- **Agent session tracking.** ADE now knows whether the agent in each terminal
  pane is working, waiting on you, or idle. It learns this from Claude Code
  hooks rather than by reading the screen, and a session stuck in `working` with
  no hook for ten minutes is re-checked against the agent's transcript and
  corrected. `ade hooks setup claude` wires it up; `ade agent-sessions` lists it.
- **Attention notifications.** The pane that needs you gets a ring, with unread
  counts on its tab, its workspace in the rail, and the Dock icon. A
  notifications panel lists them newest first, and `ade jump-to-unread` cycles
  focus through the panes that are waiting. Badges clear when the agent stops
  waiting. Agents without hooks can raise the same attention with
  `ade set-status needsInput`.
- **Workspace todos and pane progress bars.** `ade todo add|list|start|done|rm`
  keeps a per-workspace list that survives restarts, and `ade set-progress`
  draws a progress bar on an agent's pane.
- **Browser pane scripting.** `ade browser open|navigate|click|type|fill|
  screenshot|info|capabilities` drives a browser pane from the command line.
  `fill` stops at the first field it cannot find and reports how many it filled,
  so a half-filled form never reports success.
- **`ade claude-teams` — EXPERIMENTAL.** Launches Claude Code with its agent
  teams feature so teammate agents appear as real ADE panes. Agent teams is an
  undocumented Claude Code feature behind a server-side kill switch, so
  teammates may never spawn even when the command works; it also needs a real
  TTY. macOS only — Windows exits 2.
- **Bundled `ade-workspace` skill**, installed to `~/.ade/skills/` and copied
  into each ADE-managed agent, teaching agents the CLI patterns that do not
  steal your focus. Known gap: a plain `claude` session in a workspace terminal
  will not discover it, because ADE does not write into `~/.claude/`.

### Fixed

- **Packaged builds shipped without the agent hook templates.** The resource
  copy step pointed at a path the templates had moved out of, and it silently
  did nothing when the source was missing — so 0.3.0's packaged app threw while
  setting up agent hooks, which also aborted before the `ade` bin and the
  bundled skill were installed. The path is corrected and the copy step now
  fails the build loudly instead of skipping a missing source.
- Packaged builds now include the compiled `ade` CLI entry and the bundled
  `skills/` directory as app resources; without them the packaged app looked for
  a repo checkout that does not exist in a bundle, and agents got no `ade`.
- The `tmux-compat` store directory now honours the workspace suffix, so a
  suffixed workspace no longer shares state with the default one.

### Windows

- **Mission Control lands on Windows.** The `ade` command line talks to the app
  over a Windows named pipe, and every terminal pane ADE starts has `ade` on its
  PATH — the same feature set as macOS, minus `ade claude-teams` (still macOS
  only; Windows exits 2). See [`WINDOWS.md`](WINDOWS.md).
- **Attention badges on the taskbar.** macOS shows unread counts on the Dock;
  Windows shows them as a red taskbar overlay badge (`9+` past nine) and flashes
  the taskbar button when a new one arrives while the window is unfocused.
- **`ade cli install` works on Windows.** It adds `~/.ade\bin` to your user PATH
  in the registry (`HKCU\Environment`), preserving unexpanded `%VAR%` entries
  and never using `setx`. Restart your shell afterwards.
- **Token file ACL hardening.** The per-launch control token is written with
  restrictive ACLs (`icacls /inheritance:r`), so only your account can read it.
  The control pipe's default DACL grants other accounts read-only access only —
  it is not a command-injection surface ([#8](https://github.com/boostedchaos/ade/issues/8)).
- **Fixed: bundled `ade-workspace` skill read on Windows.** The skill reader now
  normalizes CRLF line endings, so the skill is served correctly on Windows CI
  and installs.
