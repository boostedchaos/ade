/**
 * Windows Canary Electron Builder Configuration
 *
 * Canary overrides (appId/productName/artifacts) layered on the "win" target,
 * which stages native binaries from `.win32-natives/`. Used by
 * `package:win:canary` (build-desktop.yml canary builds).
 *
 * @see ./electron-builder.canary.ts for the canary configuration factory.
 */

import { createCanaryConfig } from "./electron-builder.canary";

export default createCanaryConfig("win");
