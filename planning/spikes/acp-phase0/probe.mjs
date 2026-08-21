// Phase 0 spike: does the Claude Code ACP adapter surface Kyle's real skills,
// model list and effort levels? Throwaway probe — prints the raw evidence.
import { spawn } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { readFile, writeFile } from "node:fs/promises";
import * as acp from "@agentclientprotocol/sdk";

const CWD = process.argv[2];
const PROMPT = process.argv[3] ?? "Reply with exactly: OK";
const AGENT = new URL(
  "./node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
  import.meta.url,
).pathname;

const seen = { kinds: {}, commands: null, configOptions: null, modes: null, usage: null, permissions: [] };
const note = (k) => (seen.kinds[k] = (seen.kinds[k] ?? 0) + 1);

const child = spawn(process.execPath, [AGENT], { stdio: ["pipe", "pipe", "pipe"], cwd: CWD });
child.stderr.on("data", (b) => process.stderr.write(`[agent] ${b}`));

const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));

function onUpdate(params) {
  const u = params.update;
  note(u.sessionUpdate);
  switch (u.sessionUpdate) {
    case "available_commands_update":
      seen.commands = u.availableCommands ?? [];
      break;
    case "config_option_update":
      seen.configOptions = u.configOptions ?? u.options ?? u;
      break;
    case "current_mode_update":
      seen.modes = u;
      break;
    case "usage_update":
      seen.usage = u;
      break;
    case "agent_message_chunk":
      if (u.content?.type === "text") process.stdout.write(u.content.text);
      break;
    case "tool_call":
      process.stdout.write(`\n[tool] ${u.title} (${u.status})\n`);
      break;
  }
}

const result = await acp
  .client({ name: "argus-phase0-probe" })
  .onNotification(acp.methods.client.session.update, (ctx) => onUpdate(ctx.params))
  .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
    const p = ctx.params;
    seen.permissions.push(p.toolCall?.title ?? "(untitled)");
    const pick = p.options?.find((o) => o.kind?.startsWith("allow")) ?? p.options?.[0];
    return { outcome: { outcome: "selected", optionId: pick.optionId } };
  })
  .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => ({
    content: await readFile(ctx.params.path, "utf8"),
  }))
  .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
    await writeFile(ctx.params.path, ctx.params.content, "utf8");
    return {};
  })
  .connectWith(stream, async (ctx) => {
    const init = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    console.log(`\n=== initialize: protocol v${init.protocolVersion}`);
    console.log(`=== agent capabilities: ${JSON.stringify(init.agentCapabilities ?? {})}`);

    const session = await ctx.request(acp.methods.agent.session.new, {
      cwd: CWD,
      mcpServers: [],
    });
    console.log(`=== session/new response keys: ${Object.keys(session).join(", ")}`);
    if (session.configOptions) seen.configOptions ??= session.configOptions;
    if (session.availableCommands) seen.commands ??= session.availableCommands;
    if (session.modes) seen.modes ??= session.modes;

    console.log(`=== sessionId: ${session.sessionId}`);
    console.log(`\n--- prompting: ${PROMPT}\n`);
    const res = await ctx.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: PROMPT }],
    });
    return res;
  });

console.log(`\n\n=== stopReason: ${result.stopReason}`);
console.log(`=== update kinds seen: ${JSON.stringify(seen.kinds)}`);
await writeFile(process.env.EVIDENCE ?? new URL("./probe-evidence.json", import.meta.url), JSON.stringify(seen, null, 2));
console.log(`=== raw evidence written to probe-evidence.json`);
child.kill();
process.exit(0);
