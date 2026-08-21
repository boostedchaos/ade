import { readFile, realpath, writeFile } from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	relative,
	resolve,
	sep,
} from "node:path";
import { Readable, Writable } from "node:stream";
import {
	type ClientConnection,
	type ContentChunk,
	client,
	type InitializeResponse,
	methods,
	type NewSessionResponse,
	ndJsonStream,
	PROTOCOL_VERSION,
	type PromptResponse,
	RequestError,
	type SessionConfigOption,
	type SessionUpdate,
	type SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import { toAcpConfigOption } from "./config-options";
import { acpError } from "./errors";
import type {
	AcpPermissionOutcome,
	AcpPermissionRequest,
	AcpSessionUpdate,
} from "./types";

const DEBUG_ACP = process.env.SUPERSET_ACP_DEBUG === "1";

/** Client name reported to the agent in `initialize`. */
const CLIENT_NAME = "argus";

// =============================================================================
// sessionUpdate mapping
// =============================================================================

function textOf(chunk: ContentChunk): string {
	return chunk.content.type === "text" ? chunk.content.text : "";
}

/**
 * Map an adapter `session/update` payload onto the host's union.
 *
 * Anything not modeled here becomes `{ kind: "unknown", raw }` — never a throw,
 * so a `claude-agent-acp` version bump cannot take the host down.
 */
export function mapSessionUpdate(update: SessionUpdate): AcpSessionUpdate {
	switch (update.sessionUpdate) {
		case "agent_message_chunk":
			return { kind: "agent_message_chunk", text: textOf(update) };
		case "agent_thought_chunk":
			return { kind: "agent_thought_chunk", text: textOf(update) };
		case "tool_call":
			return { kind: "tool_call", toolCall: update };
		case "tool_call_update":
			return { kind: "tool_call_update", toolCall: update };
		case "plan":
			return { kind: "plan", entries: update.entries };
		case "available_commands_update":
			return {
				kind: "available_commands_update",
				commands: update.availableCommands,
			};
		case "config_option_update":
			return {
				kind: "config_option_update",
				options: update.configOptions.map(toAcpConfigOption),
			};
		case "current_mode_update":
			return { kind: "current_mode_update", modeId: update.currentModeId };
		case "session_info_update":
			return {
				kind: "session_info_update",
				title: update.title ?? null,
				updatedAt: update.updatedAt ?? null,
			};
		case "usage_update":
			return {
				kind: "usage_update",
				used: update.used,
				size: update.size,
				cost: update.cost ?? null,
			};
		default:
			if (DEBUG_ACP) {
				console.log(
					`[AcpConnection] unmapped sessionUpdate kind: ${JSON.stringify(update)}`,
				);
			}
			return { kind: "unknown", raw: update };
	}
}

// =============================================================================
// fs/* sandbox
// =============================================================================

/**
 * Resolve an agent-supplied path against the session root and refuse anything
 * that escapes it.
 *
 * Defense in depth: the adapter normally runs with permission bypass, so this
 * is not the only thing standing between the agent and the filesystem — but a
 * client that will read and write on request should not do it outside the
 * workspace it was given.
 *
 * Symlinks are followed before the check (`realpath`), because a lexical check
 * alone is satisfied by a link pointing out of the tree. For a file that does
 * not exist yet, the nearest existing ancestor is what gets resolved.
 */
export async function resolveInsideRoot(
	root: string,
	requestedPath: string,
): Promise<string> {
	const target = resolve(root, requestedPath);
	const realRoot = await realpath(root);

	// Walk up to the deepest part of the path that already exists and resolve
	// that; the remainder is about to be created and cannot itself be a link.
	let probe = target;
	const missing: string[] = [];
	let existing: string;
	for (;;) {
		try {
			existing = await realpath(probe);
			break;
		} catch {
			const parent = dirname(probe);
			if (parent === probe) {
				throw RequestError.invalidParams(
					undefined,
					`path "${requestedPath}" could not be resolved against the session root`,
				);
			}
			missing.unshift(basename(probe));
			probe = parent;
		}
	}

	const resolved =
		missing.length > 0 ? resolve(existing, ...missing) : existing;
	const rel = relative(realRoot, resolved);
	// `startsWith("..")` also refuses a legitimate file named `..hidden`. Only a
	// `rel` that IS `..`, or whose first segment is `..`, escapes the root.
	const escapes = rel === ".." || rel.startsWith(`..${sep}`);
	if (rel !== "" && (escapes || isAbsolute(rel))) {
		throw RequestError.invalidParams(
			undefined,
			`path "${requestedPath}" resolves outside the session root`,
		);
	}
	return resolved;
}

// =============================================================================
// AcpConnection
// =============================================================================

export interface AcpConnectionCallbacks {
	onSessionUpdate: (update: AcpSessionUpdate) => void;
	onPermissionRequest: (
		req: AcpPermissionRequest,
	) => Promise<AcpPermissionOutcome>;
	/**
	 * Raw `config_option_update` payload, handed over alongside the mapped
	 * update because the cache needs the adapter's own option shape (select vs
	 * boolean) that the normalized union member does not carry.
	 */
	onConfigOptions: (options: SessionConfigOption[]) => void;
	/** Fired once when the underlying connection closes, for any reason. */
	onClosed: (error?: unknown) => void;
}

export interface AcpConnectionOptions {
	/** Bracketed log prefix supplied by the owner, e.g. `[AcpSession pane-1]`. */
	logPrefix: string;
	/** Session root; the `fs/*` sandbox boundary. */
	cwd: string;
	stdin: Writable;
	stdout: Readable;
	callbacks: AcpConnectionCallbacks;
}

/**
 * The wire: an ACP client bound to one child's stdio.
 *
 * Owns the five client-side methods and the request helpers, and knows nothing
 * about panes. The SDK owns JSON-RPC framing and correlation — the NDJSON
 * parser in `terminal-host/client.ts` is for the terminal daemon protocol and
 * is deliberately not reused here.
 */
export class AcpConnection {
	private readonly connection: ClientConnection;
	private readonly logPrefix: string;

	private constructor(connection: ClientConnection, logPrefix: string) {
		this.connection = connection;
		this.logPrefix = logPrefix;
	}

	static open(options: AcpConnectionOptions): AcpConnection {
		const { callbacks, cwd, logPrefix } = options;

		// `node:stream/web`'s WHATWG types and the global ones are structurally
		// near-identical but not assignable; the runtime objects are the same.
		const stream = ndJsonStream(
			Writable.toWeb(options.stdin) as unknown as WritableStream<Uint8Array>,
			Readable.toWeb(options.stdout) as unknown as ReadableStream<Uint8Array>,
		);

		const app = client({ name: CLIENT_NAME })
			.onNotification(methods.client.session.update, (ctx) => {
				const update = ctx.params.update;
				if (update.sessionUpdate === "config_option_update") {
					callbacks.onConfigOptions(update.configOptions);
				}
				callbacks.onSessionUpdate(mapSessionUpdate(update));
			})
			.onRequest(methods.client.session.requestPermission, async (ctx) => ({
				outcome: await callbacks.onPermissionRequest(ctx.params),
			}))
			.onRequest(methods.client.fs.readTextFile, async (ctx) => {
				const path = await resolveInsideRoot(cwd, ctx.params.path);
				return { content: await readFile(path, "utf8") };
			})
			.onRequest(methods.client.fs.writeTextFile, async (ctx) => {
				const path = await resolveInsideRoot(cwd, ctx.params.path);
				await writeFile(path, ctx.params.content, "utf8");
				return {};
			});

		const connection = app.connect(stream);
		void connection.closed.then(
			() => callbacks.onClosed(),
			(error: unknown) => callbacks.onClosed(error),
		);

		return new AcpConnection(connection, logPrefix);
	}

	/** Resolves when the connection closes, for any reason. */
	get closed(): Promise<void> {
		return this.connection.closed;
	}

	async initialize(): Promise<InitializeResponse> {
		return this.call("initialize", () =>
			this.connection.agent.request(methods.agent.initialize, {
				protocolVersion: PROTOCOL_VERSION,
				clientInfo: { name: CLIENT_NAME, version: "0.1.0" },
				clientCapabilities: {
					fs: { readTextFile: true, writeTextFile: true },
				},
			}),
		);
	}

	async newSession(cwd: string): Promise<NewSessionResponse> {
		return this.call("session/new", () =>
			this.connection.agent.request(methods.agent.session.new, {
				cwd,
				mcpServers: [],
			}),
		);
	}

	async prompt(sessionId: string, text: string): Promise<PromptResponse> {
		return this.call("session/prompt", () =>
			this.connection.agent.request(methods.agent.session.prompt, {
				sessionId,
				prompt: [{ type: "text", text }],
			}),
		);
	}

	/** `session/cancel` is a notification, not a request. */
	async cancel(sessionId: string): Promise<void> {
		return this.call("session/cancel", () =>
			this.connection.agent.notify(methods.agent.session.cancel, { sessionId }),
		);
	}

	async setMode(sessionId: string, modeId: string): Promise<void> {
		await this.call("session/set_mode", () =>
			this.connection.agent.request(methods.agent.session.setMode, {
				sessionId,
				modeId,
			}),
		);
	}

	async setConfigOption(
		sessionId: string,
		configId: string,
		value: string | boolean,
	): Promise<SetSessionConfigOptionResponse> {
		return this.call("session/set_config_option", () =>
			this.connection.agent.request(
				methods.agent.session.setConfigOption,
				typeof value === "boolean"
					? { sessionId, configId, type: "boolean", value }
					: { sessionId, configId, value },
			),
		);
	}

	async closeSession(sessionId: string): Promise<void> {
		await this.call("session/close", () =>
			this.connection.agent.request(methods.agent.session.close, { sessionId }),
		);
	}

	close(error?: unknown): void {
		try {
			this.connection.close(error);
		} catch (closeError) {
			console.warn(
				`${this.logPrefix} failed to close ACP connection:`,
				closeError,
			);
		}
	}

	/** Turn any JSON-RPC failure into the stable `acp-rpc-error` code. */
	private async call<T>(method: string, send: () => Promise<T>): Promise<T> {
		try {
			return await send();
		} catch (error) {
			if (error instanceof RequestError) {
				throw acpError(
					"acp-rpc-error",
					`${method} failed (code ${error.code}): ${error.message}`,
				);
			}
			throw error;
		}
	}
}
