import type { ITerminalOptions } from "@xterm/xterm";

// Use user's theme
export const TERMINAL_THEME: ITerminalOptions["theme"] = undefined;

// Fallback timeout for first render (in case xterm doesn't emit onRender)
export const FIRST_RENDER_RESTORE_FALLBACK_MS = 250;

// Debug logging for terminal lifecycle (enable via localStorage)
// Run in DevTools console: localStorage.setItem('SUPERSET_TERMINAL_DEBUG', '1')
export const DEBUG_TERMINAL =
	typeof localStorage !== "undefined" &&
	localStorage.getItem("SUPERSET_TERMINAL_DEBUG") === "1";

// IBM Plex Mono is the Argus terminal face and leads the stack, but font
// fallback here is PER GLYPH, not per stack: Plex Mono has no Nerd Font
// private-use glyphs, so a Powerlevel10k / Oh My Posh prompt would render
// tofu if the Nerd Fonts were dropped. They stay directly behind Plex Mono,
// which means latin text renders as Plex and only the powerline glyphs fall
// through — both requirements are met without choosing between them.
export const DEFAULT_TERMINAL_FONT_FAMILY = [
	'"IBM Plex Mono"',
	"MesloLGM Nerd Font",
	"MesloLGM NF",
	"MesloLGS NF",
	"MesloLGS Nerd Font",
	"Hack Nerd Font",
	"FiraCode Nerd Font",
	"JetBrainsMono Nerd Font",
	"CaskaydiaCove Nerd Font",
	"Menlo",
	"Monaco",
	'"Courier New"',
	// SF fonts for Apple tools (swift, xcodebuild) that use SF Symbols private use area characters
	"SF Mono",
	"SF Pro",
	"monospace",
].join(", ");

// DESIGN-BRIEF.md "Typography": terminal 12.5px, IBM Plex Mono 300,
// line-height 1.95. User-overridable from Settings > Appearance.
export const DEFAULT_TERMINAL_FONT_SIZE = 12.5;
export const DEFAULT_TERMINAL_LINE_HEIGHT = 1.95;

export const TERMINAL_OPTIONS: ITerminalOptions = {
	cursorBlink: true,
	fontSize: DEFAULT_TERMINAL_FONT_SIZE,
	fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
	fontWeight: 300,
	// Argus has no bold face; 400 is the heaviest mono weight bundled.
	fontWeightBold: 400,
	lineHeight: DEFAULT_TERMINAL_LINE_HEIGHT,
	theme: TERMINAL_THEME,
	allowProposedApi: true,
	scrollback: 2000,
	// Allow Option+key to type special characters on international keyboards (e.g., Option+2 = @)
	macOptionIsMeta: false,
	cursorStyle: "block",
	cursorInactiveStyle: "outline",
	screenReaderMode: false,
};

export const RESIZE_DEBOUNCE_MS = 150;
