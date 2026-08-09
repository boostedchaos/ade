/**
 * Windows taskbar overlay-icon badge — the pre-rendered PNG side of the
 * attention badge (the count→key mapping is `overlayBadgeKey` in selectors).
 *
 * The main process has no canvas, so the digit badges are static assets shipped
 * under resources/build/icons/overlay-badge/. Resolution mirrors dock-icon.ts:
 * a src-relative path in dev/preview, the asar copy when packaged. Images are
 * cached — `setOverlayIcon` runs on every notification change.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, nativeImage, type NativeImage } from "electron";
import { overlayBadgeKey } from "./selectors";

const BADGE_SUBDIR = "resources/build/icons/overlay-badge";

/** "9+" is not a legal filename; the plus variant ships as 9plus.png. */
function badgeFilename(key: string): string {
	return `${key === "9+" ? "9plus" : key}.png`;
}

function badgeCandidates(filename: string): string[] {
	if (app.isPackaged) {
		// electron-builder copies all of src/resources → app.asar/resources; a
		// NativeImage reads fine from inside the asar.
		return [join(process.resourcesPath, "app.asar", BADGE_SUBDIR, filename)];
	}
	return [
		// Dev + preview: source tree (copyResourcesPlugin does not stage build/icons).
		join(app.getAppPath(), "src", BADGE_SUBDIR, filename),
		// Belt-and-braces for preview bundles that do stage it next to the bundle.
		join(__dirname, "..", BADGE_SUBDIR, filename),
	];
}

const cache = new Map<string, NativeImage | null>();

function loadBadge(key: string): NativeImage | null {
	if (cache.has(key)) return cache.get(key) ?? null;

	const filename = badgeFilename(key);
	const path = badgeCandidates(filename).find(existsSync);
	let image: NativeImage | null = null;
	if (!path) {
		console.warn(`[attention] Overlay badge asset not found: ${filename}`);
	} else {
		const loaded = nativeImage.createFromPath(path);
		image = loaded.isEmpty() ? null : loaded;
		if (!image) {
			console.warn(`[attention] Overlay badge loaded empty: ${path}`);
		}
	}
	cache.set(key, image);
	return image;
}

/**
 * The overlay image + accessible description for an unread count, or null when
 * there is nothing to show (the caller then clears the overlay). The
 * description carries the true count even when the icon is capped at "9+".
 */
export function overlayBadgeImage(
	count: number,
): { image: NativeImage; description: string } | null {
	const key = overlayBadgeKey(count);
	if (!key) return null;
	const image = loadBadge(key);
	if (!image) return null;
	const description =
		count === 1 ? "1 notification" : `${count} notifications`;
	return { image, description };
}
