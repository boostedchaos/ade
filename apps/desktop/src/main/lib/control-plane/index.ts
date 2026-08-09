import { SUPERSET_DIR_NAME } from "@ade/server-core/constants";
import { app, BrowserWindow } from "electron";
import {
	ControlPlaneServer,
	getControlSocketPathFor,
	getControlTokenPathFor,
	phase1Commands,
} from "../../../../../../packages/control-plane/src/index";
import { createControlPlaneHost } from "./host";
import { RendererBridge } from "./renderer-bridge";

/**
 * Lifecycle wiring for the control socket.
 *
 * Socket and token paths are derived from SUPERSET_DIR_NAME, the same constant
 * the terminal-host socket uses, so Kyle's daily app (~/.ade-default) and an
 * agent worktree app (~/.ade-<ws>) never fight over one socket.
 */

let server: ControlPlaneServer | null = null;
let bridge: RendererBridge | null = null;

function defaultGetWindow(): BrowserWindow | null {
	return BrowserWindow.getAllWindows()[0] ?? null;
}

export async function startControlPlane(
	getWindow: () => BrowserWindow | null = defaultGetWindow,
): Promise<void> {
	if (server) return;

	bridge = new RendererBridge(getWindow);
	bridge.start();

	const host = createControlPlaneHost({
		appVersion: app.getVersion(),
		getWindow,
		bridge,
	});

	const instance = new ControlPlaneServer({
		socketPath: getControlSocketPathFor(SUPERSET_DIR_NAME),
		tokenPath: getControlTokenPathFor(SUPERSET_DIR_NAME),
		host,
		commands: phase1Commands,
	});

	try {
		await instance.start();
		server = instance;
	} catch (error) {
		// A control socket that cannot bind must never stop the app booting.
		bridge.stop();
		bridge = null;
		console.error(
			"[control-plane] Failed to start:",
			error instanceof Error ? error.message : error,
		);
	}
}

export async function stopControlPlane(): Promise<void> {
	const instance = server;
	server = null;
	bridge?.stop();
	bridge = null;
	if (!instance) return;
	try {
		await instance.stop();
	} catch (error) {
		console.error(
			"[control-plane] Failed to stop cleanly:",
			error instanceof Error ? error.message : error,
		);
	}
}

/**
 * The event bus, for Phase 2/3 to emit `agent-state-changed` and
 * `notification` onto without reaching into the server.
 */
export function getControlPlaneEvents(): ControlPlaneServer["events"] | null {
	return server?.events ?? null;
}

export { RendererBridge } from "./renderer-bridge";
