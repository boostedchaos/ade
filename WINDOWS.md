# ADE on Windows

ADE ships a Windows 11 x64 desktop build alongside the macOS build. This page
covers what is Windows-specific: installing the unsigned build, Mission Control
on Windows, and the handful of platform gaps.

This is a fork build, not an official upstream release — see the fork notice in
[`README.md`](README.md) and [`NOTICE`](NOTICE) for the attribution chain
(a modified derivative of Superset under the Elastic License 2.0).

## Install

The installer is **unsigned** — there is no Developer ID or EV certificate on
this fork. SmartScreen will warn the first time you run it:

> **Windows protected your PC** → **More info** → **Run anyway**.

Verify the download before you run it. Every `windows-v*` release ships a
`SHA256SUMS.txt`; compute the hash and compare:

```powershell
Get-FileHash .\ADE-0.4.0-x64.exe -Algorithm SHA256
```

Match the printed hash against the matching line in `SHA256SUMS.txt`. If they
differ, do not run the file.

The release ships three artifacts: the installer (`.exe`), a portable build
(`.zip`), and `SHA256SUMS.txt`. Auto-update is intentionally disabled — grab
each new release by hand from the
[releases page](https://github.com/boostedchaos/ade/releases).

## Mission Control on Windows

Mission Control (the `ade` command line — see
[`docs/mission-control.md`](docs/mission-control.md)) works on Windows. The app
talks to `ade` over a local named pipe; nothing leaves your machine.

**Attention badges.** When an agent needs you, macOS shows a Dock badge; Windows
shows the same count as a **taskbar overlay icon** — a small red disc with the
unread count (`9+` past nine) layered on the app's taskbar button. The overlay
clears to nothing when the count returns to zero. When a *new* attention arrives
while the ADE window is not focused, the taskbar button also **flashes** to draw
your eye; the flash stops as soon as you focus the window.

### Get `ade` in your own terminal

Every terminal pane ADE starts already has `ade` on its PATH. To use it from a
terminal ADE did **not** launch (a plain PowerShell or Windows Terminal window),
run once:

```powershell
ade cli install
```

On Windows this adds `~/.ade\bin` (where the app writes `ade.cmd` on every boot)
to your **user** `PATH` in the registry (`HKCU\Environment`). It never uses
`setx` (which truncates PATH at 1024 characters) and it preserves any
unexpanded `%VAR%` entries and the value's `REG_EXPAND_SZ` kind. Safe to re-run.

**Restart your shell** (or sign out and back in) after installing — a running
shell does not see the new PATH.

**To remove it:** there is no `uninstall`. Delete the `~/.ade\bin` entry from
`Path` under **Settings → System → About → Advanced system settings →
Environment Variables → User variables**.

### The `ade` launcher requires `bun`

The generated `ade.cmd` launcher runs the CLI with [`bun`](https://bun.sh). If
`bun` is not on your PATH, every `ade` command prints:

```
ade: bun is required to run the ADE CLI and is not on PATH
```

and exits with code 2. Install `bun` and reopen your terminal. Agent terminals
ADE launches inherit whatever `bun` is on your system PATH.

The launcher runs the CLI bundle from `~/.ade\cli\index.mjs`, a copy the app
refreshes on every boot from the one inside its install directory. The copy is
not an optimisation: `bun` refuses to execute a script that lives in a directory
you cannot write to (`error: EPERM reading …`), which is exactly what
`C:\Program Files\ADE` is. Set `ADE_CLI_ENTRY` to run a different entry.

## Platform gaps

- **`ade claude-teams` is macOS-only.** On Windows it exits with code 2. Agent
  teams relies on a Unix tmux shim that has not been ported.

## Security note (local pipe + token)

`ade` reaches the app over a Windows **named pipe**, guarded two ways:

- **Per-launch token.** The app writes a random token to `~/.ade\control.token`
  and every `ade` call must present it. The token file is created with
  restrictive ACLs at write time (`icacls /inheritance:r /grant:r
  <you>:F` — best effort), so only your account can read it.
- **Pipe DACL.** The pipe is created with the default Windows DACL, under which
  other accounts get **read-only** access — they cannot write commands into it,
  so the pipe is not a command-injection surface. Node does not expose an API to
  further restrict a listener pipe's DACL
  ([nodejs/node#47086](https://github.com/nodejs/node/issues/47086), closed
  not-planned); the residual risk is read-only observation by another local
  account, tracked in
  [issue #8](https://github.com/boostedchaos/ade/issues/8). The listener is
  never opened with `readableAll`/`writableAll`.

## Upgrading

The terminal-host daemon that spawns your PTYs runs detached and can outlive the
app across an upgrade, still running from the **old** install path. If new
terminals fail to open after upgrading
([issue #6](https://github.com/boostedchaos/ade/issues/6)):

1. Quit the ADE app.
2. Kill the stray daemon — in PowerShell:

   ```powershell
   Get-Process node -ErrorAction SilentlyContinue |
     Where-Object { $_.Path -like '*terminal-host*' } | Stop-Process
   ```

   (or end `terminal-host.js` / the `node` process from Task Manager).
3. Relaunch ADE.

## Releasing (maintainers)

Windows releases are cut by hand — see
[`docs/releasing-windows.md`](docs/releasing-windows.md).
