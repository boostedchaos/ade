/**
 * The CLI's testable core: argv in, exit code out. `index.ts` is only a
 * shebang wrapper around this so tests never spawn a process or touch a real
 * ~/.ade socket.
 */
import { parseCommandArgs } from "./args";
import {
	type ClientOptions,
	type ControlClient,
	ControlClient as DefaultClient,
} from "./client";
import type { Command } from "./command";
import { findCommand } from "./commands";
import { stubPhase } from "./commands/stubs";
import { CliError, EXIT, type ExitCode } from "./errors";
import { commandHelp, topLevelHelp, VERSION } from "./help";
import { formatResult } from "./output";

export interface RunIo {
	stdout: (line: string) => void;
	stderr: (line: string) => void;
	/** Overridden in tests to point at a mock server. */
	createClient?: (options?: ClientOptions) => ControlClient;
	clientOptions?: ClientOptions;
	/** Stops the `events` reconnect loop. */
	signal?: AbortSignal;
	/** Reconnect backoff in ms; small values keep tests fast. */
	backoff?: { initial: number; max: number };
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		});
	});

export async function run(argv: string[], io: RunIo): Promise<ExitCode> {
	const [first, ...rest] = argv;

	if (
		first === undefined ||
		first === "--help" ||
		first === "-h" ||
		first === "help"
	) {
		io.stdout(topLevelHelp());
		return EXIT.OK;
	}
	if (first === "--version" || first === "-v") {
		io.stdout(VERSION);
		return EXIT.OK;
	}
	if (first.startsWith("-")) {
		io.stderr(`Unknown option: ${first}`);
		io.stderr("Run `ade --help` for usage.");
		return EXIT.USAGE;
	}

	const command = findCommand(first);
	if (!command) {
		io.stderr(`Unknown command: ${first}`);
		io.stderr("Run `ade --help` for the command list.");
		return EXIT.USAGE;
	}

	try {
		return await runCommand(command, rest, io);
	} catch (err) {
		// A hook-invoked command must never surface a failure — see the `silent`
		// kind in command.ts. This is the outermost of three guards (build,
		// connect, dispatch) so nothing can leak past it.
		if (command.kind === "silent") return EXIT.OK;
		if (
			err instanceof CliError &&
			err.code === EXIT.NOT_RUNNING &&
			command.offlineFallback
		) {
			const text = command.offlineFallback(
				parseCommandArgs(
					rest,
					command.options ?? [],
					command.positionals ?? [],
				),
			);
			if (text !== null) {
				io.stdout(text);
				return EXIT.OK;
			}
		}
		if (err instanceof CliError) {
			io.stderr(
				err.serverCode ? `${err.serverCode}: ${err.message}` : err.message,
			);
			if (err.code === EXIT.USAGE && !command.rawArgs) {
				io.stderr("");
				io.stderr(commandHelp(command));
			}
			return err.code;
		}
		io.stderr(err instanceof Error ? err.message : String(err));
		return EXIT.SERVER_ERROR;
	}
}

async function runCommand(
	command: Command,
	argv: string[],
	io: RunIo,
): Promise<ExitCode> {
	if (command.rawArgs) {
		if (argv.includes("--help") || argv.includes("-h")) {
			io.stdout(commandHelp(command));
			return EXIT.OK;
		}
		if (command.kind === "stub") {
			const phase = stubPhase(command.name);
			io.stderr(
				`ade ${command.name}: not yet implemented${phase ? ` (${phase})` : ""}`,
			);
			return EXIT.USAGE;
		}
	}

	const input = parseCommandArgs(
		argv,
		command.options ?? [],
		command.positionals ?? [],
	);
	if (input.help) {
		io.stdout(commandHelp(command));
		return EXIT.OK;
	}
	if (!command.build) {
		io.stderr(`ade ${command.name}: not yet implemented`);
		return EXIT.USAGE;
	}

	const request = command.build(input);

	if (command.kind === "stream") {
		return await runStream(request.args, io);
	}

	const client = (io.createClient ?? ((o) => new DefaultClient(o)))(
		io.clientOptions,
	);
	try {
		await client.connect();
		const result = await client.request(request.cmd, request.args);
		if (command.kind === "silent") return EXIT.OK;
		if (input.json) {
			io.stdout(JSON.stringify(result ?? null));
		} else {
			const text = command.format
				? command.format(result, input)
				: formatResult(result);
			if (text) io.stdout(text);
		}
		return EXIT.OK;
	} finally {
		client.close();
	}
}

/**
 * `ade events`: one dedicated connection, NDJSON to stdout, reconnect with
 * exponential backoff when the app restarts. Exits 3 only if it has never
 * connected — once it has, a drop is a reconnect, not a failure.
 */
async function runStream(
	args: Record<string, unknown>,
	io: RunIo,
): Promise<ExitCode> {
	const initial = io.backoff?.initial ?? 250;
	const max = io.backoff?.max ?? 5000;
	let delay = initial;
	let everConnected = false;

	while (!io.signal?.aborted) {
		const client = (io.createClient ?? ((o) => new DefaultClient(o)))(
			io.clientOptions,
		);
		try {
			await client.connect();
			everConnected = true;
			delay = initial;
			await new Promise<void>((resolve) => {
				client.setCloseHandler(() => resolve());
				io.signal?.addEventListener("abort", () => resolve(), { once: true });
				client
					.subscribe((args.kinds as string[] | undefined) ?? ["*"], (event) =>
						io.stdout(JSON.stringify(event)),
					)
					.catch((err: unknown) => {
						io.stderr(err instanceof Error ? err.message : String(err));
						resolve();
					});
			});
		} catch (err) {
			if (
				err instanceof CliError &&
				err.code === EXIT.NOT_RUNNING &&
				!everConnected
			) {
				io.stderr(err.message);
				return EXIT.NOT_RUNNING;
			}
			if (
				err instanceof CliError &&
				err.code === EXIT.SERVER_ERROR &&
				err.serverCode
			) {
				// A refused handshake will not fix itself by retrying.
				io.stderr(`${err.serverCode}: ${err.message}`);
				return EXIT.SERVER_ERROR;
			}
		} finally {
			client.close();
		}

		if (io.signal?.aborted) break;
		await sleep(delay, io.signal);
		delay = Math.min(max, delay * 2);
	}
	return EXIT.OK;
}
