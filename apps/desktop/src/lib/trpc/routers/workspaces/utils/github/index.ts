// Lifted to packages/server-core (issue #51, unit U2). This shim keeps the
// desktop import path (`../utils/github`) working; the implementation now lives
// in the Electron-free, DB-free server-core module so it can be shared with
// ade-server.
export { fetchGitHubPRStatus } from "@ade/server-core/github-team";
