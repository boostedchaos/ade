# PLAN — ACP Pane for Argus

**Status:** proposed, 2026-08-21. Not started.
**Goal:** give Argus a rich GUI view of a Claude Code session — messages, thinking,
tool calls, plans, a live model/effort switcher and a skills palette — without
giving up the agent identity, git worktree and memory that Argus already owns.

## Why this exists

A trial of OpenHands Agent Canvas (2026-08-21, run natively, since removed)
established the shape of the opportunity:

- Its GUI was more appealing to work in than a raw terminal pane.
- But it **dropped three things that are deal-breakers**: no Claude Fable in the
  model picker, no real-time effort switch, and no custom skills (`/wrap-up`,
  `/fable-orchestration`).
- Those are **not protocol limits.** They are gaps in that product's UI. The
  Claude Code ACP adapter sends all three; Agent Canvas ignores them.

So the opportunity is: **render what the adapter already offers.**

## Decisions taken (Kyle, 2026-08-21)

| Decision | Choice |
|---|---|
| Where the ACP host runs | **Desktop first** — Electron side, beside the terminal daemon. Port to `ade-server` later. |
| Runtimes in v1 | **Claude Code only.** Codex is a follow-on. |
| Permission handling | **Auto-approve**, matching how he runs Claude Code today. |
| Relationship to terminal panes | **ACP becomes the default view for agents**; terminal is the opt-out. |

Note on the last two together: default-view + auto-approve means agent actions run
unattended in a window he watches but does not gate. The permission *plumbing* is
built regardless — the protocol requires an answer to every request — so the
decision is a **policy default**, exposed as a toggle. Flagged once; his call taken.

## What ACP actually gives us — verified inventory

Read from `@agentclientprotocol/claude-agent-acp@0.63.0` and
`@agentclientprotocol/sdk@1.3.0` on 2026-08-21.

**Session updates the adapter emits** (all from `dist/acp-agent.js`) — this is the
render list:

| `sessionUpdate` | What it carries | Why it matters here |
|---|---|---|
| `agent_message_chunk` | assistant text | the conversation |
| `agent_thought_chunk` | thinking | Argus can show or hide it |
| `tool_call` / `tool_call_update` | tool invocations + results | the part a terminal shows badly |
| `plan` | the agent's plan | free plan view |
| `available_commands_update` | **slash commands and skills** | the missing `/wrap-up`, `/fable-orchestration` |
| `config_option_update` | **model, effort, agent, fast mode** | the missing live switcher |
| `current_mode_update` | permission mode | |
| `session_info_update` | session metadata | tab titles |
| `usage_update` | token usage | a real context meter |

**Methods Argus must implement as the ACP client** — only five, and the adapter
calls each exactly where expected:
`sessionUpdate`, `requestPermission`, `readTextFile`, `writeTextFile`,
`extNotification`.

**Methods Argus calls on the agent** (via `ClientSideConnection` in the SDK):
`initialize`, `newSession`, `loadSession`, `resumeSession`, `listSessions`,
`closeSession`, `deleteSession`, `setSessionMode`, and — the important one —
**`setConfigOption` (`session/set_config_option`)**, which is how a live model or
effort change is sent mid-session.

**Model ids are not a fixed list.** Agent Canvas hardcoded five and that is why
Fable was absent. Argus must render whatever `config_option_update` reports and
also accept a typed id. `claude-fable-5` is verified accepted by the CLI.

## What Argus already has (so this is smaller than it looks)

- **Pane types are pluggable:** `PaneType = "terminal" | "webview" | "file-viewer"
  | "devtools"` — `apps/desktop/src/shared/tabs-types.ts:11`. We add `"acp"`.
- **Pane creation is a worn path:** `createPane` (`renderer/stores/tabs/utils.ts:160`),
  with `createBrowserPane` / `createDevToolsPane` as precedent in `store.ts`.
- **Panes already carry agent status** (`PaneStatus`, working / waiting / idle) and
  Mission Control already rings a blocked pane. ACP feeds this directly.
- **A daemon that owns long-lived subprocesses already exists:**
  `packages/server-core/src/terminal-host/` (`pty-subprocess.ts`, `client.ts`).
  The ACP host is a sibling, not a new concept.
- **Runtimes are already modelled** in the DB: `AgentRuntime`
  (`packages/local-db/src/schema/zod.ts:117`), used at `schema.ts:139`.

## Architecture

```
renderer  AcpPane.tsx ── control bar (model / effort / agent / fast mode)
   │                  ├─ message list (text, thinking, tool calls, plan)
   │                  ├─ slash-command palette (from available_commands_update)
   │                  └─ composer
   │  tRPC / IPC  (mirrors the terminal pane's transport)
   ▼
main      packages/server-core/src/acp-host/
          ├─ spawn: claude-agent-acp (stdio)
          ├─ ClientSideConnection  (@agentclientprotocol/sdk)
          ├─ Client impl: sessionUpdate, requestPermission, readTextFile,
          │               writeTextFile, extNotification
          └─ per-pane session registry + event fan-out
   ▼
          claude-agent-acp ──> Claude Code CLI (own login, own ~/.claude
                               settings, hooks and skills)
```

