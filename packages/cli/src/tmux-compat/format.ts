/**
 * tmux format-string expansion.
 *
 * The probe found Claude Code reads exactly four formats (PROBE-CONTRACT.md
 * §3): `#{pane_id}`, `#{window_id}`, `#{window_name}` and the compound
 * `#{session_name}:#{window_id}.#{pane_id}`. Expansion is therefore
 * token-substitution, not a tmux format interpreter: a token this shim does
 * not know expands to the empty string rather than failing, so an
 * unanticipated format degrades to a blank line instead of an error.
 *
 * `#[…]` style directives are deliberately NOT touched — the pane-border
 * template is stored verbatim and expanded by nothing (it is written, never
 * read back).
 */

export interface FormatContext {
	paneId?: string | null;
	paneIndex?: number | null;
	paneTitle?: string | null;
	windowId?: string | null;
	windowIndex?: number | null;
	windowName?: string | null;
	sessionId?: string | null;
	sessionName?: string | null;
}

function tokenValue(name: string, ctx: FormatContext): string | undefined {
	switch (name) {
		case "pane_id":
			return ctx.paneId ?? undefined;
		case "pane_index":
			return ctx.paneIndex === null || ctx.paneIndex === undefined
				? undefined
				: String(ctx.paneIndex);
		case "pane_title":
			return ctx.paneTitle ?? undefined;
		case "window_id":
			return ctx.windowId ?? undefined;
		case "window_index":
			return ctx.windowIndex === null || ctx.windowIndex === undefined
				? undefined
				: String(ctx.windowIndex);
		case "window_name":
			return ctx.windowName ?? undefined;
		case "session_id":
			return ctx.sessionId ?? undefined;
		case "session_name":
			return ctx.sessionName ?? undefined;
		default:
			return undefined;
	}
}

export function expandFormat(format: string, ctx: FormatContext): string {
	return format.replace(
		/#\{([a-z_]+)\}/g,
		(_match, name: string) => tokenValue(name, ctx) ?? "",
	);
}
