# Handoff: Argus — ADE rebrand & design refresh

## Overview

ADE (`boostedchaos/ade`, branch `main`) is being rebranded to **Argus** with a full visual refresh of the Electron desktop app. macOS is the primary target; Windows 11 x64 must carry the same identity under Windows chrome. Dark-first, fully custom chrome (no attempt to look native on macOS beyond the traffic lights).

The identity is built on one idea: **the iris**. An open ring with a pupil is simultaneously the app mark and the per-agent status indicator. It replaces status dots, avatars and badges throughout the app.

Nothing about the product's information architecture changes: two-level Teams → Agents rail, session tabs, model bar, terminal, Agent Files panel, Mission Control panes. This is a reskin plus a small number of additive affordances (noted per screen).

## About the design files

`Argus Rebrand Directions.dc.html` is a **design reference created in HTML** — a prototype board showing intended look and behaviour, not production code to copy. The task is to recreate these designs inside the existing codebase: React 19 + TypeScript + Tailwind v4 renderer under `apps/desktop/src/renderer`, using the app's existing theme pipeline (`shared/themes`, `renderer/stores/theme`, CSS variables in `renderer/globals.css`) and existing components. Do not port the inline styles.

Open the file in a browser. It is a canvas: pan/zoom. Sections run newest-first (turn 8 at top, turn 1 at bottom). Each option has a visible id badge (`1a`, `2b`, `7c`…) used throughout this README. `support.js` must sit beside the HTML for it to render.

## Fidelity

**High fidelity.** Colors, type, spacing, and copy are final and should be matched. Two caveats:

- The app icon / tray / installer art in `5c` are geometric vector specs, not finished icon assets. They define construction (radii, strokes, size ladder) and should be rebuilt as real `.icns` / `.ico` / PNG assets from that spec.
- The phone view `4c` is directional; it targets `apps/webui`, which is less mature than the desktop app.

## Board index

| id | Screen | Platform |
| --- | --- | --- |
| 1a–1d | Four rejected/alternative identity directions (Whetstone, Argus, Golem, Gremlin) — context only | mac |
| 2·id | Argus identity sheet: mark, palette, type, iris states | — |
| 2a | Agent workspace — the primary screen | macOS |
| 2b | Agent workspace | Windows 11 |
| 3a | Mission Control (2×2 panes + todo rail) | macOS |
| 3b | Roster (no agent selected) | macOS |
| 3c | Settings — runtimes & keys | macOS |
| 4a | First run | macOS |
| 4b | New agent | macOS |
| 4c | Phone PWA (roster + one blocked session) | iOS Safari / PWA |
| 5a | Command palette | macOS |
| 5b | Mission Control | Windows 11 |
| 5c | Mark at every size, badges, DMG, wordmark | — |
| 6a | Theme token mapping (`ink.ts`) | — |
| 6b | Rename surface + screen→file map | — |
| 7a | Name alternates (rejected; Argus is locked) | — |
| 7b | Motion spec | — |
| 7c | Daylight (light theme) workspace | macOS |
| 7d | README hero + releases page | — |
| 8a | Empty & error states (4) | macOS |
| 8b | Agent Files / memory reading pane | macOS |

## Design tokens

### Ink (dark, default) — maps 1:1 onto the existing `Theme` / `UIColors` interface in `apps/desktop/src/shared/themes/types.ts`

Add as `apps/desktop/src/shared/themes/built-in/ink.ts`, register in `built-in/index.ts`, make it the default in the theme store, and update the pre-hydration fallback block in `renderer/globals.css` (`:root`). Keep ember / monokai / one-dark as alternates.

