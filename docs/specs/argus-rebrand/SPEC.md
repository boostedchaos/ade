# Argus rebrand & design refresh — build spec

Status: **approved, not started** · Created 2026-08-12 · Owner: Kyle Welch

## What this is

ADE is being rebranded to **Argus** with a full visual refresh of the Electron
desktop app. macOS is the primary target; Windows 11 x64 carries the same
identity under Windows chrome.

The identity rests on one idea: **the iris**. An open ring with a pupil is
simultaneously the app mark and the per-agent status indicator. It replaces
every status dot, avatar and badge in the app.

This is a reskin plus a small number of additive affordances. **The information
architecture does not change.**

## Records of record

| Thing | Where |
| --- | --- |
| Design brief — tokens, per-screen specs, motion, rename surface | `docs/design/argus/DESIGN-BRIEF.md` |
| 2× PNG of every screen | `docs/design/argus/screenshots/` |
| This build contract (decisions, phases, gates) | this file |
| Live resume state during the build | `docs/specs/argus-rebrand/PROGRESS.md` (create at start) |

`DESIGN-BRIEF.md` is authoritative for **what it should look like**. This file
is authoritative for **what we decided and how we ship it**. Where they
disagree, this file wins — it was written after auditing the brief against the
tree.

## Pre-flight audit (2026-08-12) — what was verified

Audited against `boostedchaos/ade` `main` @ `22a9668`. Results:

- **Every file path named in the brief exists.** Themes, renderer components,
  `main/lib/dock-icon.ts`, `resources/tray/iconTemplate.png`,
  `resources/build/icons/`, `main/lib/control-plane/` — all present.
- **The token list maps 1:1 onto the real `UIColors` interface** in
  `apps/desktop/src/shared/themes/types.ts`, including `tertiary`,
  `tertiaryActive`, `chart1..5`, `highlightMatch`, `highlightActive`. No field
  in the brief is missing from the interface, and no interface field is
  unaddressed by the brief.
- **Token adoption is high.** 9 of 260 `.tsx` files under `renderer/` contain a
  hardcoded 6-digit hex; 4 Tailwind arbitrary-color classes total. The brief's
  claim that most of the reskin arrives through the token pipeline with no
  component changes holds.
- **The IA already matches the mocks.** `WorkspaceSidebar.tsx` renders a
  "Teams" header and `ProjectHeader.tsx` counts "N agents". No restructuring.
- **`theme-boot.js` carries no colors** (13 lines; it only toggles a
  `dark`/`light` class). The `:root` block in `renderer/globals.css` is
  genuinely the only pre-hydration fallback, as the brief says.

### Corrections to the brief

1. **Default theme id lives in `built-in/index.ts`, not the theme store.**
   The brief says "make it the default in the theme store". The store reads
   `DEFAULT_THEME_ID` exported from
   `apps/desktop/src/shared/themes/built-in/index.ts` (currently `"dark"`).
   Change it there.
2. **Existing built-in ids are generic** (`dark` = ember, `light`). Adding
   `ink` and `daylight` as new ids is safe: the store already falls back to
   `DEFAULT_THEME_ID` when a persisted `activeThemeId` no longer resolves
   (`renderer/stores/theme/store.ts:223,257`). Do **not** rename ember's id.

## Rulings on gaps in the brief

Five things the brief does not resolve. These are decided; do not re-litigate.

### 1. The `review` status has no iris state — **add a fifth state**

The app's `PaneStatus` is `idle | working | permission | review`
(`apps/desktop/src/shared/tabs-types.ts:24`). The brief defines four iris
states that do not line up. Binding mapping:

| App `PaneStatus` | Iris state | Ring | Pupil |
| --- | --- | --- | --- |
| `working` | working | `#4DA3FF` | filled `#4DA3FF` |
| `permission` | waiting on you | `#FFB547` | filled `#FFB547` |
| `review` | **ready for review** (new) | `#5FC48F` | none |
| `idle` | idle | `#2B3448` | none |
| — | detached | `#2B3448` dashed | none |

`#5FC48F` is the brief's own pass-green, so the new state stays inside the
established grammar. Note the color reassignment this forces: today `working`
is **amber** and `permission` is **red** in `StatusIndicator/`. Under Argus,
working is blue and waiting is amber. That is intended.

### 2. `detached` — **deferred, with a trigger**

Nothing in the app tracks "daemon alive, UI disconnected". The signal is
derivable (the terminal-host daemon is a separate process reachable over a unix
socket / named pipe) but wiring it is its own piece of work.

Build the iris component with all five states so the state is drawable, and
render it nowhere for now.

