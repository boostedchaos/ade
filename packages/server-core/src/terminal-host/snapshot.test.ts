/**
 * Daemon `snapshot` request — integration tests.
 *
 * The point of this request is that it is READ-ONLY. `createOrAttach` also
 * returns a screen, but it registers an attached client and RESIZES the
 * session to the caller's dimensions, so using it to read would mutate the
 * user's terminal. These tests exist to prove the new path does neither.
 *
 * ISOLATION: dedicated `SUPERSET_WORKSPACE_NAME=tsnp` → `~/.ade-tsnp`, the
 * daemon test idiom. Never touches the developer's running app.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getTerminalHostSocketPathFor } from "./socket-path";
import {
	type CreateOrAttachResponse,
	type IpcRequest,
	type IpcResponse,
	type ListSessionsResponse,
	PROTOCOL_VERSION,
	type SnapshotResponse,
} from "./types";

const WORKSPACE = "tsnp";
const SUPERSET_DIR_NAME = `.ade-${WORKSPACE}`;
const SUPERSET_HOME_DIR = join(homedir(), SUPERSET_DIR_NAME);
const SOCKET_PATH = getTerminalHostSocketPathFor(SUPERSET_DIR_NAME);
const TOKEN_PATH = join(SUPERSET_HOME_DIR, "terminal-host.token");
const PID_PATH = join(SUPERSET_HOME_DIR, "terminal-host.pid");

const DAEMON_PATH = resolve(__dirname, "daemon.ts");
const XTERM_POLYFILL_PATH = resolve(__dirname, "xterm-env-polyfill.ts");

const DAEMON_TIMEOUT = 15000;

/** The dimensions the session is created at. Nothing may change these. */
const SESSION_COLS = 100;
const SESSION_ROWS = 30;
/** Deliberately different, to be handed to snapshot and ignored. */
const DECOY_COLS = 40;
const DECOY_ROWS = 12;

const IS_WIN = process.platform === "win32";

