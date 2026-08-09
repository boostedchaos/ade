/**
 * Todos (Mission Control Feature 1, Todos group) — main-process entry point.
 *
 * There is no wiring to do beyond re-exporting the store: todos emit nothing on
 * the control-plane event bus in v1 (a deliberate spec decision — no consumer
 * exists yet, and an event nobody reads is a contract that goes stale) and have
 * no renderer surface. When a todo panel lands, the change listener belongs
 * here, next to the store, the way `attention/index.ts` holds its own.
 */
export * from "./store";
