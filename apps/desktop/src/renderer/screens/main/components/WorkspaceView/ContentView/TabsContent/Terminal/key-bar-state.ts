/**
 * Sticky-Ctrl state for the mobile terminal key bar (PHASE_3 §3).
 *
 * The Blink/a-Shell pattern: tap Ctrl on the key bar to arm it, then the next
 * character typed on the software keyboard is translated to its control code
 * (tap Ctrl, tap C ⇒ ^C). Module-level singleton so the key bar component and
 * the xterm input path (useTerminalLifecycle) share one source of truth
 * without threading props through the terminal hook pyramid.
 */

let ctrlArmed = false;
const listeners = new Set<() => void>();

function notify(): void {
	for (const listener of listeners) listener();
}

export function isCtrlArmed(): boolean {
	return ctrlArmed;
}

export function setCtrlArmed(armed: boolean): void {
	if (ctrlArmed === armed) return;
	ctrlArmed = armed;
	notify();
}

export function toggleCtrlArmed(): void {
	setCtrlArmed(!ctrlArmed);
}

/** For useSyncExternalStore in the key bar UI. */
export function subscribeCtrlArmed(onChange: () => void): () => void {
	listeners.add(onChange);
	return () => listeners.delete(onChange);
}

/**
 * Translate a printable character to its control code (^A..^Z and the
 * punctuation controls). Returns null when the char has no control mapping.
 */
export function toControlCode(char: string): string | null {
	if (char.length !== 1) return null;
	if (char === "?") return "\x7f"; // ^? = DEL
	if (char === " ") return "\x00"; // ^Space = NUL
	const code = char.toUpperCase().charCodeAt(0);
	// @ A-Z [ \ ] ^ _  →  0x00-0x1f
	if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
	return null;
}

/**
 * Apply (and consume) an armed sticky Ctrl to terminal input. Called on the
 * xterm onData path: when Ctrl is armed and a single printable character
 * arrives from the keyboard, emit its control code instead and disarm.
 */
export function consumeStickyCtrl(data: string): string {
	if (!ctrlArmed || data.length !== 1) return data;
	const control = toControlCode(data);
	if (control === null) return data;
	setCtrlArmed(false);
	return control;
}
