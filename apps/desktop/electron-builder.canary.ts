/**
 * Electron Builder Configuration - Canary Build
 *
 * Extends the base config with canary-specific overrides for internal testing.
 * Can be installed side-by-side with the stable release.
 *
 * @see https://www.electron.build/configuration/configuration
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Configuration } from "electron-builder";
import { type BuildTarget, createConfig } from "./electron-builder";
import pkg from "./package.json";

const productName = "ADE Canary";
const canaryMacIconPath = join(pkg.resources, "build/icons/icon-canary.icns");
const canaryLinuxIconPath = join(pkg.resources, "build/icons/icon-canary.png");
const canaryWinIconPath = join(pkg.resources, "build/icons/icon-canary.ico");

// Target-aware like createConfig: the "win" target stages natives from
// `.win32-natives/`, so canary Windows builds must layer these overrides on
// createConfig("win"), not the default config (electron-builder.canary.win.ts).
export function createCanaryConfig(
	target: BuildTarget = "default",
): Configuration {
	const baseConfig = createConfig(target);

	return {
		...baseConfig,
		appId: "studio.persimmons.ade.canary",
		productName,

		// Inherit the public release repo from the base config (single source of
		// truth). Only the release type differs for canary.
		publish: {
			...(baseConfig.publish as Record<string, unknown>),
			releaseType: "prerelease",
		},

		mac: {
			...baseConfig.mac,
			...(existsSync(canaryMacIconPath) ? { icon: canaryMacIconPath } : {}),
			artifactName: `ADE-Canary-\${version}-\${arch}.\${ext}`,
			extendInfo: {
				...baseConfig.mac?.extendInfo,
				CFBundleName: productName,
				CFBundleDisplayName: productName,
			},
		},

		linux: {
			...baseConfig.linux,
			...(existsSync(canaryLinuxIconPath) ? { icon: canaryLinuxIconPath } : {}),
			synopsis: `${pkg.description} (Canary)`,
			artifactName: `ade-canary-\${version}-\${arch}.\${ext}`,
		},

		win: {
			...baseConfig.win,
			...(existsSync(canaryWinIconPath) ? { icon: canaryWinIconPath } : {}),
			artifactName: `ADE-Canary-\${version}-\${arch}.\${ext}`,
		},
	};
}

const config = createCanaryConfig("default");

export default config;
