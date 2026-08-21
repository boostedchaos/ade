# Phase 3 design — ACP rich rendering (tool cards, thinking, plan, usage)

**Status:** design approved for build, 2026-08-21. Brief: `PLAN_ACP_PANE.md` Phase 3.
Evidence: recon of adapter/SDK source (2026-08-21) **plus a live wire capture** —
`spikes/acp-phase3-capture/frames.json` (43 frames from a real read-read-edit turn
against `claude-agent-acp@0.63.0` and the real CLI; `capture.ts` beside it).

## Ground truth (live-observed unless marked "source")

1. **All four kinds already reach the renderer with full payloads.** The host union
   (`acp-host/types.ts:28-51`) and `mapSessionUpdate` carry `tool_call` /
   `tool_call_update` verbatim, `plan` entries, and `usage_update` used/size/cost —
   test-backed in `acp-connection.test.ts`. Phase 3 is renderer work; **no host
   changes** except the optional thought `messageId` (dropped below, see D5).
2. **Tool lifecycle, observed:** initial `tool_call` arrives `pending` with a
   generic title ("Read File", "Edit"), then refinement updates fill in the real
   title ("Read alpha.txt") and `locations`, then Edit gets a diff-content update
   (and a later REPLACING diff from the PostToolUse hook), then a final update sets
   `status: completed`. **`in_progress` never appeared** — it only exists for
   long-running tools with progress heartbeats (source: adapter `:2793`). Updates
   are sparse: an absent field means unchanged; a present `content`/`locations`
   REPLACES the collection. Correlation is `toolCallId` only. The programmatic tool
   name lives in `_meta.claudeCode.toolName` (`ToolCall.name` is never set).
3. **usage_update, observed:** ~8 per turn, `used` climbs mid-turn
   (41,371 → 43,397), `size` = the model's context window (1,000,000 for `[1m]`),
   `cost` is `null` on every frame except the turn-final one
   (`{amount: 0.670733, currency: "USD"}` — cumulative session USD).
4. **Thinking may be legitimately empty.** Current models default
   `thinking.display: "omitted"`; the adapter drops empty thought blocks and no
   client-side flag can force them visible (source: adapter `:5624`,
   `resolveThinkingConfig`). Zero thought frames in the capture. The UI must not
   present an empty thinking view as breakage.
5. **Plan replaces wholesale.** Every `plan` frame carries the complete entry list
   (`{content, priority, status}`); TodoWrite-sourced entries hardcode
   `priority: "medium"` (source: tools.js:799), so priority is not worth rendering.
   TodoWrite/Task* never produce tool cards — a plan with no matching card is
   correct.
6. **Bash never carries a terminal block for us** (we advertise only `fs`
   capabilities) — no terminal rendering in scope.
