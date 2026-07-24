export const SESSION_CLEANUP_DELAY_MS = 5000;
export const DEBUG_TERMINAL = process.env.SUPERSET_TERMINAL_DEBUG === "1";
export const CREATE_OR_ATTACH_CONCURRENCY = 3;
export const MAX_SCROLLBACK_BYTES = 500_000;
export const MAX_HISTORY_SCROLLBACK_BYTES = 512 * 1024;
export const MAX_KILLED_SESSION_TOMBSTONES = 1000;

// Daemon auto-reconnect backoff: 500ms → 1s → 2s → 4s → 8s (5 attempts, ~15.5s
// total) before surfacing a failed state to the user.
export const RECONNECT_BASE_DELAY_MS = 500;
export const RECONNECT_MAX_DELAY_MS = 8000;
export const RECONNECT_MAX_ATTEMPTS = 5;
