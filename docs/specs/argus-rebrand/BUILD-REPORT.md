# Argus rebrand — build report

Branch `argus-rebrand` · branch point `ad2a48c` (main)
Merged to **`main`** on 2026-08-12 and pushed to **`boosted`** (`github.com/boostedchaos/ade`). **Not released** — cutting a release remains a separate, deliberate step.

Contract: [SPEC.md](SPEC.md) · Design record: [../../design/argus/DESIGN-BRIEF.md](../../design/argus/DESIGN-BRIEF.md) · Live log: [PROGRESS.md](PROGRESS.md)

One commit per phase, plus a baseline commit and two fixes for defects the
gates caught.

---

## 1. Ship gates

| # | Gate | Result |
| --- | --- | --- |
| 1 | Typecheck clean at repo root | ✅ **PASS** — 18/18 (was BROKEN on `main`) |
| 2 | Test baseline not regressed | ✅ **PASS** — 41 failures, byte-identical set |
| 3 | Packaged macOS build from `/private/tmp` | ✅ **PASS** — `Argus-0.4.2-arm64.dmg` |
| 4 | `windows-ci` green | ✅ **PASS** — after fixing a real break it caught |
| 5 | Visual verification at 2× | ⚠️ **PARTIAL — static only.** See §1.5, this is the honest gap |
| 6 | Codex cross-check of the diff | ✅ **DONE** — 2 findings, 1 confirmed and fixed |

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

> **CORRECTION, 2026-08-12 — this PASS was wrong, and the evidence for that is
> the command quoted below.** The build ran with `SUPERSET_WORKSPACE_NAME=default`
> set. It is a build-time `define`, so `default` was baked into the bundle and
> that artifact reads `~/.ade-default` instead of `~/.ade` — which
> `docs/releasing-mac.md` requires be unset for any public build. The gate was
> real (the app packaged, signed and ran); what it did not check was whether the
> result was *publishable*. The section is left as written because the defect is
> legible in it: the scrub paragraph below lists nine variables and misses the
> load-bearing tenth.
>
> The artifact hashed in the table below was therefore **never published**. The
> shipped `mac-v0.4.2` was rebuilt from a clean clone of `main` (`7daeeb8`) with
> all ten `SUPERSET_*` variables unset; its hashes are in the project folder's
> `SHA256SUMS.txt` and on the release. `docs/releasing-mac.md` now carries the
> pre-publish check that would have caught this.

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

### 1.4 windows-ci — PASS (second run; the first one caught a real bug)

**Run 1 `31609717875` — FAILED, and the cause was mine.**

Typecheck, the full desktop/control-plane/cli suites, the Windows package build
and the packaged-resource verification all passed. Then:

```
Start-Process -FilePath "release/win-unpacked/ADE.exe"
  → This command cannot be run due to the error: The system cannot find the file specified.
```

Renaming `productName` renames the built binary to `Argus.exe`. Three smoke
steps in `.github/workflows/windows-ci.yml` held the old literal. Nothing local
could have caught it — those steps are unreachable from a macOS build, and the
failure lands *after* everything else is green, which makes it read like flaky
infra rather than my change.

**Fixed by DERIVING, not substituting** (`1ca27ee`). Replacing `ADE.exe` with
`Argus.exe` would reintroduce the identical bug at the next rename:

```powershell
$exe = "release/win-unpacked/$((Get-Content package.json | ConvertFrom-Json).productName).exe"
```

Applied at all three call sites; the workflow was parsed to confirm each step
runs with `working-directory: apps/desktop`, so `package.json` resolves to the
file that actually declares `productName`.

**Run 2 `31611066395` — SUCCESS**, 11m41s, every step green including the three
smoke tests that never got to run before:

- ✅ Smoke: native modules load under packaged Electron
- ✅ Smoke: packaged app boots, initializes `~/.ade`, stays alive
- ✅ Smoke: installed CLI launcher reaches control server over named pipe

