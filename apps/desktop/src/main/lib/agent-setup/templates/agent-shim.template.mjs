{{MARKER}}
// Windows/node port of the POSIX bash agent wrappers (agent-wrappers-common.ts
// buildWrapperScript + the per-agent exec lines). One generic launcher backs
// every agent's <name>.cmd / <name>.ps1 PATH shim: the shim calls
//   node "<this file>" <agentName> <user args...>
// and this script (a) resolves the REAL agent binary on PATH while skipping any
// ADE/Damon wrapper dir, (b) applies the same env + extra args the bash wrapper
// did, (c) runs codex's task_started watcher / copilot's per-repo hook injection,
// then (d) execs the real binary inheriting stdio and forwarding the exit code.
//
// Config (paths, port, install hints) is baked in at setup time, mirroring how
// the .template.sh files substitute {{...}} placeholders.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const CONFIG = {{CONFIG}};

// Marker that identifies an ADE/Damon wrapper shim so we never resolve to one.
const WRAPPER_HEADER_NEEDLE = "agent-wrapper";
// Matches a path segment ".ade" or ".ade-<workspace>" followed by "bin"
// (both separators normalized to "/"). Mirrors the POSIX resolver's skip list.
const WRAPPER_DIR_RE = /\/\.ade(?:-[^/]+)?\/bin\//;

function normalize(p) {
	return p.replaceAll("\\", "/").toLowerCase();
}

