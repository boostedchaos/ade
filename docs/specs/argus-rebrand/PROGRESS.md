# Argus rebrand — live build progress

Branch: `argus-rebrand` · Branch point: `ad2a48c` (main) · Remote: **`boosted`**

Contract: `docs/specs/argus-rebrand/SPEC.md`. Design record: `docs/design/argus/DESIGN-BRIEF.md`.

**Current phase:** Phase 0 — baseline measured, branch open.

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
| 1 — Themes | ⬜ not started | | |
| 2 — Typography | ⬜ not started | | |
| 3 — The iris | ⬜ not started | | |
| 4 — Chrome geometry | ⬜ not started | | |
| 5 — Additive affordances | ⬜ not started | | |
| 6 — States & memory pane | ⬜ not started | | |
| 7 — Motion | ⬜ not started | | |
| 8 — Name, icons, docs | ⬜ not started | | |

## Open items

- None yet.

## Deferred / not done

- `detached` iris state wiring — deferred by SPEC §Rulings 2 (state built, not fed).
- Phone PWA `4c` — out of scope, SPEC §Rulings 5.
- `slate` theme — dropped, SPEC §Rulings 3.
