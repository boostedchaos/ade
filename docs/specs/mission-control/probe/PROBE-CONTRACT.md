# Phase-0 probe: the tmux contract `tmux-compat` must satisfy

Captured 2026-08-09 against **Claude Code 2.1.226**.

- Real binary: `/Users/kylewelch/.local/share/claude/versions/2.1.226`
  (Mach-O arm64, 279,661,952 bytes). `/Users/kylewelch/.local/bin/claude` is a
  symlink to it; `/Users/kylewelch/.ade-default/bin/claude` is the ADE
  `agent-wrapper v2` shim, which resolves the same binary and injects
  `--settings`. The probe invoked the resolved binary directly so the ADE
  settings/hooks could not perturb the result.
- Raw evidence: [`tmux-calls.log`](tmux-calls.log) (two runs).
- Reproduction harness: [`fake-tmux.py`](fake-tmux.py) (the logging fake) and
  [`drive-probe.py`](drive-probe.py) (the PTY driver).

**This is a REAL captured contract, not a FALLBACK.** The flag is live and every
verb below was observed being executed by Claude Code 2.1.226.

---

## 1. Is the flag live in 2.1.226?

**Yes — confirmed both statically and dynamically.**

### Static evidence

`grep -oa` over the resolved binary, with `ANTHROPIC_API_KEY` as a known-real
control string to prove the grep fires:

| String | Occurrences |
| --- | --- |
| `ANTHROPIC_API_KEY` (control) | 178 |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | 9 |
| `CLAUDE_CODE_TEAMMATE_COMMAND` | 2 |
| `CLAUDE_CODE_TEAM_TEARDOWN_PARK_TIMEOUT_MS` | 3 |

The binary embeds its bundled JavaScript, so the actual `TmuxBackend`
implementation is readable in full rather than merely inferable from strings.
The gate is:

```js
function vu(){                                    // isAgentSwarmsEnabled
  if(!te.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS && !process.argv.includes("--agent-teams")) return false;
  if(!nt("tengu_amber_flint", true)) return false;   // server-side feature gate, defaults true
  return true;
}
```

Two ways to enable it: the env var, or the undocumented `--agent-teams` CLI
flag. A server-side gate named `tengu_amber_flint` can switch it off remotely;
it defaults to `true` and was on for this account.

### Dynamic evidence

A logging fake `tmux` was placed first on `PATH` and Claude Code was asked to
spawn a teammate. It executed the full pane-creation sequence against the fake
— see `tmux-calls.log`.

### Two gotchas that make the flag look dead when it is not

Both cost a probe run each; `tmux-compat` testing will hit them too.

1. **Headless `-p` can never use tmux.** `isInProcessEnabled()` short-circuits
   on a non-interactive session before any backend selection happens:

   ```js
   function NEn(){ if(Ln()) { E("[BackendRegistry] isInProcessEnabled: true (non-interactive session)"); return true; } ... }
   ```

   The probe must drive a **real PTY**. A first attempt with `claude -p` produced
   zero teammate tmux calls and an in-process agent — a false negative.
2. **The default teammate mode is `in-process`, not `auto`.**
   `DEFAULT_TEAMMATE_MODE = "in-process"`. Enabling the env var alone still
   yields in-process teammates. Force panes with the (hidden) CLI flag
   `--teammate-mode <tmux|iterm2|in-process|auto>`, or the `teammateMode`
   setting key. The debug log confirms it took:
   `[TeammateModeSnapshot] Captured from CLI override: tmux`.

---

## 2. Vocabulary observed

Ten distinct subcommands across the teammate lifecycle, plus three
terminal-detection calls that are unrelated to agent teams but will hit the shim
anyway. **Every call is a one-shot `execFile("tmux", argv)` — Claude Code never
runs a persistent tmux client, never uses control mode (`-CC`) for teams, and
never writes to tmux's stdin.**

### 2.1 Socket addressing — the shim must handle both

Two distinct wrappers decide the socket flags, and which one is used depends on
whether the *leader* is itself inside tmux:

```js
function _be(e){ let t = getUserTmuxSocket(); return In("tmux", t ? ["-S", t, ...e] : e); }   // leader inside tmux
function mpe(e){ return In("tmux", ["-L", `claude-swarm-${process.pid}`, ...e]); }            // external swarm session
```

