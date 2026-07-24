/**
 * Multi-device attach policy (issue #7): identifies this renderer instance
 * to the terminal router for the writer-lease policy. One id per page load —
 * a refresh mints a new id, and the old id's lease is freed when its WS
 * subscriptions drop, so the reloaded page regains write on re-attach.
 *
 * Sent with terminal createOrAttach/write/resize/detach/stream calls. The
 * desktop Electron router accepts and ignores it (single client); only
 * ade-server enforces the lease.
 */
function mintClientId(): string {
	const c = globalThis.crypto;
	if (c?.randomUUID) return c.randomUUID();
	// Very old WebViews only; uniqueness per page load is all we need.
	return `tc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const terminalClientId: string = mintClientId();
