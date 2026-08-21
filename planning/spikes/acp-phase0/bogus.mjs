import { spawn } from "node:child_process";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
const CWD = process.argv[2];
const AGENT = new URL("./node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js", import.meta.url).pathname;
const child = spawn(process.execPath, [AGENT], { stdio: ["pipe","pipe","pipe"], cwd: CWD });
child.stderr.on("data", () => {});
const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
const cur = (o,id) => (o??[]).find(x=>x.id===id)?.currentValue;
await acp.client({ name: "bogus" })
  .onNotification(acp.methods.client.session.update, () => {})
  .connectWith(stream, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: {} } });
    const s = await ctx.request(acp.methods.agent.session.new, { cwd: CWD, mcpServers: [] });
    await ctx.request(acp.methods.agent.session.setConfigOption, { sessionId: s.sessionId, configId: "model", value: "claude-fable-5[1m]" });
    let r = await ctx.request(acp.methods.agent.session.resume, { sessionId: s.sessionId, cwd: CWD, mcpServers: [] });
    console.log("after valid set   -> model=" + cur(r.configOptions,"model"));
    try {
      const b = await ctx.request(acp.methods.agent.session.setConfigOption, { sessionId: s.sessionId, configId: "model", value: "totally-not-a-model" });
      console.log("bogus set        -> ACCEPTED, reply says model=" + cur(b.configOptions,"model"));
    } catch (e) { console.log("bogus set        -> REJECTED: " + String(e.message??e).slice(0,80)); }
    r = await ctx.request(acp.methods.agent.session.resume, { sessionId: s.sessionId, cwd: CWD, mcpServers: [] });
    console.log("after bogus set  -> model=" + cur(r.configOptions,"model"));
    return {};
  });
child.kill(); process.exit(0);
