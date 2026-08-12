# Argus rebrand — build report

Branch `argus-rebrand` · branch point `ad2a48c` (main) · head `1816c2c`
Pushed to **`boosted`** (`github.com/boostedchaos/ade`). **Not merged, not released** — both are Kyle's call.

Contract: [SPEC.md](SPEC.md) · Design record: [../../design/argus/DESIGN-BRIEF.md](../../design/argus/DESIGN-BRIEF.md) · Live log: [PROGRESS.md](PROGRESS.md)

9 commits, one per phase plus a baseline commit. 146 files changed,
+3058 / −2331.

---

## 1. Ship gates

| # | Gate | Result |
| --- | --- | --- |
| 1 | Typecheck clean at repo root | ✅ **PASS** — 18/18 (was BROKEN on `main`) |
| 2 | Test baseline not regressed | ✅ **PASS** — 41 failures, byte-identical set |
| 3 | Packaged macOS build from `/private/tmp` | ✅ **PASS** — `Argus-0.4.2-arm64.dmg` |
| 4 | `windows-ci` green | ⏳ see §1.4 |
| 5 | Visual verification at 2× | ⚠️ **PARTIAL — static only.** See §1.5, this is the honest gap |
| 6 | Codex cross-check of the diff | ⏳ see §1.6 |

### 1.1 Typecheck — PASS

```
$ bun run typecheck
 Tasks:    18 successful, 18 total
```

**The gate did not pass at the branch point.** On `main` @ `ad2a48c`,
`@ade/webui#typecheck` failed:

```
../desktop/src/renderer/stores/tabs/control-plane-bridge.test 2.ts(1,38):
error TS2307: Cannot find module 'bun:test' or its corresponding type declarations.
```

Two Finder-duplicate files (`control-plane-bridge 2.ts`,
`control-plane-bridge.test 2.ts`) had been committed. Both were verified
**byte-identical** (`diff` clean) to their real counterparts and unreferenced by
any source file — the only mention anywhere was a stale
`apps/webui/.cache/tsbuildinfo.json` entry. Removed in the Phase 0 commit
(`60a5d71`), recoverable from history. This was out of the rebrand's scope but
blocked a mandatory gate, so it was converted to scope rather than routed
around.

### 1.2 Tests — PASS

Run from **each package's own cwd**, never with a path filter from the root.

| Package | pass | fail | skip | total | files | vs baseline |
| --- | --- | --- | --- | --- | --- | --- |
| `apps/desktop` | 889 | 37 | 0 | 926 | 60 | ✅ same 37 |
| `apps/server` | 19 | 0 | 0 | 19 | 2 | ✅ |
| `packages/cli` | 293 | 3 | 1 | 297 | 14 | ✅ same 3 |
| `packages/control-plane` | 274 | 0 | 2 | 276 | 11 | ✅ |
| `packages/server-core` | 504 | 1 | 2 | 507 | 35 | ✅ same 1 |
| `packages/shared` | 470 | 0 | 0 | 470 | 6 | ✅ |

**Baseline: 41 failures. Final: 41 failures.**

The comparison is **by failing test NAME, not by count** — the failure list was
captured at the branch point to `/private/tmp/argus-baseline/*.txt` and `diff`ed
after every phase. It came back identical every time. A count-only check would
have been worthless here, because the population moved.

**Population change, named rather than hidden:** desktop went from 914 tests /
57 files to 926 / 60. The entire delta is 12 tests I added (4 iris mapping,
3 relative-time, 5 motion). No pre-existing test was removed, renamed, or
skipped. The baseline failures are all pre-existing and unrelated to the
rebrand — setup-config loading, static ports, Windows `getUserName`, repo-root
resolution, hooks-from-disk.

One thing I changed rather than worked around: `Terminal/helpers.test.ts`
hardcoded ember's `#151110` as the expected terminal background, so switching
the default theme failed it. Rather than editing the literal to `#0B0E14` — the
same trap one rebrand later — the test now **derives** the expectation from
`DEFAULT_THEME_ID` via the theme registry. It asserts the property, not a
snapshot of it.

