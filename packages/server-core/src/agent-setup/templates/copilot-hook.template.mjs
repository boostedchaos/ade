{{MARKER}}
// Windows/node port of copilot-hook.template.sh.
// Called by GitHub Copilot CLI hooks. The event name arrives as argv[2].
// Copilot pipes JSON context on stdin (drained + ignored) and requires valid
// JSON on stdout. Event mapping mirrors the POSIX hook.

import process from "node:process";

const DEFAULT_PORT = "{{DEFAULT_PORT}}";

function drainStdin() {
	return new Promise((resolve) => {
		if (process.stdin.isTTY) {
			resolve();
			return;
		}
		process.stdin.on("data", () => {});
		process.stdin.on("end", () => resolve());
		process.stdin.on("error", () => resolve());
		setTimeout(() => resolve(), 2000).unref?.();
	});
}

async function post(eventType) {
	const port = process.env.SUPERSET_PORT || DEFAULT_PORT;
	const params = new URLSearchParams({
		paneId: process.env.SUPERSET_PANE_ID ?? "",
		tabId: process.env.SUPERSET_TAB_ID ?? "",
		workspaceId: process.env.SUPERSET_WORKSPACE_ID ?? "",
		eventType,
		env: process.env.SUPERSET_ENV ?? "",
		version: process.env.SUPERSET_HOOK_VERSION ?? "",
	});
	const url = `http://127.0.0.1:${port}/hook/complete?${params.toString()}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 2000);
	try {
		await fetch(url, { signal: controller.signal });
	} catch {
		// Best-effort.
	} finally {
		clearTimeout(timer);
	}
}

async function main() {
	await drainStdin();

	let eventType = process.argv[2];
	switch (eventType) {
		case "sessionStart":
			eventType = "Start";
			break;
		case "sessionEnd":
			eventType = "Stop";
			break;
		case "userPromptSubmitted":
			eventType = "Start";
			break;
		case "postToolUse":
			eventType = "Start";
			break;
		case "preToolUse":
			eventType = "PermissionRequest";
			break;
		default:
			process.stdout.write("{}\n");
			return;
	}

	// Must output valid JSON to avoid blocking the agent.
	process.stdout.write("{}\n");

	if (!process.env.SUPERSET_TAB_ID) return;

	await post(eventType);
}

main().catch(() => {});