7. `packages/ui/src/components/ai-elements/` ships purpose-built `Tool`,
   `Reasoning`, `Plan`, `FileDiffTool` components (Radix Collapsible based) —
   essentially unused in the desktop app so far (one `code-block` import), so
   treat as strong candidates that must be proven under the desktop theme, not as
   guaranteed drop-ins. `context.tsx` is NOT usable (depends on `ai`/`tokenlens`
   data we don't have).

## Decisions

- **D1 — Transcript model widens to a discriminated union, reducer stays pure.**
  `AcpEntry` gains members alongside the existing text entries:
  - `{ role: "tool"; toolCallId; call }` where `call` is the latest-wins MERGED
    tool state (title, kind, status, content, locations, rawInput, toolName).
    Merge rules exactly per ground truth 2: sparse-update semantics, collections
    replace, unknown fields never invent defaults. A `Map`-shaped index
    (`toolCallIdToEntry`) gives O(1) update correlation. A `tool_call_update` for
    an unknown id CREATES a card (defensive; mark `synthetic: true`) rather than
    being dropped.
  - `{ role: "thinking"; text }` — consecutive `agent_thought_chunk` frames append
    to the open thinking entry; any other entry-producing frame closes it.
  - Interleaving: a `tool_call` closes the open assistant text entry (the reply
    text continues in a NEW entry after the card, matching arrival order).
  - `plan` is NOT an entry: store-level `plan: PlanEntry[] | null`, replaced
    wholesale per frame.
  - `usage: { used, size, cost } | null` — store-level, latest frame wins; a
    `null`-cost frame does NOT clear a previously reported cost (keep
    `lastCost` separately so the meter can show the turn-final figure).
  - These five kinds leave `ignoredKinds`; `unknown` and the config/mode/info
    kinds stay counted.
- **D2 — Tool cards render via `ai-elements/tool` (proven first).** Builder's
  first task: render one `Tool` + `ToolHeader` + `ToolContent` under the desktop
  theme in the pane. If it composes cleanly, use it, with the status map
  pending→`input-available`, in_progress→`input-complete`,
  completed→`output-available`, failed→`output-error`. If it fights the theme or
  drags unwanted deps, fall back to `@superset/ui/collapsible` + local card
  markup matching the pane's idiom (`text-xs`, `border-border/60`) — decide once,
  note the decision, don't build both. Card anatomy either way: one collapsed
  row = status icon + title + tool name chip; expanded = diff content via
  `FileDiffTool` (or a minimal local diff block) for `{type:"diff"}`, plain
  `whitespace-pre-wrap` text for `{type:"content"}` text blocks, and rawInput as
  a collapsed JSON `code-block` section. Cards are collapsed by default; a
  `failed` card auto-expands.
- **D3 — Usage meter in the toolbar.** A compact chip (h-6, text-xs) between
  `AcpControlBar` and `PaneToolbarActions`: `43.4k / 1M · 4%`. Tooltip carries
  the exact numbers and, when known, the turn-final cost (`$0.67 session`).
  Numbers formatted for low cognitive load (k/M, one decimal max). No progress
  bar in v1 unless it drops in trivially — the number moving is the deliverable.
- **D4 — Plan panel.** When `plan` is non-null, a pinned collapsible strip at the
  top of the message list: "Plan · 2/5 done" collapsed; expanded shows entries
  with status icons (pending ○ / in_progress ◐ / completed ●) and
  strikethrough on completed. No priority display (ground truth 5). Cleared on
  `session_exit` like the rest of the transcript.
- **D5 — Thinking via `ai-elements/reasoning`** (same prove-first rule as D2),
  collapsed by default, labeled "Thinking". No host change for `messageId` —
  turn-scoped grouping (D1) is enough for v1, and zero observed thought frames
  means we would be building grouping subtleties against no evidence.
- **D6 — Phase gate, restated from the live capture** (supersedes the plan file's
  wording): a read-two-files-edit-one prompt must show **three tool cards, each
  leaving `pending` and landing on `completed`** (no `in_progress` required),
  the Edit card must show a diff, **the usage number must move mid-turn**, and
  the cost must appear by turn end. Deterministic version of the same gate: a
  reducer test replaying `spikes/acp-phase3-capture/frames.json` verbatim must
  produce exactly 3 tool entries (2 read + 1 edit, correct final titles, all
  completed, edit carrying a diff), usage `43397/1000000`, and lastCost
  `0.670733`.

## Tests (author independently of the builder)

- Reducer: the frames.json replay above (the load-bearing one); sparse-merge
  rules (absent field unchanged, content/locations replace — the duplicate-diff
  regression); orphan update creates a synthetic card; thinking
  append/close; interleaving (text → card → text ordering); plan replace and
  clear; usage latest-wins with cost retention; the five kinds no longer count
  as ignored; unknown still counts; purity (same input twice → same output).
- Rewrite the now-false block in `transcript.test.ts:170-220` (it asserts these
  kinds are ignored); keep "never throws" and unknown-counting.
- Fake child: add `fixtureToolCallSequence()` (pending → refinements → diff →
  completed) so host-level tests can drive the real wire; one acp-host test
  asserting the sequence crosses `mapSessionUpdate` intact.
- Live gate: run the capture script's prompt through the dev app by hand OR
  re-run `capture.ts` and eyeball the pane — the deterministic replay test
  covers the reducer; the by-hand step covers pixels.

## Out of scope

Terminal blocks; markdown rendering of assistant text; virtualized lists (the
message list header names both as known gaps — they stay gaps); `plan_update` /
`plan_removed` (adapter never sends them); persisting transcript across restart
(Phase 6); forcing thinking visible (no client-side knob exists).
