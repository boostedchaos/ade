# Codex as an ADE runtime

How Codex-runtime sessions are launched, which model they use, and how a
Codex agent gets the same identity/memory/skills a Claude-runtime agent gets.
Everything here was set up and verified 2026-08-11.

## Default model

ADE launches Codex with an explicit model flag, hardcoded in
`packages/shared/src/agent-command.ts` (`AGENT_PRESET_COMMANDS` and
`PROMPT_COMMANDS`). A CLI flag always beats `~/.codex/config.toml`, so the
user's Codex config cannot change what ADE sessions run — the preset in
source is the only knob (there is no per-workspace command column in
`local.db`; workspaces store only `runtime`).

Current preset: `gpt-5.6-terra` with `model_reasoning_effort="medium"`
(changed from `gpt-5.5` / `high`, 2026-08-11).

### Interim override on a live install

Until an app build carries the preset above, a deployed install still types
the old model into every session. The fix that works without a rebuild:
patch ADE's own wrapper at `~/.ade-default/bin/codex` (first on PATH for
every ADE terminal) to rewrite the model args — scoped to launches carrying
ADE's `--sandbox danger-full-access` signature so manual `codex` runs pass
through untouched. This patch is applied on Kyle's Mac (backup:
`~/.codex/.trash/2026-08-11/ade-bin-codex.bak`). Caveat: wrapper scripts are
generated (`agent-setup/shell-wrappers.ts`, marker `agent-wrapper v2`), so a
regeneration silently drops the patch — the tell is the session banner
showing `gpt-5.5 high` again. Once a build ships with the new preset, the
wrapper patch is redundant and can be dropped.

## Identity parity — AGENTS.md instead of CLAUDE.md

Claude Code loads a worktree's `CLAUDE.md`, which can `@`-include the
agent's memory files. Codex reads `AGENTS.md` instead and has **no
`@`-include support and no auto-injected memory index**, so a Codex-runtime
agent needs a worktree `AGENTS.md` that explicitly instructs it to read:

1. `<agent-home>/memory/AGENT.md` — identity, role, standing rules
2. `<agent-home>/memory/USER.md` — user profile and calibrations
3. `<agent-home>/memory/MEMORY.md` — the memory index (Claude gets this
   injected; Codex must be told to read it)
4. The user's global rules file (`~/.claude/CLAUDE.md`)

Verified working: a fresh ADE Codex session answered identity questions
correctly and self-located the right skill from the memory index alone.

## Skills

Codex auto-loads only `~/.codex/skills` (a separate directory — not a
symlink of `~/.agents/skills`). Claude Code skills are plain
`SKILL.md` instruction folders, so any runtime can use them if routed:

- Per-agent skills: the worktree `AGENTS.md` points at
  `<agent-home>/skills/` and says to read the matching `SKILL.md` before
  covered work.
- Global skills: `~/AGENTS.md` points at `~/.claude/skills/` and
  `~/.agents/skills/`, with the roster derived via `ls` at use time (never a
  hand-copied list).
- Caveat both files state: skills referencing Claude-only machinery
  (subagents, the Workflow tool, Claude-configured MCP servers) degrade to
  their checklists and bundled scripts; the agent must say so rather than
  improvise an equivalent.

Verified working: asked which skill governs a domain task, an ADE Codex
session named the right skill and quoted its actual constraints.

## Headless quirks (codex exec)

- `codex exec` rejects `--ask-for-approval` (TUI-only flag) — drop it in
  headless tests; `--sandbox` and `-c` overrides work.
- Outside a trusted directory, `codex exec` requires
  `--skip-git-repo-check`.
- The context-mode `ctx_execute_file` tool is confined to the project root;
  shell `cat` via `ctx_batch_execute` reads any absolute path.
