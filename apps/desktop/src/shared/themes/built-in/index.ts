import type { Theme } from "../types";
import { daylightTheme } from "./daylight";
import { darkTheme } from "./ember";
import { inkTheme } from "./ink";
import { lightTheme } from "./light";
import { monokaiTheme } from "./monokai";
import { oneDarkTheme } from "./one-dark";

/**
 * All built-in themes.
 *
 * Argus ships `ink` and `daylight`; they lead the list because the Settings
 * Appearance row shows only those two. Ember (`dark`), `light`, monokai and
 * one-dark stay registered as alternates so a persisted selection still
 * resolves, but they are off the swatch row.
 *
 * Ember's id stays `dark` — renaming it would orphan every persisted
 * `activeThemeId`.
 */
export const builtInThemes: Theme[] = [
	inkTheme,
	daylightTheme,
	darkTheme,
	lightTheme,
	monokaiTheme,
	oneDarkTheme,
];

/**
 * Theme ids offered on the Settings > Appearance swatch row (3c).
 */
export const ARGUS_THEME_IDS = ["ink", "daylight"] as const;

/**
 * Default theme ID
 */
export const DEFAULT_THEME_ID = "ink";

/**
 * Get a built-in theme by ID
 */
export function getBuiltInTheme(id: string): Theme | undefined {
	return builtInThemes.find((theme) => theme.id === id);
}

// Re-export individual themes
export {
	darkTheme,
	daylightTheme,
	inkTheme,
	lightTheme,
	monokaiTheme,
	oneDarkTheme,
};