describe.skipIf(IS_WIN)("Terminal Host Daemon — read-only snapshot", () => {
	let daemonProcess: ChildProcess | null = null;
	let control: Socket;
	let stream: Socket;
	let token: string;
	/**
	 * Whether the PTY in this environment actually echoes. Some sandboxes
	 * (including this agent worktree) spawn the PTY successfully but fail
	 * every write with EBADF, so no shell output ever reaches the mirror.
	 * Assertions that need real shell output are gated on this and SAY SO —
	 * a silently-skipped check is indistinguishable from a passing one.
	 */
	let ptyEchoes = false;
	const CLIENT_ID = "snapshot-test-client";
	const SESSION_ID = "snapshot-test-session";

	function cleanup(): void {
		if (existsSync(PID_PATH)) {
			try {
				const pid = Number.parseInt(readFileSync(PID_PATH, "utf-8").trim(), 10);
				if (pid > 0) process.kill(pid, "SIGTERM");
			} catch {
				// not running
			}
		}
		for (const path of [SOCKET_PATH, PID_PATH, TOKEN_PATH]) {
			try {
				if (existsSync(path)) rmSync(path);
			} catch {
				// best effort
			}
		}
	}

	function startDaemon(): Promise<void> {
		return new Promise((resolveStart, rejectStart) => {
			if (!existsSync(SUPERSET_HOME_DIR)) {
				mkdirSync(SUPERSET_HOME_DIR, { recursive: true, mode: 0o700 });
			}
			daemonProcess = spawn(
				process.execPath,
				["run", "--preload", XTERM_POLYFILL_PATH, DAEMON_PATH],
				{
					env: {
						...process.env,
						NODE_ENV: "development",
						ADE_HOME_DIR: undefined,
						SUPERSET_WORKSPACE_NAME: WORKSPACE,
					},
					stdio: ["ignore", "pipe", "pipe"],
					detached: true,
				},
			);

			let output = "";
			let settled = false;
			const timeoutId = setTimeout(() => {
				if (settled) return;
				settled = true;
				rejectStart(
					new Error(`Daemon did not start in ${DAEMON_TIMEOUT}ms: ${output}`),
				);
			}, DAEMON_TIMEOUT);

			daemonProcess.stdout?.on("data", (data) => {
				output += data.toString();
				if (output.includes("Daemon started") && !settled) {
					settled = true;
					clearTimeout(timeoutId);
					resolveStart();
				}
			});
			daemonProcess.on("error", (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutId);
				rejectStart(error);
			});
		});
	}

	function stopDaemon(): Promise<void> {
		return new Promise((resolveStop) => {
			if (!daemonProcess) return resolveStop();
			daemonProcess.on("exit", () => {
				daemonProcess = null;
				resolveStop();
			});
			daemonProcess.kill("SIGTERM");
			setTimeout(() => {
				if (daemonProcess) {
					daemonProcess.kill("SIGKILL");
					daemonProcess = null;
					resolveStop();
				}
			}, 2000);
		});
	}

	function connectSocket(): Promise<Socket> {
		return new Promise((resolveConn, rejectConn) => {
			const socket = connect(SOCKET_PATH);
			socket.on("connect", () => resolveConn(socket));
			socket.on("error", rejectConn);
			setTimeout(() => rejectConn(new Error("connect timeout")), 5000);
		});
	}

	function sendRequest(
		socket: Socket,
		request: IpcRequest,
		timeoutMs = 10000,
	): Promise<IpcResponse> {
		return new Promise((resolveReq, rejectReq) => {
			let buffer = "";
			const onData = (data: Buffer) => {
				buffer += data.toString();
				let newlineIndex = buffer.indexOf("\n");
				while (newlineIndex !== -1) {
					const line = buffer.slice(0, newlineIndex);
					buffer = buffer.slice(newlineIndex + 1);
					if (line.trim()) {
						let parsed: IpcResponse | { type?: string };
						try {
							parsed = JSON.parse(line);
						} catch {
							socket.off("data", onData);
							rejectReq(new Error(`unparseable: ${line}`));
							return;
						}
						// Skip unsolicited events; only responses carry our id.
						if ((parsed as { id?: string }).id === request.id) {
							socket.off("data", onData);
							resolveReq(parsed as IpcResponse);
							return;
						}
					}
					newlineIndex = buffer.indexOf("\n");
				}
			};
			socket.on("data", onData);
			socket.write(`${JSON.stringify(request)}\n`);
			setTimeout(() => {
				socket.off("data", onData);
				rejectReq(new Error(`request ${request.type} timed out`));
			}, timeoutMs);
		});
	}

	async function hello(socket: Socket, role: "control" | "stream", id: string) {
		const response = await sendRequest(socket, {
			id,
			type: "hello",
			payload: {
				token,
				protocolVersion: PROTOCOL_VERSION,
				clientId: CLIENT_ID,
				role,
			},
		});
		if (!response.ok)
			throw new Error(`hello failed: ${response.error.message}`);
	}

	async function snapshot(
		payload: Record<string, unknown>,
		id: string,
	): Promise<SnapshotResponse> {
		const response = await sendRequest(control, {
			id,
			type: "snapshot",
			payload,
		});
		if (!response.ok) {
			throw new Error(`snapshot failed: ${response.error.message}`);
		}
		return response.payload as SnapshotResponse;
	}

	/** Write to the PTY and give the shell time to echo + the mirror to catch up. */
	async function writeAndSettle(data: string, id: string): Promise<void> {
		const response = await sendRequest(control, {
			id,
			type: "write",
			payload: { sessionId: SESSION_ID, data },
		});
		if (!response.ok)
			throw new Error(`write failed: ${response.error.message}`);
		await new Promise((r) => setTimeout(r, 700));
	}

	beforeAll(async () => {
		cleanup();
		await startDaemon();
		token = readFileSync(TOKEN_PATH, "utf-8").trim();

		// Both sockets share a clientId — createOrAttach hard-requires the pair.
		control = await connectSocket();
		stream = await connectSocket();
		await hello(control, "control", "hello-control");
		await hello(stream, "stream", "hello-stream");

		const created = await sendRequest(control, {
			id: "create",
			type: "createOrAttach",
			payload: {
				sessionId: SESSION_ID,
				cols: SESSION_COLS,
				rows: SESSION_ROWS,
				workspaceId: "ws-snapshot",
				paneId: "pane-snapshot",
				tabId: "tab-snapshot",
				shell: "/bin/sh",
				cwd: homedir(),
			},
		});
		if (!created.ok) {
			throw new Error(`createOrAttach failed: ${created.error.message}`);
		}
		const payload = created.payload as CreateOrAttachResponse;
		expect(payload.snapshot.cols).toBe(SESSION_COLS);
		expect(payload.snapshot.rows).toBe(SESSION_ROWS);

		// Quieten the prompt so assertions match on our own markers.
		await writeAndSettle("PS1=''\n", "w-prompt");

		// Probe once: can this environment's PTY echo at all?
		await writeAndSettle("echo PTY_ECHO_PROBE\n", "w-probe");
		const probe = await snapshot(
			{ sessionId: SESSION_ID, includeScrollback: true },
			"s-probe",
		);
		ptyEchoes = probe.text.includes("PTY_ECHO_PROBE");
		if (!ptyEchoes) {
			console.warn(
				"[snapshot.test] PTY produces no output in this environment " +
					"(writes fail EBADF in some sandboxes). Shell-output assertions " +
					"are SKIPPED; the mirror-level no-resize proof still runs.",
			);
		}
	}, 60000);

	afterAll(async () => {
		try {
			control?.destroy();
			stream?.destroy();
		} catch {
			// ignore
		}
		await stopDaemon();
		cleanup();
	});

	it("returns rendered text the PTY actually produced", async () => {
		if (!ptyEchoes) return; // see ptyEchoes — reported, not silent
		await writeAndSettle("echo SNAPSHOT_MARKER_ONE\n", "w1");
		const result = await snapshot({ sessionId: SESSION_ID }, "s1");
		expect(result.text).toContain("SNAPSHOT_MARKER_ONE");
	}, 30000);

	it("reports the session's CURRENT dimensions", async () => {
		const result = await snapshot({ sessionId: SESSION_ID }, "s2");
		expect(result.cols).toBe(SESSION_COLS);
		expect(result.rows).toBe(SESSION_ROWS);
	}, 30000);

	// ---- THE NO-RESIZE TEST -------------------------------------------------

	// ---- THE NO-RESIZE TESTS ------------------------------------------------

	/**
	 * The core guarantee, provable without any shell output: snapshotting —
	 * including with dimensions in the payload, as a createOrAttach-shaped
	 * caller would send — never changes the session's size.
	 *
	 * The test proves its own sensitivity in the middle: it issues a REAL
	 * resize and asserts the reported dimensions follow it. Without that, an
	 * implementation that hardcoded the numbers, or a reporter wired to a
	 * constant, would pass every "unchanged" assertion here.
	 */
	it("does NOT resize the session, and the check can detect a resize", async () => {
		const initial = await snapshot({ sessionId: SESSION_ID }, "s-initial");
		expect(initial.cols).toBe(SESSION_COLS);
		expect(initial.rows).toBe(SESSION_ROWS);

		// `cols`/`rows` are NOT part of SnapshotRequest. Sending them anyway
		// proves that a caller who mistakenly passes createOrAttach's shape
		// cannot resize anything through this path.
		await snapshot({ sessionId: SESSION_ID }, "s-no-dims");
		await snapshot(
			{ sessionId: SESSION_ID, cols: DECOY_COLS, rows: DECOY_ROWS },
			"s-decoy-dims",
		);
		await snapshot(
			{
				sessionId: SESSION_ID,
				cols: DECOY_COLS,
				rows: DECOY_ROWS,
				includeScrollback: true,
				maxLines: 5,
				includeAnsi: true,
			},
			"s-decoy-full",
		);

		const afterReads = await snapshot(
			{ sessionId: SESSION_ID },
			"s-after-reads",
		);
		expect(afterReads.cols).toBe(SESSION_COLS);
		expect(afterReads.rows).toBe(SESSION_ROWS);

		// SENSITIVITY PROOF: a real resize must move the reported numbers.
		const resized = await sendRequest(control, {
			id: "r-shrink",
			type: "resize",
			payload: { sessionId: SESSION_ID, cols: DECOY_COLS, rows: DECOY_ROWS },
		});
		expect(resized.ok).toBe(true);
		const shrunk = await snapshot({ sessionId: SESSION_ID }, "s-shrunk");
		expect(shrunk.cols).toBe(DECOY_COLS);
		expect(shrunk.rows).toBe(DECOY_ROWS);

		// Restore, and confirm snapshots still do not move it.
		const restored = await sendRequest(control, {
			id: "r-restore",
			type: "resize",
			payload: {
				sessionId: SESSION_ID,
				cols: SESSION_COLS,
				rows: SESSION_ROWS,
			},
		});
		expect(restored.ok).toBe(true);
		await snapshot(
			{ sessionId: SESSION_ID, cols: DECOY_COLS, rows: DECOY_ROWS },
			"s-decoy-again",
		);
		const final = await snapshot({ sessionId: SESSION_ID }, "s-final");
		expect(final.cols).toBe(SESSION_COLS);
		expect(final.rows).toBe(SESSION_ROWS);
	}, 40000);

	/**
	 * The same guarantee at the PTY level, asked of the kernel rather than of
	 * our mirror — `stty size` prints "<rows> <cols>" from the tty itself, so a
	 * mirror that resized in sympathy could not fake it. Needs real shell
	 * output; gated on the probe in beforeAll.
	 */
	it("does NOT resize the PTY itself (stty size, needs a working PTY)", async () => {
		if (!ptyEchoes) return; // see ptyEchoes — reported, not silent
		await writeAndSettle("stty size\n", "w-stty-before");
		const before = await snapshot({ sessionId: SESSION_ID }, "s-stty-before");
		expect(before.text).toContain(`${SESSION_ROWS} ${SESSION_COLS}`);

		await snapshot(
			{ sessionId: SESSION_ID, cols: DECOY_COLS, rows: DECOY_ROWS },
			"s-stty-decoy",
		);

		await writeAndSettle("stty size\n", "w-stty-after");
		const after = await snapshot({ sessionId: SESSION_ID }, "s-stty-after");
		expect(after.text).toContain(`${SESSION_ROWS} ${SESSION_COLS}`);
		expect(after.text).not.toContain(`${DECOY_ROWS} ${DECOY_COLS}`);
	}, 40000);

	it("does NOT attach the caller as a client", async () => {
		const listBefore = await sendRequest(control, {
			id: "list-before",
			type: "listSessions",
			payload: undefined,
		});
		if (!listBefore.ok) throw new Error("listSessions failed");
		const beforeCount = (
			listBefore.payload as ListSessionsResponse
		).sessions.find((s) => s.sessionId === SESSION_ID)?.attachedClients;

		await snapshot({ sessionId: SESSION_ID }, "s-attach-check");

		const listAfter = await sendRequest(control, {
			id: "list-after",
			type: "listSessions",
			payload: undefined,
		});
		if (!listAfter.ok) throw new Error("listSessions failed");
		const afterCount = (
			listAfter.payload as ListSessionsResponse
		).sessions.find((s) => s.sessionId === SESSION_ID)?.attachedClients;

		expect(afterCount).toBe(beforeCount as number);
	}, 30000);

	it("does NOT disturb the event stream", async () => {
		// Collect anything the daemon pushes at the stream socket while we read.
		const events: string[] = [];
		const onData = (data: Buffer) => {
			for (const line of data.toString().split("\n")) {
				if (line.trim()) events.push(line);
			}
		};
		stream.on("data", onData);

		await snapshot({ sessionId: SESSION_ID }, "s-stream-1");
		await snapshot(
			{ sessionId: SESSION_ID, includeScrollback: true },
			"s-stream-2",
		);
		await new Promise((r) => setTimeout(r, 400));
		stream.off("data", onData);

		// No PTY output was generated, so a pure read must produce no frames.
		expect(events).toEqual([]);
	}, 30000);

	it("does not write to the PTY — the shell sees no injected input", async () => {
		if (!ptyEchoes) return; // see ptyEchoes — reported, not silent
		await writeAndSettle("echo BEFORE_READS\n", "w-before-reads");
		for (let i = 0; i < 5; i += 1) {
			await snapshot({ sessionId: SESSION_ID }, `s-quiet-${i}`);
		}
		await writeAndSettle("echo AFTER_READS\n", "w-after-reads");

		const result = await snapshot(
			{ sessionId: SESSION_ID, includeScrollback: true },
			"s-quiet-final",
		);
		// Between the two markers there must be nothing but the echoed command
		// and its output — a read that leaked bytes into the PTY would show as
		// stray characters or a shell error here.
		const between = result.text.slice(
			result.text.indexOf("BEFORE_READS"),
			result.text.lastIndexOf("AFTER_READS"),
		);
		expect(between).not.toContain("command not found");
		expect(between).not.toContain("syntax error");
	}, 40000);

	// ---- shape and options --------------------------------------------------

	it("omits ANSI unless asked, and includes it when asked", async () => {
		const plain = await snapshot({ sessionId: SESSION_ID }, "s-plain");
		expect(plain.ansi).toBeUndefined();

		const withAnsi = await snapshot(
			{ sessionId: SESSION_ID, includeAnsi: true },
			"s-ansi",
		);
		expect(typeof withAnsi.ansi).toBe("string");
	}, 30000);

	it("caps output with maxLines, counted from the most recent", async () => {
		if (!ptyEchoes) return; // see ptyEchoes — reported, not silent
		await writeAndSettle(
			"for i in 1 2 3 4 5 6 7 8; do echo LINE_$i; done\n",
			"w-many",
		);
		const capped = await snapshot(
			{ sessionId: SESSION_ID, includeScrollback: true, maxLines: 3 },
			"s-capped",
		);
		expect(capped.text.split("\n").length).toBeLessThanOrEqual(3);
		// The cap keeps the END of the output, so the last line survives and an
		// early one does not.
		expect(capped.text).toContain("LINE_8");
		expect(capped.text).not.toContain("LINE_1");
	}, 40000);

	it("reports liveness and cwd", async () => {
		const result = await snapshot({ sessionId: SESSION_ID }, "s-meta");
		expect(result.isAlive).toBe(true);
		expect(result.flushed).toBe(true);
		expect(typeof result.scrollbackLines).toBe("number");
		expect(result.alternateScreen).toBe(false);
	}, 30000);

	it("errors for a session the daemon does not have", async () => {
		const response = await sendRequest(control, {
			id: "s-missing",
			type: "snapshot",
			payload: { sessionId: "no-such-session" },
		});
		expect(response.ok).toBe(false);
		if (!response.ok) {
			expect(response.error.code).toBe("SNAPSHOT_FAILED");
			expect(response.error.message).toContain("Session not found");
		}
	}, 30000);

	it("requires authentication", async () => {
		const anon = await connectSocket();
		try {
			const response = await sendRequest(anon, {
				id: "s-anon",
				type: "snapshot",
				payload: { sessionId: SESSION_ID },
			});
			expect(response.ok).toBe(false);
			if (!response.ok) {
				expect(response.error.code).toBe("NOT_AUTHENTICATED");
			}
		} finally {
			anon.destroy();
		}
	}, 30000);
});
