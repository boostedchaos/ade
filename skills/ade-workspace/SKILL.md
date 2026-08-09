---
name: ade-workspace
description: Drive the ADE window you are running inside via the `ade` CLI.
---

# Working inside an ADE pane

You are running in a terminal pane of ADE. The `ade` command talks to the
running app over a local socket, so you can open panes, read other panes, and
tell the human when you need them — without leaving your terminal.

`ade` is already on your PATH. If it exits `3`, the app is not running and
nothing here will work; do not try to launch it.

## Do not steal focus

The single most useful pattern, and the one to copy verbatim:

```sh
ade new-pane --type browser --direction right --url https://localhost:3000 --focus false
```

That splits a browser pane in beside you and leaves the human's cursor where it
was. **Always pass `--focus false`** unless you were asked to bring something to
the front — a pane that grabs focus mid-sentence is the fastest way to be
unwelcome.

## Naming a pane

Every command that takes a target accepts three forms:

| Form | Means |
|---|---|
| `focused` | whatever the human is looking at right now |
| `pane:2` | 2nd pane in the focused tab, counting as it looks on screen |
| a UUID | exactly that pane, from `ade list-panes` |

Positions are resolved when the command runs, so `pane:2` can mean a different
pane a second later. Use the UUID when you are coming back to something.

Your own pane id is in `$ADE_SURFACE_ID`.

## Panes

```sh
ade list-panes                                  # what exists, with ids and status
ade new-pane --type terminal --direction down   # split a terminal below you
ade new-pane --type file-viewer --path src/x.ts --direction right --focus false
ade close-pane <pane>
ade focus-pane <pane>                           # only when asked
```

## Talking to another pane

```sh
ade send <pane> "npm test" --enter    # type into it
ade send-key <pane> C-c               # Enter, Escape, C-c, Up, …
ade read-screen <pane> --lines 40     # what is on screen now
ade capture-pane <pane>               # full scrollback
```

Read before you send. A pane sitting at a prompt and a pane halfway through an
interactive installer look identical until you look.

## Reporting your own state

```sh
ade set-status $ADE_SURFACE_ID needsInput   # you are blocked on the human
ade set-status $ADE_SURFACE_ID working
ade set-progress $ADE_SURFACE_ID 60         # 0-100
ade set-progress $ADE_SURFACE_ID clear
```

`needsInput` lights a ring on your pane and badges the tab, so use it when you
genuinely cannot continue — not to announce progress. Progress clears itself
when you go idle.

Claude Code panes report status automatically through hooks; you only need
`set-status` if you are some other agent, or if you are blocked on something no
hook can see.

## Getting attention

```sh
ade notify --title "Migration finished" --body "42 rows changed"
ade list-notifications --unread
ade jump-to-unread                          # human-facing: cycles to the next asking pane
```

`notify` defaults to your own pane. It shows the human a real OS notification,
so spend them.

## Todos

Per-workspace, shared with anyone else working in it.

```sh
ade todo add --workspace focused "Backfill the citations"
ade todo list --workspace focused --state pending
ade todo start <id>
ade todo done <id>
ade todo rm <id>
```

## Browser panes

Only acts on the one pane you name — there is no run-everywhere form.

```sh
ade browser open --url https://example.com --direction right --focus false
ade browser navigate --pane <pane> --url https://example.com/login
ade browser click --pane <pane> --selector "button[type=submit]"
ade browser type --pane <pane> --selector "#email" --text "a@b.c"
ade browser fill --pane <pane> --fields '{"#email":"a@b.c","#pw":"hunter2"}'
ade browser screenshot --pane <pane>        # prints the PNG path it wrote
```

Selectors are plain CSS and a miss is an error naming the selector, not a
silent no-op. There is **no CDP and no cookie import** — if you need a real
browser-automation harness, say so rather than working around it here.

## Seeing what other agents are doing

```sh
ade agent-sessions        # every pane with an agent, its state and progress
ade events                # live stream: panes, agent states, notifications
```

## Exit codes

`0` ok · `1` the command failed · `2` bad usage or unsupported here · `3` ADE
is not running.
