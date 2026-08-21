# Phase 0 findings — 2026-08-21

Ran against `@agentclientprotocol/claude-agent-acp@0.63.0` +
`@agentclientprotocol/sdk@1.3.0`, macOS, Kyle's own Claude Code login, in a
throwaway git workspace.

## Verdict: PASS. Build the pane.

Every one of the three Agent Canvas deal-breakers is present in the protocol
stream. They were that product's UI gaps, exactly as the plan predicted.

### 1. Custom skills — present

`available_commands_update` reported **101 commands** on a bare run, including
`wrap-up`, `fable-orchestration`, `storm-research` and `triad`.

### 2. Model list — present, and it includes Fable

`session/new` returns `configOptions` with a `model` select whose options are
`default`, `opus[1m]`, **`claude-fable-5[1m]` (labelled "Fable")**, `sonnet`,
`haiku`. Agent Canvas hardcoded a five-item list of its own and simply omitted
this one; the adapter reports it.

### 3. Effort — present, full range

An `effort` select (`category: thought_level`) with `default`, `low`, `medium`,
`high`, `xhigh`, `max`. Current value `medium`, matching `~/.claude/settings.json`.

Also reported and worth rendering: a `mode` select (all six permission modes) and
a `fast` mode select.

## Live switching works — verified independently

`session/set_config_option` changed model to `claude-fable-5[1m]` and effort to
`high` mid-session. Confirmed **not** by the call's own reply but by a separate
`session/resume`, which returned both new values.

## Two findings that change Phase 4

1. **An invalid model id is ACCEPTED and silently downgrades to `default`.**
   Setting `model = "totally-not-a-model"` returned success, and an independent
   `session/resume` then read back `model=default`. No error at any point. So the
   pane MUST validate a typed id against the reported option list, and MUST read
   the value back — a green write here means nothing.
2. **`config_option_update` did not arrive during a normal prompt turn**, so the
   pane cannot rely on notifications alone to know the current values. The
   reliable read-back path is `session/resume`, which returns `configOptions`.

## Controls run (so "it passed" means something)

- **Negative:** pointing `CLAUDE_CONFIG_DIR` at an empty directory made the run
  fail loudly with an RPC error. It did not quietly report an empty command list.
- **Positive:** a planted `phase0-canary` skill in the workspace appeared in the
  next capture, and the count moved 101 -> 103 (the canary plus one MCP-provided
  command that connected on that run). So the list tracks reality rather than
  being canned.
- One earlier "control" was **invalid and caught**: it re-read the previous run's
  evidence file and reprinted the old result. Fixed by writing each run to its own
  file. Recorded because a stale checker is indistinguishable from a passing one.
- The first read-back attempt reported `model=default` and looked like a failure.
  Cause was self-inflicted: the bogus-id control ran before the read-back and had
  reset the value. Re-ordered, then re-confirmed.

## Notes for Phase 1

- Adapter defaults to `permissionMode: bypassPermissions`, which already matches
  the auto-approve decision. It warns that `canUseTool` is then never consulted —
  so the permission-prompt toggle must switch the MODE, not just the callback.
- `session/list` returns only `sessionId`, `cwd`, `title`, `updatedAt` — no config
  state. Use `session/resume` when the pane needs current values.
- The client surface really is five methods; `probe.mjs` implements all of them in
  under 100 lines.
