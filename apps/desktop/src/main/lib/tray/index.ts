import { existsSync } from "node:fs";
import { join } from "node:path";
import { workspaces } from "@superset/local-db";
import { eq } from "drizzle-orm";
import {
	app,
	BrowserWindow,
	dialog,
	Menu,
	type MenuItemConstructorOptions,
	nativeImage,
	Tray,
} from "electron";
import { localDb } from "main/lib/local-db";
import { menuEmitter } from "main/lib/menu-events";
import {
	restartDaemon as restartDaemonShared,
	tryListExistingDaemonSessions,
} from "main/lib/terminal";
import { getTerminalHostClient } from "main/lib/terminal-host/client";
import type { ListSessionsResponse } from "main/lib/terminal-host/types";

const POLL_INTERVAL_MS = 5000;

const IS_WIN = process.platform === "win32";

/** Must have "Template" suffix for macOS dark/light mode support */
const TRAY_ICON_FILENAME = "iconTemplate.png";

/**
 * Windows tray icons want a full-color .ico (a macOS template image renders as
 * a black-on-transparent blob). We reuse the app icon.ico that already ships
 * for the installer. Note for E4/packaging: this file must be staged where the
 * packaged app can read it (extraResources / asarUnpack under resources/build/
 * icons or resources/tray), otherwise the win32 tray falls back to the
 * monochrome template png below.
 */
const WIN_TRAY_ICON_FILENAME = "icon.ico";

function firstExisting(paths: string[]): string | null {
	for (const p of paths) {
		if (existsSync(p)) return p;
	}
	return null;
}

function getTrayIconPath(): string | null {
	if (IS_WIN) {
		const winPath = app.isPackaged
			? firstExisting([
					join(
						process.resourcesPath,
						"app.asar.unpacked/resources/build/icons",
						WIN_TRAY_ICON_FILENAME,
					),
					join(
						process.resourcesPath,
						"app.asar.unpacked/resources/tray",
						WIN_TRAY_ICON_FILENAME,
					),
				])
			: firstExisting([
					join(
						app.getAppPath(),
						"src/resources/build/icons",
						WIN_TRAY_ICON_FILENAME,
					),
					join(__dirname, "../resources/build/icons", WIN_TRAY_ICON_FILENAME),
				]);
		if (winPath) return winPath;
		console.warn(
			"[Tray] Windows .ico not found; falling back to template png (will render monochrome)",
		);
		// Fall through to the shared template png below as a last resort.
	}

	if (app.isPackaged) {
		const prodPath = join(
			process.resourcesPath,
			"app.asar.unpacked/resources/tray",
			TRAY_ICON_FILENAME,
		);
		if (existsSync(prodPath)) return prodPath;
		return null;
	}

	const previewPath = join(__dirname, "../resources/tray", TRAY_ICON_FILENAME);
	if (existsSync(previewPath)) {
		return previewPath;
	}

	const devPath = join(
		app.getAppPath(),
		"src/resources/tray",
		TRAY_ICON_FILENAME,
	);
	if (existsSync(devPath)) {
		return devPath;
	}

	console.warn("[Tray] Icon not found at:", previewPath, "or", devPath);
	return null;
}

let tray: Tray | null = null;
let pollIntervalId: ReturnType<typeof setInterval> | null = null;

function createTrayIcon(): Electron.NativeImage | null {
	const iconPath = getTrayIconPath();
	if (!iconPath) {
		console.warn("[Tray] Icon not found");
		return null;
	}

	try {
		let image = nativeImage.createFromPath(iconPath);
		const size = image.getSize();

		if (image.isEmpty() || size.width === 0 || size.height === 0) {
			console.warn("[Tray] Icon loaded with zero size from:", iconPath);
			return null;
		}

		// 16x16 is standard menu bar size, auto-scales for Retina
		if (size.width > 22 || size.height > 22) {
			image = image.resize({ width: 16, height: 16 });
		}
		// Template images are a macOS concept — on Windows they'd render as a
		// black-on-transparent silhouette, so keep the full-color icon there.
		if (!IS_WIN) {
			image.setTemplateImage(true);
		}
		return image;
	} catch (error) {
		console.warn("[Tray] Failed to load icon:", error);
		return null;
	}
}

function showWindow(): void {
	const windows = BrowserWindow.getAllWindows();

	if (windows.length > 0) {
		const mainWindow = windows[0];
		if (mainWindow.isMinimized()) {
			mainWindow.restore();
		}
		mainWindow.show();
		mainWindow.focus();
	} else {
		// Triggers window creation via makeAppSetup's activate handler
		app.emit("activate");
	}
}

function openSettings(): void {
	showWindow();
	menuEmitter.emit("open-settings");
}

function openTerminalSettings(): void {
	showWindow();
	menuEmitter.emit("open-settings", "terminal");
}

function openSessionInSuperset(workspaceId: string): void {
	showWindow();
	menuEmitter.emit("open-workspace", workspaceId);
}

