// Type shim for the `node-pty` import specifier.
//
// package.json aliases `node-pty` to `@lydell/node-pty`, whose bundled
// `node-pty.d.ts` declares everything inside `declare module '@lydell/node-pty'`
// with no top-level exports. Importing that file directly as `node-pty`
// therefore fails with TS2306 ("not a module"). The triple-slash reference pulls
// the ambient `@lydell/node-pty` declaration into scope; the module block below
// re-exports it under the `node-pty` specifier the app source imports.
//
// Source files keep importing `node-pty` unchanged (per the port plan).

/// <reference path="../node_modules/node-pty/node-pty.d.ts" />

declare module "node-pty" {
	export * from "@lydell/node-pty";
}
