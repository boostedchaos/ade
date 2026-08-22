import {
  AcpHost,
  setAcpBinaryPathResolver,
  setAcpExecPathResolver,
} from "/Users/kylewelch/Documents/PROJECTS/ADE Windows 11/source/packages/server-core/src/acp-host/index";
setAcpBinaryPathResolver(() => "/Users/kylewelch/Documents/PROJECTS/ADE Windows 11/source/node_modules/.bun/@agentclientprotocol+claude-agent-acp@0.63.0+d9f3fa5251fc2eb0/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js");
setAcpExecPathResolver(() => "/Users/kylewelch/.local/bin/node");
const host = new AcpHost();
const paneId = "a8-live";
const frames: any[] = [];
host.on(`update:${paneId}`, (u: any) => frames.push(u));
const info = await host.createSession({
  paneId,
  cwd: process.env.LV_CWD!,
  env: { CLAUDE_CODE_EXECUTABLE: "/Users/kylewelch/.local/bin/claude" },
  resumeSessionId: process.env.LV_SESSION_ID!,
});
console.log(`requested id: ${process.env.LV_SESSION_ID}`);
console.log(`restored: ${info.restored}`);
console.log(`acpSessionId: ${info.acpSessionId}`);
console.log(`history frames: ${frames.length}`);
for (const f of frames) {
  const text = (f.text ?? f.content?.text ?? "").slice(0, 80);
  console.log(`  kind=${f.kind} text=${JSON.stringify(text)}`);
}
await host.disposeSession(paneId);
console.log("disposed");
process.exit(0);
