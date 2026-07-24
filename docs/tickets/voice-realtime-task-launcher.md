# Future: OpenAI Realtime (ChatGPT-Live) voice front-end for launching background agent tasks

**Status:** exploratory — not scoped or estimated. Captured from a `workforce` repo conversation
(2026-07-14) so the idea isn't lost. Pick up when there's bandwidth to actually scope it.

## Idea

Use OpenAI's Realtime API (ChatGPT-Live voice mode) as a conversational front-end that can launch
background Claude Code / ADE agent tasks mid-conversation, without blocking or degrading the
live voice call. Cameron talks to the voice model; the model kicks off work in the background while
the conversation continues, and the result surfaces later (push notification, or injected back into
the live call if it's still open).

## Why this fits ADE

ADE already has the right shape for this: a headless `ade-server` daemon, per-agent git
worktrees, detached terminal sessions that survive disconnects, and any-device browser clients over
HTTPS+WSS/tRPC. Voice would just be a new client surface talking to the same server, alongside the
browser UI.

HAL (`services/hal/` in the `workforce` repo) already proves the core pattern in miniature: async
trigger from phone/browser → task runs detached → push notification on completion. Directly reusable
prior art.

## Proposed architecture (fire-and-forget + async result delivery)

1. **Launch (voice → task).** OpenAI Realtime API supports mid-conversation function/tool calls. The
   voice model calls something like `launch_task(description)` → backend hands off to ADE to
   start a Claude Code session in a fresh/named agent worktree → returns an immediate ack ("on it,
   I'll let you know") so the voice turn isn't blocked. Latency profile should match any other tool
   call — no expected degradation to conversation quality.

2. **Execution (unchanged).** The launched session runs exactly like any other ADE-triggered
   session — voice is just a new trigger surface, not a different execution path. No expected
   degradation to execution quality.

3. **Result delivery — two options, staged:**
   - **v1 (build first):** push notification when the task finishes, same as ADE/HAL's existing
     completion-notification path. Simple, mostly already exists.
   - **v2 (nice-to-have):** live mid-call result injection — the Realtime API supports pushing a new
     conversation item into an *already open* session server-side, so the voice model can proactively
     report back if the call is still active when the task completes. More work, not required for v1
     value.
   - Also worth considering: a `check_task_status` tool the voice model can call proactively if
     Cameron asks "did that finish?" mid-conversation.

## Open design question worth flagging

Audio and task descriptions would transit OpenAI's servers before reaching Claude — a mixed-provider
seam (not a blocker, just a deliberate tradeoff to make consciously, e.g. what gets included in the
task description passed to the tool call).

## Next steps when picked back up

- Scope a v1: Realtime API session setup, one `launch_task` tool, wired to ADE's existing
  task-launch entry point, push notification on completion.
- Decide where the Realtime session itself runs (ade-server vs. a separate small service) and how
  it authenticates back into ADE.
- Prototype the latency of the launch handshake to confirm it doesn't introduce an audible pause.
