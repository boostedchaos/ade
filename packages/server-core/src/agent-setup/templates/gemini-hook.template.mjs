{{MARKER}}
// Windows/node port of gemini-hook.template.sh.
// Gemini CLI hooks receive JSON on stdin and MUST print JSON to stdout.
// Events: BeforeAgent -> Start, AfterAgent -> Stop, AfterTool -> Start.

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
		setTimeout(() => resolve(data), 2000).unref?.();
	});
}

function extractString(input, key) {
	const re = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`);
	const m = input.match(re);
	return m ? m[1] : "";
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
	const input = await readStdin();
	let eventType = extractString(input, "hook_event_name");

	switch (eventType) {
		case "BeforeAgent":
			eventType = "Start";
			break;
		case "AfterAgent":
			eventType = "Stop";
			break;
		case "AfterTool":
			eventType = "Start";
			break;
		default:
			process.stdout.write("{}\n");
			return;
	}

	// Emit the required JSON response immediately to avoid blocking the agent.
	process.stdout.write("{}\n");

	if (!process.env.SUPERSET_TAB_ID) return;

	await post(eventType);
}

main().catch(() => {});
