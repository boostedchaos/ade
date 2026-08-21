// Phase 4 live verify against the REAL adapter + REAL Claude Code CLI.
import {
  AcpHost,
  setAcpBinaryPathResolver,
  setAcpExecPathResolver,
} from "/Users/kylewelch/Documents/PROJECTS/ADE Windows 11/source/packages/server-core/src/acp-host/index";

const ADAPTER =
  "/Users/kylewelch/Documents/PROJECTS/ADE Windows 11/source/node_modules/.bun/@agentclientprotocol+claude-agent-acp@0.63.0+d9f3fa5251fc2eb0/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
setAcpBinaryPathResolver(() => ADAPTER);
setAcpExecPathResolver(() => "/Users/kylewelch/.local/bin/node");

const host = new AcpHost();
const paneId = "live-verify";
const cwd = process.env.LV_CWD!;

function pick(options: any[], id: string) {
  return options.find((o) => o.id === id);
}
function show(label: string, snap: { options: any[]; seq: number; fromWire: boolean }) {
  const m = pick(snap.options, "model");
  const e = pick(snap.options, "effort");
  const f = pick(snap.options, "fast");
  console.log(
    `${label}: seq=${snap.seq} fromWire=${snap.fromWire} model=${m?.currentValue} effort=${e?.currentValue} fast=${f?.currentValue}`,
  );
}

const info = await host.createSession({
  paneId,
  cwd,
  env: { CLAUDE_CODE_EXECUTABLE: "/Users/kylewelch/.local/bin/claude" },
});
console.log(`session up: ${info.acpSessionId} state=${info.state}`);
const modelOpt = pick(info.configOptions, "model");
console.log(
  "reported models:",
  (modelOpt?.values ?? []).map((v: any) => v.id).join(", "),
);

// Step 1a: switch model to Fable mid-session, verify by resume read-back.
await host.setConfigOption(paneId, "model", "claude-fable-5[1m]");
show("after model->fable", await host.readConfig(paneId));

// Step 1b: switch effort to high.
await host.setConfigOption(paneId, "effort", "high");
show("after effort->high", await host.readConfig(paneId));

// Step 2a: gibberish id sharing NO token with any model — local gate should
// refuse it before the wire (it is unlisted and we do not pass allowUnlisted).
try {
  await host.setConfigOption(paneId, "model", "zzqqxx");
  console.log("FAIL: zzqqxx accepted by local gate");
} catch (err: any) {
  console.log(`zzqqxx (no allowUnlisted): refused locally: ${err.code ?? err.message}`);
}
// Same id THROUGH the escape hatch — per A5 the adapter itself must error.
try {
  await host.setConfigOption(paneId, "model", "zzqqxx", { allowUnlisted: true });
  console.log("zzqqxx (allowUnlisted): adapter ACCEPTED (unexpected per A5)");
} catch (err: any) {
  console.log(`zzqqxx (allowUnlisted): adapter errored as predicted: ${String(err.message).slice(0, 90)}`);
}
show("after zzqqxx attempts", await host.readConfig(paneId));

// Step 2b: tokenized-bogus ids through the hatch. Live behavior check:
for (const bogus of ["claude-opus-99", "totally-not-a-model"]) {
  try {
    await host.setConfigOption(paneId, "model", bogus, { allowUnlisted: true });
    const snap = await host.readConfig(paneId);
    const actual = pick(snap.options, "model")?.currentValue;
    console.log(`${bogus}: adapter ACCEPTED; read-back model='${actual}' (chip ${actual === bogus ? "would NOT fire - BAD" : "would fire"})`);
  } catch (err: any) {
    console.log(`${bogus}: adapter ERRORED: ${String(err.message).slice(0, 80)}`);
  }
  show(`after ${bogus}`, await host.readConfig(paneId));
}

// Step 3: restore Fable, send a real prompt, confirm the turn completes.
await host.setConfigOption(paneId, "model", "claude-fable-5[1m]");
await host.setConfigOption(paneId, "effort", "low");
let sawText = false;
host.on(`update:${paneId}`, (u: any) => {
  if (u.kind === "agent_message_chunk") sawText = true;
});
const t0 = Date.now();
const result = await host.prompt(paneId, "Reply with exactly: OK");
console.log(
  `prompt after switch: stopReason=${result.stopReason} sawText=${sawText} in ${Date.now() - t0}ms`,
);
show("final", await host.readConfig(paneId));

await host.disposeSession(paneId);
console.log("disposed cleanly");
process.exit(0);