- **Leader inside tmux** (`$TMUX` set): `-S <path>`, where the path is the first
  comma-separated field of `$TMUX`. Observed: `-S /fake-socket` from
  `TMUX=/fake-socket,0,0`.
- **Leader not inside tmux**: `-L claude-swarm-<leader_pid>` — a private named
  socket, so the swarm never lands in the user's default tmux server. Observed:
  `-L claude-swarm-87807`.

A third form exists in a *separate* code path (`f7b`, the non-splitpane spawn)
that passes **no socket flags at all** and talks to the default server.

### 2.2 The terminal-detection calls (fire at startup, before any teammate)

| argv | Expected reply |
| --- | --- |
| `['-V']` | version banner, e.g. `tmux 3.5a`; exit 0 = "tmux available" |
| `['display-message', '-p', '-t', '%0', '#{session_name}:#{window_id}.#{pane_id}']` | one line |
| `['show', '-Av', 'mouse']` | option value |
| `['show', '-gv', 'focus-events']` | option value |
| `['show-environment', '-g', 'CLAUDE_CODE_CHILD_SESSION']` | value or exit 1 |

Note the last three use the `show` / `show-environment` aliases, not
`show-options`, and `-A` / `-g` / `-v` short flags.

### 2.3 The teammate lifecycle — RUN A, leader inside tmux

Exact argv, in the exact order observed:

```
tmux -S /fake-socket display-message -t %0 -p '#{window_id}'
tmux -S /fake-socket list-panes -t @0 -F '#{pane_id}'
tmux -S /fake-socket split-window -d -t %0 -h -l 70% -P -F '#{pane_id}' -- cat
tmux -S /fake-socket set-option -p -t %1 window-style 'bg=default,fg=blue'
tmux -S /fake-socket set-option -p -t %1 pane-border-style 'fg=blue'
tmux -S /fake-socket set-option -p -t %1 pane-active-border-style 'fg=blue'
tmux -S /fake-socket select-pane -t %1 -T helper
tmux -S /fake-socket set-option -p -t %1 pane-border-format '#[fg=blue,bold] #{pane_title} #[default]'
tmux -S /fake-socket list-panes -t @0 -F '#{pane_id}'
tmux -S /fake-socket set-option -w -t @0 pane-border-status top
tmux -S /fake-socket set-option -p -t %1 remain-on-exit failed
tmux -S /fake-socket respawn-pane -k -t %1 -- 'cd <cwd> && env <ENV> <claude-binary> <agent flags>'
...
tmux -S /fake-socket kill-pane -t %1                       (teardown, ~290 s later)
```

`display-message` here reads the **leader's own pane id** from `$TMUX_PANE`
first and only shells out when that is absent; the `#{window_id}` lookup is
always a subprocess and its result is cached for the session
(`cachedLeaderWindowTarget`).

### 2.4 The teammate lifecycle — RUN B, leader NOT inside tmux

```
tmux -V
tmux -L claude-swarm-87807 has-session -t claude-swarm
tmux -L claude-swarm-87807 new-session -d -s claude-swarm -n swarm-view -P -F '#{pane_id}' -- cat
tmux -L claude-swarm-87807 list-panes -t claude-swarm:swarm-view -F '#{pane_id}'
tmux -L claude-swarm-87807 set-option -w -t claude-swarm:swarm-view pane-border-status top
tmux -L claude-swarm-87807 set-option -p -t %1 window-style 'bg=default,fg=blue'
tmux -L claude-swarm-87807 set-option -p -t %1 pane-border-style 'fg=blue'
tmux -L claude-swarm-87807 set-option -p -t %1 pane-active-border-style 'fg=blue'
tmux -L claude-swarm-87807 select-pane -t %1 -T helper
tmux -L claude-swarm-87807 set-option -p -t %1 pane-border-format '#[fg=blue,bold] #{pane_title} #[default]'
tmux -L claude-swarm-87807 list-panes -t claude-swarm:swarm-view -F '#{pane_id}'
tmux -L claude-swarm-87807 set-option -p -t %1 remain-on-exit failed
tmux -L claude-swarm-87807 respawn-pane -k -t %1 -- 'cd <cwd> && env <ENV> <claude-binary> <agent flags>'
...
tmux -L claude-swarm-87807 kill-pane -t %1
```

`has-session` returning **non-zero** is what triggers session creation. A shim
that returns 0 unconditionally will make Claude Code skip `new-session` and then
target a session that does not exist.