**Review trigger:** implement `detached` the first time a user-visible bug is
filed that reduces to "the app showed idle when the daemon was actually still
running", or when the daemon gains a health endpoint for any other reason.

### 3. The `slate` theme — **dropped**

`slate` appears exactly once in the brief, as a Settings appearance swatch
(`DESIGN-BRIEF.md` §3c), with no tokens defined anywhere in the bundle. Ship
two Argus themes: **`ink`** (dark, default) and **`daylight`** (light). The
Appearance row shows `ink` and `daylight` only. Keep ember / monokai / one-dark
registered as alternates but off the swatch row.

### 4. Fonts — **vendor IBM Plex locally, it is its own phase**

There is no font infrastructure today: no `font-family` declaration anywhere in
`renderer/globals.css`, so the app inherits Tailwind's system stack. IBM Plex
Sans + IBM Plex Mono (SIL OFL) must be added as bundled `.woff2` files.

The renderer CSP already sets `font-src 'self'` (`renderer/index.html`), so
local fonts work and remote fonts are blocked — bundling is required, not
optional.

### 5. Phone PWA (`4c`) — **out of scope**

`apps/webui` contains **one** `.tsx` file. Delivering screen `4c` is building a
mobile app, not reskinning one. It is excluded from this build. The screenshot
stays in `docs/design/argus/screenshots/` as direction for a future project.

## Kyle's decisions (2026-08-12)

- **Full rename, including `appId`.** `studio.persimmons.ade` becomes an Argus
  id. Accepted consequence: macOS treats it as a new application, so the
  existing `/Applications/ADE.app` will not auto-update into it — Kyle installs
  Argus.app once by hand and deletes the old app. Agent data in `~/.ade-default`
  is unaffected (it is keyed by the baked `SUPERSET_WORKSPACE_NAME`, not by
  `appId`).
- **Deliberately NOT renamed** (from the brief, ratified): the `ade` CLI binary,
  `~/.ade` on disk, the `ade-server` package, and the ELv2 / `NOTICE`
  modification chain. Renaming the on-disk home or the CLI breaks every existing
  install and every agent skill that shells out to `ade`.

## Phases

Commit at every phase boundary and post a one-line progress note. Update
`PROGRESS.md` as you go so a hard stop is cheap.

### Phase 1 — Themes

Land `ink` and `daylight` through the existing token pipeline.

- `apps/desktop/src/shared/themes/built-in/ink.ts` — new, tokens from
  `DESIGN-BRIEF.md` §"Ink (dark, default)".
- `apps/desktop/src/shared/themes/built-in/daylight.ts` — new, tokens from
  §"Daylight (light)".
- `apps/desktop/src/shared/themes/built-in/index.ts` — register both; set
  `DEFAULT_THEME_ID = "ink"`.
- `apps/desktop/src/renderer/globals.css` — replace the ember values in the
  `:root` pre-hydration block with ink's, and the `:root.light` block with
  daylight's.

Highest visual payoff, lowest risk. Verify by launching and confirming no ember
orange survives anywhere.

### Phase 2 — Typography

- Vendor IBM Plex Sans (300/400/500) and IBM Plex Mono (300/400) as `.woff2`
  under `apps/desktop/src/renderer/assets/fonts/`, with `@font-face` in
  `globals.css`. Bundle only the weights listed — never bold.
- Adopt the label grammar on **every** panel header: IBM Plex Mono, 10px,
  `letter-spacing: .24em`, uppercase, `#5C6779`. The brief calls this the single
  most identity-carrying detail; treat a missed panel header as a defect.
- Apply the size ladder from §Typography.

### Phase 3 — The iris

- One component, five states (§Rulings 1). Base geometry: 14×14 viewBox, outer
  ring `r=6`, pupil `r=2`, stroke 1.
- Replace every status dot, avatar and badge. Start from the 10 files that
  reference `StatusIndicator` or `AttentionBadge`; then sweep for remaining
  dots.
- The app mark is the same object plus an outer ring (72 viewBox) — see
  §"The iris" for the size ladder and the below-20px simplification.
- Rules: never rotate, never fill the outer ring, clear space = one ring
  diameter, minimum wordmark width 96px.

### Phase 4 — Chrome geometry

Titlebar, rail, tab strip, model bar, terminal, status bar, Agent Files panel —
macOS (`2a`) and Windows 11 (`2b`). Exact measurements in §2a / §2b.

