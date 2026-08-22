# Phase 6 live gates — A8 and AL1

Run against the real `claude-agent-acp` 0.63.0 adapter and the real `claude`
CLI on this machine, 2026-08-21. Each script is `bun <script>.ts` from a
scratch git repo, with `LV_CWD` set to that repo.

## A8 / F2 — do plain-CLI session ids load through AcpHost?

The premise the resume-parity fix rests on: the flip hands the pane the newest
conversation id, resolved from `claudeSessions.list`, which is the id space the
plain `claude` CLI writes. If the adapter minted its own ids in a separate
store, passing one across would fail every time and the fix would be theatre.

Session created OUTSIDE the adapter, by the plain CLI:

```
$ claude -p "Reply OK" --output-format json
{… "session_id":"9101f15a-6cfb-4144-8572-6ebbff18260b" …,"result":"OK"…}
```

Then loaded through `AcpHost.createSession({ resumeSessionId })`
(`a8-verify.ts`), with the update listener attached BEFORE the await:

```
requested id: 9101f15a-6cfb-4144-8572-6ebbff18260b
restored: replayed
acpSessionId: 9101f15a-6cfb-4144-8572-6ebbff18260b
history frames: 2
  kind=user_message_chunk text="Reply OK"
  kind=agent_message_chunk text="OK"
disposed
```

PASSED. One id space, the id survives the round trip, and both halves of the
turn replay as ordinary update frames — including the user's own, which is what
`user_message_chunk` (A3) exists to reconstruct.

## AL1 — which mode does the `prompt` policy actually select?

`resolveModeIdForPolicy` picked "the first mode that is not bypass". What the
adapter sends today (`al1-modes.ts`):

```
availableModes in wire order:
  auto
  default
  acceptEdits
  plan
  dontAsk
  bypassPermissions
currentModeId after the policy applied: auto
```

So the prompting policy was selecting `auto` — a model classifier that decides
on the user's behalf and raises no `session/request_permission` at all. The
policy had silently stopped prompting, and an agent that never asks is
indistinguishable from an agent with nothing to ask about.

`fake-acp-child.ts`'s `FIXTURE_MODES` led with `default`, which is why every
test passed. The fixture now carries the wire order above, and the order is
part of what it fixtures.

After the fix (`default` by id, first non-bypass only as a fallback),
`al1-verify.ts`:

```
mode selected by the prompt policy: default
permission_request RAISED: Write al1-proof.txt
  options: allow_always, allow, reject
  answered with: allow_always
turn stopReason: end_turn
file written: true
```

PASSED end to end: a real request reached the handler, the answer went back on
the wire, the tool ran and the turn completed.