### 2.5 Verbs present in the code but not exercised by this probe

Reachable on paths the probe did not enter; the shim should implement them.

| Verb | Path | argv shape |
| --- | --- | --- |
| `split-window` (subsequent teammates) | 2nd+ teammate | `split-window -d -t <mid-pane> {-v\|-h} -P -F '#{pane_id}' -- cat` — no `-l 70%`; `-v`/`-h` alternate by parity of the existing teammate count, and the target is the *middle* teammate pane, not the newest |
| `select-layout` | rebalance | `select-layout -t <window> main-vertical` (leader mode, >2 panes) / `select-layout -t <window> tiled` (external mode, >1 pane) |
| `resize-pane` | rebalance, leader mode | `resize-pane -t <leader-pane> -x 30%` |
| `list-windows` | external session reuse | `list-windows -t claude-swarm -F '#{window_name}'` |
| `new-window` | external session reuse, and the non-splitpane spawn | `new-window -t claude-swarm -n <name> -P -F '#{pane_id}' -- cat` |
| `has-session` / `new-session` (bare) | non-splitpane spawn (`use_splitpane: false`) | `has-session -t claude-swarm`, then `new-session -d -s claude-swarm` — **no socket flags, no `-P/-F`**; window name is `teammate-<slug>` |
| `display-message -p '#{pane_id}'` | leader pane id when `$TMUX_PANE` is unset | `display-message -p '#{pane_id}'` |

---

## 3. Format strings requested

Only four, all via `-F` on a listing/creating verb or `-p` on `display-message`:

| Format string | Requested by | Reply shape |
| --- | --- | --- |
| `#{pane_id}` | `split-window -P -F`, `new-session -P -F`, `new-window -P -F`, `list-panes -F`, `display-message -p` | `%N`, one per line for `list-panes` |
| `#{window_id}` | `display-message -t <pane> -p` | `@N`, single line |
| `#{window_name}` | `list-windows -t claude-swarm -F` | one name per line |
| `#{session_name}:#{window_id}.#{pane_id}` | startup terminal detection (not agent teams) | single line |

A fifth is **written, never read** — the pane-border template handed to
`set-option`, which tmux itself expands later:
`#[fg=<color>,bold] #{pane_title} #[default]`. The shim must store it verbatim
and not attempt to interpolate it at set time.

Parsing on Claude Code's side is uniformly `stdout.trim().split("\n").filter(Boolean)`.
A trailing newline is fine; a leading blank line is not.

Colour names come from a fixed map — `red, blue, green, yellow, magenta,
colour208, colour205, cyan` (from `purple`→`magenta`, `orange`→`colour208`,
`pink`→`colour205`).

---

## 4. stdin usage

**None.** The fake logged stdin on every invocation and no record in either run
carried a `STDIN:` line. Every payload — including the full teammate command
line — travels as **argv**, via `respawn-pane -- <command>`.

This is the single most important structural finding, and it is the opposite of
what the spec's verb list assumes:

> **`send-keys` is never used to start or drive a teammate, and `capture-pane`
> is never used at all.**

Both strings exist in the binary but belong to other features (the `--tmux`
classic launcher and the tmux `-CC` detection path). The agent-teams code sends
a command to a pane exclusively through:

```js
async function Vzo(socketFlags, target, command){
  await In("tmux", [...socketFlags, "set-option", "-p", "-t", target, "remain-on-exit", "failed"]);
  const r = await In("tmux", [...socketFlags, "respawn-pane", "-k", "-t", target, "--", command]);
  if (r.code !== 0) throw new SwarmPaneError(`Failed to send command to pane ${target}: ${r.stderr}`);
}
```

Consequences for `tmux-compat`:

- The shim needs no keystroke injection, no shell-quoting-into-a-prompt, and no
  screen scraping.
- `respawn-pane -k` must **replace** the process running in an existing pane,
  keeping the pane id stable. The pane is created running `cat` as a
  placeholder and only becomes a Claude process at respawn time.
- `remain-on-exit failed` is set immediately before each respawn: a pane whose
  command exits non-zero must stay visible rather than closing.
- Claude Code hard-rejects any command containing a Unicode `Cc` control
  character before it reaches tmux (`Refusing to send command containing control
  character U+XXXX to terminal pane`), so the shim will never receive one.

---

## 5. Ordering and lifecycle