Windows specifics that are easy to miss: `titleBarOverlay` becomes
`{ color: '#0E1219', symbolColor: '#9AA5B6', height: 40 }` in
`main/windows/main.ts`; real raised tabs rather than an underline; model bar
becomes bordered chips; backslash paths; `Ctrl K` / `Alt+Enter` hints.

Files: `renderer/screens/main/components/WorkspaceSidebar/`, `WorkspaceView/`
(and `ContentView/ModelBar/`, `ContentView/ContentHeader/`).

### Phase 5 — Additive affordances

The only genuinely new behavior in the refresh. All three read signals the app
already tracks (attention state, blocked session id and age).

1. **Rail attention reason** — two-line mono 10.5px `#8A7A5C` under a waiting
   agent.
2. **Blocked-session strip** — full-width bar above the status bar, shown only
   when another agent is waiting; clicking switches to that session (§2a).
3. **Mission Control ringed pane** — amber inset ring + tinted header on a
   blocked agent's pane (§3a / §5b).

### Phase 6 — States and the memory pane

- Empty & error states (`8a`), all four quadrants. The copy matters: the
  "can't reach the server" state must say sessions are still running in the
  daemon and nothing was lost.
- Agent Files / memory reading pane (`8b`), including the two provenance
  treatments (agent-written vs user-pinned). This needs a provenance flag per
  memory block — if none exists, add it as renderer-side derivation from write
  history rather than new persistent state.
- Also in this phase: Roster (`3b`), Settings (`3c`), First run (`4a`), New
  agent (`4b`), Command palette (`5a`).

### Phase 7 — Motion

Four movements only; everything else instant. Full spec in §Motion (7b).

Non-negotiables: nothing animates on load or while the terminal is streaming;
no element changes position (color, opacity and radius only); the attention ring
pulses **exactly three times then stops**, never loops; `prefers-reduced-motion`
collapses every movement to an instant state change; max 2 concurrent
animations. Duration tokens 120 / 220 / 900ms.

### Phase 8 — Name, icons, docs

Last, once the app already looks like itself. Rename surface table in
§"Rename surface (6b)". Includes `appId` (see Decisions).

The icon specs in `5c` are **geometric vector construction specs, not finished
assets** — rebuild real `.icns` / `.ico` / PNG ladder and the 16px mono tray
template from that spec.

## Ship gates

None of these is optional. Record evidence for each in `BUILD-REPORT.md`.

1. **Typecheck clean** at the repo root.
2. **Test baseline not regressed.** Run `bun test` from each package's own cwd —
   never with a path filter from the repo root, which silently runs a subset.
   The bar is "no worse than `main` at the branch point", not zero failures;
   measure the baseline first and record the number and the commit it came from.
3. **Packaged macOS build** from `/private/tmp` (packaging under `~/Documents`
   fails on File-Provider xattrs), with `SUPERSET_WORKSPACE_NAME=default` baked
   — it is a build-time `define`, runtime env is ignored. Scrub `SUPERSET_*`
   from the environment before building or an agent's workspace name leaks into
   the binary.
4. **`windows-ci` green.** On a feature branch it must be dispatched:
   `gh workflow run windows-ci.yml --ref <branch> -R boostedchaos/ade`.
5. **Visual verification against the screenshots**, screen by screen, at 2×.
   A checklist in `BUILD-REPORT.md` naming each screen and what was compared.
6. **Codex cross-check** of the diff (`-m gpt-5.6-sol`, tight brief with a hard
   finding cap and a mandatory concrete failure scenario per finding).

## Traps recorded from prior builds in this repo

- Push to remote **`boosted`** (github.com/boostedchaos/ade). `origin` points at
  the upstream fork `per-simmons/damon-ade` and 403s.
- **Never run `biome check --write` over `packages/server-core/src/agent-setup/`**
  — it parses the `*.template.mjs` files as JS and corrupts their `{{MARKER}}`
  placeholders.
- A second ADE/Argus instance **exits silently** (single-instance lock,
  `main/index.ts`). No crash report ≠ crash. Check `ps aux` before diagnosing a
  launch failure.
- After an app upgrade, "PTY process exited immediately" in
  `~/.ade-default/daemon.log` means the detached terminal-host daemon is still
  running from the **old** app path. Quit, `pkill -f
  "app.asar/dist/main/terminal-host.js"`, relaunch.

## Out of scope

- Phone PWA / `apps/webui` (§Rulings 5).
- The `detached` iris state's wiring (§Rulings 2) — the state is built, not fed.
- The `slate` theme (§Rulings 3).
- Renaming the `ade` CLI, `~/.ade`, or `ade-server` (§Decisions).
- Any release publish or merge to `main` — both are Kyle's call after review.
