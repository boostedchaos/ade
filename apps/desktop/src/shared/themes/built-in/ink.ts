import type { Theme } from "../types";

/**
 * Ink - the default Argus dark theme.
 *
 * Cool, near-black blue-grey. Separation is done with hairlines and background
 * steps (#0B0E14 -> #0E1219 -> #141A25 -> #16202F), never with shadows.
 * The accent is the iris blue #4DA3FF.
 *
 * Every value below is quoted verbatim from docs/design/argus/DESIGN-BRIEF.md
 * ("Ink (dark, default)"). Nothing here is derived.
 */
export const inkTheme: Theme = {
	id: "ink",
	name: "Ink",
	author: "Argus",
	type: "dark",
	isBuiltIn: true,

	ui: {
		// Core - near-black blue-grey
		background: "#0B0E14",
		foreground: "#D7DDE8",
		card: "#10141D",
		cardForeground: "#D7DDE8",
		popover: "#10141D",
		popoverForeground: "#D7DDE8",

		// Primary - light foreground for contrast
		primary: "#D7DDE8",
		primaryForeground: "#0B0E14",

		// Secondary - the selected-row step
		secondary: "#16202F",
		secondaryForeground: "#D7DDE8",

		// Muted
		muted: "#16202F",
		mutedForeground: "#7B8598",

		// Accent
		accent: "#16202F",
		accentForeground: "#D7DDE8",

		// Tertiary - panel toolbars, sidebar, titlebar
		tertiary: "#0E1219",
		tertiaryActive: "#141A25",

		// Destructive
		destructive: "#E06A6A",
		destructiveForeground: "#FFD9D9",

		// Borders - the hairline, used everywhere
		border: "#1C2231",
		input: "#1C2231",
		ring: "#21324A",

		// Sidebar
		sidebar: "#0E1219",
		sidebarForeground: "#D7DDE8",
		sidebarPrimary: "#4DA3FF",
		sidebarPrimaryForeground: "#0B0E14",
		sidebarAccent: "#16202F",
		sidebarAccentForeground: "#D7DDE8",
		sidebarBorder: "#1C2231",
		sidebarRing: "#21324A",

		// Charts - blue / pass green / waiting amber / violet / red
		chart1: "#4DA3FF",
		chart2: "#5FC48F",
		chart3: "#FFB547",
		chart4: "#A78BFA",
		chart5: "#E06A6A",

		// Search highlights - iris blue tint
		highlightMatch: "rgba(77, 163, 255, 0.20)",
		highlightActive: "rgba(77, 163, 255, 0.50)",
	},

	terminal: {
		background: "#0B0E14",
		foreground: "#B6C1D2",
		cursor: "#4DA3FF",
		cursorAccent: "#0B0E14",
		selectionBackground: "rgba(77, 163, 255, 0.22)",

		// Standard ANSI colors
		black: "#0B0E14",
		red: "#E06A6A",
		green: "#5FC48F",
		yellow: "#FFB547",
		blue: "#4DA3FF",
		magenta: "#A78BFA",
		cyan: "#63C7D6",
		white: "#D7DDE8",

		// Bright ANSI colors
		brightBlack: "#3F4A5E",
		brightRed: "#EC8585",
		brightGreen: "#7FD6A8",
		brightYellow: "#FFC873",
		brightBlue: "#7DBCFF",
		brightMagenta: "#C0A9FC",
		brightCyan: "#84D8E4",
		brightWhite: "#FFFFFF",
	},
};