1. **Startup.** Terminal detection runs (`-V`, `display-message`, `show`,
   `show-environment`). `-V` exiting 0 is the sole "tmux is available" test.
2. **Backend selection**, cached for the whole session after the first spawn:
   explicit `teammateMode: iterm2` → iTerm2; else inside tmux → tmux; else in
   iTerm2 → iTerm2 (or tmux fallback); else tmux available → external session
   mode; else error. Non-interactive sessions bypass all of this and go
   in-process.
3. **Spawn**, serialized by a promise chain — concurrent spawn requests are
   queued, so the shim will never see two interleaved pane-creation sequences.
   Order is fixed: resolve target → count panes → create pane running `cat` →
   colour → title → border-format → border-status → rebalance → write the
   teammate's prompt to its file inbox → `remain-on-exit` → `respawn-pane`.
4. **Rebalance** after every teammate: `main-vertical` + `resize-pane -x 30%`
   when the leader shares the window, `tiled` in the external swarm session.
5. **No polling.** Nothing in the teammate path calls `capture-pane`,
   `list-panes` on a timer, or `wait-for`. Between spawn and teardown the probe
   captured **zero** tmux calls across ~290 seconds of an agent working. Status
   flows over the team file and the message inbox, not the terminal.
6. **Teardown.** A single `kill-pane -t <pane_id>` per teammate, driven by the
   task's `AbortController`. No `kill-session`, no `kill-window` — the
   `claude-swarm` session is left running. `CLAUDE_CODE_TEAM_TEARDOWN_PARK_TIMEOUT_MS`
   (default 10,000 ms) governs the wait before that fires.

### The respawned command, verbatim

```
cd <cwd> && env CLAUDECODE=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 SSL_CERT_FILE=/etc/ssl/cert.pem \
  /Users/kylewelch/.local/share/claude/versions/2.1.226 \
  --agent-id helper@session-e36bd9ce --agent-name helper --team-name session-e36bd9ce \
  --agent-color blue --parent-session-id e36bd9ce-441c-4f75-804a-8fe27958c374 \
  --dangerously-skip-permissions --effort medium --model claude-opus-5
```

- One shell string, so the pane command is run through a shell.
- The binary is **pinned to the running version's absolute path**, not `claude`
  from `PATH` — unless `CLAUDE_CODE_TEAMMATE_COMMAND` overrides it. That
  override is the clean seam for Mission Control to interpose on teammate
  launches without touching the shim.
- `env` re-exports a curated allowlist (cloud-provider auth vars, CA-bundle
  vars); `CLAUDE_CODE_HOST_CREDS_FILE` is explicitly dropped.
- Team name defaults to `session-<short-id>`; agent id is `<name>@<team>`.
- `main` is a reserved teammate name (it routes to the main conversation).
  Names are sanitized against `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/` and
  de-duplicated with a `-2`, `-3` suffix.

---

## 6. Surprises worth carrying into the `tmux-compat` design

1. **No `send-keys`, no `capture-pane`.** The spec's verb list should be
   re-scoped: implement `respawn-pane -k` and `set-option -p remain-on-exit`
   properly and the command channel is done. Screen-scraping infrastructure is
   not needed.
2. **`respawn-pane` is the whole command channel**, and it requires stable pane
   ids across a process replacement.
3. **Panes are born running `cat`.** A shim that refuses to create a pane
   without a real command, or that reaps a pane whose command is a no-op, breaks
   the flow before the respawn.
4. **Two socket modes plus a no-socket third**, chosen by whether the leader is
   inside tmux. `-S <path>`, `-L claude-swarm-<pid>`, and bare.
5. **`has-session` must fail honestly.** Returning 0 for a session that does not
   exist skips `new-session` and strands every later call.
6. **The teammate command is argv, and it is long** (~500 bytes). Any argv
   length limit or quoting pass in the shim is a live risk.
7. **Nothing polls.** A shim can be entirely reactive; there is no keep-alive
   traffic to service.
8. **`--teammate-mode` and `--agent-teams` are hidden CLI flags** (`.hideHelp()`),
   which makes them stable enough to test against but absent from `--help`.
   Mission Control's own launcher should surface them explicitly.
9. **`tengu_amber_flint` is a server-side kill switch.** The feature can be
   disabled remotely without a version change, so `tmux-compat` must degrade
   gracefully when a spawn simply never arrives — and the launcher should stay
   marked experimental in `--help`, per the spec.