### 1.3 Packaged macOS build — PASS

Built from `/private/tmp/argus-build` (a full `rsync` copy), **not** from
`~/Documents`, per the File-Provider xattr trap.

```
$ env -i HOME=... PATH=... SUPERSET_WORKSPACE_NAME=default \
        CSC_IDENTITY_AUTO_DISCOVERY=false bash -lc 'bun run build'
exit 0
```

| Artifact | SHA-256 |
| --- | --- |
| `Argus-0.4.2-arm64.dmg` (160,775,806 B) | `08878199abb1645a3b872430241ab7defd26fe06b66dbf5c1afdc8dc7d018be4` |
| `Argus-0.4.2-arm64-mac.zip` (42,991,616 B) | `189011f5017b2702bc78a34c9fd48cd73b207c6d466f2b99af8626dede46a308` |

**Environment scrub — this one nearly bit.** My shell had
`SUPERSET_WORKSPACE_NAME=Ethel` along with 9 other `SUPERSET_*` variables. The
workspace name is a build-time `define`, so an unscrubbed build would have baked
*Ethel* into the binary. The build ran under `env -i` with exactly one
`SUPERSET_*` variable set.

Verified **in the packaged artifact**, not in the source that produced it:

- `Info.plist`: `CFBundleIdentifier=com.boostedchaos.argus`,
  `CFBundleName=Argus`, `CFBundleDisplayName=Argus`, `CFBundleExecutable=Argus`.
- `dist/main/index.js`: **zero** remaining `process.env.SUPERSET_WORKSPACE_NAME`
  lookups (the define replaced them), and `"default"` present.
- Searched the whole build tree for `Ethel`: 2 hits, both inside `.js.map`
  sourcemaps, and both are **a committed source comment** documenting a past bug
  about a workspace named "Ethel" — not an environment leak. Checked the
  surrounding bytes rather than trusting the match count.
- Unpacked `app.asar` and confirmed all **5 IBM Plex `.woff2` files** and **both
  tray templates** are inside the shipped bundle. This is the exact failure mode
  that shipped an entire missing section on mayo-world-site: the repo being
  right says nothing about what the package contains.
- Extracted the shipped `index-*.css` (421,730 B) out of `app.asar` and asserted
  the tokens against it — see §3.

### 1.4 windows-ci — dispatched

```
$ gh workflow run windows-ci.yml --ref argus-rebrand -R boostedchaos/ade
https://github.com/boostedchaos/ade/actions/runs/31609717875
```

Status at the time of writing: **in_progress**. Recent runs on this workflow
take ~13–15 min. **Result appended in §5 when it completes** — this report is
not claiming a pass it has not seen.

### 1.5 Visual verification — PARTIAL, and this is the real gap

**I did not launch the app.** The screen-by-screen comparison in §2 is based on
the built artifact and the source, not on a running window. That is weaker
evidence than the gate asks for, and I am not going to describe it as anything
else.

**Why I stopped:** the packaged `Argus.app` bakes
`SUPERSET_WORKSPACE_NAME=default`, so it uses `~/.ade-default` — **the same data
directory and the same terminal-host daemon as the ADE you are running right
now**, which is also the app hosting this session. The recorded trap for this
repo is that a daemon left running from a different app path produces "PTY
process exited immediately"; launching a second app against that daemon could
have taken your live session down mid-build. The new `appId` avoids the
single-instance lock but not the shared daemon.

**The 60-second check, for you to run when nothing is in flight:**

```
open /private/tmp/argus-build/apps/desktop/release/mac-arm64/Argus.app
```

Quit ADE first. If terminals do not attach, the recorded fix is:
`pkill -f "app.asar/dist/main/terminal-host.js"`, then relaunch.

What to look at first, in order of how likely I am to have got it wrong:

1. The **rail** — iris/name/count rows, and whether losing the folder-vs-laptop
   glyph actually bothers you (§4).
2. The **model bar** — it kept runtime icons instead of the mock's text labels
   (§4).
