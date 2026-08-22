import {
  AcpHost,
  setAcpBinaryPathResolver,
  setAcpExecPathResolver,
} from "/Users/kylewelch/Documents/PROJECTS/ADE Windows 11/source/packages/server-core/src/acp-host/index";
setAcpBinaryPathResolver(() => "/Users/kylewelch/Documents/PROJECTS/ADE Windows 11/source/node_modules/.bun/@agentclientprotocol+claude-agent-acp@0.63.0+d9f3fa5251fc2eb0/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js");
setAcpExecPathResolver(() => "/Users/kylewelch/.local/bin/node");
const host = new AcpHost();
const paneId = "al1-verify";
host.on(`permission:${paneId}`, (req: any) => {
  console.log(`permission_request RAISED: ${req.title}`);
  console.log(`  options: ${req.options.map((o: any) => o.optionId).join(", ")}`);
  const allow = req.options.find((o: any) => o.kind.startsWith("allow"));
  host.answerPermission(paneId, req.requestId, allow.optionId);
  console.log(`  answered with: ${allow.optionId}`);
});
const info = await host.createSession({ paneId, cwd: process.env.LV_CWD!, env: { CLAUDE_CODE_EXECUTABLE: "/Users/kylewelch/.local/bin/claude" }, permissionPolicy: "prompt" });
console.log(`mode selected by the prompt policy: ${info.modes?.currentModeId}`);
const result = await host.prompt(paneId, "Create a file named al1-proof.txt containing the word PROOF. Use the Write tool.");
console.log(`turn stopReason: ${result.stopReason}`);
console.log(`file written: ${await Bun.file(`${process.env.LV_CWD}/al1-proof.txt`).exists()}`);
await host.disposeSession(paneId);
process.exit(0);
