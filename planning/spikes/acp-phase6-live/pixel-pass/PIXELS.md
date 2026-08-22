# Pixel pass — dev build, driven via the app's own CDP (2026-08-22)

Method: `DESKTOP_AUTOMATION_PORT=9224 bun run dev`, then CDP over that port
(Page.captureScreenshot + Input events). The port's OWNER was verified by
pid/binary before driving — a first attempt connected to the production app's
CDP (every Argus instance self-binds `DESKTOP_AUTOMATION_PORT || 41729`;
setup.ts:73-75) and was caught by Kyle. Screenshots are of the app's own
window; no macOS screen-capture permission involved.

Verified on pixels (dev build, workspace "Coding Bruh / Rupert"):

1. `dev-flip.png` — "New session — Claude" opened an ACP pane (Phase 6 flip),
   tab named by workspace (A9); control bar renders model/effort/fast/agent
   (Phase 4); "Restored previous session. / Dismiss" strip (B1/A10) with the
   workspace's newest prior conversation REPLAYED including user turns
   (A3/A8 resume parity — first-ever ACP pane in that workspace).
2. `dev-palette-wr.png` — typing `/wr` opens the palette with `/wrap-up` +
   one-line truncated description (Phase 5).
3. `dev-question.png` — AskUserQuestion renders as a question card: field
   title, Red/Blue option buttons (selection highlight), "Other" free-text,
   Submit/Decline (A5/B2); titlebar shows "1 waiting" and the tab is ringed
   (A6 status → Mission Control).
4. `dev-final.png` — card settled to "Answered: Blue" with a check; agent
   replied "You picked **Blue**"; two further live tool cards (Bash cat +
   Edit) with success status icons (Phase 3); usage chip ticked
   47.6k → 49.1k / 1M · 5% (Phase 3 meter).

Known cosmetic gap, per design out-of-scope: markdown in agent text renders
literally (`**Blue**`). Side effect of the run: the dev sandbox agent
(Rupert, `.ade-ethel`) saved "prefers Blue" to its own memory/USER.md —
harmless, its data.

Not covered: permission-mode ("Ask me") card pixels — the mechanism was
live-verified at the host layer (`al1-verify.ts`); its card shares the
AcpRequestCard component verified in 3/4.