```
id: "ink", name: "Ink", type: "dark", isBuiltIn: true

ui:
  background            #0B0E14   (was #151110)
  foreground            #D7DDE8   (was #eae8e6)
  card                  #10141D
  cardForeground        #D7DDE8
  popover               #10141D
  popoverForeground     #D7DDE8
  primary               #D7DDE8
  primaryForeground     #0B0E14
  secondary             #16202F
  secondaryForeground   #D7DDE8
  muted                 #16202F
  mutedForeground       #7B8598
  accent                #16202F
  accentForeground      #D7DDE8
  tertiary              #0E1219      (panel toolbars, sidebar, titlebar)
  tertiaryActive        #141A25
  destructive           #E06A6A
  destructiveForeground #FFD9D9
  border                #1C2231      (the hairline — used everywhere)
  input                 #1C2231
  ring                  #21324A
  sidebar               #0E1219
  sidebarForeground     #D7DDE8
  sidebarPrimary        #4DA3FF      (was #e07850 — the accent change)
  sidebarPrimaryForeground #0B0E14
  sidebarAccent         #16202F
  sidebarAccentForeground #D7DDE8
  sidebarBorder         #1C2231
  sidebarRing           #21324A
  chart1..5             #4DA3FF #5FC48F #FFB547 #A78BFA #E06A6A
  highlightMatch        rgba(77,163,255,0.20)
  highlightActive       rgba(77,163,255,0.50)

terminal:
  background #0B0E14   foreground #B6C1D2   cursor #4DA3FF
  cursorAccent #0B0E14  selectionBackground rgba(77,163,255,0.22)
  black #0B0E14  red #E06A6A  green #5FC48F  yellow #FFB547
  blue #4DA3FF   magenta #A78BFA  cyan #63C7D6  white #D7DDE8
  brightBlack #3F4A5E  brightRed #EC8585  brightGreen #7FD6A8
  brightYellow #FFC873  brightBlue #7DBCFF  brightMagenta #C0A9FC
  brightCyan #84D8E4  brightWhite #FFFFFF
```

Additional non-token values used in the mocks (derive or add as needed):
`#0E1219` panel, `#141A25` raised, `#16202F` selected row, `#21324A` focus ring/active chip border, `#2B3448` idle iris stroke, `#3F4A5E` disabled text, `#5C6779` label text, `#7B8598` secondary text, `#9AA5B6` body text, `#C6CFDD` emphasis, `#E6ECF5` active tab text, `#E0CBA6` amber-on-dark text, `#8A7A5C` amber muted, `#5FC48F` pass green.

### Daylight (light) — `7c`

```
background #F6F7F9   card/panel #FFFFFF   terminal bg #FBFCFD
border #E4E8EF (#DFE4EC on the outer frame)
foreground #1A2130   body #3C465C   muted #64708A   faint #8A94A8   disabled #A8B1C2
accent (working) #1F6FD0        accent bg #EEF4FD
waiting #B8720D                 waiting bg #FDF6E9   waiting text #7A5A14
idle stroke #C2CBD8   pass #2F8F5B   destructive #C0392B
```
The blue darkens from `#4DA3FF` to `#1F6FD0` and amber from `#FFB547` to `#B8720D` so both hold ≥4.5:1 on white.

### Typography

- UI: **IBM Plex Sans**. Weights 300 (display/headings), 400 (body), 500 (active/selected labels). Never bold.
- Mono: **IBM Plex Mono**, weight 300 for terminal output and 400 for chips/paths/ids.
- Section labels: IBM Plex Mono, 10px, `letter-spacing: .24em`, `text-transform: uppercase`, color `#5C6779`. This is the single most identity-carrying detail — use it for every panel header.
- Wordmark: IBM Plex Sans 300, uppercase, `letter-spacing: .42em` (`.46em` at display sizes).
- Sizes: titlebar brand 14px · rail agent 13.5px · tab 13px · body 13–13.5px · terminal 12.5px · mono chips 11px · labels 10px · status bar 10.5px.

### Spacing, radii, borders

- Radii: window 10px (mac) / 8px (Windows); inner surfaces 2–3px on mac, 4px on Windows; **no pill shapes anywhere**.
- Borders: 1px `#1C2231` hairlines only. No shadows anywhere in the app. Separation is done with hairlines and background steps (`#0B0E14` → `#0E1219` → `#141A25`).
- Rail width 238px (mac) / 250px (Windows). Right panel 280px. Titlebar 46px (mac) / 40px (Windows). Tab strip 44px. Model bar 40px. Status bar 30px.
- Rail rows: 11px vertical padding, 18px horizontal, 12px gap between iris and label.
- Selected rail row: `background: linear-gradient(90deg, rgba(77,163,255,.10), transparent)` + `box-shadow: inset 2px 0 0 #4DA3FF`.
- Active tab: `box-shadow: inset 0 -1px 0 #4DA3FF` (mac). Windows uses a real raised tab: 34px tall, `border: 1px solid #1C2231` with no bottom border, `border-radius: 4px 4px 0 0`, background `#0B0E14` against a `#0E1219` strip.

## The iris (build this first)

One component, four states. Base geometry on a 14×14 viewBox: outer ring `r=6`, pupil `r=2`, stroke 1.

