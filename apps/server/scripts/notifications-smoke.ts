/**
 * Headless notifications smoke: boots nothing itself — point it at a running
 * server (like scripts/smoke.ts).
 *
 *   DESKTOP_NOTIFICATIONS_PORT=51799 ADE_HOME_DIR=... \
 *     node dist/server.cjs serve --port 7810        # terminal 1
 *   ADE_PORT=7810 ADE_HOOK_PORT=51799 \
 *     bun run scripts/notifications-smoke.ts         # terminal 2
 *
 * Verifies the issue-#21 plumbing end-to-end: a WS subscriber on
 * `notifications.subscribe` receives the AGENT_LIFECYCLE event produced when an
 * agent hook curls the server's hook receiver — fired here EXACTLY the way the
 * scaffolded notify-hook.template.sh does (curl -sG with --data-urlencode).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import superjson from "superjson";
import WebSocket from "ws";
import type { AppRouter } from "../src/routers";

const PORT = Number(process.env.ADE_PORT || 7777);
// The hook receiver binds env.DESKTOP_NOTIFICATIONS_PORT (default 51741), which
// is the same value injected into terminals as SUPERSET_PORT.
const HOOK_PORT = Number(
	process.env.ADE_HOOK_PORT ||
		process.env.DESKTOP_NOTIFICATIONS_PORT ||
		51741,
);
const home = process.env.ADE_HOME_DIR || join(homedir(), ".ade");
const token = readFileSync(join(home, "token"), "utf8").trim();

/** Fire the hook the way notify-hook.template.sh does: GET with urlencoded query. */
function fireHook(params: Record<string, string>): string {
	const args = [
		"-sG",
		`http://127.0.0.1:${HOOK_PORT}/hook/complete`,
		"--connect-timeout",
		"1",
		"--max-time",
		"2",
	];
	for (const [k, v] of Object.entries(params)) {
		args.push("--data-urlencode", `${k}=${v}`);
	}
	const res = spawnSync("curl", args, { encoding: "utf8" });
	return res.stdout.trim();
}

async function main() {
	const failures: string[] = [];

	const wsClient = createWSClient({
		url: `ws://127.0.0.1:${PORT}/trpc?token=${token}`,
		WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
	});
	const trpc = createTRPCClient<AppRouter>({
		links: [wsLink({ client: wsClient, transformer: superjson })],
	});

	const paneId = `smoke-pane-${Date.now()}`;
	const workspaceId = "smoke-ws";
	const tabId = "smoke-tab";

	// Subscribe, then fire a Stop hook and assert delivery with correct ids.
	const stopEvent = new Promise<{
		type: string;
		data: { eventType: string; paneId?: string; workspaceId?: string };
	}>((resolve, reject) => {
		const sub = trpc.notifications.subscribe.subscribe(undefined, {
			onData: (evt) => {
				const e = evt as {
					type: string;
					data?: { eventType?: string; paneId?: string; workspaceId?: string };
				};
				if (e.type === "agent-lifecycle" && e.data?.eventType === "Stop") {
					sub.unsubscribe();
					resolve(
						e as {
							type: string;
							data: {
								eventType: string;
								paneId?: string;
								workspaceId?: string;
							};
						},
					);
				}
			},
			onError: reject,
		});
		setTimeout(() => reject(new Error("no Stop event within 10s")), 10000);
	});

	// Let the subscription register on the emitter before firing.
	await new Promise((r) => setTimeout(r, 500));

	const stopResponse = fireHook({
		paneId,
		tabId,
		workspaceId,
		sessionId: "sess-smoke",
		eventType: "Stop",
		env: "production",
		version: "2",
	});
	if (!stopResponse.includes('"success":true')) {
		failures.push(`hook receiver did not return success: ${stopResponse}`);
	} else {
		console.log(`ok: hook receiver accepted Stop (${stopResponse})`);
	}

	const evt = await stopEvent;
	if (evt.data.paneId !== paneId)
		failures.push(`wrong paneId: ${evt.data.paneId}`);
	if (evt.data.workspaceId !== workspaceId)
		failures.push(`wrong workspaceId: ${evt.data.workspaceId}`);
	console.log(
		`ok: subscriber received AGENT_LIFECYCLE Stop with matching ids (${JSON.stringify(evt.data)})`,
	);

	// UserPromptSubmit must normalize to Start server-side.
	const startEvent = new Promise<void>((resolve, reject) => {
		const sub = trpc.notifications.subscribe.subscribe(undefined, {
			onData: (evt2) => {
				const e = evt2 as { type: string; data?: { eventType?: string } };
				if (e.type === "agent-lifecycle" && e.data?.eventType === "Start") {
					sub.unsubscribe();
					resolve();
				}
			},
			onError: reject,
		});
		setTimeout(() => reject(new Error("no Start event within 8s")), 8000);
	});
	await new Promise((r) => setTimeout(r, 300));
	fireHook({
		paneId,
		workspaceId,
		eventType: "UserPromptSubmit",
		env: "production",
		version: "2",
	});
	await startEvent;
	console.log("ok: UserPromptSubmit normalized to Start and delivered");

	// An unknown eventType is accepted but produces no event (forward compat).
	const ignored = fireHook({ paneId, eventType: "Bogus", env: "production" });
	if (!ignored.includes('"ignored":true')) {
		failures.push(`unknown eventType not ignored cleanly: ${ignored}`);
	} else {
		console.log("ok: unknown eventType accepted + ignored");
	}

	wsClient.close();

	if (failures.length) {
		console.error("NOTIFICATIONS SMOKE FAILURES:", failures);
		process.exit(1);
	}
	console.log("NOTIFICATIONS SMOKE OK");
	process.exit(0);
}

main().catch((e) => {
	console.error("NOTIFICATIONS SMOKE FAILED:", e);
	process.exit(1);
});
