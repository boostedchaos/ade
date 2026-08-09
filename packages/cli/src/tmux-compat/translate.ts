/**
 * The translator: tmux vocabulary → ADE control-plane calls.
 *
 * Built against docs/specs/mission-control/probe/PROBE-CONTRACT.md, which is a
 * REAL captured contract from Claude Code 2.1.226 and OVERRIDES the spec's
 * assumed verb usage. Load-bearing facts it changes:
 *
 * - The command channel is `set-option -p … remain-on-exit failed` followed by
 *   `respawn-pane -k -t %N -- '<shell string>'` on a pane born as a
 *   placeholder. `send-keys` never starts a teammate and `capture-pane` is
 *   never called (both are implemented anyway — they are in the spec's verb
 *   set and cost little).
 * - Nothing polls, nothing writes to stdin, teardown is `kill-pane` only.
 * - Exactly four format strings are ever read back.
 *
 * Exit codes here are TMUX's, not the ADE CLI's: Claude Code tests
 * `result.code !== 0`, and `has-session` MUST fail honestly (a shim that
 * returns 0 for a session that does not exist makes Claude skip `new-session`
 * and strand every later call).
 */
import { encodeKey, knownKeyNames, UnknownKeyError } from "../keys";
import { expandFormat, type FormatContext } from "./format";
import { parseGlobal, parseVerb, type VerbFlags } from "./parse";
import { execLine } from "./quote";
import {
	type CompatStore,
	nextId,
	type PaneRecord,
	type SessionRecord,
	type StoreData,
	type WindowRecord,
} from "./store";

/** Reported by `tmux -V`. Claude Code only checks that the call exits 0. */
export const TMUX_VERSION = "tmux 3.4";

/** Values `show` reports for options nothing has set. */
const OPTION_DEFAULTS: Record<string, string> = {
	mouse: "off",
	"focus-events": "off",
	"pane-border-status": "off",
	"default-shell": "/bin/sh",
};