| State | Ring | Pupil |
| --- | --- | --- |
| working | `#4DA3FF` | filled `#4DA3FF` |
| waiting on you | `#FFB547` | filled `#FFB547` |
| idle | `#2B3448` | none |
| detached (daemon alive, UI disconnected) | `#2B3448`, `stroke-dasharray="2 2"` | none |

The app mark is the same object with an added outer ring: 72 viewBox, outer `r=31` stroke `#2B3448`, iris `r=14` stroke `#4DA3FF` width 2–3, pupil `r=4.5` filled. Below 20px the outer ring is dropped and the pupil grows (see `5c`): at 20px use ring `r=26` stroke 7, pupil `r=9`; at 16px mono use `r=24` stroke 9, pupil `r=10` in `#D7DDE8`.

Rules: never rotate the mark, never fill the outer ring, clear space = one ring diameter, minimum wordmark width 96px.

## Screens

### 2a — Agent workspace (macOS) — the primary screen

Layout, left to right: rail (238px) · main column (flex) · Agent Files panel (280px). Above them a 46px titlebar; the main column stacks tab strip (44px) → model bar (40px) → terminal (flex) → blocked-agent strip (conditional) → status bar (30px).

- **Titlebar**: traffic lights (11px circles, `#3A4356`) at left; mark + `ARGUS` wordmark; right side a `⌘K` affordance (1px border, 5px/12px padding) and a live status line — `● 1 working  ● 1 waiting` in mono 11px with 5px dots.
- **Rail**: mono-caps team headers (`CORE PLATFORM`, `INFRA`); agent rows with iris, name, and a right-aligned session count in `#4DA3FF` (working) or `?` in `#FFB547` (waiting). **Additive:** under a waiting agent, a two-line mono 10.5px reason in `#8A7A5C` (e.g. "needs an answer on the migration order"). Rail footer: `local · no cloud` / `~/.ade` in `#5C6779` / `#3F4A5E`.
- **Tab strip**: session names 13px; active tab gets a 5px blue dot and the inset bottom rule; `+ session` right-aligned in mono 11px.
- **Model bar**: mono 11px runtimes in a row, 22px gaps. Active runtime gets `box-shadow: 0 0 0 1px #21324A inset`, 4px/10px padding, 2px radius, `#4DA3FF` text. A `|` divider in `#3F4A5E` separates first-class CLIs (claude, codex, opencode) from OpenRouter models (kimi k2.7, minimax m3, glm 5.2).
- **Terminal**: 20px/22px padding, IBM Plex Mono 300 12.5px, line-height 1.95. Agent name prefix in `#4DA3FF`, a `·` separator in `#3F4A5E`, wrapped continuation lines indented 6 spaces. Tool lines use a `#7B8598` label column (`edit`, `test`) with `+18` in blue, `−6` in `#E06A6A`, `14 pass` in `#5FC48F`. Cursor is `▌` in `#4DA3FF`.
- **Blocked strip (additive)**: full-width bar above the status bar, `background: rgba(255,181,71,.05)`, top hairline, 12px/22px padding: amber iris + `rook is blocked on migrations — asked 4m ago` (13px `#E0CBA6`, session name in mono) + right-aligned `jump to it ⌥↵` in `#FFB547`. Shown only when another agent is waiting; clicking it switches to that session.
- **Status bar**: `● working` (blue) · `auth-refactor ↑2` · `claude-sonnet` · right-aligned `argus 0.4.0`. Mono 10.5px `#5C6779`.
- **Agent Files panel**: `MEMORY · PAT` label; file rows in mono 12px with right-aligned size; the recently-written file highlighted `background: rgba(77,163,255,.07)`, 2px radius, `#4DA3FF`, timestamp `now`; nested skill files indented 20px. Below a hairline, a `JUST LEARNED` block with the newest memory note at 13px/1.7 weight 300.

### 2b — Agent workspace (Windows 11)

Identical palette, type, iris and IA. Differences only:

- 40px titlebar in `#0E1219`; **caption buttons** at right: three 46px-wide hit areas (minimize = 11×1px bar, maximize = 10×10px 1px-border square, close = 11×11px ✕), all `#9AA5B6`; centred breadcrumb `core platform / pat / refactor-auth` in mono 11px `#5C6779`. Set Electron `titleBarOverlay` to `{ color: '#0E1219', symbolColor: '#9AA5B6', height: 40 }`.
- Window radius 8px; inner surfaces 4px.
- Rail 250px on `#0E1219`, with a search affordance row at top (`search · Ctrl K`, `#141A25`, 4px radius) and 12px-padded rows; the selected row is `#16202F` with a 3px rounded blue bar inset at the left.
- Real raised tabs (see radii above) with a per-tab `✕`.
- Model bar becomes bordered chips (6px/12px, 4px radius) rather than bare text; right-aligned `ConPTY`.
- Paths render with backslashes; the rail footer shows `%USERPROFILE%\.ade`; status bar reads `argus 0.4.0 · win11 x64`.
- Keyboard hints: `Ctrl K`, `Alt+Enter` instead of `⌘K`, `⌥↵`.