The last two are worth more than a green tick: they prove the **renamed** app
boots on Windows and that the deliberately **un-renamed** `ade` CLI still
reaches it over the named pipe. That is direct evidence for the rename boundary
in SPEC §Decisions, not an assumption about it.

**Left alone, and it is your call:** `release-desktop.yml` writes stable copies
named `ADE-<arch>.dmg`. Its globs still match the Argus artifacts so a release
would not fail — but that filename *is* the public
`/releases/latest/download/ADE-arm64.dmg` URL. Renaming it breaks every existing
link, which is an outward-facing product decision rather than a build fix.

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

### 1.6 Codex cross-check — DONE, 2 findings, 1 confirmed

`codex exec -m gpt-5.6-sol` over the 7,605-line diff, tight brief (hard cap of 8
findings, mandatory concrete failure scenario, explicit don't-report list).
82,479 tokens. It returned **2** findings — both within the bar, no noise.

Neither was accepted on its say-so; both were checked against the tree.

**FINDING 1 [high] — `appId` change breaks in-place upgrade. → REJECTED as a
defect; it is a recorded decision.**

Codex is factually right: `com.boostedchaos.argus` means the updater cannot
treat this as the same installed app. But that is not a bug — it is
SPEC §Decisions, which chose it *and named this exact consequence*: "macOS
treats it as a new application, so the existing `/Applications/ADE.app` will not
auto-update into it — Kyle installs Argus.app once by hand and deletes the old
app." Codex only had the diff, not the SPEC, so it could not know. Useful as an
**independent confirmation that the consequence is real** rather than as a
finding.

**FINDING 2 [low] — the memory-write flash can stick forever. → CONFIRMED, real,
and FIXED.**

Severity was understated; the mechanism was slightly wrong; the defect is real.

The clear timer lived inside the `files` effect, so its cleanup cancelled the
pending clear on *any* subsequent `files` change. If that change found nothing
new, the effect returned early **without scheduling a replacement**, and the row
stayed highlighted until the panel unmounted.

Codex's stated trigger — a refetch carrying identical data — would usually not
fire it, because React Query's structural sharing returns the same reference and
the effect never re-runs. The genuinely reachable trigger is different and more
likely: **an agent writes a NEW memory file.** That changes the array (so the
effect does re-run) without raising any existing file's mtime, so `changed` is
empty and the early return strands the highlight.

Fixed by splitting detection from clearing and keying the clear timer on
`flashing` itself rather than on `files`, which makes the invariant hold by
construction — whenever something is flashing, a timer to stop it exists.
Typecheck 18/18, tests unchanged at 889/37.

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

## 5. Final state

**All six gates resolved.** Five pass; gate 5 (visual) remains PARTIAL by
choice — see §1.5 for why and for the command to close it.

> **UPDATE, 2026-08-12 — gate 5 is now CLOSED, and gate 3's PASS was withdrawn.**
> Gate 5: Kyle ran a full working session inside Argus 0.4.2; the installed
> `/Applications/Argus.app` `app.asar` hashed identical to the one inside the
> dmg, and that day's `daemon.log` held 75 lines with zero ERROR or WARN.
> Gate 3: see the correction at §1.3 — the packaged build it passed was not
> publishable, and the shipped artifact was rebuilt. Net: the gate that was
> flagged as the honest gap held up, and the one marked PASS is the one that
> was wrong. **A self-declared gap gets re-checked; a green gate does not.**

Two real defects were caught by the gates and fixed, both mine:

1. **`windows-ci` smoke steps hardcoded `ADE.exe`** — caught by gate 4, fixed by
   deriving the name from `productName` (`1ca27ee`).
2. **The memory-write flash could stick permanently** — caught by gate 6, fixed
   by keying the clear timer on `flashing` rather than on `files`.

Both fixes went in as their own commits with the reasoning, and both were
re-verified (windows-ci rerun green; typecheck 18/18, tests at baseline).

The one gate I did not close is the one I could not close safely, and it is
stated as such rather than quietly marked green.
