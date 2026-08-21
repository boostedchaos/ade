# Phase 4 design — ACP control bar (model / effort / fast / agent)

**Status:** design approved for build, 2026-08-21. Brief: `PLAN_ACP_PANE.md:153-166`.
Recon (2026-08-21, from installed `claude-agent-acp@0.63.0` + `sdk@1.3.0` source)
established the facts below; do not re-derive them.

## Ground truth the design rests on

1. **The host already has** a `ConfigOptionCache` seeded from `session/new`,
   replaced on `config_option_update`, and a validated `setConfigOption` path
   (`acp-session.ts:348-367`). Missing: `session/resume`, tRPC exposure, and the
   `name`/`description`/`category` fields the normalizer drops.
2. **A mistyped model id never errors.** The adapter fuzzy-resolves it
   (`resolveModelPreference`, adapter `:4970`) to some *other valid* model, often
   `default`. A green write proves nothing; only a read-back does.
3. **`session/resume` returns `configOptions`** and is non-destructive **only if
   its params byte-match `session/new`'s** (`{ sessionId, cwd, mcpServers: [] }`).
   A mismatched fingerprint silently tears down and recreates the live session
   (adapter `getOrCreateSession`, `:3970`). Use resume, never `session/load`
   (load replays history).
4. **The option set is dynamic.** `effort` and `fast` can appear/vanish on a model
   change (a `config_option_update` fires when they do). `agent` only exists when
   custom agents are configured — its absence is normal. Render from the reported
   list; never hardcode a four-control layout.
5. **`fast` arrives as a select with values `"on"`/`"off"`** under Argus's current
   `initialize` capabilities (no boolean opt-in). The host's boolean branch is dead
   code against this adapter today. **Decision: keep it that way in Phase 4** — do
   not add the boolean capability; render two-value selects as a switch.
6. Option ids are stable adapter constants: `"mode"`, `"model"`, `"effort"`,
   `"agent"`, `"fast"`.

## Decisions

- **D1 — Widen `AcpConfigOption` additively.** Add `name: string`,
  `description?: string`, `category?: string` to `AcpConfigOption`
  (`acp-host/types.ts`); add optional `description` to each value. Normalizer
  (`config-options.ts:toAcpConfigOption`) carries them through and **flattens
  grouped select options** (`SessionConfigSelectGroup`) into a flat `values`
  list, prefixing labels with the group name (`"Group / Option"`). No consumer
  breaks: Phase 2 ignores these fields.
- **D2 — Store the exact `session/new` params for reuse.** `AcpSession` records
  the exact `cwd` string and `mcpServers` array reference it sent to
  `session/new`, and `resume()` sends those same values. A unit test asserts the
  resume request on the wire deep-equals the new request's `{cwd, mcpServers}`.
- **D3 — One mutation does write + read-back.** New tRPC mutation
  `acp.setConfigOption({ paneId, configId, value, allowUnlisted? })`:
  1. Local gate: value must be in the cached option list — **except** when
     `allowUnlisted: true` AND `configId === "model"` (the typed-id escape hatch;
     the plan requires a model missing from the list to still be reachable).
  2. Wire write via the existing `AcpSession.setConfigOption` (extended to accept
     the unlisted-model bypass).
  3. **Mandatory read-back** via `session/resume`; re-seed the cache from its
     `configOptions`.
  4. Return `{ configOptions, applied: { configId, requestedValue, actualValue,
     verified: boolean } }`. `verified` is `requestedValue === actualValue` (for
     model, compare against the option id the read-back reports as current).
  The renderer trusts only this return value and the event stream — never its own
  optimistic state — for final display.
- **D4 — Also expose `acp.readConfig({ paneId })`** (mutation, not query — it
  touches the wire): performs a resume read-back and returns the fresh list. Used
  on pane mount after `ensureSession` resolves, and by the verify step.
- **D5 — Renderer: a `AcpControlBar` in the toolbar's left region**
  (`AcpPane.tsx:184-196`, replacing the bare "ACP Session" span — keep the label
  as a small prefix). Pure reducer (`controlBar.ts`) owns config state per pane,
  tested without React, mirroring `transcript.ts`. State seeds from `acp.state`,
  reconciles from `config_option_update` events (handler goes through the existing
  ref, `AcpPane.tsx:77-78` — never force a re-subscribe), and from mutation
  returns.
- **D6 — Controls by category, in order:** `model` → `thought_level` (effort) →
  `fast` → `agent`. **`mode` is excluded from the bar** (auto-approve policy is a
  Phase-later toggle; plan lists four controls). Unknown categories render last as
  plain selects — forward-compatible.
  - `model`: a `Command`-based combobox (pattern: `NewAgentModal.tsx:392-398`) —
    filterable list of reported options **plus free-typed entry**. A typed value
    not in the list submits with `allowUnlisted: true` and shows an inline
    warning chip when the read-back's `verified` is false:
    `"adapter resolved '<typed>' → '<actual>'"`. That chip is the Agent-Canvas
    failure made visible instead of silent.
  - `effort`, `agent`, unknown selects: `@superset/ui/select`
    (pattern: `LinkBehaviorSetting.tsx`).
  - `fast` (any two-value select whose values are `on`/`off`): a switch.
  - While a write+read-back is in flight the control is disabled with a spinner;
    on settle it renders the read-back truth. No optimistic display of the
    requested value (finding #2 makes optimism a lie).
  - `description` renders as the control's tooltip (it carries e.g. the reason
    fast mode is unavailable).
- **D7 — Absence is normal.** A missing `effort`/`fast`/`agent` option renders
  nothing (no placeholder, no error). If a `config_option_update` removes an
  option mid-session, the control disappears; the reducer handles this case and
  has a test for it.

## Tests (author independently of the builder)

Host (`fake-acp-child.ts` seam — real SDK on real streams, doctrine of
`config-options.test.ts`: assert what went on the wire):

- Add a `session/resume` handler to the fake child (none exists). Fixture returns
  `configOptions`.
- Resume params byte-match new params (D2). Include the destructive case as the
  *fires* proof: a fake whose resume handler asserts/records params lets the test
  show a mismatched `cwd` WOULD have been sent if the code regresses.
- `setConfigOption` with unlisted model + `allowUnlisted` reaches the wire;
  unlisted non-model value never reaches the wire (existing gate holds).
- Read-back re-seeds the cache; `verified:false` when the fake's resume reports a
  different current model than requested. (Override the fake's default
  `session/set_config_option` handler — its default returns `configOptions: []`.)
- Router (`acp.test.ts` `FakeAcpHost` seam): new `setConfigOptionCalls` /
  `readConfigCalls` recording; procedures forward and return correctly.

Renderer (pure-function only, no React harness exists):

- `controlBar.ts` reducer: seed, reconcile-from-update, option-removed (D7),
  in-flight → settle, verified-mismatch state.

Live verify (the phase gate, run by hand in the dev app):

1. Open an ACP pane, switch model to `claude-fable-5[1m]` and effort to `high`
   mid-session — no restart; the bar shows both after read-back.
2. **Prove the check fires:** type a bogus model id. The bar must show the
   mismatch warning with the fuzzy-resolved actual value — not the typed value,
   not silence.
3. Send a prompt after the switch; the reply metadata/behavior is consistent with
   the new model (usage/latency sanity, not a formal proof).

## Out of scope

Boolean capability opt-in; the `mode` control; persisting config choices across
app restarts; Codex; the slash palette (Phase 5).
