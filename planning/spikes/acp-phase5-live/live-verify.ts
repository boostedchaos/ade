import {
  AcpHost,
  setAcpBinaryPathResolver,
  setAcpExecPathResolver,
} from "/Users/kylewelch/Documents/PROJECTS/ADE Windows 11/source/packages/server-core/src/acp-host/index";
setAcpBinaryPathResolver(() => "/Users/kylewelch/Documents/PROJECTS/ADE Windows 11/source/node_modules/.bun/@agentclientprotocol+claude-agent-acp@0.63.0+d9f3fa5251fc2eb0/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js");
setAcpExecPathResolver(() => "/Users/kylewelch/.local/bin/node");
const host = new AcpHost();
const paneId = "p5-live";
let text = "";
const info = await host.createSession({ paneId, cwd: process.env.LV_CWD!, env: { CLAUDE_CODE_EXECUTABLE: "/Users/kylewelch/.local/bin/claude" } });
host.on(`update:${paneId}`, (u: any) => { if (u.kind === "agent_message_chunk") text += u.text; });
console.log(`at session/new: cached commands = ${info.availableCommands.length}`);
// The list arrives via notification shortly after start — poll info() through the cache (D1).
let cached: string[] = [];
for (let i = 0; i < 40 && cached.length === 0; i++) {
  await new Promise((r) => setTimeout(r, 250));
  cached = (host.getSessionInfo(paneId)?.availableCommands ?? []).map((c: any) => c.name);
}
console.log(`cached after wait: ${cached.length} | wrap-up: ${cached.includes("wrap-up")} | fable-orchestration: ${cached.includes("fable-orchestration")}`);
const result = await host.prompt(paneId, "/context");
console.log(`/context: stopReason=${result.stopReason} replyBytes=${text.length}`);
console.log(`reply mentions context/tokens: ${/context|token/i.test(text)}`);
await host.disposeSession(paneId);
console.log("disposed");
process.exit(0);
