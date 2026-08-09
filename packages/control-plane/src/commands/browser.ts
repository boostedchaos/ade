import {
	optionalBoolean,
	optionalString,
	requireEnum,
	requireString,
} from "../args";
import type { BrowserPaneHost } from "../host";
import { ControlError } from "../protocol";
import type { AuthenticatedSession, CommandRegistry } from "../server";
import { requirePane } from "../snapshot";
import { resolveTarget } from "../target-resolution";

/**
 * Browser-pane scripting group (Mission Control Feature 1, Browser group).
 *
 * SECURITY, and the reason there is no "all panes" form anywhere in this file:
 * every verb below executes JavaScript inside a real web page under the user's
 * session cookies. The SPEC constraint is that a command acts ONLY on the pane
 * the caller names, so each one resolves exactly one pane and each one proves
 * that pane is a browser pane before touching it.
 *
 * The page scripts are built here, as pure functions over a selector and a
 * value, and handed to `host.browser.evaluate`. That split is deliberate: the
 * fiddly half (escaping, element-not-found reporting, which DOM events a
 * framework-controlled input needs) is then unit-testable without Electron, and
 * the host adapter has nothing in it to get wrong.
 *
 * NOT SUPPORTED — reported by `browser-capabilities` rather than left for a
 * caller to discover by failure: CDP attachment, cookie/profile import, and
 * multi-pane fan-out. The first two are SPEC "Out of scope"; the third is the
 * security constraint above.
 */

const DIRECTIONS = ["left", "right", "up", "down"] as const;

export const BROWSER_UNSUPPORTED = [
	"cdp: no Chrome DevTools Protocol attachment",
	"cookies: no cookie or profile import/export",
	"multi-pane: commands act on exactly one named pane, never on all",
] as const;

function requireBrowserHost(session: AuthenticatedSession): BrowserPaneHost {
	const browser = session.host.browser;
	if (!browser) {
		throw new ControlError(
			"UNSUPPORTED",
			"This ADE build has no browser panes",
		);
	}
	return browser;
}

/**
 * Resolve `--pane` to a pane that is a browser pane AND has a live webContents.
 *
 * Both halves matter and fail differently. A terminal pane is a BAD_REQUEST —
 * the caller aimed at the wrong thing. A browser pane whose webview has not
 * attached yet (or has been destroyed) is a NOT_FOUND: the target is right and
 * momentarily unusable, which is the distinction a retrying caller needs.
 */
function requireBrowserPane(
	session: AuthenticatedSession,
	args: Record<string, unknown>,
): { paneId: string; browser: BrowserPaneHost } {
	const browser = requireBrowserHost(session);
	const snapshot = session.host.getSnapshot();
	const paneId = resolveTarget(snapshot, "pane", requireString(args, "pane"));
	const pane = requirePane(snapshot, paneId);

	// The CLI says "browser"; the pane record says `webview`. That rename is the
	// app's own (shared/tabs-types.ts PaneType), and translating it here rather
	// than exposing it is why `ade browser-click --pane pane:2` does not require
	// the caller to know ADE's internal vocabulary.
	if (pane.type !== "webview") {
		throw new ControlError(
			"BAD_REQUEST",
			`Pane ${paneId} is a ${pane.type} pane, not a browser pane`,
		);
	}
	if (!browser.isAttached(paneId)) {
		throw new ControlError(
			"NOT_FOUND",
			`Browser pane ${paneId} has no live web contents (still loading, or closed)`,
		);
	}
	return { paneId, browser };
}

/**
 * PURE. Embed an arbitrary string in generated JavaScript as a literal.
 *
 * JSON.stringify handles quotes, backslashes and control characters correctly;
 * the two extra replacements close the holes it leaves in a *script* context —
 * `</script>` would end an inline script block, and U+2028/2029 are literal
 * line terminators in JS source but legal inside a JSON string.
 */
export function jsLiteral(value: string): string {
	return JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

/**
 * PURE. Wrap a body that receives `el` — the element matched by `selector` —
 * in the lookup and the not-found error every verb shares.
 *
 * The thrown message names the selector, because "element not found" with no
 * selector in it is the single least useful error an automation tool can
 * produce. `document.querySelector` is used rather than a wait-for-element
 * loop: a command that silently blocks for ten seconds and then fails is worse
 * than one that fails immediately and lets the caller decide to retry.
 */
export function elementScript(selector: string, body: string): string {
	return `(() => {
  const el = document.querySelector(${jsLiteral(selector)});
  if (!el) throw new Error("No element matches selector " + ${jsLiteral(selector)});
  ${body}
})()`;
}

/** PURE. Click script for `browser-click`. */
export function clickScript(selector: string): string {
	return elementScript(
		selector,
		`el.scrollIntoView({ block: "center", inline: "center" });
  el.click();
  return { clicked: true, tag: el.tagName.toLowerCase() };`,
	);
}

/**
 * PURE. Set an input's value for `browser-type` / `browser-fill`.
 *
 * The native value setter plus the two dispatched events is what makes this
 * work on a React/Vue-controlled input. Assigning `el.value` alone updates the
 * DOM but not the framework's state, so the page looks filled and submits
 * empty — the classic silent failure of naive form automation.
 */
export function typeScript(selector: string, text: string): string {
	return elementScript(
		selector,
		`el.focus();
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, ${jsLiteral(text)});
  else el.value = ${jsLiteral(text)};
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { filled: true, tag: el.tagName.toLowerCase() };`,
	);
}

/**
 * PURE. Validate and normalise the `--fields` payload of `browser-fill`.
 *
 * Accepts `{selector: text}`. Rejects a non-string value rather than coercing:
 * `{"#qty": 3}` coercing to "3" would work today and silently do the wrong
 * thing the first time someone passes `null` meaning "clear this".
 */
export function parseFillFields(value: unknown): Array<[string, string]> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ControlError(
			"BAD_REQUEST",
			'"fields" must be an object of {selector: text}',
		);
	}
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length === 0) {
		throw new ControlError("BAD_REQUEST", '"fields" must not be empty');
	}
	return entries.map(([selector, text]) => {
		if (typeof text !== "string") {
			throw new ControlError(
				"BAD_REQUEST",
				`"fields.${selector}" must be a string`,
			);
		}
		return [selector, text];
	});
}

