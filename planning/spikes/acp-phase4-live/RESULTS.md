# Phase 4 live verify — REAL adapter + REAL Claude Code CLI (2026-08-21)

Run: `LV_CWD=<scratch git repo> bun live-verify.ts` against
`claude-agent-acp@0.63.0` (entry `dist/index.js` — NOT `dist/acp-agent.js`),
node from `~/.local/bin/node`, `CLAUDE_CODE_EXECUTABLE=~/.local/bin/claude`,
driving `AcpHost` from `packages/server-core/src/acp-host/` at commit 61d2882.

Verbatim output (stderr warnings elided):

```
session up: b65b9c41-b70d-4ab1-ae9a-b4db540f291a state=ready
reported models: default, opus[1m], claude-fable-5[1m], sonnet, haiku
after model->fable: seq=3 fromWire=true model=claude-fable-5[1m] effort=medium fast=undefined
after effort->high: seq=5 fromWire=true model=claude-fable-5[1m] effort=high fast=undefined
zzqqxx (no allowUnlisted): refused locally: acp-invalid-config-value: "zzqqxx" is not a declared value for "model". Legal values: default, opus[1m], claude-fable-5[1m], sonnet, haiku
zzqqxx (allowUnlisted): adapter errored as predicted: acp-rpc-error: session/set_config_option failed (code -32603): Internal error
after zzqqxx attempts: seq=6 fromWire=true model=claude-fable-5[1m] effort=high fast=undefined
claude-opus-99: adapter ERRORED: acp-rpc-error: session/set_config_option failed (code -32603): Internal error
after claude-opus-99: seq=7 fromWire=true model=claude-fable-5[1m] effort=high fast=undefined
totally-not-a-model: adapter ACCEPTED; read-back model='default' (chip would fire)
after totally-not-a-model: seq=10 fromWire=true model=default effort=high fast=off
prompt after switch: stopReason=end_turn sawText=true in 6513ms
final: seq=13 fromWire=true model=claude-fable-5[1m] effort=low fast=undefined
disposed cleanly
orphans: 0
```

## What this proves

1. **Gate step 1 (design "Live verify" 1): PASSED.** Model switched to
   `claude-fable-5[1m]` and effort to `high` mid-session, no restart, both
   confirmed by an independent `session/resume` read-back. The resume was
   NON-destructive: the same acpSessionId answered every subsequent call.
2. **Gate step 2 (prove the check fires): PASSED, both branches.**
   - `zzqqxx` without the hatch: refused by the LOCAL gate, never on the wire.
   - `zzqqxx` through `allowUnlisted`: the ADAPTER errored (A5's error branch).
   - `totally-not-a-model` (Phase 0's exact string): silently downgraded to
     `default`; the read-back exposed it — this is the substitution-chip path,
     live. `verified` would be false; the chip fires.
3. **Gate step 3: PASSED.** A real prompt after the switches completed
   (`end_turn`, streamed text, 6.5 s).
4. **Dynamic option set, live:** after the downgrade to `default`, `fast`
   APPEARED (`off`) where Fable reports no fast option — ground truth #4
   observed against the real adapter.
5. **seq (A1) monotonic across the whole run; `fromWire=true` on every
   read-back; teardown left zero orphan adapters.**

## Behavior correction vs amendment A5

A5 predicted token-sharing bogus ids ("claude-opus-99") fuzzy-resolve silently.
Live, `claude-opus-99` ERRORS (-32603) while `totally-not-a-model` silently
downgrades. So the error-vs-downgrade split is NOT cleanly predictable from
tokenization; both live outcomes exist and BOTH are handled: an adapter error
renders as the red error text, a silent substitution is exposed by the
mandatory read-back and renders as the warning chip.

## Not covered here

This drove the host layer (the same code path the tRPC router calls). The
rendered React bar itself was not exercised — its logic is covered by the 30
`controlBar.test.ts` reducer tests; visual confirmation in the dev app remains
a by-hand step.
