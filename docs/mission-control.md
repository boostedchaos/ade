# Mission Control

Mission Control is a command line for the ADE app. You type `ade …` in any
terminal and the running app does it — opens panes, reads screens, moves focus.
Agents running inside ADE can call the same commands, so they can show you
things and tell you when they need you.

Nothing here leaves your machine. `ade` talks to the app over a local socket.

## Get `ade` in your terminal

Agents already have it. Every terminal pane ADE starts has `ade` on its PATH —
you do not have to do anything for that.

For your own shell, run this once:

```sh
ade cli install
```

It puts a link to `ade` in `/usr/local/bin` (or `~/.local/bin` if that is not
writable). Safe to re-run. Windows is not supported yet.

If a command prints `ADE app is not running (no control socket)`, open the ADE
app and try again. `ade` never launches the app for you.

## The five things you will actually do

### 1. See which agent needs you

When an agent asks permission, its pane gets a glowing ring, and the count goes
up on the tab, the workspace rail, and the Dock icon. Click the ring, or jump
there from anywhere:

```sh
ade jump-to-unread
```

Run it again to cycle to the next one. It wraps around at the end.

To see the same thing as a list:

```sh
ade list-notifications --unread
```

The panel and the badges clear on their own when the agent stops waiting.

An agent without hooks can raise the ring by hand:

```sh
ade set-status needsInput
```

### 2. Drive panes from a terminal

Split a new terminal below the one you are in:

```sh
ade new-pane --direction down
```

Open a browser pane on the right **without stealing your cursor**:

```sh
ade new-pane --type browser --direction right --url http://localhost:3000 --focus false
```

`--focus false` is the polite default for anything an agent opens.

See what exists, then read one:

```sh
ade list-panes
ade read-screen pane:2 --lines 40
```

Type into a pane. Text is sent exactly as written and does **not** press Enter
unless you say so:

```sh
ade send pane:2 "bun test" --enter
ade send-key pane:2 C-c
```

**About `pane:2`.** Targets can be a UUID, a position like `pane:2`, or the word
`focused`. Positions are counted at the moment the command runs, so `pane:2` can
mean a different pane a second later. Positions always count inside whatever is
focused right now: `tab:2` means the 2nd tab of the focused workspace, `pane:2`
the 2nd pane of the focused tab. To touch something outside the focused
workspace, use the UUID that `list-tabs` and `list-panes` print.

### 3. Keep a todo list per workspace

```sh
ade todo add "fix the badge counter"
ade todo list
ade todo start <id>
ade todo done <id>
```

The list belongs to the focused workspace and survives restarts. `start` and
`done` need the todo's id from `ade todo list`, not a position.

### 4. Drive a browser pane

Open one, then click and type in it:

```sh
ade browser open --url https://example.com --focus false
ade browser click --pane pane:2 --selector "#login"
ade browser fill --pane pane:2 --fields '{"#user":"kyle","#pw":"hunter2"}'
ade browser screenshot --pane pane:2 --path /tmp/shot.png
```

`fill` stops at the first field it cannot find and tells you how many it filled,
so a half-filled form never looks like a success. `screenshot` writes a PNG and
prints the path.

### 5. Agent teams — EXPERIMENTAL

```sh
ade claude-teams
```

This launches Claude Code so its teammate agents appear as real ADE panes you
can watch. It is marked experimental because agent teams is an undocumented
Claude Code feature behind a server-side switch Anthropic controls — a teammate
may simply never show up, and that is not a bug on this side.

It needs a real terminal window. Claude Code silently falls back to in-app
teammates when its output is not a TTY, so run it from a terminal pane, not from
a script. macOS only for now; Windows exits with code 2.

## Command reference

Run `ade <command> --help` for the flags. Add `--json` to any command to get the
raw result instead of a table.

**Panes and layout**

| Command | What it does |
|---|---|
| `new-pane` | Create a pane next to an existing one |
| `new-split` | Split a pane, putting the new one in the freed space |
| `split-off` | Move a pane out of its split into its own tab |
| `focus-pane` | Focus a pane |
| `move-pane` | Move a pane into another tab |
| `close-pane` | Close a pane |
| `list-panes` | List panes |

**Tabs and workspaces**

| Command | What it does |
|---|---|
| `new-tab` | Create a tab |
| `list-tabs` | List tabs |
| `new-workspace` | Create a workspace for a project |
| `list-workspaces` | List workspaces |
| `focus-workspace` | Focus a workspace |

**Terminal input and output**

| Command | What it does |
|---|---|
| `send` | Type text into a terminal pane |
| `send-key` | Send a named key (`Enter`, `C-c`, `Up`, …) |
| `read-screen` | Read what is visible in a terminal pane |
| `capture-pane` | Capture a pane's whole scrollback |

**Agent status**

| Command | What it does |
|---|---|
| `agent-sessions` | List tracked agent sessions, one per terminal pane |
| `set-status` | Report a pane as `working`, `needsInput`, or `idle` |
| `set-progress` | Set or clear a pane's progress bar |
| `hooks` | Wire up ADE's Claude Code hooks (`hooks setup claude`, `hooks status`) |
| `agent-event` | Report a hook event — called by the hooks, not by you |

**Todos**

| Command | What it does |
|---|---|
| `todo` | Workspace todos: `add`, `list`, `start`, `done`, `rm` |

**Browser panes**

| Command | What it does |
|---|---|
| `browser` | Drive a browser pane: `open`, `navigate`, `click`, `type`, `fill`, `screenshot`, `info`, `capabilities` |

**Notifications**

| Command | What it does |
|---|---|
| `notify` | Raise a notification, optionally about a pane |
| `list-notifications` | List notifications, newest first |
| `mark-notification-read` | Mark one read, or `--all` |
| `jump-to-unread` | Focus the next pane waiting on you |

**Events**

| Command | What it does |
|---|---|
| `events` | Stream what happens in the app as one JSON object per line |

**Other**

| Command | What it does |
|---|---|
| `cli` | Manage the `ade` bin itself (`cli install`) |
| `claude-teams` | EXPERIMENTAL: launch Claude Code with agent teams as ADE panes |
| `tmux-compat` | Internal — the shim `claude-teams` points a fake `tmux` at |

**Exit codes:** `0` worked · `1` the command failed · `2` bad usage or
unsupported platform · `3` the ADE app is not running.

## Known limitations

**Reading a dead pane gives you history, not the screen.** `read-screen` and
`capture-pane` return a `source` field. On a live pane it says `live-screen` —
what is really on screen right now. On a pane whose process has exited it says
`scrollback-history`, which is the saved text and can differ from the last frame
a full-screen program drew. Check the `source` field when the answer matters.

**Browser panes are not a full browser automation tool.** There is no Chrome
DevTools Protocol attachment and no way to import cookies or a profile, so you
cannot hand it a logged-in session. Every verb acts on exactly one named pane —
no fan-out.

**`ade claude-teams` is experimental and macOS-only.** Agent teams is
undocumented and behind a server-side kill switch Anthropic can flip, so
teammates may never spawn even when the command itself works. It also needs a
real TTY. Windows exits with code 2.

**A plain `claude` session will not find the `ade-workspace` skill on its own.**
ADE installs the skill to `~/.ade/skills/ade-workspace/SKILL.md` and copies it
into each ADE-managed agent, where that agent's `CLAUDE.md` points at it. Claude
Code discovers skills from `~/.claude/skills` and `<project>/.claude/skills`, and
ADE deliberately never writes into your Claude config. So in an ordinary
workspace terminal the file is on disk but nothing tells Claude to read it —
point it at the path yourself if you want it.