export const browserCommands: CommandRegistry = {
	/**
	 * Open a NEW browser pane as a split of an existing one.
	 *
	 * Routed through the ordinary `new-pane` bridge op rather than a second
	 * creation path, so the flagship pattern in the bundled skill —
	 * `--direction right --focus false` — behaves identically whichever verb the
	 * caller reaches for.
	 */
	"browser-open": async (session, args) => {
		const snapshot = session.host.getSnapshot();
		const url = requireString(args, "url");
		const sourcePaneId = resolveTarget(
			snapshot,
			"pane",
			optionalString(args, "pane") ?? "focused",
		);
		const sourcePane = requirePane(snapshot, sourcePaneId);
		const tab = snapshot.tabs.find((t) => t.id === sourcePane.tabId);
		if (!tab) {
			throw new ControlError(
				"NOT_FOUND",
				`Pane ${sourcePaneId} has no tab in the current state`,
			);
		}

		return session.host.dispatchToRenderer({
			kind: "new-pane",
			paneType: "browser",
			sourcePaneId,
			tabId: tab.id,
			workspaceId: tab.workspaceId,
			direction: requireEnum(args, "direction", DIRECTIONS, "right"),
			url,
			focus: optionalBoolean(args, "focus", true),
		});
	},

	"browser-navigate": async (session, args) => {
		const { paneId, browser } = requireBrowserPane(session, args);
		const url = requireString(args, "url");
		await browser.navigate(paneId, url);
		return { paneId, url };
	},

	"browser-click": async (session, args) => {
		const { paneId, browser } = requireBrowserPane(session, args);
		const selector = requireString(args, "selector");
		const result = await browser.evaluate(paneId, clickScript(selector));
		return { paneId, selector, result };
	},

	"browser-type": async (session, args) => {
		const { paneId, browser } = requireBrowserPane(session, args);
		const selector = requireString(args, "selector");
		// An empty string is a legitimate "clear this field", so `text` is read
		// directly rather than through requireString (which rejects "").
		const text = args.text;
		if (typeof text !== "string") {
			throw new ControlError("BAD_REQUEST", '"text" must be a string');
		}
		const result = await browser.evaluate(paneId, typeScript(selector, text));
		return { paneId, selector, result };
	},

	/**
	 * Fill several fields in one round trip.
	 *
	 * Fields are applied in order and the command STOPS at the first failure,
	 * reporting how many were filled. Continuing past a missing selector would
	 * leave a half-filled form and report success, which is the worst of the
	 * three possible behaviours.
	 */
	"browser-fill": async (session, args) => {
		const { paneId, browser } = requireBrowserPane(session, args);
		const fields = parseFillFields(args.fields);

		const filled: string[] = [];
		for (const [selector, text] of fields) {
			try {
				await browser.evaluate(paneId, typeScript(selector, text));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new ControlError(
					"NOT_FOUND",
					`Filled ${filled.length} of ${fields.length} fields; "${selector}" failed: ${message}`,
				);
			}
			filled.push(selector);
		}
		return { paneId, filled, count: filled.length };
	},

	/** Returns the FILE PATH written, not the image bytes — a PNG does not belong on an NDJSON line. */
	"browser-screenshot": async (session, args) => {
		const { paneId, browser } = requireBrowserPane(session, args);
		const { path } = await browser.screenshot(
			paneId,
			optionalString(args, "path"),
		);
		return { paneId, path };
	},

	/**
	 * What this build's browser automation can and cannot do.
	 *
	 * Exists so "does it support CDP?" is answerable by asking rather than by
	 * reading the source or hitting an error. The CLI's `--help` prints the same
	 * list; this is the machine-readable copy for an agent.
	 */
	"browser-capabilities": (session) => {
		const browser = session.host.browser;
		return {
			available: browser !== undefined,
			supported: ["open", "navigate", "click", "type", "fill", "screenshot"],
			unsupported: [...BROWSER_UNSUPPORTED],
		};
	},

	/** Current URL/title of a browser pane. Cheap, and the natural check after a navigate. */
	"browser-info": (session, args) => {
		const { paneId, browser } = requireBrowserPane(session, args);
		const info = browser.pageInfo(paneId);
		if (!info) {
			throw new ControlError(
				"NOT_FOUND",
				`Browser pane ${paneId} has no live web contents`,
			);
		}
		return { paneId, ...info };
	},
};
