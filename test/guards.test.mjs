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
function fakeFlashpoint(body, { receipt = true } = {}) {
  const fp = new Flashpoint({ budget: 1, log: async () => {} });
  fp.connect = async () => ({
    headers: {},
    paidFetch: async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: receipt
          ? { "payment-response": Buffer.from(JSON.stringify({ transaction: "0xabc", network: "eip155:8453" })).toString("base64") }
          : {},
      }),
  });
  return fp;
}
for (const [label, body] of [
  ["MCP isError", { jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "Error executing tool chat: orchestrator did not reply within 300.0s" }] } }],
  ["status failed", { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ status: "failed", error: "surveys agent crashed" }) }] } }],
]) {
  const fp = fakeFlashpoint(body);
  let threw = null;
  try {
    await fp.call("chat", { message: "x" }, "test");
  } catch (e) {
    threw = e;
  }
  check(`${label}: raises`, threw instanceof FlashpointError, threw?.message?.slice(0, 50));
  check(`${label}: still charged`, Math.abs(fp.spentUsd - 0.01) < 1e-9, `spent $${fp.spentUsd}`);
}
{
  const fp = fakeFlashpoint({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ reply: "fine", error: null, status: "completed" }) }] } });
  const out = await fp.call("chat", { message: "x" }, "test");
  check("a normal reply with error:null is not a failure", out?.reply === "fine");
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
