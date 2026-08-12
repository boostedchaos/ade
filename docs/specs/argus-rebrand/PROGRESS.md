# Argus rebrand — live build progress

Branch: `argus-rebrand` · Branch point: `ad2a48c` (main) · Remote: **`boosted`**

Contract: `docs/specs/argus-rebrand/SPEC.md`. Design record: `docs/design/argus/DESIGN-BRIEF.md`.

**Current phase:** Phase 5 — Additive affordances.

---

## Baseline at branch point

Measured on `argus-rebrand` @ `ad2a48c` before any rebrand edit.

### Typecheck (gate 1)

`bun run typecheck` at repo root **FAILED on `main`** — 16 of 18 tasks passed,
`@ade/webui#typecheck` errored:

```
../desktop/src/renderer/stores/tabs/control-plane-bridge.test 2.ts(1,38):
error TS2307: Cannot find module 'bun:test' or its corresponding type declarations.
```

Cause: two Finder-duplicate files were committed to the repo —
`control-plane-bridge 2.ts` and `control-plane-bridge.test 2.ts`. Both are
**byte-identical** (`diff` clean) to their real counterparts, and nothing in
`apps/` or `packages/` imports either one; the only reference was a stale
`apps/webui/.cache/tsbuildinfo.json` entry. The webui tsconfig has no
`bun:test` types, so the stray test copy broke its typecheck.

Removed both in the Phase 0 commit (`git rm`, recoverable from history). This
is outside the rebrand scope but blocks ship gate 1, so it was converted to
scope rather than routed around. **After removal: `bun run typecheck` → 18
successful, 18 total.**

### Tests (gate 2)

Run from each package's own cwd, per SPEC. `bun test` never matched the
duplicate file (its glob wants a literal `.test.ts` suffix), so removing it
**did not change the test population** — desktop stayed at 914 tests / 57
files before and after. Comparisons below are therefore population-stable.

| Package | pass | fail | skip | total | files |
| --- | --- | --- | --- | --- | --- |
| `apps/desktop` | 877 | **37** | 0 | 914 | 57 |
| `apps/server` | 19 | 0 | 0 | 19 | 2 |
| `packages/cli` | 293 | **3** | 1 | 297 | 14 |
| `packages/control-plane` | 274 | 0 | 2 | 276 | 11 |
| `packages/server-core` | 504 | **1** | 2 | 507 | 35 |
| `packages/shared` | 470 | 0 | 0 | 470 | 6 |

**Baseline failure count: 41.** The bar for gate 2 is "no worse than this".

The 41 failing test *names* are recorded at
`/private/tmp/argus-baseline/*.txt` so the end-of-build comparison is by name,
not just by count. They are all pre-existing and unrelated to the rebrand
(setup-config loading, static ports, Windows `getUserName`, repo-root
resolution, hooks-from-disk).

---

## Phase log

| Phase | State | Commit | Note |
| --- | --- | --- | --- |
| 0 — baseline | ✅ done | — | Baseline measured; blocking duplicate files removed; typecheck clean |
| 1 — Themes | ✅ done | `PH1` | `ink` + `daylight` land; ember orange gone from renderer/main; typecheck 18/18, tests at baseline |
| 2 — Typography | ✅ done | `PH2` | IBM Plex vendored (5 woff2, OFL); label grammar on 14 headers; 40 bold tokens demoted; verified in the BUILT css |
| 3 — The iris | ✅ done | `PH3` | `<Iris>` (5 states) + `<ArgusMark>` ladder + lockup; every status dot, avatar and old wordmark replaced; motion CSS landed |
| 4 — Chrome geometry | ✅ done | `PH4` | Titlebar/rail/tab strip/model bar/status bar geometry; radii retargeted; shadows gone; 89 Tailwind palette colors -> tokens |
| 5 — Additive affordances | ⬜ not started | | |
| 6 — States & memory pane | ⬜ not started | | |
| 7 — Motion | ⬜ not started | | |
| 8 — Name, icons, docs | ⬜ not started | | |

## Deviations from the SPEC (each deliberate, each with a reason)

**`titleBarOverlay` was NOT set.** SPEC Phase 4 asks for
`titleBarOverlay: { color: '#0E1219', symbolColor: '#9AA5B6', height: 40 }` in
`main/windows/main.ts`. This app has never set that option — it uses
`frame: false` with `titleBarStyle: "hidden"` and draws its own caption buttons
in `WindowControls.tsx`. Setting the overlay would paint NATIVE Windows caption
buttons on top of the custom ones, so the window would show two sets. The
overlay's colors and height are instead applied to the components that actually
render: `--argus-titlebar-height` (40px under `.platform-win32`),
`--argus-panel` (#0E1219) and `--argus-text-body` (#9AA5B6) on the caption
glyphs, which were rebuilt to the brief's primitives (11×1px bar, 10×10px
square, 11×11px ✕). Same result on screen; no duplicate controls.

**The ⌘K titlebar affordance is a hint, not a button.** The command palette's
open state is local to the workspace page (`useCommandPalette` holds it in
`useState`), so making the chip clickable means lifting it into a store — a
behavior change, and this build is a reskin. It renders exactly as the mock
draws it and shows `Ctrl K` on Windows.

**The model bar keeps runtime ICONS rather than the mock's text labels.** The
mock lists runtimes as mono text (`claude  codex  opencode | kimi k2.7 …`); the
real component renders icon buttons with tooltips and a "not installed" marker.
Converting to text would drop the icons, which are an existing product
affordance the design bundle did not know about. Geometry, height, colors and
radii follow the brief. Flagged for Kyle's call at visual review.

## Open items

- `:root.platform-win32` geometry vars are declared in `globals.css` and the
  class is stamped by `theme-boot.js`, but nothing consumes them until Phase 4.
- The Settings Appearance swatch row (3c) must read `ARGUS_THEME_IDS` from
  `shared/themes/built-in` rather than `builtInThemes` — wired in Phase 6.
- The rail no longer distinguishes a branch workspace from a repo workspace.
  The folder/laptop glyph was the only carrier of that bit and the 2a mock has
  no repo-type marker; `isBranchWorkspace` is still in `WorkspaceIcon`'s props
  so it can be re-surfaced without an API change. Flagged for Kyle at visual
  review.
- `detached` is built and drawable but rendered nowhere, per SPEC §Rulings 2.
  Note the 2a mock DOES show it (agent `nova`, dashed ring) — the SPEC wins.
- Phase 7 still owns wiring `pulse` to real blocked-agent state, the pane-focus
  transition and the memory-write flash. The CSS for all four movements is
  already in `globals.css`; only the iris wake is currently driven.
- Terminal line-height 1.95 is the brief's figure and is airy for a terminal.
  It is user-overridable from Settings > Appearance; flagged for Kyle's eye at
  visual review rather than silently softened.

## Deferred / not done

- `detached` iris state wiring — deferred by SPEC §Rulings 2 (state built, not fed).
- Phone PWA `4c` — out of scope, SPEC §Rulings 5.
- `slate` theme — dropped, SPEC §Rulings 3.
