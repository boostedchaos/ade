/**
 * Windows Electron Builder Configuration
 *
 * Cross-built from macOS (or on a windows-latest CI runner). Produces an
 * unsigned x64 NSIS installer + portable zip. All win32 native binaries are
 * staged by `scripts/prepare-win-natives.ts` into `.win32-natives/` and mapped
 * into the package by `createConfig("win")`; nothing is compiled here
 * (`npmRebuild: false`).
 *
 * @see ./electron-builder.ts for the shared configuration factory.
 */

import { createConfig } from "./electron-builder";

export default createConfig("win");
