// The guards that protect money and honesty, checked without the network.
//   node test/guards.test.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { Flashpoint, FlashpointError } from "../src/flashpoint.mjs";
import { ResearchAgent } from "../src/agent.mjs";

process.env.ANTHROPIC_API_KEY = "";
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "ok   " : "WRONG"}  ${name}${detail ? `  (${detail})` : ""}`);
};

// 1. A bad number must stop the run before anything is created or spent.
//    "--budget 10usd" used to become NaN, and no price is greater than NaN,
//    so the cap never fired.
const runsDir = new URL("../runs/", import.meta.url);
const before = fs.readdirSync(runsDir).length;
for (const bad of [["--budget", "10usd"], ["--budget"], ["--rounds", "two"], ["--rounds", "0"], ["--wait", "-5"]]) {
  const r = spawnSync("node", ["run.mjs", "--objective", "x", ...bad], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  check(`rejects ${bad.join(" ")}`, r.status === 1 && /must be/.test(r.stderr), r.stderr.trim().split("\n")[0]);
}
check("no run folder left behind", fs.readdirSync(runsDir).length === before);

// 2. A tool that fails inside a successful response is a failure, and it was
//    still paid for. Real case: "Error executing tool chat: orchestrator did
//    not reply within 300.0s" used to be parsed as an answer.
// `bodies` is what each successive call returns; the last one repeats.
function fakeFlashpoint(bodies, { receipt = true } = {}) {
  const fp = new Flashpoint({ budget: 1, log: async () => {} });
  let n = 0;
  fp.connect = async () => ({
    headers: {},
    paidFetch: async () => {
      const body = bodies[Math.min(n++, bodies.length - 1)];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: receipt
          ? { "payment-response": Buffer.from(JSON.stringify({ transaction: "0xabc", network: "eip155:8453" })).toString("base64") }
          : {},
      });
    },
  });
  fp.attempts = () => n;
  return fp;
}
const ok = (obj) => ({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(obj) }] } });
const isError = { jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "Error executing tool chat: orchestrator did not reply within 300.0s" }] } };

for (const [label, body] of [
  ["MCP isError", isError],
  ["status failed", ok({ status: "failed", error: "surveys agent crashed" })],
  ["status cancelled", ok({ status: "cancelled" })],
]) {
  const fp = fakeFlashpoint([body]);
  let threw = null;
  try {
    await fp.call("chat", { message: "x" }, "test");
  } catch (e) {
    threw = e;
  }
  check(`${label}: raises after one retry`, threw instanceof FlashpointError && fp.attempts() === 2, `${fp.attempts()} tries`);
  check(`${label}: both tries charged`, Math.abs(fp.spentUsd - 0.02) < 1e-9, `spent $${fp.spentUsd}`);
}
{
  // A send must never be retried blindly: if the first try went out and then
  // failed, a retry would mail everyone twice.
  const fp = fakeFlashpoint([isError, ok({ reply: "would be a second send" })]);
  let threw = null;
  try {
    await fp.call("tool_survey", { brief: "send" }, "send", { retry: false });
  } catch (e) {
    threw = e;
  }
  check("retry:false makes exactly one attempt", threw instanceof FlashpointError && fp.attempts() === 1, `${fp.attempts()} tries`);
}
{
  // Transient: fails once, then answers. One error used to end the run.
  const fp = fakeFlashpoint([isError, ok({ reply: "recovered" })]);
  const out = await fp.call("chat", { message: "x" }, "test");
  check("a transient tool error is retried and recovers", out?.reply === "recovered" && fp.attempts() === 2);
}
for (const [label, body] of [
  ["error:null", ok({ reply: "fine", error: null, status: "completed" })],
  ["error:{}", ok({ reply: "fine", error: {}, status: "completed" })],
  ['error:""', ok({ reply: "fine", error: "", status: "completed" })],
]) {
  const fp = fakeFlashpoint([body]);
  const out = await fp.call("chat", { message: "x" }, "test");
  check(`a normal reply with ${label} is not a failure`, out?.reply === "fine" && fp.attempts() === 1);
}

// 2b. A round that was sent must survive a failure while reading it, and
//     still appear in the write-up. It used to be recorded only at the end.
{
  const { renderRun } = await import("../src/report.mjs");
  const agent = new ResearchAgent({
    objective: "x", audience: "x", emails: ["someone@example.com"], budget: 10, maxRounds: 1, send: true,
    log: async () => {}, say: () => {},
  });
  process.env.WAIT_MS = "0";
  const live = { result: { final_text: "The survey is live: flashpointopinions.com/170d47ff-104b-4f59-b013-4eb8355a8d70" } };
  const sent = { result: { final_text: "Invitation is on its way to 1 person." } };
  agent.brain.planFirstRound = async () => ({ title: "T", reasoning: "R", questions: [{ text: "Q?", type: "single" }] });
  agent.brain.recommend = async () => ({ recommendation: "x", confidence: "low" });
  let call = 0;
  agent.converse = async () => {
    call++;
    if (call === 1) return live;
    if (call === 2) {
      agent.lastExchangeDone = true;
      return sent;
    }
    throw new FlashpointError("collect failed: orchestrator did not reply");
  };
  const out = await agent.run();
  const r = out.rounds[0];
  check("sent round kept after reading fails", out.rounds.length === 1 && r?.distributed === true && r.analysis === null);
  const md = renderRun({ summary: out, stamp: "t", send: true });
  check("write-up says it was sent but never read", /Sent to the list\./.test(md) && /never read/.test(md));
}

// 3. A few cents are held back so the recommendation can always be written.
{
  const agent = new ResearchAgent({
    objective: "x", audience: "x", emails: [], budget: 10, maxRounds: 1, send: false,
    log: async () => {}, say: () => {},
  });
  check("budget minus reserve during the rounds", Math.abs(agent.flashpoint.budgetUsd - 9.95) < 1e-9, `$${agent.flashpoint.budgetUsd}`);
  let atRecommend = null;
  agent.runRound = async () => ({ round: 1, distributed: false, completes: 0 });
  agent.brain.recommend = async () => {
    atRecommend = agent.flashpoint.budgetUsd;
    return { recommendation: "x", confidence: "low" };
  };
  await agent.run();
  check("full budget back for the recommendation", Math.abs(atRecommend - 10) < 1e-9, `$${atRecommend}`);
}

const pass = results.every(Boolean);
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