The agent's **cwd is its existing Argus worktree** — that is the whole point, and
it is a single argument to `session/new`.

## Phases

Each phase ends with a commit and a stated verification. A phase is not done until
its check has been proven to *fire* (run it against a known-bad case first).

### Phase 0 — Spike outside Argus (half a day)

A standalone Node script that spawns `claude-agent-acp`, opens a session in a scratch
repo, sends one prompt, and prints every `sessionUpdate` it receives.

**Verify:** the printed stream contains `available_commands_update` listing a custom
skill (e.g. `wrap-up`) and a `config_option_update` containing an effort option.
**Prove the check fires:** run once with a bogus `--model`; the run must fail loudly
rather than print an empty command list that reads like success.

This phase alone answers the only question that can kill the plan: *does the adapter
surface his real skills and effort levels on his machine, under his login?*

### Phase 1 — `acp-host` package

`packages/server-core/src/acp-host/` — spawn, connection, the five client methods,
session registry keyed by pane id, teardown ladder (stdin EOF → SIGTERM → SIGKILL,
copying the terminal host's existing escalation).

**Verify:** unit tests for the five client methods; a killed subprocess leaves no
orphan (`pgrep -f claude-agent-acp` empty after teardown).

### Phase 2 — Minimal pane

`PaneType` gains `"acp"`. `AcpPane.tsx` renders text in / text out and nothing else.
Spawn path: a session tab can be created as ACP instead of terminal.

**Verify:** send "reply with exactly: OK", see OK. Pane survives an app restart or
states plainly that it did not (whichever is true — do not paper over it).

### Phase 3 — Rich rendering

`agent_thought_chunk`, `tool_call` / `tool_call_update`, `plan`, `usage_update`.
Tool calls collapse; thinking is toggleable; usage becomes the context meter the
terminal pane never had.

**Verify:** a prompt that reads two files and edits one shows three tool cards with
correct status transitions, and the usage number moves.

### Phase 4 — The control bar (the first deal-breaker)

Drive `config_option_update` into a bar under the tab: **model, effort, agent,
fast mode**. Changing one calls `setConfigOption` mid-session.

**Verify:** switch to `claude-fable-5` and to effort `high` **without restarting the
session**, and confirm the change took by reading back the next
`config_option_update` — not by the UI's own optimistic state.
**Must also accept a typed model id** so a model missing from the reported list is
still reachable. This is the exact failure that killed Agent Canvas.

### Phase 5 — Slash commands and skills (the second deal-breaker)

`available_commands_update` becomes a `/` palette in the composer.

**Verify:** `/wrap-up` and `/fable-orchestration` both appear and both run.
**Prove the check fires:** temporarily disable one skill and confirm it disappears
from the palette — an empty palette and a broken subscription look identical.

### Phase 6 — Make it the default, and make it durable

- New agent sessions open as ACP; terminal is a per-session opt-out.
- Session persistence via `loadSession` / `resumeSession` so a tab reopens where it
  was, matching what terminal scrollback already does.
- Map ACP status to `PaneStatus` so Mission Control's ring and badge work unchanged.

**Verify:** restart the app with three live ACP sessions; all three resume. Mission
Control reports a blocked pane for an ACP pane, not only a terminal one.

## Risks, named

1. **Feature loss nobody notices.** The terminal shows things only the CLI draws.
   Before Phase 6 flips the default, list what the TUI renders that ACP does not
   send, and decide each one deliberately. Do not discover this in daily use.
2. **Adapter version drift.** Pin `@agentclientprotocol/claude-agent-acp` (0.63.0
   today) and `@agentclientprotocol/sdk` (1.3.0). The adapter is young; a minor
   bump can move the update vocabulary.
3. **Auto-approve + default view.** Chosen deliberately. Ship the toggle in the
   same phase as the policy so reversing it is a switch, not a build.
4. **Upstream merge cost.** New pane type + a new server-core subtree is additive,
   but `store.ts` and `tabs-types.ts` are files upstream also edits. Keep the ACP
   code in its own directory and touch shared files minimally.
5. **Windows.** Subprocess spawn and teardown differ; Windows force-terminates.
   Phase 1's teardown ladder must be tested on Windows before Phase 6.

## Out of scope for v1

Codex and Gemini adapters; running ACP through `ade-server` for the web UI;
multi-agent orchestration inside one pane; automations/schedules (the Agent Canvas
feature Kyle explicitly does not want).