async function killSession(paneId: string): Promise<void> {
	try {
		const client = getTerminalHostClient();
		const connected = await client.tryConnectAndAuthenticate();
		if (connected) {
			await client.kill({ sessionId: paneId });
			console.log(`[Tray] Killed session: ${paneId}`);
		}
	} catch (error) {
		console.error(`[Tray] Failed to kill session ${paneId}:`, error);
	}

	await updateTrayMenu();
}

function getWorkspaceName(workspaceId: string): string {
	try {
		const workspace = localDb
			.select({ name: workspaces.name })
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.get();
		return workspace?.name || workspaceId.slice(0, 8);
	} catch {
		return workspaceId.slice(0, 8);
	}
}

function formatSessionLabel(
	session: ListSessionsResponse["sessions"][0],
): string {
	const attached = session.attachedClients > 0 ? " (attached)" : "";
	const shellName = session.shell?.split("/").pop() || "shell";
	return `${shellName}${attached}`;
}

function buildSessionsSubmenu(
	sessions: ListSessionsResponse["sessions"],
): MenuItemConstructorOptions[] {
	const aliveSessions = sessions.filter((s) => s.isAlive);
	const menuItems: MenuItemConstructorOptions[] = [];

	if (aliveSessions.length === 0) {
		menuItems.push({ label: "No active sessions", enabled: false });
	} else {
		const byWorkspace = new Map<string, ListSessionsResponse["sessions"]>();
		for (const session of aliveSessions) {
			const existing = byWorkspace.get(session.workspaceId) || [];
			existing.push(session);
			byWorkspace.set(session.workspaceId, existing);
		}

		let isFirst = true;
		for (const [workspaceId, workspaceSessions] of byWorkspace) {
			const workspaceName = getWorkspaceName(workspaceId);

			if (!isFirst) {
				menuItems.push({ type: "separator" });
			}
			menuItems.push({
				label: workspaceName,
				enabled: false,
			});

			for (const session of workspaceSessions) {
				menuItems.push({
					label: formatSessionLabel(session),
					submenu: [
						{
							label: "Open in ADE",
							click: () => openSessionInSuperset(session.workspaceId),
						},
						{
							label: "Kill",
							click: () => killSession(session.paneId),
						},
					],
				});
			}

			isFirst = false;
		}
	}

	menuItems.push({ type: "separator" });
	menuItems.push({
		label: "Terminal Settings",
		click: openTerminalSettings,
	});

	return menuItems;
}

async function quitApp(): Promise<void> {
	const { sessions } = await tryListExistingDaemonSessions();
	const hasActiveSessions = sessions.some((s) => s.isAlive);

	if (!hasActiveSessions) {
		app.quit();
		return;
	}

	const { response } = await dialog.showMessageBox({
		type: "question",
		buttons: ["Cancel", "Keep Sessions", "Kill Sessions"],
		defaultId: 1,
		cancelId: 0,
		title: "Quit ADE?",
		message: "Quit ADE?",
		detail:
			"Keep sessions running in the background, or kill all sessions and shut down the daemon?",
	});

	if (response === 0) {
		return;
	}

	if (response === 2) {
		await restartDaemonShared();
	}

	app.quit();
}

async function updateTrayMenu(): Promise<void> {
	if (!tray) return;

	const { sessions } = await tryListExistingDaemonSessions();
	const sessionCount = sessions.filter((s) => s.isAlive).length;

	const sessionsSubmenu = buildSessionsSubmenu(sessions);
	const sessionsLabel =
		sessionCount > 0
			? `Background Sessions (${sessionCount})`
			: "Background Sessions";

	const menu = Menu.buildFromTemplate([
		{
			label: sessionsLabel,
			submenu: sessionsSubmenu,
		},
		{ type: "separator" },
		{
			label: "Open ADE",
			click: showWindow,
		},
		{
			label: "Settings",
			click: openSettings,
		},
		{
			label: "Quit",
			click: quitApp,
		},
	]);

	tray.setContextMenu(menu);
}

/** Call once after app.whenReady() */
export function initTray(): void {
	if (tray) {
		console.warn("[Tray] Already initialized");
		return;
	}

	// Tray is supported on macOS and Windows. Linux tray support is
	// inconsistent across desktop environments, so it stays disabled there.
	if (process.platform !== "darwin" && !IS_WIN) {
		return;
	}

	try {
		const icon = createTrayIcon();
		if (!icon) {
			console.warn("[Tray] Skipping initialization - no icon available");
			return;
		}

		tray = new Tray(icon);
		tray.setToolTip("ADE");

		updateTrayMenu().catch((error) => {
			console.error("[Tray] Failed to build initial menu:", error);
		});

		pollIntervalId = setInterval(() => {
			updateTrayMenu().catch((error) => {
				console.error("[Tray] Failed to update menu:", error);
			});
		}, POLL_INTERVAL_MS);
		// Don't keep Electron alive just for tray updates
		pollIntervalId.unref();

		console.log("[Tray] Initialized successfully");
	} catch (error) {
		console.error("[Tray] Failed to initialize:", error);
	}
}

/** Call on app quit */
export function disposeTray(): void {
	if (pollIntervalId) {
		clearInterval(pollIntervalId);
		pollIntervalId = null;
	}

	if (tray) {
		tray.destroy();
		tray = null;
	}
}
