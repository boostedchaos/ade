import type { Theme } from "../types";

/**
 * Daylight - the Argus light theme (screen 7c).
 *
 * The blue darkens from #4DA3FF to #1F6FD0 and amber from #FFB547 to #B8720D
 * so both hold >= 4.5:1 on white.
 *
 * The brief's Daylight block (docs/design/argus/DESIGN-BRIEF.md, "Daylight
 * (light) - 7c") gives a shorter list than Ink's, so a handful of interface
 * fields are DERIVED by mirroring Ink's role for the same token. Every derived
 * value is marked `derived:` below; everything unmarked is quoted from the
 * brief.
 */
export const daylightTheme: Theme = {
	id: "daylight",
	name: "Daylight",
	author: "Argus",
	type: "light",
	isBuiltIn: true,

	ui: {
		// Core
		background: "#F6F7F9",
		foreground: "#1A2130",
		card: "#FFFFFF",
		cardForeground: "#1A2130",
		popover: "#FFFFFF",
		popoverForeground: "#1A2130",

		// Primary - derived: mirrors Ink, where primary is the foreground and
		// primaryForeground is the background.
		primary: "#1A2130",
		primaryForeground: "#F6F7F9",

		// Secondary - the selected-row step. Ink uses its selected-row color
		// here; Daylight's equivalent is the accent background.
		secondary: "#EEF4FD",
		secondaryForeground: "#1A2130",

		// Muted
		muted: "#EEF4FD",
		mutedForeground: "#64708A",

		// Accent
		accent: "#EEF4FD",
		accentForeground: "#1A2130",

		// Tertiary - panel toolbars, sidebar, titlebar. In a light theme the
		// panel sits ABOVE the background rather than below it, so panel is
		// white on the #F6F7F9 field.
		tertiary: "#FFFFFF",
		// derived: the pressed/raised step, Ink's #141A25 role inverted.
		tertiaryActive: "#EDF1F7",

		// Destructive
		destructive: "#C0392B",
		// derived: text ON the destructive fill; white clears 4.5:1 on #C0392B.
		destructiveForeground: "#FFFFFF",

		// Borders - the hairline
		border: "#E4E8EF",
		input: "#E4E8EF",
		// derived: focus ring / active chip border, Ink's #21324A role.
		ring: "#C7D8F2",

		// Sidebar
		sidebar: "#FFFFFF",
		sidebarForeground: "#1A2130",
		sidebarPrimary: "#1F6FD0",
		// derived: text ON the primary fill.
		sidebarPrimaryForeground: "#FFFFFF",
		sidebarAccent: "#EEF4FD",
		sidebarAccentForeground: "#1A2130",
		sidebarBorder: "#E4E8EF",
		// derived: matches `ring` above.
		sidebarRing: "#C7D8F2",

		// Charts - derived: Ink's chart ramp, each hue darkened to its Daylight
		// counterpart (blue, pass green, waiting amber given by the brief;
		// violet and red darkened to match).
		chart1: "#1F6FD0",
		chart2: "#2F8F5B",
		chart3: "#B8720D",
		chart4: "#7C5CD6",
		chart5: "#C0392B",

		// Search highlights - derived: Ink's alpha ramp, pulled back so dark
		// body text stays readable through the fill.
		highlightMatch: "rgba(31, 111, 208, 0.18)",
		highlightActive: "rgba(31, 111, 208, 0.40)",
	},

	terminal: {
		background: "#FBFCFD",
		foreground: "#3C465C",
		cursor: "#1F6FD0",
		cursorAccent: "#FBFCFD",
		selectionBackground: "rgba(31, 111, 208, 0.18)",

		// Standard ANSI colors - derived: Ink's ANSI ramp darkened to hold
		// contrast on the #FBFCFD terminal field.
		black: "#1A2130",
		red: "#C0392B",
		green: "#2F8F5B",
		yellow: "#B8720D",
		blue: "#1F6FD0",
		magenta: "#7C5CD6",
		cyan: "#1F7A8C",
		white: "#3C465C",

		// Bright ANSI colors - derived, as above.
		brightBlack: "#8A94A8",
		brightRed: "#D4503F",
		brightGreen: "#3FA76D",
		brightYellow: "#CE8617",
		brightBlue: "#3B85E0",
		brightMagenta: "#8E70E2",
		brightCyan: "#2A8FA3",
		brightWhite: "#1A2130",
	},
};
