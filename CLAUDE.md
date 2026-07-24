# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code
in this repository. Broader project context and conventions live in `README.md`
and `AGENTS.md` — read those too.

## graphify

This repo has a graphify knowledge graph at `graphify-out/graph.json`, kept fresh
automatically by a git post-commit hook (global config lives in the `workforce`
repo's `git-hooks/`, see that repo's README for the mechanism).

- **Before answering a non-trivial question about this codebase** (architecture,
  "where is X", "what calls Y", cross-file relationships), check whether
  `graphify-out/graph.json` exists. If it does, query it (`/graphify query
  "<question>"`, or `/graphify path` / `/graphify explain`) before grepping the
  repo from scratch — it's often faster and catches relationships grep misses.
- **After code changes**, the post-commit hook rebuilds the graph automatically —
  no manual step needed. If `graphify-out/.needs_update` appears, a doc/image
  change needs LLM re-extraction: run `/graphify --update` once in a session.
- Skip this for trivial one-line lookups where a direct grep is just as fast.
