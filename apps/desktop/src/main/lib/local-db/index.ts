// Moved to packages/server-core (Phase 1 extraction). Import order matters:
// the hook registration must evaluate before the package module, which opens
// the DB and runs migrations at module scope.
import "./register-host-hooks";

export * from "@ade/server-core/local-db";