### 3a / 5b — Mission Control

2×2 CSS grid of panes + 286px todo rail. Pane header 34px (mac) / 38px (Windows): iris, agent name 12.5px, session name in mono 10.5px `#5C6779`.

- A pane whose agent is blocked gets `box-shadow: inset 0 0 0 1px rgba(255,181,71,.35)` (mac) or `border-color: rgba(255,181,71,.45)` (Windows) and an amber-tinted header.
- The fourth pane in the mock is a browser pane (skeleton bars `#141A25`).
- **Todo rail**: `WORKSPACE TODO` label; rows are done (✓ `#5FC48F`, strikethrough `#5C6779`), active (blue iris, `#D7DDE8`), blocked (amber ring, `#E0CBA6`), pending (`○ #3F4A5E`). Below: `PANE COMMANDS` listing `ade split right`, `ade type "2" --pane rook`, `ade read --pane pat`, `ade todo done 2` in mono 11.5px. Footer: `panes survive restarts`.
- On Windows the grid uses 10px gaps and each pane is a bordered `#0E1219` card with 4px radius, inside 10px window padding.

### 3b — Roster (nothing selected)

Full-bleed content, 44px/56px padding. Headline `Four agents, one machine.` at 30px weight 300, with `new agent ⌘N` right-aligned in mono 11px.