3. **Terminal line-height 1.95** — the brief's figure, and very airy for a
   terminal. Settings → Appearance overrides it.
4. **Daylight** — switch to it. It has the most derived (non-brief) values.

### 1.6 Codex cross-check — dispatched

`codex exec -m gpt-5.6-sol` against a 7,605-line diff (docs and binaries
excluded), with a tight brief: **hard cap of 8 findings**, a **mandatory
concrete failure scenario per finding**, and an explicit don't-report list
(style, naming, missing tests, a11y polish, performance speculation,
abstraction suggestions, docs, pre-existing issues, type nitpicks tsc already
passes).

Status at the time of writing: **still running**. **Result and my verification
of each claim appended in §5.** Findings are not accepted on Codex's say-so —
this reviewer is high-recall / variable-precision, and every claim gets checked
against the tree before it is treated as real.

---

## 2. Screen-by-screen visual checklist

**Method, stated honestly:** each row compares the 2× mock against source and
against the *shipped* stylesheet extracted from `app.asar`. Rows marked
**[static]** were not seen rendered. Nothing here is a claim about pixels on a
screen.

| Screen | What was compared | Result |
| --- | --- | --- |
| **2a** Workspace, macOS | Titlebar 46px + mark/wordmark + ⌘K chip + live status line; rail 238px with iris rows, 11/18px padding, gradient+2px selection; tab strip 44px with 5px dot + 1px accent rule; model bar 40px; blocked strip; status bar 30px mono; Agent Files panel with sizes | ◐ [static] — all geometry and tokens present; **model bar keeps icons** (§4) |
| **2b** Workspace, Windows 11 | 40px titlebar via `.platform-win32`; 4px surface radii; caption buttons rebuilt as 11×1 bar / 10×10 square / 11×11 ✕ at 46px wide; `Ctrl K` and `Alt+Enter` hints | ◐ [static] — `platform-win32` block confirmed in shipped CSS; **not seen on Windows** |
| **3a/5b** Mission Control | Blocked pane ring retargeted red → amber (`inset 0 0 0 1px`, tinted header) | ◐ [static] — rule confirmed in `mosaic-theme.css` |
| **3b** Roster | Inherited the global token/type/label pass; no bespoke rebuild | ◐ [static] — **not individually rebuilt** (§4) |
| **3c** Settings | Label grammar on section heads; `ARGUS_THEME_IDS` exported for the ink/daylight swatch row | ◐ [static] — **swatch row not rewired** (§4) |
| **4a** First run | Inherited global pass | ◐ [static] — **not rebuilt** (§4) |
| **4b** New agent | Inherited global pass | ◐ [static] — **not rebuilt** (§4) |
| **4c** Phone PWA | — | ⛔ **out of scope**, SPEC §Rulings 5 |
| **5a** Command palette | Scrim retargeted to `--argus-scrim` `rgba(6,8,12,.66)`, the brief's value | ◐ [static] |
| **5c** Marks and icons | `.icns` (10 sizes), `.ico` (6), `icon.png`, tray template 1×/2× — rebuilt from the geometric spec, size ladder honoured (outer ring dropped ≤20px) | ✅ **rendered and inspected** — see §3.3 |
| **6a** Theme tokens | `ink.ts` field-by-field against the brief | ✅ **verified 1:1**, verbatim |
| **7b** Motion | Four movements; 3-pulse cap; reduced motion; no positional properties | ✅ **asserted by test, canary-proven** — §3.2 |
| **7c** Daylight | Full `daylight.ts` + `:root.light` incl. `--argus-*` ladder | ◐ [static] — derived values flagged (§4) |
| **8a** Empty/error states | Quadrants 1 and 2 built to the grammar; 3 and 4 have no equivalent screen | ◐ **2 of 4** (§4) |
| **8b** Agent files / memory | Panel with real sizes/mtimes and the `now` highlight | ◐ **provenance markers NOT built** (§4) |

---

## 3. Evidence

### 3.1 Tokens in the SHIPPED stylesheet

