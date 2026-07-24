import { beforeEach, describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import {
	createFrameHeader,
	PtySubprocessFrameDecoder,
	PtySubprocessIpcType,
} from "./pty-subprocess-ipc";
import "./xterm-env-polyfill";

const { Session } = await import("./session");

class FakeStdout extends EventEmitter {}

class FakeStdin extends EventEmitter {
	readonly writes: Buffer[] = [];

	write(chunk: Buffer | string): boolean {
		this.writes.push(
			Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"),
		);
		return true;
	}
}

class FakeChildProcess extends EventEmitter {
	readonly stdout = new FakeStdout();
	readonly stdin = new FakeStdin();
	pid = 4242;
	kill(): boolean {
		return true;
	}
}

let fakeChildProcess: FakeChildProcess;
let spawnCalls: Array<{ command: string; args: string[] }> = [];

describe("Terminal Host Session shell args", () => {
	beforeEach(() => {
		fakeChildProcess = new FakeChildProcess();
		spawnCalls = [];
	});

	it("sends bash --rcfile args in spawn payload", () => {
		const session = new Session({
			sessionId: "session-bash-args",
			workspaceId: "workspace-1",
			paneId: "pane-1",
			tabId: "tab-1",
			cols: 80,
			rows: 24,
			cwd: "/tmp",
			shell: "/bin/bash",
			spawnProcess: (command: string, args: readonly string[], _options) => {
				spawnCalls.push({ command, args: [...args] });
				return fakeChildProcess as unknown as ChildProcess;
			},
		});

		session.spawn({
			cwd: "/tmp",
			cols: 80,
			rows: 24,
			env: { PATH: "/usr/bin" },
		});

		expect(spawnCalls.length).toBe(1);

		fakeChildProcess.stdout.emit(
			"data",
			createFrameHeader(PtySubprocessIpcType.Ready, 0),
		);

		const decoder = new PtySubprocessFrameDecoder();
		const frames = fakeChildProcess.stdin.writes.flatMap((chunk) =>
			decoder.push(chunk),
		);
		const spawnFrame = frames.find(
			(frame) => frame.type === PtySubprocessIpcType.Spawn,
		);

		expect(spawnFrame).toBeDefined();
		const spawnPayload = JSON.parse(
			spawnFrame?.payload.toString("utf8") ?? "{}",
		) as { args?: string[] };

		expect(spawnPayload?.args?.[0]).toBe("--rcfile");
		expect(spawnPayload?.args?.[1]?.endsWith(path.join("bash", "rcfile"))).toBe(
			true,
		);
	});
});

describe("Terminal Host Session stdin backpressure", () => {
	// Regression: write() returning false still ACCEPTS the chunk (false only
	// signals backpressure). The flush loop must dequeue before writing —
	// re-writing the head chunk after drain duplicates bytes mid-stream and
	// desyncs the subprocess frame decoder (seen on Windows, where pipes
	// backpressure immediately).
	class BackpressuredStdin extends EventEmitter {
		readonly writes: Buffer[] = [];

		write(chunk: Buffer | string): boolean {
			this.writes.push(
				Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"),
			);
			return false; // accept the chunk, but report backpressure every time
		}
	}

	it("never duplicates bytes when every write reports backpressure", async () => {
		const child = new FakeChildProcess();
		const stdin = new BackpressuredStdin();
		Object.defineProperty(child, "stdin", { value: stdin });

		const session = new Session({
			sessionId: "session-backpressure",
			workspaceId: "workspace-1",
			paneId: "pane-1",
			tabId: "tab-1",
			cols: 80,
			rows: 24,
			cwd: "/tmp",
			shell: "/bin/bash",
			spawnProcess: () => child as unknown as ChildProcess,
		});

		session.spawn({ cwd: "/tmp", cols: 80, rows: 24, env: { PATH: "/usr/bin" } });
		child.stdout.emit(
			"data",
			createFrameHeader(PtySubprocessIpcType.Ready, 0),
		);

		// Each drain releases exactly one more queued chunk.
		for (let i = 0; i < 20 && stdin.listenerCount("drain") > 0; i++) {
			stdin.emit("drain");
			await Promise.resolve();
		}

		// The byte stream must decode cleanly into frames...
		const decoder = new PtySubprocessFrameDecoder();
		const frames = stdin.writes.flatMap((chunk) => decoder.push(chunk));

		// ...with the Spawn frame present exactly once (duplication would either
		// throw in the decoder or repeat the frame).
		const spawnFrames = frames.filter(
			(frame) => frame.type === PtySubprocessIpcType.Spawn,
		);
		expect(spawnFrames.length).toBe(1);

		// And the total bytes written equal the frames' encoded size — no extras.
		const totalWritten = stdin.writes.reduce((n, b) => n + b.length, 0);
		const encodedSize = frames.reduce((n, f) => n + 5 + f.payload.length, 0);
		expect(totalWritten).toBe(encodedSize);
	});
});
