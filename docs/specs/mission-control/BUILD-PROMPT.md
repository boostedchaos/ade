# Mission Control — paste-ready build prompt

Paste the block below into a FRESH Claude Code session (model: Fable 5,
`/effort medium`) with cwd = this repo's root
(`~/Documents/PROJECTS/ADE Windows 11/source`). It runs the whole build
autonomously per `docs/specs/mission-control/SPEC.md`.

---

Build the Mission Control feature set end to end, fully autonomously, per
the approved spec at `docs/specs/mission-control/SPEC.md`. Read the whole
spec first; it is the contract — its decisions are settled, do not
re-litigate them. Work on branch `mission-control` off main.

Orchestration: you are the architect only (~10% of the work). Delegate
research, execution, and verification to parallel Opus 5 subagents
(`model: opus`, effort `high`; mechanical fan-out lanes may use `medium`;
the ship-gating adversarial verifier runs at `xhigh`). Give each executor a
disjoint file set, the spec path, and the rule set: edit only your files, no
git commits (you commit at phase boundaries), run targeted tests, report
files-changed + any divergence from the spec. Relay cross-package findings
between agents immediately. Delegate independent subtasks and keep working
while they run; don't block on the slowest.

Hybrid harness clause: Phase 0 includes the agent-teams probe. If the probe
shows `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` working in the installed
Claude Code version, you MAY run one narrow mechanical lane of a later
phase via agent teams to dogfood it — but only a lane whose failure is
cheap, and standard subagents remain the default for everything else. If
the probe fails, note it and proceed with subagents only.

Phase discipline: execute Phases 0–6 in the spec's order, straight through.
Commit at every phase boundary with a one-line progress note; never batch
commits to the end. A stop must be cheap at any moment: keep the tree
committed and append resume state (current phase, open items, agent
assignments) to `docs/specs/mission-control/PROGRESS.md` as you go.

Prior findings are hypotheses: the spec's "ground truth" file:line claims
were verified at `302d183` — executors must re-confirm each one they rely
on at HEAD and flag drift rather than patching blind.

Ship gates (all six in the spec's Verification section) are mandatory:
baseline-diff test protocol against `302d183`, new-code tests, live macOS
smoke, adversarial review PLUS Codex CLI cross-check (`codex exec
--sandbox read-only`, SHIP/FIX-FIRST verdict), windows-ci green on the
branch, and the packaged mac 0.4.0 build (clone to /private/tmp, scrub
SUPERSET_* env, bake SUPERSET_WORKSPACE_NAME=default, isolated boot smoke).
Grep the full diff for homelab hostnames/IPs/tokens before any push — this
repo is public. Do not publish releases and do not merge to main; leave
the branch pushed, artifacts + SHA256SUMS.txt at the project root, and a
final report in `docs/specs/mission-control/BUILD-REPORT.md` covering: what
shipped, gate results with the commands that produced them, divergences
from spec, and what you deliberately did NOT change.

Before reporting progress, audit each claim against a tool result from this
session; if unverified, say so. If tests fail, say so with the output. You
are operating autonomously — the user cannot answer mid-task. For
reversible actions that follow from the spec, proceed. End only when Phase
6 is complete or you are blocked on input only the user can provide; if
blocked, commit, write the blocker to PROGRESS.md, and stop cleanly.

---

Handy after the run: `git log --oneline mission-control`, then read
`docs/specs/mission-control/BUILD-REPORT.md`.
