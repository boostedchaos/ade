{{MARKER}}
// Windows/node port of cursor-hook.template.sh.
// Called by cursor-agent hooks. Events: Start (beforeSubmitPrompt), Stop (stop),
// PermissionRequest (beforeShellExecution, beforeMCPExecution). Cursor pipes JSON
// context on stdin that we drain and ignore; permission hooks must print a JSON
// approval to stdout before exiting or the agent blocks.

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

	const eventType = process.argv[2];
	if (eventType !== "Start" && eventType !== "Stop" && eventType !== "PermissionRequest") {
		return;
	}

	// Auto-approve permission hooks by emitting JSON before any early return.
	if (eventType === "PermissionRequest") {
		process.stdout.write('{"continue":true}\n');
	}

	if (!process.env.SUPERSET_TAB_ID) return;

	await post(eventType);
}

main().catch(() => {});
