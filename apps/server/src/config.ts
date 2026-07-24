import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v4";
import { ensureADEHomeDir } from "./environment";

const configSchema = z.object({
	port: z.number().int().min(1).max(65535).default(7777),
	/**
	 * Bind address. Defaults to loopback (D7): remote access goes through
	 * Tailscale Serve or a reverse proxy, never a raw non-local bind unless
	 * explicitly configured.
	 */
	bind: z.string().default("127.0.0.1"),
});

export type ServerConfig = z.infer<typeof configSchema>;

export interface CliOverrides {
	port?: number;
	bind?: string;
}

/** Load ~/.ade/server.json (if present) and apply CLI overrides on top. */
export function loadConfig(overrides: CliOverrides = {}): ServerConfig {
	const home = ensureADEHomeDir();
	const configPath = join(home, "server.json");
	let fileConfig: unknown = {};
	if (existsSync(configPath)) {
		try {
			fileConfig = JSON.parse(readFileSync(configPath, "utf8"));
		} catch (error) {
			throw new Error(
				`Invalid JSON in ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const base = configSchema.parse(fileConfig);
	return {
		port: overrides.port ?? base.port,
		bind: overrides.bind ?? base.bind,
	};
}
