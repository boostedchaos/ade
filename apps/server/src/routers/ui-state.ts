import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDefaultHotkeysState } from "@ade/server-core/hotkeys";
import { observable } from "@trpc/server/observable";
import { z } from "zod/v4";
import { ensureADEHomeDir } from "../environment";
import { authedProcedure, router } from "../trpc";

/**
 * Server-side UI state (tabs / theme / hotkeys) — the desktop keeps this in
 * its lowdb appState; headless it lives in ~/.ade/ui-state.json. State
 * follows the user across browsers (a deliberate D-decision in PHASE_1 §3's
 * router table). Payloads are opaque here — the renderer owns the shapes.
 */

const FILE = "ui-state.json";
type Store = Record<string, unknown>;

function load(): Store {
	const path = join(ensureADEHomeDir(), FILE);
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Store;
	} catch {
		return {};
	}
}

function save(store: Store): void {
	writeFileSync(
		join(ensureADEHomeDir(), FILE),
		JSON.stringify(store, null, 2),
	);
}

const emitter = new EventEmitter();

// Sections the renderer expects to be non-null get seeded defaults
// (mirroring the desktop's appState defaults).
const DEFAULTS: Record<string, () => unknown> = {
	hotkeys: () => createDefaultHotkeysState(),
	tabs: () => ({
		activeTabIds: {},
		focusedPaneIds: {},
		tabs: {},
		panes: {},
		layouts: {},
	}),
};

function section(key: string) {
	return router({
		get: authedProcedure.query(
			() => load()[key] ?? DEFAULTS[key]?.() ?? null,
		),
		set: authedProcedure.input(z.unknown()).mutation(({ input }) => {
			const store = load();
			store[key] = input;
			save(store);
			emitter.emit("change", { key, value: input });
		}),
	});
}

export const uiStateRouter = router({
	tabs: section("tabs"),
	theme: section("theme"),
	hotkeys: section("hotkeys"),
	subscribe: authedProcedure.subscription(() =>
		observable<{ key: string; value: unknown }>((emit) => {
			const fn = (evt: { key: string; value: unknown }) => emit.next(evt);
			emitter.on("change", fn);
			return () => emitter.off("change", fn);
		}),
	),
});
