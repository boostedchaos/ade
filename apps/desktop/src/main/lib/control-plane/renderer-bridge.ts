import { randomUUID } from "node:crypto";
import { BrowserWindow, ipcMain } from "electron";
import {
	type BridgeOp,
	ControlError,
} from "../../../../../../packages/control-plane/src/index";

/**
 * Main half of the control-plane bridge.
 *
 * Imported by relative path rather than as `@ade/control-plane`: the package
 * has no dependency edge from apps/desktop, so the bare specifier does not
 * resolve (verified — bun errors "Cannot find module"), and adding the edge
 * would mean editing apps/desktop/package.json and bun.lock, which this lane
 * does not own. electron.vite.config.ts already references
 * ../../packages/server-core by relative path, so this is the house pattern.
 *
 * Transport is plain Electron IPC (`webContents.send` + `ipcMain.on`), not
 * tRPC: the tRPC routers live under apps/desktop/src/lib/trpc/, outside this
 * lane's ownership, and `window.ipcRenderer` is already exposed generically by
 * the preload — the same channel shape `deep-link-navigate` uses. No preload
 * change was required.
 */

export const CONTROL_PLANE_OP_CHANNEL = "ade:control-plane:op";
export const CONTROL_PLANE_RESULT_CHANNEL = "ade:control-plane:result";

/** PROTOCOL.md: renderer bridge did not answer in 10 s → TIMEOUT. */
export const BRIDGE_TIMEOUT_MS = 10_000;

interface PendingOp {
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

interface BridgeReply {
	opId?: unknown;
	result?: unknown;
	error?: unknown;
}

export class RendererBridge {
	private readonly pending = new Map<string, PendingOp>();
	private listening = false;

	constructor(
		private readonly getWindow: () => BrowserWindow | null = () =>
			BrowserWindow.getAllWindows()[0] ?? null,
	) {}

	start(): void {
		if (this.listening) return;
		this.listening = true;
		ipcMain.on(CONTROL_PLANE_RESULT_CHANNEL, this.onReply);
	}

	stop(): void {
		if (!this.listening) return;
		this.listening = false;
		ipcMain.off(CONTROL_PLANE_RESULT_CHANNEL, this.onReply);
		for (const [opId, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(
				new ControlError("INTERNAL", "Control plane stopped before reply"),
			);
			this.pending.delete(opId);
		}
	}

	private readonly onReply = (_event: unknown, payload: BridgeReply): void => {
		if (!payload || typeof payload.opId !== "string") return;
		const entry = this.pending.get(payload.opId);
		if (!entry) return; // already timed out
		this.pending.delete(payload.opId);
		clearTimeout(entry.timer);

		if (payload.error) {
			const err = payload.error as { code?: string; message?: string };
			// The renderer's BridgeOpError codes are a subset of the wire codes;
			// anything else becomes INTERNAL rather than inventing a new code.
			const code =
				err.code === "BAD_REQUEST" ||
				err.code === "UNSUPPORTED" ||
				err.code === "NOT_FOUND"
					? err.code
					: "INTERNAL";
			entry.reject(new ControlError(code, err.message ?? "Bridge op failed"));
			return;
		}
		entry.resolve((payload.result as Record<string, unknown>) ?? {});
	};

	async dispatch(op: BridgeOp): Promise<Record<string, unknown>> {
		const window = this.getWindow();
		if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
			throw new ControlError(
				"RENDERER_UNAVAILABLE",
				"No Argus window is open to run this layout operation",
			);
		}
		if (!this.listening) {
			throw new ControlError("INTERNAL", "Renderer bridge is not started");
		}

		const opId = randomUUID();
		const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(opId);
				reject(
					new ControlError(
						"TIMEOUT",
						`Renderer did not answer within ${BRIDGE_TIMEOUT_MS} ms`,
					),
				);
			}, BRIDGE_TIMEOUT_MS);
			// Do not hold the process open on a pending op.
			timer.unref?.();
			this.pending.set(opId, { resolve, reject, timer });
		});

		window.webContents.send(CONTROL_PLANE_OP_CHANNEL, { opId, op });
		return promise;
	}

	get pendingCount(): number {
		return this.pending.size;
	}
}
