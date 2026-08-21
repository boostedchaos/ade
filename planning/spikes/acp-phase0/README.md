# Phase 0 spike — ACP probe

Throwaway scripts that answer the question `PLAN_ACP_PANE.md` Phase 0 asks:
does the Claude Code ACP adapter actually surface the skills, models and effort
levels Kyle needs, on his machine, under his login?

**Result: yes.** Findings in `FINDINGS.md`. Run date 2026-08-21.

## Running them

```sh
npm i @agentclientprotocol/sdk @agentclientprotocol/claude-agent-acp
mkdir workspace && (cd workspace && git init)

node probe.mjs  ./workspace "Reply with exactly: OK"   # inventory what the adapter sends
node switch.mjs ./workspace                            # live model + effort switch
node bogus.mjs  ./workspace                            # what an invalid model id does
```

`probe.mjs` writes its raw capture to `probe-evidence.json` (or `$EVIDENCE`).
That file is deliberately **not committed** — it contains the full local command
inventory, and this repository is public.
