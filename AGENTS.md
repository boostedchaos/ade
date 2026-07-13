# ADE Windows Port — Repository Guide

Guidelines for agents and developers working in this repository.

This is **`boostedchaos/ade-windows-port`**, a fork of
[`per-simmons/damon-ade`](https://github.com/per-simmons/damon-ade) (itself derived from
Superset) that adds Windows 11 x64 support to **ADE**, an Electron desktop app for running
persistent coding agents (Claude Code, Codex, OpenCode) in terminals. The product of this
repo is the desktop app; everything else is inherited scaffolding.

## Structure

Bun + Turbo monorepo:

- **`apps/desktop`** — the ADE Electron app. All Windows-port work lives here:
  - `src/main` — Electron main process (terminal host, agent setup, auto-updater)
  - `src/lib/trpc` — main-process tRPC routers (workspaces, git, permissions, keys)
  - `electron-builder.ts` / `electron-builder.win.ts` — packaging (NSIS + zip on Windows)
  - `scripts/` — Windows native staging (`prepare-win-natives.ts`,
    `copy-native-modules.ts`, `verify-win-package.ts`)
- **`apps/web`, `apps/marketing`, `apps/admin`, `apps/api`, `apps/docs`, `apps/mobile`,
  `apps/streams`** — inherited upstream Superset apps. Not built, shipped, or maintained by
  this fork; don't modify them except when syncing with upstream.
- **`packages/`** — shared libraries used by the desktop app (`local-db`, `trpc`, `ui`,
  `shared`, `agent`, `desktop-mcp`, ...). `packages/ui` is shadcn/ui + TailwindCSS v4.
- **`tooling/typescript`** — shared TypeScript configs.

## Tech stack

- **Package manager:** Bun (no npm/yarn/pnpm). **Build:** Turborepo + electron-vite.
- **Desktop:** Electron, React, tRPC over IPC, SQLite via `packages/local-db`.
- **Code quality:** Biome, run at the repo root (not per-package).

## Common commands

```bash
bun run lint               # biome check (no changes)
bun run lint:fix           # fix auto-fixable issues
bun run typecheck          # type check all packages
bun test                   # run tests

# apps/desktop
bun run compile:app        # production build into dist/
bunx electron .            # launch the built app
bun run build:win          # full Windows pipeline: compile + stage natives + NSIS/zip + verify
```

Windows notes: the build uses prebuilt native binaries only (`npmRebuild` off — no Visual
Studio toolchain needed). Set `ADE_SKIP_INSTALL_APP_DEPS=1` during `bun install` on machines
without one. `.github/workflows/windows-ci.yml` is the ground-truth Windows build recipe.

## Agent rules

1. **Type safety** — avoid `any` unless necessary.
2. **Prefer `gh` CLI** for GitHub operations (PRs, issues) over raw `git` where possible.
3. **Don't regress the Windows port.** Platform-specific behavior is deliberate and
   documented in commit history: `.cmd`-only shims (never `.ps1`), ConPTY signal handling,
   canonical-uppercase env keys on win32, junction-safe file removal, PE-header validation
   of staged natives. Read the surrounding comments before "simplifying" any
   `process.platform` branch.
4. **Elastic License 2.0** — mark modifications to the original Superset/ADE source per the
   license (see LICENSE.md).

## Component conventions (renderer code)

- One folder per component: `ComponentName/ComponentName.tsx` + `index.ts` barrel export.
- Co-locate by usage: used once → nest under the parent's `components/`; used 2+ times →
  promote to the highest shared parent.
- Tests, hooks, utils, and constants live next to the code that uses them.
- Exception: `src/components/ui/` (shadcn/ui) uses kebab-case single files — the shadcn CLI
  expects that format.
