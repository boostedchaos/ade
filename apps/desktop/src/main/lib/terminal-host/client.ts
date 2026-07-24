// Moved to packages/server-core (Phase 1 extraction). This shim also wires
// the Electron-specific daemon script location — every desktop consumer
// imports the client through this path, so registration precedes first use.
import { join } from "node:path";
import { setDaemonScriptPathResolver } from "@ade/server-core/terminal-host/client";
import { app } from "electron";

setDaemonScriptPathResolver(() =>
	join(app.getAppPath(), "dist", "main", "terminal-host.js"),
);

export * from "@ade/server-core/terminal-host/client";
