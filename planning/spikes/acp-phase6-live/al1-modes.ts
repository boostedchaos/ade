import {
  AcpHost,
  setAcpBinaryPathResolver,
  setAcpExecPathResolver,
} from "/Users/kylewelch/Documents/PROJECTS/ADE Windows 11/source/packages/server-core/src/acp-host/index";
setAcpBinaryPathResolver(() => "/Users/kylewelch/Documents/PROJECTS/ADE Windows 11/source/node_modules/.bun/@agentclientprotocol+claude-agent-acp@0.63.0+d9f3fa5251fc2eb0/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js");
setAcpExecPathResolver(() => "/Users/kylewelch/.local/bin/node");
const host = new AcpHost();
const paneId = "al1-modes";
const info = await host.createSession({ paneId, cwd: process.env.LV_CWD!, env: { CLAUDE_CODE_EXECUTABLE: "/Users/kylewelch/.local/bin/claude" }, permissionPolicy: "prompt" });
console.log("availableModes in wire order:");
for (const m of info.modes?.availableModes ?? []) console.log(`  ${m.id}`);
console.log(`currentModeId after the policy applied: ${info.modes?.currentModeId}`);
await host.disposeSession(paneId);
process.exit(0);