Extracted from `app.asar` → `dist/renderer/assets/index-BRpE-38u.css`:

| Check | Result |
| --- | --- |
| Ember colours (`e07850`/`151110`/`eae8e6`) | **0 occurrences** |
| Ink `#0b0e14` / accent `#4da3ff` | 3 / 7 |
| Waiting `#ffb547` / pass `#5fc48f` / idle ring `#2b3448` | 5 / 3 / 1 |
| Daylight `#f6f7f9` / `#1f6fd0` / `#b8720d` | 2 / 7 / 5 |
| `IBM Plex Sans` / `IBM Plex Mono` | 4 / 3 |
| `.platform-win32` block | present |

The label grammar, shipped verbatim:

```css
.argus-label {
  font-family: var(--argus-font-mono);
  font-size: var(--argus-size-label);
  font-weight: var(--argus-weight-body);
  letter-spacing: .24em;
  text-transform: uppercase;
  color: var(--argus-text-label);
  line-height: 1;
}
```

Applied to **14 panel-header sites** found by sweeping `renderer/` for
`uppercase`. The brief calls this the single most identity-carrying detail and
says a missed panel header is a defect.

### 3.2 Motion — canary-proven, not just green

5 tests assert the stylesheet's properties. Green tests prove nothing on their
own, so the checker was tested against a known-bad control:

```
plant:   argus-attention-pulse ... ease-out 3 both  →  ease-out infinite both
result:  4 pass / 1 fail — "never loops the attention ring"   ← the checker fires
restore: from backup copy → 5 pass / 0 fail
```

Shipped keyframe and rule, confirmed in `app.asar`'s CSS:

```css
@keyframes argus-attention-pulse { 0% { r: 6; opacity: .45 } 100% { r: 6.6; opacity: 0 } }
.argus-iris-attention-ring { animation: argus-attention-pulse var(--argus-duration-slow) ease-out 3 both; }
```

The tests also assert no Argus keyframe touches `top/left/right/bottom/margin/
width/height/translate` — "no element changes position", so the terminal cannot
be reflowed by an animation.

**A subtle rule that needed code, not CSS:** the wake animation is deliberately
NOT attached to `.argus-iris-pupil`. A pupil that merely *exists* must not
animate, or every app launch and every rail re-render replays the wake on every
working agent at once — "nothing animates on load", broken invisibly.
`useWokeUp()` applies it only on a post-mount `idle → working` transition.

### 3.3 Icons — the failure that a clean exit code hid

First pass rendered the marks from SVG via ImageMagick. Exit code 0, correct
file sizes, valid PNG/ICNS/ICO headers — and **the icons were wrong**: a blue
dot on a dark plate, both rings missing, because ImageMagick's internal SVG
renderer silently drops stroked circles with `fill="none"`. Caught only by
rendering a preview and *looking at it*.

Rebuilt with ImageMagick primitives. Verified visually: outer ring, blue iris
ring, filled pupil; simplified two-element mark at small sizes.

`icon.ico` is hand-assembled with PNG-compressed payloads (10.4 KB, 6 sizes).
ImageMagick's BMP-payload output was 370 KB — 40× the icon it replaced.

### 3.4 Sweeps that were the real Daylight hazard

| Sweep | Count | Why it mattered |
| --- | --- | --- |
| Raw Tailwind palette colours → Argus tokens | **89** across 27 files | A Tailwind `amber-500` is the same hex in both themes; the design wants `#FFB547` in Ink and `#B8720D` on white |
| `shadow-*` removed | 15 across 11 files | "No shadows anywhere." Each de-shadowed floating element was checked to still carry a border |
| `font-bold`/`font-semibold` → `font-medium` | 40 across 29 files | Argus has no bold; `font-synthesis-weight: none` stops the browser faking one |
| `white/N`, `black/N` scrims and overlays | 8 | White-on-terminal overlays invert wrongly under Daylight |
| Radii retargeted at `--radius-*` | 64 files, 4 lines changed | Tailwind v4 resolves `rounded-md` → `var(--radius-md)`, so this reskins every `rounded-*` from one place **and** follows the platform (2px mac / 4px Windows) with no conditionals |

