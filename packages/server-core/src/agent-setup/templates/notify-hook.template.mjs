{{MARKER}}
// Windows/node port of notify-hook.template.sh.
// Called by CLI agents (Claude Code, Codex, Mastra, OpenCode plugin) when they
// complete or need input. Claude pipes JSON on stdin; Codex passes it as argv[2].
// Behavior mirrors the POSIX shell hook exactly (event extraction + mapping +
// the /hook/complete GET), reimplemented with node built-ins so it runs on
// Windows where bash/curl are absent.

import process from "node:process";

const DEFAULT_PORT = "{{DEFAULT_PORT}}";

function readStdin() {
	return new Promise((resolve) => {
		let data = "";
		if (process.stdin.isTTY) {
			resolve("");
			return;
		}
		process.stdin.setEncoding("utf-8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => resolve(data));
		process.stdin.on("error", () => resolve(data));
		// Guard against a hook that never receives EOF.
		setTimeout(() => resolve(data), 2000).unref?.();
	});
}

// Extract a string field from a JSON blob the same way the shell hook's grep -oE
// did: tolerant of surrounding noise, whitespace around the colon, and works even
// when the payload is not valid JSON (agents occasionally emit trailing data).
function extractString(input, key) {
	const re = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`);
	const m = input.match(re);
	return m ? m[1] : "";
}

async function main() {
	const argInput = process.argv[2];
	const input = argInput && argInput.length > 0 ? argInput : await readStdin();

	const sessionId = extractString(input, "session_id");
	// Claude Code's JSON-escaped path; the stuck-state corrector tails this file.
	const transcriptPath = extractString(input, "transcript_path").replace(
		/\\\\/g,
		"\\",
	);

	// Skip if this isn't a Superset terminal hook and there's no Mastra session.
	if (!process.env.SUPERSET_TAB_ID && !sessionId) return;

	let eventType = extractString(input, "hook_event_name");
	if (!eventType) {
		const codexType = extractString(input, "type");
		if (codexType === "agent-turn-complete") eventType = "Stop";
	}

	if (eventType === "UserPromptSubmit") eventType = "Start";

	// A parse failure must not fire a false completion notification.
	if (!eventType) return;

	const debugRaw = process.env.SUPERSET_DEBUG_HOOKS;
	let debug = false;
	if (debugRaw) {
		debug = /^(1|true|yes|on)$/i.test(debugRaw);
	} else if (
		process.env.SUPERSET_ENV === "development" ||
		process.env.NODE_ENV === "development"
	) {
		debug = true;
	}

	if (debug) {
		process.stderr.write(
			`[notify-hook] event=${eventType} sessionId=${sessionId} paneId=${process.env.SUPERSET_PANE_ID} tabId=${process.env.SUPERSET_TAB_ID} workspaceId=${process.env.SUPERSET_WORKSPACE_ID}\n`,
		);
	}

	const port = process.env.SUPERSET_PORT || DEFAULT_PORT;
	const params = new URLSearchParams({
		paneId: process.env.SUPERSET_PANE_ID ?? "",
		tabId: process.env.SUPERSET_TAB_ID ?? "",
		workspaceId: process.env.SUPERSET_WORKSPACE_ID ?? "",
		sessionId: sessionId ?? "",
		transcriptPath: transcriptPath ?? "",
		eventType,
		env: process.env.SUPERSET_ENV ?? "",
		version: process.env.SUPERSET_HOOK_VERSION ?? "",
	});
	const url = `http://127.0.0.1:${port}/hook/complete?${params.toString()}`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 2000);
	try {
		const res = await fetch(url, { signal: controller.signal });
		if (debug) {
			process.stderr.write(`[notify-hook] dispatched status=${res.status}\n`);
		}
	} catch {
		// Best-effort: never block the agent on a notification failure.
	} finally {
		clearTimeout(timer);
	}
}

main().catch(() => {});
