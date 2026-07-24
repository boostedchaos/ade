/**
 * Multi-device attach policy smoke test (issue #7, mirror-readonly v1).
 * Point it at a running server, like scripts/smoke.ts:
 *   node dist/server.cjs serve --port 7805     # terminal 1
 *   ADE_PORT=7805 bun run scripts/multi-attach-smoke.ts   # terminal 2
 *
 * Two concurrent WS clients against one pane verify:
 *   1. first attach is the writer, second is a read-only mirror
 *   2. writer input reaches the pty; mirror input is dropped
 *   3. the mirror still sees a live stream of the pane output
 *   4. takeWriter transfers the lease (mode events flip on both clients)
 *   5. dropping the writer's socket frees the lease (mirror gets mode:false)
 *   6. a write against the freed pane acquires the lease
 *   7. a fresh client (reconnect after refresh) attaches as writer
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	createTRPCClient,
	createWSClient,
	httpBatchLink,
	wsLink,
} from "@trpc/client";
import superjson from "superjson";
import WebSocket from "ws";
import type { AppRouter } from "../src/routers";

const PORT = Number(process.env.ADE_PORT || 7777);
const BASE = `http://127.0.0.1:${PORT}/trpc`;
const home = process.env.ADE_HOME_DIR || join(homedir(), ".ade");
const token = readFileSync(join(home, "token"), "utf8").trim();

const failures: string[] = [];
function check(ok: boolean, label: string) {
	if (ok) console.log(`ok: ${label}`);
	else failures.push(label);
}

function httpClient() {
	return createTRPCClient<AppRouter>({
		links: [
			httpBatchLink({
				url: BASE,
				transformer: superjson,
				headers: { authorization: `Bearer ${token}` },
			}),
		],
	});
}

type StreamEvent =
	| { type: "data"; data: string }
	| { type: "mode"; readOnly: boolean }
	| { type: string; [k: string]: unknown };

/** One simulated device: its own WS connection + event log. */
function device(clientId: string, paneId: string) {
	const ws = createWSClient({
		url: `ws://127.0.0.1:${PORT}/trpc?token=${token}`,
		WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
	});
	const trpc = createTRPCClient<AppRouter>({
		links: [wsLink({ client: ws, transformer: superjson })],
	});
	const events: StreamEvent[] = [];
	let received = "";
	const sub = trpc.terminal.stream.subscribe(
		{ paneId, clientId },
		{
			onData: (evt) => {
				events.push(evt as StreamEvent);
				if (evt.type === "data") received += evt.data;
			},
			onError: (err) => {
				failures.push(`${clientId} stream error: ${err.message}`);
			},
		},
	);
	return {
		clientId,
		events,
		output: () => received,
		lastMode: () => {
			const modes = events.filter((e) => e.type === "mode") as Array<{
				type: "mode";
				readOnly: boolean;
			}>;
			return modes.at(-1)?.readOnly;
		},
		close: () => {
			sub.unsubscribe();
			ws.close();
		},
	};
}

async function waitFor(
	label: string,
	predicate: () => boolean,
	timeoutMs = 15_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`timeout waiting for: ${label}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
	const paneId = `attach-smoke-${Date.now()}`;
	const cwd = process.env.USERPROFILE || process.env.HOME || ".";
	const http = httpClient();

	// --- Device A attaches first: writer.
	const a = device("client-a", paneId);
	const attachA = await http.terminal.createOrAttach.mutate({
		workspaceId: "attach-smoke-ws",
		paneId,
		tabId: "attach-smoke-tab",
		cols: 80,
		rows: 24,
		cwd,
		clientId: "client-a",
	});
	check(attachA.readOnly === false, "first attach is the writer");
	await waitFor("A mode event", () => a.lastMode() !== undefined);
	check(a.lastMode() === false, "writer stream reports readOnly=false");

	// --- Device B attaches concurrently: read-only mirror.
	const b = device("client-b", paneId);
	const attachB = await http.terminal.createOrAttach.mutate({
		workspaceId: "attach-smoke-ws",
		paneId,
		tabId: "attach-smoke-tab",
		cols: 80,
		rows: 24,
		cwd,
		clientId: "client-b",
	});
	check(attachB.readOnly === true, "concurrent attach is a read-only mirror");
	await waitFor("B mode event", () => b.lastMode() !== undefined);
	check(b.lastMode() === true, "mirror stream reports readOnly=true");

	// --- Writer input flows; the mirror sees the same output.
	await http.terminal.write.mutate({
		paneId,
		data: "echo MARKER_WRITER_A\r",
		clientId: "client-a",
	});
	await waitFor("writer marker on A", () =>
		a.output().includes("MARKER_WRITER_A"),
	);
	check(true, "writer write reached the pty");
	await waitFor("writer marker mirrored to B", () =>
		b.output().includes("MARKER_WRITER_A"),
	);
	check(true, "mirror receives a live copy of the pane stream");

	// --- Mirror input is dropped server-side.
	await http.terminal.write.mutate({
		paneId,
		data: "echo MARKER_MIRROR_B\r",
		clientId: "client-b",
	});
	await sleep(3_000);
	check(
		!a.output().includes("MARKER_MIRROR_B") &&
			!b.output().includes("MARKER_MIRROR_B"),
		"mirror write was ignored",
	);

	// --- Explicit takeover: last-writer-wins on user action.
	await http.terminal.takeWriter.mutate({ paneId, clientId: "client-b" });
	await waitFor("modes flip after takeWriter", () => {
		return a.lastMode() === true && b.lastMode() === false;
	});
	check(true, "takeWriter flips modes on both clients");
	await http.terminal.write.mutate({
		paneId,
		data: "echo MARKER_TAKEOVER_B\r",
		clientId: "client-b",
	});
	await waitFor("takeover marker", () =>
		a.output().includes("MARKER_TAKEOVER_B"),
	);
	check(true, "new writer's input flows after takeover");
	await http.terminal.write.mutate({
		paneId,
		data: "echo MARKER_DEMOTED_A\r",
		clientId: "client-a",
	});
	await sleep(2_000);
	check(
		!b.output().includes("MARKER_DEMOTED_A"),
		"demoted writer's input is ignored",
	);

	// --- Dropping the writer's socket frees the lease.
	b.close();
	await waitFor("A told the pane is free", () => a.lastMode() === false);
	check(true, "writer drop frees the lease (mirror notified via mode event)");

	// --- First write against the freed pane acquires the lease.
	await http.terminal.write.mutate({
		paneId,
		data: "echo MARKER_REACQUIRE_A\r",
		clientId: "client-a",
	});
	await waitFor("reacquire marker", () =>
		a.output().includes("MARKER_REACQUIRE_A"),
	);
	check(true, "freed pane acquired by next write");

	// --- Refresh scenario: writer's socket drops, a fresh clientId attaches.
	a.close();
	await sleep(500);
	const attachC = await http.terminal.createOrAttach.mutate({
		workspaceId: "attach-smoke-ws",
		paneId,
		tabId: "attach-smoke-tab",
		cols: 80,
		rows: 24,
		cwd,
		clientId: "client-c",
	});
	check(
		attachC.readOnly === false,
		"reconnect after writer drop regains write (fresh clientId)",
	);

	await http.terminal.kill.mutate({ paneId });
	console.log("ok: pane killed");

	if (failures.length) {
		console.error("MULTI-ATTACH SMOKE FAILURES:", failures);
		process.exit(1);
	}
	console.log("MULTI-ATTACH SMOKE OK");
	process.exit(0);
}

main().catch((e) => {
	console.error("MULTI-ATTACH SMOKE FAILED:", e);
	process.exit(1);
});
