/**
 * `ade tmux-compat <argv…>` — the shim target.
 *
 * `~/.ade/claude-teams-bin/tmux` execs this with tmux's own argv, so Claude
 * Code's agent-teams backend drives ADE panes believing it is driving tmux.
 * PROTOCOL.md: `tmux-compat` never appears on the wire — it calls ordinary
 * control-plane commands.
 */
import { ControlClient } from "../client";
import type { Command, LocalIo } from "../command";
import { CompatStore, defaultStoreDir } from "../tmux-compat/store";
import {
	type ControlApi,
	runTmuxCompat,
	type TranslateDeps,
} from "../tmux-compat/translate";

export interface TmuxCompatOverrides {
	store?: CompatStore;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	connect?: () => Promise<ControlApi>;
}

export async function runTmuxCompatCommand(
	argv: string[],
	io: LocalIo,
	overrides: TmuxCompatOverrides = {},
): Promise<number> {
	const env = overrides.env ?? process.env;
	const deps: TranslateDeps = {
		store: overrides.store ?? new CompatStore(defaultStoreDir(env)),
		env,
		cwd: overrides.cwd ?? process.cwd(),
		io: {
			stdout: (text) => io.stdout(text),
			stderr: (text) => io.stderr(text),
		},
		connect:
			overrides.connect ??
			(async () => {
				const client = new ControlClient();
				await client.connect();
				// One-shot process: the client dies with it, so nothing closes this
				// explicitly. `process.exit` in index.ts tears the socket down.
				return client;
			}),
	};
	return await runTmuxCompat(argv, deps);
}

export const tmuxCompatCommands: Command[] = [
	{
		name: "tmux-compat",
		group: "Teams",
		summary: "Internal: translate tmux argv into ADE control-plane calls",
		kind: "local",
		rawArgs: true,
		notes:
			"Not meant to be typed. `ade claude-teams` materializes a `tmux`\n" +
			"executable that execs this, so Claude Code's experimental agent-teams\n" +
			"backend creates real ADE panes instead of tmux panes.\n\n" +
			"Exit codes here are TMUX's (0 ok, 1 failed), not the ade CLI's, because\n" +
			"Claude Code branches on them. Unknown verbs are logged to\n" +
			"~/.ade/tmux-compat.log and exit 0. Socket flags (-S / -L) are accepted\n" +
			"and ignored — the shim is the server. Mapping state lives in\n" +
			"~/.ade/tmux-compat-store.json.",
		runLocal: (argv, io) => runTmuxCompatCommand(argv, io),
	},
];
