import {
  AcpHost,
  setAcpBinaryPathResolver,
  setAcpExecPathResolver,
} from "/Users/kylewelch/Documents/PROJECTS/ADE Windows 11/source/packages/server-core/src/acp-host/index";

setAcpBinaryPathResolver(
  () =>
    "/Users/kylewelch/Documents/PROJECTS/ADE Windows 11/source/node_modules/.bun/@agentclientprotocol+claude-agent-acp@0.63.0+d9f3fa5251fc2eb0/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
);
setAcpExecPathResolver(() => "/Users/kylewelch/.local/bin/node");

const host = new AcpHost();
const paneId = "p3-capture";
const frames: any[] = [];
const info = await host.createSession({
  paneId,
  cwd: process.env.CAP_CWD!,
  env: { CLAUDE_CODE_EXECUTABLE: "/Users/kylewelch/.local/bin/claude" },
});
host.on(`update:${paneId}`, (u: any) => frames.push(u));
console.log(`session ${info.acpSessionId}`);
const result = await host.prompt(
  paneId,
  "Read alpha.txt and beta.txt, then edit beta.txt changing 'beta line 2' to 'beta line 2 EDITED'. Then reply DONE.",
);
console.log(`stopReason=${result.stopReason} frames=${frames.length}`);
await Bun.write(
  "frames.json",
  JSON.stringify(frames, null, 1),
);
// Summary: kind sequence + tool card lifecycles
const counts: Record<string, number> = {};
for (const f of frames) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
console.log("kind counts:", JSON.stringify(counts));
const cards: Record<string, string[]> = {};
for (const f of frames) {
  if (f.kind === "tool_call" || f.kind === "tool_call_update") {
    const tc = f.toolCall;
    const id = tc.toolCallId;
    (cards[id] ??= []).push(
      `${f.kind === "tool_call" ? "CALL" : "upd"}:{title=${JSON.stringify(tc.title)},kind=${tc.kind},status=${tc.status},content=${tc.content ? tc.content.map((c: any) => c.type).join("+") : "-"},locs=${tc.locations?.length ?? "-"},name=${tc._meta?.claudeCode?.toolName}}`,
    );
  }
}
for (const [id, seq] of Object.entries(cards)) {
  console.log(`\n${id}:\n  ${seq.join("\n  ")}`);
}
for (const f of frames) {
  if (f.kind === "usage_update") console.log(`usage: used=${f.used} size=${f.size} cost=${JSON.stringify(f.cost)}`);
  if (f.kind === "plan") console.log(`plan: ${JSON.stringify(f.entries)}`);
  if (f.kind === "agent_thought_chunk") console.log(`thought: ${JSON.stringify(f.text).slice(0, 60)}`);
}
await host.disposeSession(paneId);
console.log("disposed");
process.exit(0);
