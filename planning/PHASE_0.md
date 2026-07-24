---
type: reference
tags: [repo/papyrus-ade]
up: "[[Repos/papyrus-ade/planning/PLAN_MAIN|PLAN_MAIN]]"
---
# Phase 0 — Fork groundwork & rebrand (~0.5–1 day)

Make the fork legally tidy, named Papyrus, and lean — before any architecture
work. Everything here is cheap now and expensive later (renames touch more
files every week; the license notice must predate any distribution).

## 1. License compliance (ELv2 chain)

The repo is Elastic License 2.0, Copyright Superset, Inc.; per-simmons' ADE is
already a derivative documented in `NOTICE`. Papyrus extends that chain — it
does **not** replace it.

- Keep `LICENSE.md` and `THIRD-PARTY-NOTICES.md` byte-identical.
- Append a Papyrus block to `NOTICE` **below** the existing ADE block
  (prominent-modification-notice requirement). Draft:

  ```
  Papyrus

  This product is a modified derivative of ADE (itself a derivative of
  Superset, Copyright Superset, Inc.), distributed under the Elastic
  License 2.0. The full license terms are in LICENSE.md.

  Modifications made in this derivative include, but are not limited to:

    - Renamed the product to Papyrus.
    - Restructured the application as a client–server system: a headless
      papyrus-server daemon and a browser-based web UI, replacing the
      macOS-only Electron packaging as the primary form factor.
    - Added Windows support for the server and terminal host.
    - Removed the remaining Superset hosted-cloud applications.

  Use of this software remains subject to the Elastic License 2.0.
  ```

- Add a short "License" section to the README noting: self-hosting for your
  own use is fine; offering Papyrus to third parties as a hosted/managed
  service is prohibited by ELv2. (Guards against future accidental drift —
  see risk table in [PLAN_MAIN.md](PLAN_MAIN.md) §6.)

## 2. Rename ADE → Papyrus

- **User-facing strings**: app name, window titles, menu labels, README,
  `apps/desktop/package.json` `productName`/description. Package scope renames
  (`@ade/desktop` → `@papyrus/desktop`) are optional now — cosmetic, and they
  churn every import; defer to taste.
- **Data directory**: `apps/desktop/src/main/lib/app-environment.ts` resolves
  `APP_DATA` to `~/.ade[-<workspace>]`. **Decision (recommended): rename to
  `~/.papyrus` now with a one-time migration** — on first boot, if
  `~/.papyrus` is absent and `~/.ade` exists, move (rename) the directory and
  log it. It's early enough that migration is trivial; every week of delay
  adds agents/state to migrate.
- **Do not rename** things that carry upstream identity for license reasons
  (`LICENSE.md` copyright line, NOTICE chain) or that would break the
  terminal-host handshake mid-migration — the daemon socket dir `~/.superset/`
  moves in Phase 1 with the named-pipe work, not here.

## 3. Quarantine the Superset cloud leftovers

These apps are upstream Superset's multi-tenant cloud product, untouched by
the ADE fork, and are **not** what Papyrus builds on (PLAN_MAIN §3):
`apps/{web, api, mobile, admin, marketing, streams}`.

- Remove them from the workspace/Turbo graph rather than deleting outright
  (git preserves history either way, but quarantine is compile-checked and
  reversible): move to `attic/` **or** drop them from the root `package.json`
  workspaces + `turbo.json` pipeline.
- Clean root `package.json` scripts that reference them: `dev` (filters
  `@superset/api`, `@superset/web`), `dev:caddy`, `dev:docs`,
  `dev:marketing`, `db:push`/`db:migrate` (cloud `packages/db`).
- **Packages audit** — the desktop app must keep building. Suspected
  cloud-only: `packages/{db, auth, email, chat, chat-mastra}`. Known-needed:
  `packages/{local-db, ui, shared, trpc, agent, mcp, desktop-mcp, scripts}`.
  Verify with a build + `grep` for imports from quarantined packages inside
  `apps/desktop`; anything shared that leaks in gets inlined or stubbed.
- Deploy leftovers (`Caddyfile.example`, `fly.toml`): keep
  `Caddyfile.example` (Phase 3 reuses it for the LAN TLS alternative); drop
  `fly.toml`.
- **Delete for real only after M1** (Phase 2 exit), when we know nothing
  shared is still imported.

## 4. README rewrite

Replace the ADE README with: what Papyrus is, the one-server/any-screen
architecture diagram, current status (pre-implementation), the license
section, and a pointer to `planning/`.

## Checklist

- [x] Append Papyrus modification block to `NOTICE` (keep Superset → ADE chain)
- [x] Verify `LICENSE.md` + `THIRD-PARTY-NOTICES.md` untouched
- [x] Rename user-facing strings ADE → Papyrus (src, scripts, electron-builder, workflows, release docs, protocol `papyrus://`, appId `dev.cameroncrow.papyrus`)
- [x] `~/.ade` → `~/.papyrus` one-time migration in `app-environment.ts` (+ env var `PAPYRUS_HOME_DIR`)
- [x] Quarantine `apps/{web,api,mobile,admin,marketing,streams}` from workspace + turbo graph (explicit workspaces list)
- [x] Clean root `package.json` scripts (dev filters, caddy, db:push/migrate)
- [x] Audit `packages/*` imports — desktop imports `@superset/{auth,chat,chat-mastra,db}` directly, so those packages STAY in the graph; deeper untangling deferred to Phase 1 extraction
- [x] Drop `fly.toml`; keep `Caddyfile.example` for Phase 3
- [x] Rewrite README (identity, architecture, license note)

**Exit:** repo builds, is legally tidy, and carries only what Papyrus uses.

## Related

- [[Repos/papyrus-ade/planning/PLAN_MAIN|PLAN_MAIN]]
- [[Repos/papyrus-ade/planning/PHASE_1|PHASE_1]]
- [[Repos/papyrus-ade/planning/TODO|TODO]]