---

## 4. What I did NOT do, and why

Ordered by how much it matters.

1. **I did not launch the app** (gate 5). Risked taking down your live ADE
   session — shared daemon, shared `~/.ade-default`. Command in §1.5.

2. **8b's per-block provenance markers are not built.** The brief wants each
   memory block marked agent-written (blue border, `· just added`) or
   user-pinned (grey, `· yours, pinned`). SPEC §Phase 6 says derive it
   renderer-side "from write history rather than new persistent state" — **there
   is no write history.** The app records no per-block authorship and no
   per-file write log; mtime is per-*file* and cannot say who wrote which
   paragraph. Deriving it means inventing attribution, and a wrong
   "yours, pinned" on a line the agent actually wrote is worse than no marker.
   Needs a real write log — a feature, not a reskin. **Recorded, not fixed.**

3. **8a quadrants 3 and 4** (runtime missing, worktree conflicts) have no
   equivalent full-page state in the app — one is an install dialog off the
   model bar, the other surfaces in the changes view. Building them is new
   screens. `ArgusState` is built and exported for whoever does.

4. **`titleBarOverlay` was NOT set**, contradicting SPEC §Phase 4. This app has
   never used that option: it runs `frame: false` + `titleBarStyle: "hidden"`
   and draws its own caption buttons. Setting the overlay paints **native**
   Windows caption buttons on top of the custom ones — two sets. The overlay's
   stated colours and height (`#0E1219`, `#9AA5B6`, 40px) are applied to the
   components that actually render. Same result on screen.

5. **Model bar keeps runtime icons** instead of the mock's mono text labels. The
   icons plus their "not installed" markers are an existing product affordance
   the design bundle did not know about. Geometry, height and colours follow the
   brief. **Your call at visual review.**

6. **The rail lost the folder-vs-laptop glyph.** The 2a mock shows no repo-type
   marker, so the iris replaced it — but that glyph was the only carrier of
   "branch workspace vs repo workspace". `isBranchWorkspace` is still in
   `WorkspaceIcon`'s props so it can come back without an API change.

7. **The ⌘K titlebar chip is a hint, not a button.** The palette's open state is
   local to the workspace page; making it clickable means lifting it into a
   store — a behaviour change, and this is a reskin.

8. **Roster (3b), Settings (3c), First run (4a), New agent (4b)** were not
   individually rebuilt. They inherit the global token, type, radius, shadow and
   label passes, which is most of the reskin, but no per-screen work was done
   against their mocks. **The Settings Appearance swatch row still lists every
   built-in theme** rather than just ink/daylight — `ARGUS_THEME_IDS` is
   exported and ready, the row is not rewired.

9. **`dock-icon.ts` untouched.** The brief lists it as "dock badge art — iris,
   blue/amber states"; the actual file is a **dev-only** workspace-tint border,
   something else entirely. It picks up the new icon automatically.

10. **`detached` iris state renders nowhere**, per SPEC §Rulings 2 — built and
    drawable, not fed. Note the 2a mock *does* show it (agent `nova`, dashed
    ring). The SPEC wins.

11. **Code comments still say "ADE".** They refer to the codebase and repo,
    which are not renamed. Rewriting ~40 comments would bury the real rename in
    churn.

Two lines the blanket doc rename got **wrong**, caught by reading the diff:
the fork notice ("renamed back to ADE") is history and was restored, and the
ELv2 chain had become *"Argus is a modified derivative of Argus"* — nonsense,
and a false licensing statement. Both fixed; `NOTICE` now **appends** the
rebrand to the modification chain rather than overwriting the earlier entry.

---

## 5. Pending gates

Appended when they land.

### 5.1 windows-ci

Run `31609717875` — **result pending at the time of writing.**

### 5.2 Codex cross-check

**Result pending at the time of writing.** Every finding will be verified
against the tree before being treated as real, and the verdict on each recorded
here — including any I reject and why.
