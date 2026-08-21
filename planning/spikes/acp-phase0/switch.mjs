// Phase 0b: can we change model + effort MID-SESSION and see it take?
import { spawn } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { readFile, writeFile } from "node:fs/promises";
import * as acp from "@agentclientprotocol/sdk";

const CWD = process.argv[2];
const AGENT = new URL("./node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js", import.meta.url).pathname;
const child = spawn(process.execPath, [AGENT], { stdio: ["pipe", "pipe", "pipe"], cwd: CWD });
child.stderr.on("data", () => {});
const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));

let latest = null;               // last configOptions seen via notification
const pick = (opts, id) => (opts ?? []).find((o) => o.id === id);
const cur = (opts, id) => pick(opts, id)?.currentValue;

await acp
  .client({ name: "argus-phase0-switch" })
  .onNotification(acp.methods.client.session.update, (ctx) => {
    const u = ctx.params.update;
    if (u.sessionUpdate === "config_option_update") latest = u.configOptions ?? u.options ?? null;
  })
  .onRequest(acp.methods.client.session.requestPermission, (ctx) => ({
    outcome: { outcome: "selected", optionId: ctx.params.options[0].optionId },
  }))
  .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => ({ content: await readFile(ctx.params.path, "utf8") }))
  .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => { await writeFile(ctx.params.path, ctx.params.content, "utf8"); return {}; })
  .connectWith(stream, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    const s = await ctx.request(acp.methods.agent.session.new, { cwd: CWD, mcpServers: [] });
    const before = s.configOptions;
    console.log(`BEFORE  model=${cur(before, "model")}  effort=${cur(before, "effort")}`);

    const r1 = await ctx.request(acp.methods.agent.session.setConfigOption, {
      sessionId: s.sessionId, configId: "model", value: "claude-fable-5[1m]",
    });
    const r2 = await ctx.request(acp.methods.agent.session.setConfigOption, {
      sessionId: s.sessionId, configId: "effort", value: "high",
    });
    const after = r2?.configOptions ?? r1?.configOptions ?? latest;
    console.log(`AFTER   model=${cur(after, "model")}  effort=${cur(after, "effort")}`);

    // Read-back from an independent source: a fresh notification, not the call's own reply.
    await ctx.request(acp.methods.agent.session.prompt, {
      sessionId: s.sessionId, prompt: [{ type: "text", text: "Reply with exactly: OK" }],
    });
    console.log(`READBACK(notification) model=${cur(latest, "model")}  effort=${cur(latest, "effort")}`);

    const listed = await ctx.request(acp.methods.agent.session.list, {}).catch((e) => ({ error: String(e.message ?? e).slice(0,80) }));
    console.log("LIST keys: " + JSON.stringify(Object.keys(listed)).slice(0,120));
    const mine = (listed.sessions ?? []).find((x) => x.sessionId === s.sessionId);
    console.log("LIST entry: " + JSON.stringify(mine ?? listed).slice(0, 400));
    const res = await ctx.request(acp.methods.agent.session.resume, { sessionId: s.sessionId, cwd: CWD, mcpServers: [] }).catch((e) => ({ error: String(e.message ?? e).slice(0,100) }));
    console.log("RESUME keys: " + JSON.stringify(Object.keys(res)));
    console.log(`RESUME readback model=${cur(res.configOptions, "model")} effort=${cur(res.configOptions, "effort")}`);

child.kill();
process.exit(0);
    // Negative control: an id the agent should reject.
    try {
      await ctx.request(acp.methods.agent.session.setConfigOption, {
        sessionId: s.sessionId, configId: "model", value: "totally-not-a-model",
      });
      console.log("CONTROL bogus model was ACCEPTED  <-- the check would not catch a bad id");
    } catch (e) {
      console.log(`CONTROL bogus model REJECTED: ${String(e.message ?? e).slice(0, 90)}`);
    }
    return {};
  });