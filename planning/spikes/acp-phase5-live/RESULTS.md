# Phase 5 live verify — real adapter + real CLI (2026-08-21)

Run against the D1 host cache at commit 89291a8 (before the A1-A5 fixes, which
touch renderer logic the script does not exercise). `live-verify.ts` beside
this file; same spawn recipe as `acp-phase4-live` (adapter entry
`dist/index.js`, `CLAUDE_CODE_EXECUTABLE` at Kyle's installed claude).

Verbatim output (stderr elided):

```
at session/new: cached commands = 0
cached after wait: 103 | wrap-up: true | fable-orchestration: true
/context: stopReason=end_turn replyBytes=25374
reply mentions context/tokens: true
disposed
orphans: 0
```

What this proves:

1. **Ground truth 3 observed live:** `session/new` carries no commands (cache
   correctly empty at that instant); the list arrives via the notification and
   the D1 cache fills to 103 — so a late/remounted reader gets the list from
   `info()` instead of an empty palette.
2. **The plan's gate names, live:** `wrap-up` and `fable-orchestration` are
   both in the cached list read back through `AcpSessionInfo`.
3. **Running a command is prompt text:** `/context` sent through the normal
   prompt path executed and returned a real context report (25 KB reply
   mentioning tokens). `/wrap-up` was deliberately NOT run live — it would
   execute Kyle's real wrap-up skill against a scratch repo; `/context` is the
   established benign probe (Phase 2 precedent).
4. Teardown left zero orphan adapters.

Not covered: the palette UI itself (pixels, keyboard) — pure logic is under
test (exact-match priority, clamp, lifecycle messages, hint visibility, height
fit); the by-hand dev-app check remains, as in Phases 3 and 4. The live
skill-disable check is deliberately not run against Kyle's real skills; the
deterministic disappearance test in `commands.test.ts` covers the mechanism.
