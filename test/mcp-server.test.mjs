// The MCP server, driven through the SDK's own client over stdio. Free:
// LIONMATCH_AGENT_SCRIPT always points at test/fixtures/fake-run.mjs, so no
// real run (no wallet, no USDC, no email) can start from here.
//   node test/mcp-server.test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = path.join(ROOT, "runs");
const FAKE = path.join(ROOT, "test", "fixtures", "fake-run.mjs");
const REAL_RUN = "2026-11-22T01-20-38";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(Boolean(ok));
  console.log(`${ok ? "ok   " : "WRONG"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (res) => (res?.content ?? []).map((c) => c.text ?? "").join("\n");
const json = (res) => {
  try {
    return JSON.parse(textOf(res));
  } catch {
    return null;
  }
};
const mcpRuns = () => (fs.existsSync(RUNS) ? fs.readdirSync(RUNS).filter((n) => n.startsWith("mcp-")) : []);

// ── The seam. Never spawn the server without it. ─────────────────────────
const env = {
  ...getDefaultEnvironment(),
  LIONMATCH_AGENT_SCRIPT: FAKE,
  FAKE_RUN_SLEEP_MS: "3000",
  // Second layer, in case the seam ever broke: point Flashpoint at a closed
  // local port and switch the Claude backend off, so even run.mjs could not
  // reach anything that charges.
  FLASHPOINT_MCP_BASE: "http://127.0.0.1:9",
  ANTHROPIC_API_KEY: "",
};
if (!env.LIONMATCH_AGENT_SCRIPT || path.resolve(env.LIONMATCH_AGENT_SCRIPT) !== FAKE || !fs.existsSync(FAKE)) {
  console.log("WRONG  LIONMATCH_AGENT_SCRIPT is not the fake fixture; refusing to start the server");
  console.log("FAIL");
  process.exit(1);
}
check("LIONMATCH_AGENT_SCRIPT points at the fake fixture", true, path.relative(ROOT, env.LIONMATCH_AGENT_SCRIPT));

const before = new Set(mcpRuns());
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, "mcp-server.mjs")],
  cwd: ROOT,
  env,
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (d) => (stderr += d));
const client = new Client({ name: "mcp-server-test", version: "1.0.0" });

try {
  await client.connect(transport);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });

  // 1. Exactly the four tools.
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const want = ["get_research_report", "get_research_status", "list_research_runs", "run_research"];
  check("lists exactly the four tools", JSON.stringify(names) === JSON.stringify(want), names.join(", "));
  const runTool = tools.find((t) => t.name === "run_research");
  check("budget is required, with no default", runTool?.inputSchema?.required?.includes("budget") && runTool?.inputSchema?.properties?.budget?.default === undefined);
  check("run_research warns about USDC and real email", /USDC/.test(runTool?.description) && /IRREVERSIBLE/i.test(runTool?.description));

  // 2. Reading the real, finished run.
  const list = json(await call("list_research_runs"));
  const row = Array.isArray(list) ? list.find((r) => r.run_id === REAL_RUN) : null;
  check(`list_research_runs includes ${REAL_RUN}`, row && row.finished === true && row.send === true, row ? `$${row.spent_usd}` : "missing");
  const starts = (list ?? []).map((r) => r.started_at ?? "");
  check("list_research_runs is newest first", starts.every((s, i) => i === 0 || starts[i - 1] >= s));

  const status = json(await call("get_research_status", { run_id: REAL_RUN }));
  check("status: finished", status?.finished === true && status?.phase === "finished", status?.phase);
  check("status: spent about $4.09", Math.abs((status?.spent_usd ?? 0) - 4.09) < 0.005, `$${status?.spent_usd}`);
  check("status: send was on, one round with its completes", status?.send === true && status?.rounds?.length === 1 && "completes" in status.rounds[0] && "enough_to_answer" in status.rounds[0]);
  check("status: has the recommendation", typeof status?.recommendation === "string" && status.recommendation.length > 0);

  const report = await call("get_research_report", { run_id: REAL_RUN });
  const runMd = fs.readFileSync(path.join(RUNS, REAL_RUN, "RUN.md"), "utf8");
  check("report returns RUN.md", !report.isError && textOf(report) === runMd);

  // 3. Bad ids never reach the filesystem.
  for (const bad of ["../../etc", "abc/../../x", "run id!", "a", "..", "x".repeat(65)]) {
    for (const tool of ["get_research_status", "get_research_report"]) {
      const res = await call(tool, { run_id: bad });
      check(`${tool} rejects ${JSON.stringify(bad.length > 20 ? `${bad.slice(0, 8)}…` : bad)}`, res.isError === true, textOf(res).split("\n")[0].slice(0, 70));
    }
  }
  const missing = await call("get_research_status", { run_id: "no-such-run-here" });
  check("unknown run id is a clear error", missing.isError === true && /No run named/.test(textOf(missing)));

  // 4. Bad run_research calls are refused before anything is spawned.
  const ok = { objective: "Which event should the club run?", budget: 0.5, rounds: 1, wait_seconds: 0 };
  const refusals = [
    ["without budget", { objective: ok.objective }, /budget/i],
    ["with rounds: 0", { ...ok, rounds: 0 }, /rounds/i],
    ["with rounds: 6", { ...ok, rounds: 6 }, /rounds/i],
    ["with budget: 51", { ...ok, budget: 51 }, /budget/i],
    ["with send: true and no emails", { ...ok, send: true }, /emails/i],
    ["with send: true and an empty list", { ...ok, send: true, emails: [] }, /emails/i],
    ["with a malformed email", { ...ok, emails: ["not-an-address"] }, /email/i],
    ["with an objective over 500 chars", { ...ok, objective: "x".repeat(501) }, /objective/i],
    ["with an objective starting with --", { ...ok, objective: "--send" }, /objective/i],
  ];
  for (const [name, args, pattern] of refusals) {
    const res = await call("run_research", args);
    check(`run_research refused ${name}`, res.isError === true && pattern.test(textOf(res)), textOf(res).replace(/\s+/g, " ").slice(0, 90));
  }
  check("no run folder created by the refused calls", mcpRuns().every((n) => before.has(n)));

  // 5. A valid run (the fake) starts, refuses a second, and finishes.
  const started = await call("run_research", { ...ok, audience: "test audience" });
  const s = json(started);
  check("run_research starts a run", !started.isError && /^mcp-[A-Za-z0-9-]+$/.test(s?.run_id ?? "") && fs.existsSync(path.join(RUNS, s?.run_id ?? "_")), s?.run_id ?? textOf(started));
  check("it ran the fake script", s?.script === path.relative(ROOT, FAKE), s?.script);
  check("the note says dry run and the cap", /dry run/i.test(s?.note ?? "") && /\$0\.5/.test(s?.note ?? ""));
  const id = s?.run_id;

  if (id) {
    const argv = JSON.parse(fs.readFileSync(path.join(RUNS, id, "argv.json"), "utf8"));
    const flag = (f) => argv[argv.indexOf(f) + 1];
    check(
      "flags passed through",
      flag("--objective") === ok.objective && flag("--budget") === "0.5" && flag("--rounds") === "1" && flag("--wait") === "0" && flag("--run-id") === id && flag("--audience") === "test audience",
      argv.join(" "),
    );
    check("no --send on a dry run", !argv.includes("--send"));

    const second = await call("run_research", ok);
    check("a second run is refused while the first is alive", second.isError === true && /still going/.test(textOf(second)), textOf(second).slice(0, 80));

    const mid = json(await call("get_research_status", { run_id: id }));
    check("status while running", mid?.finished === false && mid?.process_running === true, `${mid?.phase}, running=${mid?.process_running}`);
    const early = await call("get_research_report", { run_id: id });
    check("report before the end says it has not finished", !early.isError && /has not finished/.test(textOf(early)));

    let done = null;
    for (let i = 0; i < 40 && !done?.finished; i++) {
      await sleep(250);
      done = json(await call("get_research_status", { run_id: id }));
    }
    check("polling shows it finished", done?.finished === true && done?.phase === "finished", done?.phase);
    check("finished status: objective, $0, recommendation", done?.objective === ok.objective && done?.spent_usd === 0 && /Fake recommendation/.test(done?.recommendation ?? ""));
    for (let i = 0; i < 20 && done?.process_running !== false; i++) {
      await sleep(100);
      done = json(await call("get_research_status", { run_id: id }));
    }
    check("its process has ended", done?.process_running === false);
    const rep = await call("get_research_report", { run_id: id });
    check("report of the fake run", !rep.isError && /Fake recommendation/.test(textOf(rep)));
    const listed = json(await call("list_research_runs"));
    check("the new run is listed first", listed?.[0]?.run_id === id && listed[0].finished === true, listed?.[0]?.run_id);

    // 6. A send: true run passes --send and the list, and says it is real
    //    email. Still the fake: nothing is mailed.
    const sendRes = await call("run_research", { ...ok, send: true, emails: ["a@example.com", "b@example.org"] });
    const sr = json(sendRes);
    check("send: true starts (fake) with a REAL EMAIL warning", !sendRes.isError && /REAL EMAIL/.test(sr?.note ?? "") && /2 people/.test(sr?.note ?? ""), sr?.run_id ?? textOf(sendRes));
    check("the result does not echo the addresses", !/example\.(com|org)/.test(textOf(sendRes)));
    if (sr?.run_id) {
      const argv2 = JSON.parse(fs.readFileSync(path.join(RUNS, sr.run_id, "argv.json"), "utf8"));
      check("--send and --emails passed", argv2.includes("--send") && argv2[argv2.indexOf("--emails") + 1] === "a@example.com,b@example.org");
      // Let it finish before cleanup, or it would write into a deleted folder.
      let d2 = null;
      for (let i = 0; i < 40 && !(d2?.finished && d2?.process_running === false); i++) {
        await sleep(250);
        d2 = json(await call("get_research_status", { run_id: sr.run_id }));
      }
      check("the send run finished too", d2?.finished === true);
    }
  }
} catch (error) {
  check(`no unexpected error`, false, error?.stack ?? String(error));
} finally {
  await client.close().catch(() => {});
  // Remove only the run folders this test created.
  for (const name of mcpRuns()) {
    if (!before.has(name)) fs.rmSync(path.join(RUNS, name), { recursive: true, force: true });
  }
}
check("cleaned up its own run folders", mcpRuns().every((n) => before.has(n)));
check("real run untouched", fs.existsSync(path.join(RUNS, REAL_RUN, "RUN.md")));

const pass = results.every(Boolean);
if (!pass && stderr) console.log(`\nserver stderr:\n${stderr}`);
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
