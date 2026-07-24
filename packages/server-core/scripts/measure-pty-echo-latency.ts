/**
 * Measures keystroke->echo latency at the pty-subprocess boundary (#58).
 *
 * Spawns a REAL pty-subprocess build as a child process, speaks the framed
 * stdio protocol, spawns a real shell PTY, writes single keystrokes, and
 * measures Write-frame-sent -> Data-frame-received deltas (median over 25
 * samples). Then runs a 20k-line echo flood and reports the Data-frame rate
 * (the number that decides whether the optional 16ms flood-guard from
 * docs/tickets/terminal-native-feel.md issue 1 is needed).
 *
 * On Windows the subprocess MUST run under Node, not bun (node-pty's ConPTY
 * conin socket breaks under bun — see apps/server/scripts/build.ts), so pass
 * a CJS bundle there:
 *
 *   cd packages/server-core
 *   bun -e "await require('esbuild').build({ bundle: true, platform: 'node',
 *     format: 'cjs', target: 'node20', external: ['node-pty'],
 *     entryPoints: ['src/terminal-host/pty-subprocess.ts'],
 *     outfile: 'pty-subprocess.tmp.cjs' })"
 *   bun scripts/measure-pty-echo-latency.ts pty-subprocess.tmp.cjs "after"
 *
 * On POSIX the .ts entry can be passed directly (runs under bun).
 * For a before/after comparison, bundle the old revision too:
 *   git show <rev>:packages/server-core/src/terminal-host/pty-subprocess.ts
 * into a sibling file in src/terminal-host/ (so its relative imports
 * resolve), bundle it the same way, and run this script against both.
 */
import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import {
	type PtySubprocessFrame,
	PtySubprocessFrameDecoder,
	PtySubprocessIpcType,
	writeFrame,
} from "../src/terminal-host/pty-subprocess-ipc";

const subprocessPath = path.resolve(process.argv[2] ?? "");
const label = process.argv[3] ?? subprocessPath;
if (!process.argv[2]) {
	console.error(
		"usage: bun scripts/measure-pty-echo-latency.ts <pty-subprocess bundle> [label]",
	);
	process.exit(1);
}

// Working dir for the subprocess: this package root (so require("node-pty")
// resolves for CJS bundles placed here).
const pkgDir = path.resolve(import.meta.dirname, "..");

type FrameRecord = PtySubprocessFrame & { t: number };
const frameListeners = new Set<(frame: FrameRecord) => void>();

function startChild(): ChildProcess {
	// .cjs bundles run under Node; .ts entries run under the current runtime.
	const runtime = subprocessPath.endsWith(".cjs") ? "node" : process.execPath;
	const child = spawn(runtime, [subprocessPath], {
		cwd: pkgDir,
		stdio: ["pipe", "pipe", "inherit"],
	});
	const decoder = new PtySubprocessFrameDecoder();
	child.stdout?.on("data", (chunk: Buffer) => {
		for (const frame of decoder.push(chunk)) {
			const rec: FrameRecord = { ...frame, t: performance.now() };
			for (const listener of [...frameListeners]) listener(rec);
		}
	});
	return child;
}

function waitForFrame(
	predicate: (frame: FrameRecord) => boolean,
	timeoutMs: number,
): Promise<FrameRecord> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			frameListeners.delete(listener);
			reject(new Error(`timeout waiting for frame (${timeoutMs}ms)`));
		}, timeoutMs);
		const listener = (frame: FrameRecord) => {
			if (!predicate(frame)) return;
			clearTimeout(timer);
			frameListeners.delete(listener);
			resolve(frame);
		};
		frameListeners.add(listener);
	});
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function main(): Promise<void> {
	const child = startChild();
	const stdin = child.stdin;
	if (!stdin) throw new Error("no stdin");

	await waitForFrame((f) => f.type === PtySubprocessIpcType.Ready, 10000);

	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (typeof v === "string") env[k] = v;
	}
	const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
	writeFrame(
		stdin,
		PtySubprocessIpcType.Spawn,
		Buffer.from(
			JSON.stringify({
				shell,
				args: [],
				cwd: pkgDir,
				cols: 120,
				rows: 30,
				env,
			}),
			"utf8",
		),
	);
	await waitForFrame((f) => f.type === PtySubprocessIpcType.Spawned, 10000);

	// Let the shell prompt settle (ConPTY initial paint).
	await sleep(2000);

	// --- Keystroke echo latency ---
	const samples: number[] = [];
	for (let i = 0; i < 25; i++) {
		const t0 = performance.now();
		const wait = waitForFrame(
			(f) => f.type === PtySubprocessIpcType.Data && f.t >= t0,
			3000,
		);
		writeFrame(stdin, PtySubprocessIpcType.Write, Buffer.from("a", "utf8"));
		try {
			const frame = await wait;
			samples.push(frame.t - t0);
		} catch {
			console.error(`sample ${i}: no echo (skipped)`);
		}
		await sleep(120);
	}

	const sorted = [...samples].sort((a, b) => a - b);
	console.log(`\n=== ${label} ===`);
	console.log(
		`keystroke->Data-frame latency over ${samples.length} samples (ms):`,
	);
	if (sorted.length === 0) {
		console.log("  NO SAMPLES — echo never arrived");
	} else {
		console.log(
			`  median=${median(samples).toFixed(2)} p25=${sorted[Math.floor(sorted.length * 0.25)].toFixed(2)} p75=${sorted[Math.floor(sorted.length * 0.75)].toFixed(2)} min=${sorted[0].toFixed(2)} max=${sorted[sorted.length - 1].toFixed(2)}`,
		);
	}

	// Clear the typed chars off the prompt line.
	writeFrame(stdin, PtySubprocessIpcType.Write, Buffer.from("\r", "utf8"));
	await sleep(500);

	// --- Flood test ---
	let floodFrames = 0;
	let floodBytes = 0;
	let firstT = 0;
	let lastT = 0;
	const floodListener = (f: FrameRecord) => {
		if (f.type !== PtySubprocessIpcType.Data) return;
		if (firstT === 0) firstT = f.t;
		lastT = f.t;
		floodFrames += 1;
		floodBytes += f.payload.length;
	};
	frameListeners.add(floodListener);
	const floodCmd =
		process.platform === "win32"
			? "for /L %i in (1,1,20000) do @echo yes yes yes yes yes yes yes yes\r"
			: "i=0; while [ $i -lt 20000 ]; do echo yes yes yes yes yes yes yes yes; i=$((i+1)); done\n";
	writeFrame(stdin, PtySubprocessIpcType.Write, Buffer.from(floodCmd, "utf8"));

	// Wait until output has been quiet for 1s (or 60s cap).
	const floodStart = performance.now();
	for (;;) {
		await sleep(250);
		const now = performance.now();
		if (lastT !== 0 && now - lastT > 1000) break;
		if (now - floodStart > 60000) break;
	}
	frameListeners.delete(floodListener);

	const durS = (lastT - firstT) / 1000;
	console.log("flood (20k echo lines):");
	console.log(
		`  ${floodFrames} Data frames, ${(floodBytes / 1024).toFixed(0)}KB in ${durS.toFixed(2)}s -> ${(floodFrames / durS).toFixed(0)} frames/s, avg ${(floodBytes / floodFrames / 1024).toFixed(1)}KB/frame`,
	);

	writeFrame(stdin, PtySubprocessIpcType.Dispose);
	await sleep(300);
	child.kill();
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
