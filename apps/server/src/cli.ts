import { parseArgs } from "node:util";
import { rotateToken } from "./auth";
import { loadConfig } from "./config";
import { startServer } from "./server";

const HELP = `ade-server

Usage:
  ade serve [--port <n>] [--bind <addr>]
  ade token rotate

Options:
  --port <n>     Port to listen on (default 7777, or "port" in ~/.ade/server.json)
  --bind <addr>  Address to bind (default 127.0.0.1; use Tailscale Serve or a
                 reverse proxy for remote access rather than a wide bind)
  --help         Show this help

Commands:
  serve          Start the server (default)
  token rotate   Mint a new access token; all devices must re-enter it
`;

async function main() {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			port: { type: "string" },
			bind: { type: "string" },
			help: { type: "boolean" },
		},
	});

	const command = positionals[0] ?? "serve";
	if (values.help || command === "help") {
		console.log(HELP);
		return;
	}

	if (command === "token") {
		if (positionals[1] !== "rotate") {
			console.error(`Unknown token command: ${positionals[1] ?? ""}\n${HELP}`);
			process.exit(1);
		}
		const { token, path } = rotateToken();
		console.log("Token rotated. All devices must re-enter the new token.");
		console.log(`New token (shown once): ${token}`);
		console.log(`Stored at: ${path}`);
		return;
	}

	if (command !== "serve") {
		console.error(`Unknown command: ${command}\n${HELP}`);
		process.exit(1);
	}

	const config = loadConfig({
		port: values.port ? Number(values.port) : undefined,
		bind: values.bind,
	});
	if (values.port && Number.isNaN(Number(values.port))) {
		console.error(`Invalid --port: ${values.port}`);
		process.exit(1);
	}

	const running = await startServer(config);

	const shutdown = async (signal: string) => {
		console.log(`\n${signal} received, shutting down`);
		await running.close();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
	console.error("ade-server failed to start:", error);
	process.exit(1);
});