Table with mono-caps column heads (`agent`, `repo`, `runtime`, `last learned`, `seen`) over a `#1C2231` hairline; rows 20px vertical padding separated by `#131926`. Columns: 26px iris · 150px name (15px/500) · 180px repo (mono 11.5px) · 120px runtime · flex **last learned** (13px weight 300 — this is the point of the screen: each agent's newest memory note) · 90px right-aligned age, colored blue/amber/grey by state. The working agent's row gets the same gradient wash as the rail selection. Footer strip: `server · localhost:7777`, the tailnet URL, `argus 0.4.0`.

### 3c — Settings

216px nav (`Runtimes & keys` selected with the 2px inset blue bar + gradient) · content pane 34px/44px padding.

- Title 22px weight 300 + one-line 13.5px `#7B8598` explanation.
- Runtime table: iris · name · version · path. Missing runtimes show `not found` and the install command in `#4DA3FF`.
- OpenRouter key: masked value in a 1px-bordered field (max 520px), `replace` in blue, `encrypted at rest` in `#5C6779`; below, the three model chips it unlocks.
- Two-up footer: memory write-back toggles (34×18px track, `#21324A` on / `#1C2231` off, 14px knob `#4DA3FF` / `#3F4A5E`) and Appearance swatches — 60×34px `ink` (selected, blue border), `slate`, `daylight`.

### 4a — First run

Centred 660px column. Mark 56px, wordmark 22px, one 15px weight-300 paragraph: local-only, no account. Then a checklist where the iris is the check: git (version + longpaths), node, claude, optional CLIs (idle iris, `optional · not installed`), OpenRouter key (amber iris, `needed only for kimi · minimax · glm`, `add later`). Primary action `Create your first agent` (1px `#4DA3FF` border, 13px/26px padding, 3px radius) with `or restore from ~/.ade` beside it.

### 4b — New agent

Left column: 64px dashed photo drop target + name field (blue border, blue caret); repo and team fields side by side with mono helper text (`worktree · ~/.ade/agents/<uuid>/worktree`); runtime chips (unavailable runtimes greyed to `#3F4A5E` with `· not installed`); then a flexible `AGENT.md` editor showing the seeded brief (mono 12px, headings in `#4DA3FF`). Action `Create rook` + helper `creates worktree · seeds memory · opens a session`.

Right column (300px): `WHAT GETS WRITTEN` file tree (`AGENT.md`, `USER.md`, `MEMORY.md`, `skills/`, `worktree/`) and a note that memory lives outside the worktree.

### 4c — Phone PWA

393-class viewport. Screen 1 is the roster: 46px status area, brand row, team headers, 16px/20px agent rows (≥44px tall) with iris + name + `refactor-auth · working` in mono 10.5px; waiting agents get the amber tint. Screen 2 is one session: back chevron, iris, agent, session; transcript in mono 11.5px; and a **fixed answer bar** — the agent's enumerated options as full-width tap targets (`1`, `2`) plus a `type…` field. Principle: the phone is for unblocking, not working; no terminal input by default.

### 5a — Command palette

Dimmed workspace (28% opacity + `rgba(6,8,12,.66)` scrim). Dialog 660px, top 96px, `#0E1219`, 1px `#21324A`, 5px radius. Input row: mark + query in mono 15px weight 300 with blue caret + `esc`. Results grouped under mono-caps headers — **Sessions** (iris + `agent · session`, right-aligned state), **Memory** (searching memory contents is the differentiator; matched substring in `#4DA3FF`), **Commands** (`›` prefix + shortcut). Selected row uses the rail's gradient + inset blue bar. Footer: `↵ open` · `⌥↵ open in new pane` · `searches memory too`.

### 8a — Empty & error states

Four quadrants, each: 40px icon built from the iris grammar, 20px weight-300 title, ≤420px explanation at 13.5px, optional mono detail block, one primary action.

1. **No agents yet** — dashed idle ring. `Create an agent` / `⌘N`.
2. **Can't reach the server** — red ring with `!`. Copy must say sessions are still running in the daemon and nothing was lost; show `last seen 40s ago · localhost:7777` and the restart command; `Retry now` + auto-retry countdown.
3. **Runtime missing** — amber minus. Memory and worktree untouched; show the install command; primary action switches this session to an installed runtime.
4. **Worktree conflicts** — amber ✕. List `both modified` files; `Open the worktree`; explicitly does not auto-resolve.

### 8b — Agent Files / memory

Three columns: 250px file nav grouped `CANONICAL` / `TOPICS` / `SKILLS` / `BRIDGES` (bridges greyed with `generated · don't edit`) · reading pane · 266px write history.

Reading pane header: filename, `2.4k · written by pat 40s ago`, `edit`, `history`. Body renders MEMORY.md as sections under mono-caps labels (Conventions, Lessons, Rules from you, Index). Two provenance treatments:

- agent-written highlight: `border-left: 2px solid #4DA3FF` + `rgba(77,163,255,.06)`, with `· just added` in blue.
- user-authored: `border-left: 2px solid #2B3448`, `· yours, pinned`.

Legend in the footer plus `outside the worktree · never committed`. Right column: recent writes (age + one-line summary) and a note that the agent consolidates rather than appends.

## Motion (7b)

Four movements only. Everything else is instant.

| Movement | Trigger | Spec |
| --- | --- | --- |
| Iris wake | idle → working | 220ms `cubic-bezier(.2,.8,.2,1)`; pupil scales 0 → 1.5r → 1r, ring color crossfades `#2B3448` → `#4DA3FF` |
| Attention ring | agent becomes blocked | 900ms ease-out, **exactly 3 pulses then stop**; a second ring expands 6→6.6r fading .45→0. Never loops; the badge persists after |
| Pane focus | pane selected | 120ms linear; border `#1C2231` → `#4DA3FF` and background `#0E1219` → `#111A29`. No scale, no shadow, no reflow |
| Memory write | MEMORY.md updated | flash `rgba(77,163,255,.22)` in 90ms, out over 600ms |

Rules: motion reports state, never decorates. Nothing animates on load or while the terminal is streaming. No element changes position — only color, opacity and radius. `prefers-reduced-motion` drops every one to an instant state change. Max 2 concurrent animations. Duration tokens: 120 / 220 / 900ms.

## Rename surface (6b)

User-visible name changes:

| File | What |
| --- | --- |
| `apps/desktop/package.json` | `productName`, `appId`, build target names |
| `apps/desktop/src/main/lib/menu.ts` | app menu title, About panel |
| `apps/desktop/src/main/windows/main.ts` | window title, `titleBarOverlay` colors → `#0E1219` / `#9AA5B6` |
| `apps/desktop/src/main/lib/dock-icon.ts` | dock badge art — iris, blue/amber states |
| `apps/desktop/src/resources/tray/iconTemplate.png` | 16px mono mark |
| `apps/desktop/src/resources/build/icons/` | icns / ico / png ladder |
| `apps/desktop/src/renderer/index.html` | document title, `theme-color` → `#0B0E14`, favicon |
| `README.md`, `WINDOWS.md`, `CHANGELOG.md` | prose, download section, release channel names |

**Deliberately not renamed:** the `ade` CLI binary, `~/.ade` on disk, the `ade-server` package, and the ELv2 / `NOTICE` modification chain. Renaming the on-disk home or the CLI breaks existing installs and every agent skill that shells out to `ade`; if it ever happens it needs a migration and its own release.

## Screen → existing components

| Screen | Files |
| --- | --- |
| 2a / 2b | `renderer/screens/main/components/WorkspaceSidebar/`, `WorkspaceView/` |
| 3a / 5b | `WorkspaceView/` panes, `main/lib/control-plane/`, `components/AttentionBadge/` |
| 3b | `WorkspacesListView/`, `StartView/` |
| 3c | `SettingsButton/`, `renderer/stores/settings-state.ts`, `renderer/stores/theme/` |
| 4a / 4b | `WorkspaceInitEffects.tsx`, `renderer/stores/new-workspace-modal.ts`, `main/lib/agent-scaffold.ts` |
| 4c | `apps/webui`, `renderer/hooks/useIsMobile.ts` |
| 5a | `CommandPalette/`, `KeywordSearch/`, `SearchDialog/` |
| 5c | `main/lib/dock-icon.ts`, `resources/tray/`, `resources/build/icons/` |
| 6a | `shared/themes/built-in/`, `shared/themes/types.ts`, `renderer/globals.css` |
| 8b | Agent Files panel in `WorkspaceView/`, `renderer/stores/file-explorer.ts` |

## Suggested order of work

1. **Land `ink.ts` + `daylight`** and update the `globals.css` pre-hydration fallbacks. Most of the reskin arrives through the existing token pipeline with no component changes.
2. **Swap typography** to IBM Plex Sans / Mono and adopt the label grammar (mono 10px, `.24em`, uppercase, `#5C6779`) for every panel header.
3. **Build the iris component** and replace every status dot, avatar and badge with it.
4. **Additive affordances**: rail attention reason, blocked-session strip, Mission Control ringed pane.
5. **Empty/error states and the memory reading pane.**
6. **Name, icons, installer art, docs** — last, once the app already looks like itself.

## State

No new persistent state beyond what the app has. The additive pieces read existing signals: agent attention state (already tracked from agent hooks — working / waiting / idle), the blocked session id and how long it has been blocked, memory file mtimes and a provenance flag per memory block (agent-written vs user-pinned) for `8b`. Theme selection uses the existing theme store.

## Assets

- Fonts: **IBM Plex Sans** and **IBM Plex Mono** (SIL OFL). Bundle them locally rather than loading from Google Fonts — the app must work offline.
- All marks and icons in the board are inline SVG defined in this README's iris spec; no raster assets are required except the generated app/tray icons.
- No third-party imagery is used.

## Files in this bundle

- `Argus Rebrand Directions.dc.html` — the full design board (turns 1–8). Open in a browser.
- `support.js` — runtime required by the HTML board.
- `github.md` — repo association and screen→file map used during design.
- `screenshots/` — 2× PNG of every screen, safe to commit into the repo (e.g. `docs/design/`) and reference from the README:

| File | Screen |
| --- | --- |
| `2a-workspace-macos.png` | Agent workspace, macOS |
| `2b-workspace-windows11.png` | Agent workspace, Windows 11 |
| `3a-mission-control-macos.png` | Mission Control, macOS |
| `3b-roster.png` | Roster |
| `3c-settings.png` | Settings — runtimes & keys |
| `4a-first-run.png` | First run |
| `4b-new-agent.png` | New agent |
| `4c-phone-pwa.png` | Phone PWA |
| `5a-command-palette.png` | Command palette |
| `5b-mission-control-windows11.png` | Mission Control, Windows 11 |
| `5c-marks-and-icons.png` | Mark, size ladder, badges, DMG, wordmark |
| `6a-theme-tokens.png` | `ink.ts` token mapping |
| `6b-rename-and-file-map.png` | Rename surface + screen→file map |
| `7b-motion-spec.png` | Motion spec |
| `7c-daylight-light-theme.png` | Daylight light theme |
| `7d-readme-hero-releases.png` | README hero + releases |
| `8a-empty-and-error-states.png` | Empty & error states |
| `8b-agent-files-memory.png` | Agent Files / memory pane |

Rejected directions (`1a`–`1d`) and rejected name alternates (`7a`) are in the HTML board only.
