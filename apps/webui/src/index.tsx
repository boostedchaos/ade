// Order matters: the preload shim must exist before any renderer module
// evaluates (stores read window.App at import time).
import "./shell-web";
import "./register-sw";
import "./viewport-fix";
import { ensureAuthenticated } from "./login-gate";

// Gate on a validated token, THEN dynamically import the renderer (so the
// heavy bundle and its authed boot calls don't run until we're connected).
ensureAuthenticated().then(() => {
	import("../../desktop/src/renderer/index");
});