export interface ControlApi {
	request(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}

export interface TmuxIo {
	stdout(text: string): void;
	stderr(text: string): void;
}

export interface TranslateDeps {
	store: CompatStore;
	io: TmuxIo;
	env: NodeJS.ProcessEnv;
	/** Lazy so `-V`, `set-option` and `display-message` never open a socket. */
	connect: () => Promise<ControlApi>;
	cwd: string;
}

/** Verbs with real behaviour. Anything else is logged and exits 0 (fail-soft). */
const HANDLED = new Set([
	"-V",
	"has-session",
	"new-session",
	"new-window",
	"split-window",
	"list-panes",
	"list-windows",
	"list-sessions",
	"display-message",
	"set-option",
	"set-window-option",
	"select-pane",
	"select-window",
	"kill-pane",
	"kill-window",
	"kill-session",
	"kill-server",
	"respawn-pane",
	"send-keys",
	"capture-pane",
	"select-layout",
	"resize-pane",
	"show",
	"show-options",
	"show-window-options",
	"show-environment",
]);

/** Layout verbs ADE's mosaic owns: accepted, no visual effect, exit 0. */
const LAYOUT_NOOPS = new Set(["select-layout", "resize-pane", "kill-server"]);

class TmuxError extends Error {}

// ---------------------------------------------------------------------------
// Resolution helpers — all operate on the in-memory store under the lock
// ---------------------------------------------------------------------------

function leaderPaneId(env: NodeJS.ProcessEnv): string {
	return env.TMUX_PANE ?? "%0";
}

function bumpCounter(
	data: StoreData,
	kind: "pane" | "window" | "session",
	id: string,
): void {
	const numeric = Number(id.slice(1));
	if (Number.isFinite(numeric) && numeric >= data.counters[kind]) {
		data.counters[kind] = numeric + 1;
	}
}

/**
 * Binds `%0` (or whatever `$TMUX_PANE` says) to the pane ADE launched Claude
 * in. `ade claude-teams` seeds this, but the shim must also work when Claude
 * was started some other way with the shim on PATH.
 */
function ensureLeader(data: StoreData, env: NodeJS.ProcessEnv): PaneRecord {
	const paneId = leaderPaneId(env);
	const existing = data.panes[paneId];
	if (existing) {
		if (!existing.adePaneId && env.ADE_SURFACE_ID) {
			existing.adePaneId = env.ADE_SURFACE_ID;
		}
		return existing;
	}

	const sessionId = "$0";
	const windowId = "@0";
	const sessionName = env.ADE_TMUX_SESSION ?? "ade";

	data.sessions[sessionId] ??= {
		id: sessionId,
		name: sessionName,
		windowOrder: [],
	};
	data.windows[windowId] ??= {
		id: windowId,
		sessionId,
		name: sessionName,
		adeTabId: null,
		options: {},
		paneOrder: [],
	};
	const session = data.sessions[sessionId] as SessionRecord;
	const window = data.windows[windowId] as WindowRecord;
	if (!session.windowOrder.includes(windowId))
		session.windowOrder.push(windowId);

	const pane: PaneRecord = {
		id: paneId,
		windowId,
		adePaneId: env.ADE_SURFACE_ID ?? null,
		title: null,
		options: {},
		state: "shell",
		command: null,
	};
	data.panes[paneId] = pane;
	if (!window.paneOrder.includes(paneId)) window.paneOrder.unshift(paneId);

	bumpCounter(data, "pane", paneId);
	bumpCounter(data, "window", windowId);
	bumpCounter(data, "session", sessionId);
	return pane;
}

function findSession(
	data: StoreData,
	target: string,
): SessionRecord | undefined {
	if (target.startsWith("$")) return data.sessions[target];
	return Object.values(data.sessions).find((s) => s.name === target);
}

function findWindow(data: StoreData, target: string): WindowRecord | undefined {
	if (target === "") return undefined;
	if (target.startsWith("@")) return data.windows[target];
	if (target.startsWith("%")) {
		const pane = data.panes[target];
		return pane ? data.windows[pane.windowId] : undefined;
	}
	if (target.startsWith("$")) {
		const session = data.sessions[target];
		const first = session?.windowOrder[0];
		return first ? data.windows[first] : undefined;
	}
	if (target.includes(":")) {
		const [sessionPart = "", rest = ""] = target.split(":", 2);
		const session = findSession(data, sessionPart);
		if (!session) return undefined;
		const windowPart = (rest.split(".")[0] ?? "").trim();
		if (windowPart === "") {
			const first = session.windowOrder[0];
			return first ? data.windows[first] : undefined;
		}
		if (windowPart.startsWith("@")) return data.windows[windowPart];
		return session.windowOrder
			.map((id) => data.windows[id])
			.find((w): w is WindowRecord => w?.name === windowPart);
	}
	// Bare name: a window name first, then a session's first window.
	const byName = Object.values(data.windows).find((w) => w.name === target);
	if (byName) return byName;
	const session = findSession(data, target);
	const first = session?.windowOrder[0];
	return first ? data.windows[first] : undefined;
}

function findPane(
	data: StoreData,
	target: string,
	env: NodeJS.ProcessEnv,
): PaneRecord | undefined {
	if (target === "") return data.panes[leaderPaneId(env)];
	if (target.startsWith("%")) return data.panes[target];
	if (target.includes(".")) {
		const paneRef = target.slice(target.lastIndexOf(".") + 1);
		if (paneRef.startsWith("%")) return data.panes[paneRef];
	}
	const window = findWindow(data, target);
	const first = window?.paneOrder[0];
	return first ? data.panes[first] : undefined;
}

function contextFor(data: StoreData, pane: PaneRecord): FormatContext {
	const window = data.windows[pane.windowId];
	const session = window ? data.sessions[window.sessionId] : undefined;
	return {
		paneId: pane.id,
		paneIndex: window ? window.paneOrder.indexOf(pane.id) : 0,
		paneTitle: pane.title,
		windowId: window?.id ?? null,
		windowIndex: session ? session.windowOrder.indexOf(pane.windowId) : 0,
		windowName: window?.name ?? null,
		sessionId: session?.id ?? null,
		sessionName: session?.name ?? null,
	};
}

/**
 * The control-plane target for a pane. An unbound LEADER pane falls back to
 * `focused` (the pane Claude is running in is the focused one at launch); any
 * other unbound pane is a mapping bug and must fail loudly rather than act on
 * whatever happens to be focused.
 */
function adeRef(pane: PaneRecord, env: NodeJS.ProcessEnv): string {
	if (pane.adePaneId) return pane.adePaneId;
	if (pane.id === leaderPaneId(env)) return "focused";
	throw new TmuxError(`pane ${pane.id} is not mapped to an ADE pane`);
}

interface ListPanesResult {
	tabId: string;
	panes: { id: string }[];
}

function asListPanes(value: unknown): ListPanesResult {
	const record = (value ?? {}) as Partial<ListPanesResult>;
	return { tabId: record.tabId ?? "", panes: record.panes ?? [] };
}

function createdPaneId(value: unknown): string | null {
	const record = (value ?? {}) as { paneId?: string };
	return record.paneId ?? null;
}

function createdTabId(value: unknown): string | null {
	const record = (value ?? {}) as { tabId?: string };
	return record.tabId ?? null;
}

/** Which ADE tab holds a given ADE pane. Focused tab first — the common case. */
async function findTabForPane(
	api: ControlApi,
	adePaneId: string | null,
): Promise<string | null> {
	const focused = asListPanes(await api.request("list-panes", {}));
	if (!adePaneId) return focused.tabId || null;
	if (focused.panes.some((p) => p.id === adePaneId)) return focused.tabId;

	const tabs = ((await api.request("list-tabs", {})) ?? {}) as {
		tabs?: { id: string }[];
	};
	for (const tab of tabs.tabs ?? []) {
		const listed = asListPanes(
			await api.request("list-panes", { tab: tab.id }),
		);
		if (listed.panes.some((p) => p.id === adePaneId)) return tab.id;
	}
	return null;
}

async function ensureWindowTab(
	data: StoreData,
	window: WindowRecord,
	api: ControlApi,
): Promise<string | null> {
	if (window.adeTabId) return window.adeTabId;
	const bound = window.paneOrder
		.map((id) => data.panes[id]?.adePaneId)
		.find((id): id is string => Boolean(id));
	window.adeTabId = await findTabForPane(api, bound ?? null);
	return window.adeTabId;
}

function registerPane(
	data: StoreData,
	window: WindowRecord,
	adePaneId: string | null,
	afterPaneId?: string,
): PaneRecord {
	const id = nextId(data, "pane");
	const pane: PaneRecord = {
		id,
		windowId: window.id,
		adePaneId,
		title: null,
		options: {},
		state: "shell",
		command: null,
	};
	data.panes[id] = pane;
	const at = afterPaneId ? window.paneOrder.indexOf(afterPaneId) : -1;
	if (at >= 0) window.paneOrder.splice(at + 1, 0, id);
	else window.paneOrder.push(id);
	return pane;
}

function forgetPane(data: StoreData, pane: PaneRecord): void {
	const window = data.windows[pane.windowId];
	if (window) {
		window.paneOrder = window.paneOrder.filter((id) => id !== pane.id);
	}
	delete data.panes[pane.id];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runTmuxCompat(
	argv: string[],
	deps: TranslateDeps,
): Promise<number> {
	const parsed = parseGlobal(argv);
	const { verb } = parsed;

	if (verb === "-V") {
		deps.io.stdout(TMUX_VERSION);
		return 0;
	}
	if (verb === "") return 0;
	if (!HANDLED.has(verb)) {
		deps.store.log({ event: "unknown-verb", verb, argv });
		return 0;
	}
	if (LAYOUT_NOOPS.has(verb)) {
		// ADE's mosaic owns geometry; tmux's layout verbs have no counterpart and
		// their absence is invisible to Claude Code (it never reads layout back).
		deps.store.log({ event: "noop-verb", verb, argv });
		return 0;
	}

	const flags = parseVerb(verb, parsed.rest);

	let api: ControlApi | null = null;
	const connect = async (): Promise<ControlApi> => {
		api ??= await deps.connect();
		return api;
	};

	try {
		return await deps.store.transact((data) =>
			dispatch(verb, flags, data, { ...deps, connect }),
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		deps.io.stderr(message);
		deps.store.log({ event: "error", verb, argv, message });
		return 1;
	}
}

interface Ctx extends TranslateDeps {
	connect: () => Promise<ControlApi>;
}

async function dispatch(
	verb: string,
	flags: VerbFlags,
	data: StoreData,
	ctx: Ctx,
): Promise<number> {
	ensureLeader(data, ctx.env);
	const target = flags.values.get("t") ?? "";

	switch (verb) {
		case "has-session":
			return await hasSession(data, target, ctx);
		case "new-session":
			return await newSession(data, flags, ctx);
		case "new-window":
			return await newWindow(data, flags, target, ctx);
		case "split-window":
			return await splitWindow(data, flags, target, ctx);
		case "list-panes":
			return await listPanes(data, flags, target, ctx);
		case "list-windows":
			return listWindows(data, flags, target, ctx);
		case "list-sessions":
			return listSessions(data, flags, ctx);
		case "display-message":
			return displayMessage(data, flags, target, ctx);
		case "set-option":
		case "set-window-option":
			return setOption(data, flags, target, verb, ctx);
		case "select-pane":
			return await selectPane(data, flags, target, ctx);
		case "select-window":
			return 0;
		case "kill-pane":
			return await killPane(data, target, ctx);
		case "kill-window":
			return await killWindow(data, target, ctx);
		case "kill-session":
			return await killSession(data, target, ctx);
		case "respawn-pane":
			return await respawnPane(data, flags, target, ctx);
		case "send-keys":
			return await sendKeys(data, flags, target, ctx);
		case "capture-pane":
			return await capturePane(data, flags, target, ctx);
		case "show":
		case "show-options":
		case "show-window-options":
			return showOptions(data, flags, target, verb, ctx);
		case "show-environment":
			return showEnvironment(data, flags, ctx);
		default:
			return 0;
	}
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

/**
 * `has-session` must fail honestly (PROBE-CONTRACT §6.5). Beyond the store
 * lookup it verifies the mapped ADE tab still exists, so a session whose tab
 * the user closed is reported absent and Claude recreates it.
 */
async function hasSession(
	data: StoreData,
	target: string,
	ctx: Ctx,
): Promise<number> {
	const session = findSession(data, target);
	if (!session) {
		ctx.io.stderr(`can't find session: ${target}`);
		return 1;
	}

	const windowId = session.windowOrder[0];
	const tabId = windowId ? data.windows[windowId]?.adeTabId : null;
	if (tabId) {
		try {
			const api = await ctx.connect();
			const tabs = ((await api.request("list-tabs", {})) ?? {}) as {
				tabs?: { id: string }[];
			};
			const live = (tabs.tabs ?? []).some((tab) => tab.id === tabId);
			if (!live) {
				for (const id of session.windowOrder) {
					const window = data.windows[id];
					for (const paneId of window?.paneOrder ?? [])
						delete data.panes[paneId];
					delete data.windows[id];
				}
				delete data.sessions[session.id];
				ctx.io.stderr(`can't find session: ${target}`);
				return 1;
			}
		} catch {
			// App unreachable: trust the store rather than inventing an answer.
		}
	}
	return 0;
}

function printCreated(
	flags: VerbFlags,
	context: FormatContext,
	ctx: Ctx,
	fallback: string,
): void {
	if (!flags.bools.has("P")) return;
	ctx.io.stdout(expandFormat(flags.values.get("F") ?? fallback, context));
}

/**
 * `new-session` / `new-window` → a new ADE tab. `-d` (detached) maps to
 * `focus: false`.
 *
 * The `-- cat` placeholder command is deliberately DROPPED: the pane is
 * created running the default shell instead, because `respawn-pane` later
 * needs a live shell in that pane to exec the teammate command into. A pane
 * born running `cat` would have no channel to respawn through.
 */
async function newSession(
	data: StoreData,
	flags: VerbFlags,
	ctx: Ctx,
): Promise<number> {
	const name = flags.values.get("s") ?? "claude-swarm";
	if (findSession(data, name)) {
		ctx.io.stderr(`duplicate session: ${name}`);
		return 1;
	}

	const api = await ctx.connect();
	const result = await api.request("new-tab", {
		cwd: ctx.cwd,
		focus: !flags.bools.has("d"),
	});

	const sessionId = nextId(data, "session");
	const windowId = nextId(data, "window");
	const session: SessionRecord = {
		id: sessionId,
		name,
		windowOrder: [windowId],
	};
	const window: WindowRecord = {
		id: windowId,
		sessionId,
		name: flags.values.get("n") ?? name,
		adeTabId: createdTabId(result),
		options: {},
		paneOrder: [],
	};
	data.sessions[sessionId] = session;
	data.windows[windowId] = window;
	const pane = registerPane(data, window, createdPaneId(result));

	printCreated(flags, contextFor(data, pane), ctx, "#{session_name}:");
	return 0;
}

async function newWindow(
	data: StoreData,
	flags: VerbFlags,
	target: string,
	ctx: Ctx,
): Promise<number> {
	const session = findSession(data, target);
	if (!session) {
		ctx.io.stderr(`can't find session: ${target}`);
		return 1;
	}

	const api = await ctx.connect();
	const result = await api.request("new-tab", {
		cwd: ctx.cwd,
		focus: !flags.bools.has("d"),
	});

	const windowId = nextId(data, "window");
	const window: WindowRecord = {
		id: windowId,
		sessionId: session.id,
		name: flags.values.get("n") ?? windowId,
		adeTabId: createdTabId(result),
		options: {},
		paneOrder: [],
	};
	data.windows[windowId] = window;
	session.windowOrder.push(windowId);
	const pane = registerPane(data, window, createdPaneId(result));

	printCreated(flags, contextFor(data, pane), ctx, "#{window_id}");
	return 0;
}

/**
 * `split-window` → `new-pane` against the target pane. `-h` is tmux's
 * horizontal SPLIT (side by side) → direction right; `-v` stacks → down;
 * `-b` puts the new pane before the target → left/up. `-l <size>` is dropped:
 * ADE's mosaic sizes its own tiles.
 */
async function splitWindow(
	data: StoreData,
	flags: VerbFlags,
	target: string,
	ctx: Ctx,
): Promise<number> {
	const source = findPane(data, target, ctx.env);
	if (!source) {
		ctx.io.stderr(`can't find pane: ${target}`);
		return 1;
	}
	const window = data.windows[source.windowId];
	if (!window) {
		ctx.io.stderr(`can't find window for pane: ${source.id}`);
		return 1;
	}

	const horizontal = flags.bools.has("h");
	const before = flags.bools.has("b");
	const direction = horizontal
		? before
			? "left"
			: "right"
		: before
			? "up"
			: "down";

	const api = await ctx.connect();
	const result = await api.request("new-pane", {
		pane: adeRef(source, ctx.env),
		direction,
		type: "terminal",
		cwd: ctx.cwd,
		focus: !flags.bools.has("d"),
	});
	const adePaneId = createdPaneId(result);
	if (!adePaneId) {
		ctx.io.stderr("ADE created no pane for split-window");
		return 1;
	}

	const pane = registerPane(data, window, adePaneId, source.id);
	printCreated(flags, contextFor(data, pane), ctx, "#{pane_id}");
	return 0;
}

/**
 * `list-panes` answers from the store, but prunes panes whose ADE pane is gone
 * (closed by the user) when the tab can be resolved — Claude Code counts the
 * result to decide split targets and rebalancing, so a stale count misplaces
 * the next teammate.
 */
async function listPanes(
	data: StoreData,
	flags: VerbFlags,
	target: string,
	ctx: Ctx,
): Promise<number> {
	const window = findWindow(data, target || leaderPaneId(ctx.env));
	if (!window) {
		ctx.io.stderr(`can't find window: ${target}`);
		return 1;
	}

	try {
		const api = await ctx.connect();
		const tabId = await ensureWindowTab(data, window, api);
		if (tabId) {
			const live = new Set(
				asListPanes(await api.request("list-panes", { tab: tabId })).panes.map(
					(p) => p.id,
				),
			);
			for (const paneId of [...window.paneOrder]) {
				const pane = data.panes[paneId];
				if (pane?.adePaneId && !live.has(pane.adePaneId))
					forgetPane(data, pane);
			}
		}
	} catch (err) {
		// Best effort: an unreachable app must not turn a listing into a failure.
		ctx.store.log({
			event: "list-panes-prune-failed",
			message: err instanceof Error ? err.message : String(err),
		});
	}

	const format = flags.values.get("F") ?? "#{pane_id}";
	const lines = window.paneOrder
		.map((id) => data.panes[id])
		.filter((pane): pane is PaneRecord => Boolean(pane))
		.map((pane) => expandFormat(format, contextFor(data, pane)));
	if (lines.length > 0) ctx.io.stdout(lines.join("\n"));
	return 0;
}

function listWindows(
	data: StoreData,
	flags: VerbFlags,
	target: string,
	ctx: Ctx,
): number {
	const session = findSession(data, target || "");
	if (!session) {
		ctx.io.stderr(`can't find session: ${target}`);
		return 1;
	}
	const format = flags.values.get("F") ?? "#{window_id}";
	const lines = session.windowOrder
		.map((id) => data.windows[id])
		.filter((window): window is WindowRecord => Boolean(window))
		.map((window, index) =>
			expandFormat(format, {
				windowId: window.id,
				windowIndex: index,
				windowName: window.name,
				sessionId: session.id,
				sessionName: session.name,
			}),
		);
	if (lines.length > 0) ctx.io.stdout(lines.join("\n"));
	return 0;
}

function listSessions(data: StoreData, flags: VerbFlags, ctx: Ctx): number {
	const format = flags.values.get("F") ?? "#{session_name}";
	const lines = Object.values(data.sessions).map((session) =>
		expandFormat(format, { sessionId: session.id, sessionName: session.name }),
	);
	if (lines.length > 0) ctx.io.stdout(lines.join("\n"));
	return 0;
}

/**
 * `display-message -p <format>`. Answers from the store with no socket call —
 * this fires at Claude Code startup before any teammate exists.
 */
function displayMessage(
	data: StoreData,
	flags: VerbFlags,
	target: string,
	ctx: Ctx,
): number {
	const pane = findPane(data, target, ctx.env);
	if (!pane) {
		ctx.io.stderr(`can't find pane: ${target}`);
		return 1;
	}
	if (!flags.bools.has("p")) return 0;
	const format =
		flags.positionals[0] ?? "#{session_name}:#{window_id}.#{pane_id}";
	ctx.io.stdout(expandFormat(format, contextFor(data, pane)));
	return 0;
}

/**
 * `set-option` stores verbatim and has no visual effect. That is sufficient:
 * the only option the flow depends on is `remain-on-exit failed`, whose
 * meaning is honoured by respawnPane (a pane whose process died is recreated
 * rather than treated as gone), and the pane-border template is written but
 * never read back (PROBE-CONTRACT §3).
 */
function setOption(
	data: StoreData,
	flags: VerbFlags,
	target: string,
	verb: string,
	ctx: Ctx,
): number {
	const name = flags.positionals[0];
	if (!name) {
		ctx.io.stderr("set-option: no option name");
		return 1;
	}
	const value = flags.positionals[1] ?? "";
	const unset = flags.bools.has("u");

	const scope = flags.bools.has("p")
		? "pane"
		: flags.bools.has("w") || verb === "set-window-option"
			? "window"
			: "global";

	if (scope === "pane") {
		const pane = findPane(data, target, ctx.env);
		if (!pane) {
			ctx.io.stderr(`can't find pane: ${target}`);
			return 1;
		}
		if (unset) delete pane.options[name];
		else pane.options[name] = value;
		return 0;
	}
	if (scope === "window") {
		const window = findWindow(data, target || leaderPaneId(ctx.env));
		if (!window) {
			ctx.io.stderr(`can't find window: ${target}`);
			return 1;
		}
		if (unset) delete window.options[name];
		else window.options[name] = value;
		return 0;
	}
	if (unset) delete data.globalOptions[name];
	else data.globalOptions[name] = value;
	return 0;
}

/**
 * `select-pane -T <title>` sets the pane title ONLY. Claude Code titles every
 * teammate pane right after creating it, and focusing on each of those would
 * yank Kyle's focus around during a spawn burst. Without `-T` it focuses.
 */
async function selectPane(
	data: StoreData,
	flags: VerbFlags,
	target: string,
	ctx: Ctx,
): Promise<number> {
	const pane = findPane(data, target, ctx.env);
	if (!pane) {
		ctx.io.stderr(`can't find pane: ${target}`);
		return 1;
	}
	const title = flags.values.get("T");
	if (title !== undefined) {
		pane.title = title;
		return 0;
	}
	const api = await ctx.connect();
	await api.request("focus-pane", { pane: adeRef(pane, ctx.env) });
	return 0;
}

async function killPane(
	data: StoreData,
	target: string,
	ctx: Ctx,
): Promise<number> {
	const pane = findPane(data, target, ctx.env);
	if (!pane) {
		ctx.io.stderr(`can't find pane: ${target}`);
		return 1;
	}
	if (pane.adePaneId) {
		const api = await ctx.connect();
		await api.request("close-pane", { pane: pane.adePaneId });
	}
	forgetPane(data, pane);
	return 0;
}

async function killWindow(
	data: StoreData,
	target: string,
	ctx: Ctx,
): Promise<number> {
	const window = findWindow(data, target || leaderPaneId(ctx.env));
	if (!window) {
		ctx.io.stderr(`can't find window: ${target}`);
		return 1;
	}
	const api = await ctx.connect();
	for (const paneId of [...window.paneOrder]) {
		const pane = data.panes[paneId];
		if (pane?.adePaneId)
			await api.request("close-pane", { pane: pane.adePaneId });
		if (pane) forgetPane(data, pane);
	}
	const session = data.sessions[window.sessionId];
	if (session) {
		session.windowOrder = session.windowOrder.filter((id) => id !== window.id);
	}
	delete data.windows[window.id];
	return 0;
}

async function killSession(
	data: StoreData,
	target: string,
	ctx: Ctx,
): Promise<number> {
	const session = findSession(data, target);
	if (!session) {
		ctx.io.stderr(`can't find session: ${target}`);
		return 1;
	}
	for (const windowId of [...session.windowOrder]) {
		await killWindow(data, windowId, ctx);
	}
	delete data.sessions[session.id];
	return 0;
}

/**
 * `respawn-pane -k -t %N -- '<shell string>'` — the whole command channel.
 *
 * ADE has no "replace the process in this pane" primitive, so there are two
 * paths and the choice is NOT about `-k`:
 *
 * 1. The pane still runs its placeholder shell (`state: "shell"`) → type
 *    `exec /bin/sh -c '<cmd>'` into it. `exec` replaces the shell, so the pane
 *    holds exactly one process and tmux's kill/exit semantics carry over, and
 *    the tmux pane id stays stable across the replacement — which is what
 *    PROBE-CONTRACT §6.2 requires.
 * 2. The pane has already been exec'd (`state: "execed"`) → there is NO shell
 *    to type into. Typing would either feed keystrokes to a running teammate
 *    or vanish into a dead pane, so the pane is REBUILT: split a fresh pane
 *    off the old one (same position), close the old one, remap the tmux id to
 *    the new ADE paneId, then take path 1. This is also how `remain-on-exit
 *    failed` is honoured — a pane whose command exited is still respawnable.
 *
 * Falls back to splitting off a sibling pane, then to a new tab, if the old
 * ADE pane is gone entirely.
 */
async function respawnPane(
	data: StoreData,
	flags: VerbFlags,
	target: string,
	ctx: Ctx,
): Promise<number> {
	const pane = findPane(data, target, ctx.env);
	if (!pane) {
		ctx.io.stderr(`can't find pane: ${target}`);
		return 1;
	}
	if (!flags.hasCommand || flags.command.length === 0) {
		ctx.io.stderr("respawn-pane: no command");
		return 1;
	}
	// tmux joins multiple command words with a space; the probe always sends one.
	const command = flags.command.join(" ");
	const api = await ctx.connect();

	if (pane.state === "execed" || !pane.adePaneId) {
		const rebuilt = await rebuildPane(data, pane, api, ctx);
		if (!rebuilt) {
			ctx.io.stderr(`failed to respawn pane ${pane.id}`);
			return 1;
		}
	}

	const ref = adeRef(pane, ctx.env);
	// Both respawn paths land here, and both can arrive before the pane can
	// accept a write: the rebuild path has just created an ADE pane whose PTY
	// spawns asynchronously, and the first respawn of a placeholder-shell pane
	// races the shell's own spawn. Writing early throws, which the caller reads
	// as "the respawn failed" and the teammate never starts.
	if (!(await waitForPaneReady(api, ref, ctx))) {
		ctx.io.stderr(`pane ${pane.id} did not become ready`);
		return 1;
	}

	await api.request("send", {
		pane: ref,
		text: execLine(command),
		enter: true,
	});
	pane.state = "execed";
	pane.command = command;
	return 0;
}

/** Total budget for a pane's PTY to come up. Generous: the spawn semaphore
 * serialises 8 at a time, so a burst can queue. */
const PANE_READY_TIMEOUT_MS = 10_000;
/** First poll gap; doubles up to PANE_READY_MAX_INTERVAL_MS. */
const PANE_READY_INITIAL_INTERVAL_MS = 25;
const PANE_READY_MAX_INTERVAL_MS = 250;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Blocks until the control plane says the pane's PTY is alive.
 *
 * A pane exists in the layout well before it can be written to — `new-pane`
 * replies when the renderer's store mutation lands, and the PTY is spawned
 * afterwards by the terminal lifecycle effect. `pane-ready` is the only wire
 * command that reports the second stage; `list-panes` and the layout snapshot
 * both report the first.
 *
 * Returns false on timeout so the caller can exit 1 the way tmux would, rather
 * than writing into a pane that cannot accept it.
 *
 * An ADE older than this command answers BAD_REQUEST "Unknown command", which
 * is treated as "cannot check" and lets the send proceed — degrading to the
 * previous racy behaviour rather than breaking respawn outright against a
 * mismatched app.
 */
async function waitForPaneReady(
	api: ControlApi,
	ref: string,
	ctx: Ctx,
): Promise<boolean> {
	const deadline = Date.now() + PANE_READY_TIMEOUT_MS;
	let interval = PANE_READY_INITIAL_INTERVAL_MS;
	let lastMessage = "";

	for (;;) {
		try {
			const result = (await api.request("pane-ready", { pane: ref })) as {
				ready?: boolean;
			} | null;
			if (result?.ready) return true;
			lastMessage = "pane not ready";
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message.includes("Unknown command")) {
				ctx.store.log({ event: "pane-ready-unsupported", pane: ref });
				return true;
			}
			// NOT_FOUND while the renderer is still materialising the pane is
			// expected; keep polling and let the deadline decide.
			lastMessage = message;
		}

		if (Date.now() >= deadline) {
			ctx.store.log({
				event: "pane-ready-timeout",
				pane: ref,
				waitedMs: PANE_READY_TIMEOUT_MS,
				message: lastMessage,
			});
			return false;
		}
		await delay(Math.min(interval, Math.max(0, deadline - Date.now())));
		interval = Math.min(interval * 2, PANE_READY_MAX_INTERVAL_MS);
	}
}

/** Recreates a pane's ADE pane in place and remaps the tmux id onto it. */
async function rebuildPane(
	data: StoreData,
	pane: PaneRecord,
	api: ControlApi,
	ctx: Ctx,
): Promise<boolean> {
	const window = data.windows[pane.windowId];
	const previous = pane.adePaneId;

	const sources: string[] = [];
	if (previous) sources.push(previous);
	for (const id of window?.paneOrder ?? []) {
		const sibling = data.panes[id];
		if (sibling && sibling.id !== pane.id && sibling.adePaneId) {
			sources.push(sibling.adePaneId);
		}
	}

	let created: string | null = null;
	for (const source of sources) {
		try {
			created = createdPaneId(
				await api.request("new-pane", {
					pane: source,
					direction: "right",
					type: "terminal",
					cwd: ctx.cwd,
					focus: false,
				}),
			);
			if (created) break;
		} catch (err) {
			ctx.store.log({
				event: "respawn-split-failed",
				source,
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}

	if (!created) {
		// Nothing in the window survives: give the pane a tab of its own rather
		// than losing the teammate.
		const result = await api.request("new-tab", { cwd: ctx.cwd, focus: false });
		created = createdPaneId(result);
		if (created && window) window.adeTabId = createdTabId(result);
	}
	if (!created) return false;

	if (previous) {
		try {
			await api.request("close-pane", { pane: previous });
		} catch (err) {
			ctx.store.log({
				event: "respawn-close-failed",
				pane: previous,
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}

	pane.adePaneId = created;
	pane.state = "shell";
	return true;
}

/**
 * `send-keys` — unused by agent teams (PROBE-CONTRACT §4) but in the spec's
 * verb set. A known key name goes through `send-key`; anything else is typed
 * literally. `-l` forces literal.
 */
async function sendKeys(
	data: StoreData,
	flags: VerbFlags,
	target: string,
	ctx: Ctx,
): Promise<number> {
	const pane = findPane(data, target, ctx.env);
	if (!pane) {
		ctx.io.stderr(`can't find pane: ${target}`);
		return 1;
	}
	const api = await ctx.connect();
	const literal = flags.bools.has("l");
	// The key table is keyed lowercase and encodeKey looks up case-insensitively;
	// tmux writes `Enter`, so compare the same way or every named key is typed
	// as literal text instead.
	const known = new Set(knownKeyNames().map((name) => name.toLowerCase()));
	const ref = adeRef(pane, ctx.env);

	for (const token of flags.positionals) {
		const isKey =
			!literal &&
			(known.has(token.toLowerCase()) || /^([CMS]-)+.$/.test(token));
		if (isKey) {
			try {
				await api.request("send-key", {
					pane: ref,
					key: token,
					data: encodeKey(token),
				});
				continue;
			} catch (err) {
				if (!(err instanceof UnknownKeyError)) throw err;
			}
		}
		await api.request("send", { pane: ref, text: token });
	}
	return 0;
}

async function capturePane(
	data: StoreData,
	flags: VerbFlags,
	target: string,
	ctx: Ctx,
): Promise<number> {
	const pane = findPane(data, target, ctx.env);
	if (!pane) {
		ctx.io.stderr(`can't find pane: ${target}`);
		return 1;
	}
	const api = await ctx.connect();
	const result = (await api.request("capture-pane", {
		pane: adeRef(pane, ctx.env),
		...(flags.bools.has("e") ? { raw: true } : {}),
	})) as { text?: string } | string | null;

	// `-p` prints to stdout; without it tmux fills a paste buffer, which has no
	// ADE counterpart, so the capture is dropped (and logged).
	if (!flags.bools.has("p")) {
		ctx.store.log({ event: "capture-pane-without-p", pane: pane.id });
		return 0;
	}
	const text = typeof result === "string" ? result : (result?.text ?? "");
	if (text) ctx.io.stdout(text.replace(/\n$/, ""));
	return 0;
}

function showOptions(
	data: StoreData,
	flags: VerbFlags,
	target: string,
	verb: string,
	ctx: Ctx,
): number {
	const scope = flags.bools.has("p")
		? "pane"
		: flags.bools.has("w") || verb === "show-window-options"
			? "window"
			: "global";

	let table: Record<string, string> = data.globalOptions;
	if (scope === "pane") {
		table = findPane(data, target, ctx.env)?.options ?? {};
	} else if (scope === "window") {
		table = findWindow(data, target || leaderPaneId(ctx.env))?.options ?? {};
	}

	const name = flags.positionals[0];
	const valueOnly = flags.bools.has("v");

	if (!name) {
		const lines = Object.entries(table).map(([key, value]) =>
			valueOnly ? value : `${key} ${value}`,
		);
		if (lines.length > 0) ctx.io.stdout(lines.join("\n"));
		return 0;
	}

	// An option nothing set answers with a plausible default (or empty) and
	// exits 0 — the startup detection calls (`show -Av mouse`, `show -gv
	// focus-events`) must not look like a broken tmux.
	const value =
		table[name] ?? data.globalOptions[name] ?? OPTION_DEFAULTS[name] ?? "";
	ctx.io.stdout(valueOnly ? value : `${name} ${value}`);
	return 0;
}

/**
 * `show-environment -g <NAME>`. An unset variable exits 1, which is what real
 * tmux does and what Claude Code's startup detection expects for
 * `CLAUDE_CODE_CHILD_SESSION`.
 */
function showEnvironment(data: StoreData, flags: VerbFlags, ctx: Ctx): number {
	const name = flags.positionals[0];
	if (!name) {
		const lines = Object.entries(data.environment).map(
			([key, value]) => `${key}=${value}`,
		);
		if (lines.length > 0) ctx.io.stdout(lines.join("\n"));
		return 0;
	}
	const value = data.environment[name];
	if (value === undefined) {
		ctx.io.stderr(`unknown variable: ${name}`);
		return 1;
	}
	ctx.io.stdout(flags.bools.has("v") ? value : `${name}=${value}`);
	return 0;
}