function isWrapperPath(candidate) {
	const norm = normalize(candidate);
	// Skip our own bin dir and any ADE/Damon wrapper bin dir.
	if (norm.startsWith(normalize(CONFIG.binDir) + "/")) return true;
	if (WRAPPER_DIR_RE.test(norm)) return true;
	// Skip other wrapper shims by header (foreign ADE/Damon installs on PATH).
	try {
		const fd = fs.openSync(candidate, "r");
		try {
			const buf = Buffer.alloc(512);
			const read = fs.readSync(fd, buf, 0, 512, 0);
			if (buf.toString("utf-8", 0, read).includes(WRAPPER_HEADER_NEEDLE)) {
				return true;
			}
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		// Unreadable candidate: fall through and let it be considered.
	}
	return false;
}

function findRealBinary(name) {
	let out = "";
	try {
		out = execFileSync("where.exe", [name], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return null;
	}
	const candidates = out
		.split(/\r?\n/)
		.map((s) => s.trim())
		.filter(Boolean);
	for (const candidate of candidates) {
		if (!isWrapperPath(candidate)) return candidate;
	}
	return null;
}

function missingBinaryMessage(name) {
	const info = CONFIG.installInfo[name];
	if (info) {
		return `ADE: ${name} not found on PATH. Install ${info.label}: ${info.command} — ${info.url}`;
	}
	return `ADE: ${name} not found in PATH. Install it and ensure it is on PATH, then retry.`;
}

// Faithful port of codex-wrapper-exec.template.sh: tail the codex TUI session log
// and fire a Start notification on each new task_started event (deduped by
// turn_id). Returns a stop() function.
function startCodexWatcher(notifyMjs) {
	if (!process.env.SUPERSET_TAB_ID) return () => {};
	if (!notifyMjs || !fs.existsSync(notifyMjs)) return () => {};

	process.env.CODEX_TUI_RECORD_SESSION = "1";
	if (!process.env.CODEX_TUI_SESSION_LOG_PATH) {
		const ts = Math.floor(Date.now() / 1000);
		process.env.CODEX_TUI_SESSION_LOG_PATH = path.join(
			os.tmpdir(),
			`superset-codex-session-${process.pid}_${ts}.jsonl`,
		);
	}
	const logPath = process.env.CODEX_TUI_SESSION_LOG_PATH;

	let lastTurnId = "";
	let offset = 0;
	let remainder = "";
	let started = false;

	const handleLine = (line) => {
		if (
			line.includes('"dir":"to_tui"') &&
			line.includes('"kind":"codex_event"') &&
			line.includes('"type":"task_started"')
		) {
			const m = line.match(/"turn_id":"([^"]*)"/);
			const turnId = m ? m[1] : "task_started";
			if (turnId !== lastTurnId) {
				lastTurnId = turnId;
				try {
					spawn(process.execPath, [notifyMjs, '{"hook_event_name":"Start"}'], {
						stdio: "ignore",
						detached: false,
					}).unref?.();
				} catch {
					// Best-effort.
				}
			}
		}
	};

	const poll = () => {
		let size;
		try {
			size = fs.statSync(logPath).size;
		} catch {
			return; // Log not created yet.
		}
		if (!started) started = true;
		if (size < offset) offset = 0; // Truncated/rotated.
		if (size === offset) return;
		let chunk = "";
		try {
			const fd = fs.openSync(logPath, "r");
			try {
				const buf = Buffer.alloc(size - offset);
				const read = fs.readSync(fd, buf, 0, buf.length, offset);
				chunk = buf.toString("utf-8", 0, read);
				offset += read;
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			return;
		}
		remainder += chunk;
		const lines = remainder.split("\n");
		remainder = lines.pop() ?? "";
		for (const line of lines) handleLine(line);
	};

	const interval = setInterval(poll, 100);
	interval.unref?.();
	return () => clearInterval(interval);
}

// Faithful port of buildCopilotWrapperExecLine: refresh the per-repo Copilot hook
// file in the current working directory and keep it git-ignored.
function injectCopilotHooks(cfg) {
	if (!process.env.SUPERSET_TAB_ID) return;
	if (!cfg?.hookMjs || !fs.existsSync(cfg.hookMjs)) return;
	try {
		const hooksDir = path.join(".github", "hooks");
		const hookFile = path.join(hooksDir, "superset-notify.json");
		fs.mkdirSync(hooksDir, { recursive: true });
		fs.writeFileSync(hookFile, `${JSON.stringify(cfg.hooksJson, null, 2)}\n`);

		const gitInfoDir = path.join(".git", "info");
		if (fs.existsSync(gitInfoDir)) {
			const excludePath = path.join(gitInfoDir, "exclude");
			const entry = ".github/hooks/superset-notify.json";
			let contents = "";
			try {
				contents = fs.readFileSync(excludePath, "utf-8");
			} catch {
				contents = "";
			}
			if (!contents.split(/\r?\n/).includes(entry)) {
				fs.appendFileSync(excludePath, `${entry}\n`);
			}
		}
	} catch {
		// Best-effort: never block the agent.
	}
}

function runReal(realBin, args) {
	const ext = path.extname(realBin).toLowerCase();
	let cmd;
	let cmdArgs;
	if (ext === ".cmd" || ext === ".bat") {
		cmd = process.env.ComSpec || "cmd.exe";
		cmdArgs = ["/d", "/s", "/c", realBin, ...args];
	} else if (ext === ".ps1") {
		cmd = "powershell.exe";
		cmdArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", realBin, ...args];
	} else {
		cmd = realBin;
		cmdArgs = args;
	}

	const child = spawn(cmd, cmdArgs, { stdio: "inherit" });

	// Let the child own console control events (Ctrl+C / Ctrl+Break); we exit
	// only when it does, forwarding its status.
	const swallow = () => {};
	process.on("SIGINT", swallow);
	process.on("SIGBREAK", swallow);

	child.on("error", (err) => {
		process.stderr.write(`ADE: failed to launch ${realBin}: ${err.message}\n`);
		process.exit(127);
	});
	child.on("exit", (code, signal) => {
		if (typeof code === "number") process.exit(code);
		// Terminated by signal: surface a conventional non-zero code.
		process.exit(signal ? 1 : 0);
	});
}

function main() {
	const agentName = process.argv[2];
	const userArgs = process.argv.slice(3);
	if (!agentName) {
		process.stderr.write("ADE: agent shim invoked without an agent name\n");
		process.exit(2);
	}

	const agent = CONFIG.agents[agentName] ?? {};

	const realBin = findRealBinary(agentName);
	if (!realBin) {
		process.stderr.write(`${missingBinaryMessage(agentName)}\n`);
		process.exit(127);
	}

	if (agent.env) {
		for (const [k, v] of Object.entries(agent.env)) process.env[k] = v;
	}

	let extraArgs = agent.extraArgs ? [...agent.extraArgs] : [];

	if (agent.copilotInject) injectCopilotHooks(agent.copilotInject);

	if (agent.codexWatcher) {
		startCodexWatcher(CONFIG.notifyMjs);
		extraArgs = ["-c", `notify=["node","${CONFIG.notifyMjs.replaceAll("\\", "\\\\")}"]`, ...extraArgs];
	}

	runReal(realBin, [...extraArgs, ...userArgs]);
}

main();
