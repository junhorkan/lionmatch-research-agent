#!/usr/bin/env node
// MCP server: hands the research agent (run.mjs) to any MCP client over stdio.
//
//   node mcp-server.mjs        (normally started by the client, not by hand)
//
// stdout IS the MCP channel. Nothing in this file may write to it except the
// SDK's transport; every diagnostic goes to stderr.
//
// A run takes many minutes and spends real USDC, so run_research only starts
// one — as a detached child that outlives this server — and returns at once.
// The other three tools read what the run writes to runs/<id>/.
//
// LIONMATCH_AGENT_SCRIPT replaces run.mjs with another script. It exists so the
// test can point it at a fake that spends nothing.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Anything that slips through to console.log would corrupt the protocol.
console.log = (...args) => console.error(...args);
const note = (line) => process.stderr.write(`[lionmatch-research] ${line}\n`);

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNS = path.join(ROOT, "runs");
const SCRIPT = process.env.LIONMATCH_AGENT_SCRIPT
  ? path.resolve(ROOT, process.env.LIONMATCH_AGENT_SCRIPT)
  : path.join(ROOT, "run.mjs");
const RUN_ID = /^[A-Za-z0-9-]{6,64}$/;
// Same test run.mjs applies; anything it would silently drop is refused here
// instead, so the caller knows exactly who will be mailed.
const EMAIL = /^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/;

// Runs this server process started: id -> { child, pid, exited, code, signal, error }.
const children = new Map();

/** Same masking as src/flashpoint.mjs's redact(), for text this server passes on. */
const mask = (s) =>
  String(s).replace(/[^\s@<>()[\]",;:*`]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, (hit) => `<address at ${hit.split("@")[1]}>`);

class UserError extends Error {}

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const fail = (message) => ({ content: [{ type: "text", text: message }], isError: true });

/** Wrap a handler so any throw comes back as a tool error, never a crash. */
const safe = (fn) => async (args) => {
  try {
    return await fn(args ?? {});
  } catch (error) {
    if (!(error instanceof UserError)) note(`tool error: ${error?.stack ?? error}`);
    return fail(error instanceof UserError ? error.message : `Internal error: ${error?.message ?? error}`);
  }
};

/** Resolve runs/<id> safely: right shape, and it cannot point outside runs/. */
function runDir(runId) {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) {
    throw new UserError("run_id must be 6-64 letters, digits or hyphens (as returned by run_research or list_research_runs).");
  }
  const dir = path.resolve(RUNS, runId);
  if (path.dirname(dir) !== path.resolve(RUNS)) throw new UserError("run_id must name a folder directly inside runs/.");
  if (!fs.existsSync(dir)) throw new UserError(`No run named "${runId}" in runs/.`);
  // A symlink inside runs/ must not lead outside it either.
  const real = fs.realpathSync(dir);
  const realRuns = fs.realpathSync(RUNS);
  if (path.dirname(real) !== realRuns) throw new UserError("run_id must name a folder directly inside runs/.");
  return dir;
}

function readLog(dir) {
  const file = path.join(dir, "log.jsonl");
  if (!fs.existsSync(file)) return null;
  const events = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // The run may be mid-write on the last line; skip it.
    }
  }
  return events;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Is this run's process still going? null when this server does not know. */
function running(runId, dir) {
  const own = children.get(runId);
  if (own) return !own.exited && !own.error && alive(own.pid);
  // Started by an earlier instance of this server: it left its pid behind.
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "mcp-server.json"), "utf8"));
    if (Number.isInteger(meta.pid)) return alive(meta.pid);
  } catch {
    // not ours
  }
  return null;
}

/**
 * A run this server started that is still alive — including one started by an
 * earlier instance of this server (the client restarted), found by the pid it
 * left in runs/<id>/mcp-server.json. A run that has written its finish line
 * no longer counts, whatever its pid is now doing.
 */
function activeRun() {
  for (const [id, c] of children) if (!c.exited && !c.error && alive(c.pid)) return id;
  if (!fs.existsSync(RUNS)) return null;
  for (const name of fs.readdirSync(RUNS)) {
    if (!name.startsWith("mcp-") || children.has(name) || !RUN_ID.test(name)) continue;
    const dir = path.join(RUNS, name);
    if (!fs.existsSync(path.join(dir, "mcp-server.json"))) continue;
    if ((readLog(dir) ?? []).some((e) => e.type === "finish")) continue;
    if (running(name, dir)) return name;
  }
  return null;
}

const money = (n) => (typeof n === "number" && Number.isFinite(n) ? Number(n.toFixed(2)) : null);

/**
 * Dollars spent so far. Every `result` and `timeline` line carries the running
 * total; a tool that failed after being paid logs `tool-error` with its price
 * instead, so those are added on top of the last total.
 */
function spentFrom(events) {
  const finish = events.findLast((e) => e.type === "finish");
  if (finish && typeof finish.spentUsd === "number") return money(finish.spentUsd);
  let total = 0;
  for (const e of events) {
    if (typeof e.spentUsd === "number" && (e.type === "result" || e.type === "timeline")) total = Math.max(total, e.spentUsd);
    else if (e.type === "tool-error" && typeof e.price === "number") total += e.price;
  }
  return money(total);
}

/** What the run is doing now, read from its most recent events. */
function phaseFrom(events) {
  let phase = "starting";
  for (const e of events) {
    const what = `${e.why ?? ""} ${e.goal ?? ""}`;
    if (e.type === "start") phase = "planning";
    else if (e.type === "finish") phase = "finished";
    else if (e.type === "stopped") phase = "stopped";
    else if (e.type === "decision" && e.stage === "plan") phase = "planning";
    else if (e.type === "decision" && e.stage === "analyse") phase = "analysing";
    else if (e.type === "decision" && e.stage === "recommend") phase = "recommending";
    else if (e.type === "decision" && e.stage === "wait-again") phase = "waiting";
    else if (e.type === "send-check") phase = "sending";
    else if (e.type === "round") {
      if (!e.distributed) phase = "recommending"; // nothing sent: the run stops and writes its answer
      else if (e.completes === null || e.completes === undefined) phase = e.analysis ? "analysing" : "waiting";
    } else if (/deciding what to ask/.test(what)) phase = "planning";
    else if (/create and publish/.test(what)) phase = "building/publishing";
    // First round: "create the panel … and send it the round 1 survey"; later: "send the round N survey to the panel …".
    else if (/create the panel|send (?:it )?the round|make sure the round/.test(what)) phase = "sending";
    else if (/collect the round/.test(what)) phase = "collecting";
    else if (/reading round/.test(what)) phase = "analysing";
    else if (/final recommendation/.test(what)) phase = "recommending";
  }
  return phase;
}

/** Each round once, at its latest state. */
function roundsFrom(events) {
  const byNumber = new Map();
  for (const e of events) if (e.type === "round" && Number.isInteger(e.round)) byNumber.set(e.round, e);
  const finish = events.findLast((e) => e.type === "finish");
  if (finish?.rounds) for (const r of finish.rounds) if (Number.isInteger(r.round)) byNumber.set(r.round, r);
  return [...byNumber.values()]
    .sort((a, b) => a.round - b.round)
    .map((r) => ({
      round: r.round,
      title: r.plan?.title ?? null,
      survey_url: r.survey_url ?? null,
      sent: Boolean(r.distributed),
      completes: r.completes ?? null,
      enough_to_answer: typeof r.analysis?.enough_to_answer === "boolean" ? r.analysis.enough_to_answer : null,
    }));
}

function consoleTail(dir, lines = 15) {
  const file = path.join(dir, "console.txt");
  if (!fs.existsSync(file)) return null;
  const all = fs.readFileSync(file, "utf8").trimEnd().split("\n");
  return mask(all.slice(-lines).join("\n"));
}

function summarise(runId, dir) {
  const events = readLog(dir);
  if (!events) return null;
  const start = events.find((e) => e.type === "start") ?? {};
  const finish = events.findLast((e) => e.type === "finish");
  const stopped = events.findLast((e) => e.type === "stopped");
  return { events, start, finish, stopped, running: running(runId, dir) };
}

// ── run_research ─────────────────────────────────────────────────────────

async function runResearch({ objective, audience, emails = [], send = false, rounds = 2, budget, wait_seconds = 600 }) {
  // The schema has already checked types and ranges; these are the rules it cannot express.
  objective = objective.trim();
  if (!objective) throw new UserError("objective must not be empty.");
  if (objective.startsWith("--")) throw new UserError('objective must not start with "--".');
  if (audience !== undefined) {
    audience = audience.trim();
    if (audience.startsWith("--")) throw new UserError('audience must not start with "--".');
    if (!audience) audience = undefined;
  }
  const bad = emails.filter((e) => !EMAIL.test(e.trim()));
  if (bad.length) throw new UserError(`${bad.length} of the emails do not look like single email addresses; nothing was started.`);
  const list = [...new Set(emails.map((e) => e.trim()))];
  if (send && list.length === 0) throw new UserError("send: true needs at least one address in emails. Nothing was started.");

  const busy = activeRun();
  if (busy) {
    throw new UserError(`Run ${busy} is still going. One run spends money at a time: wait for it to finish (get_research_status) before starting another.`);
  }
  if (!fs.existsSync(SCRIPT)) throw new UserError(`The agent script is missing: ${SCRIPT}`);

  fs.mkdirSync(RUNS, { recursive: true });
  const base = `mcp-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  let runId = base;
  for (let n = 2; fs.existsSync(path.join(RUNS, runId)); n++) runId = `${base}-${n}`;
  const dir = path.join(RUNS, runId);
  fs.mkdirSync(dir);

  const args = [SCRIPT, "--objective", objective];
  if (audience) args.push("--audience", audience);
  if (list.length) args.push("--emails", list.join(","));
  args.push("--rounds", String(rounds), "--budget", String(budget), "--wait", String(wait_seconds));
  if (send) args.push("--send");
  args.push("--run-id", runId);

  const out = fs.openSync(path.join(dir, "console.txt"), "a");
  let child;
  try {
    child = spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: ["ignore", out, out], env: process.env });
  } finally {
    fs.closeSync(out);
  }
  const record = { child, pid: child.pid, exited: false, code: null, signal: null, error: null };
  children.set(runId, record);
  child.on("error", (error) => {
    record.error = error.message;
    note(`run ${runId} failed to start: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    Object.assign(record, { exited: true, code, signal });
    note(`run ${runId} exited (code ${code}${signal ? `, signal ${signal}` : ""})`);
  });
  child.unref();
  fs.writeFileSync(
    path.join(dir, "mcp-server.json"),
    JSON.stringify({ pid: child.pid, started_at: new Date().toISOString(), script: path.relative(ROOT, SCRIPT) }, null, 2),
  );
  note(`started run ${runId} (pid ${child.pid}, ${send ? `sending to ${list.length}` : "dry run"}, budget $${budget})`);

  // run.mjs refuses bad settings or a missing wallet key within a second.
  // Catch that here rather than hand back a run that never existed.
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (record.error || (record.exited && record.code !== 0 && !fs.existsSync(path.join(dir, "log.jsonl")))) {
    throw new UserError(
      `The run exited straight away without starting (exit code ${record.code}). Its output:\n${consoleTail(dir) ?? record.error ?? "(none)"}`,
    );
  }

  const what = send
    ? `REAL EMAIL: the survey will be emailed to ${list.length} ${list.length === 1 ? "person" : "people"}. That cannot be undone.`
    : `Dry run: nobody will be emailed${list.length ? ` (the ${list.length} address${list.length === 1 ? "" : "es"} given will not be used)` : ""}. It still designs and publishes a survey, which costs real USDC.`;
  return text({
    run_id: runId,
    folder: path.relative(ROOT, dir),
    log: path.relative(ROOT, path.join(dir, "log.jsonl")),
    console: path.relative(ROOT, path.join(dir, "console.txt")),
    pid: child.pid,
    script: path.relative(ROOT, SCRIPT),
    note: [
      `Started in the background; it takes many minutes${wait_seconds >= 3600 ? " (hours, with this wait)" : ""}.`,
      what,
      `Spending cap: $${budget} of real USDC, checked before every paid call. Up to ${rounds} round${rounds === 1 ? "" : "s"}, waiting ${wait_seconds}s for replies each round${send ? " (and once more if nobody answers)" : ""}.`,
      "It keeps running if this MCP client closes. Check on it with get_research_status; read the write-up with get_research_report when it finishes.",
    ].join(" "),
  });
}

// ── get_research_status ─────────────────────────────────────────────────

async function getStatus({ run_id }) {
  const dir = runDir(run_id);
  const s = summarise(run_id, dir);
  const own = children.get(run_id);
  if (!s) {
    // Started, but the run has not written its first line yet (or never will).
    const done = own?.exited || own?.error;
    return text({
      run_id,
      phase: done ? "stopped" : "starting",
      finished: false,
      process_running: running(run_id, dir),
      ...(done ? { stop_reason: `the process exited (code ${own.code}) before writing a log`, console_tail: consoleTail(dir) } : {}),
    });
  }
  const { events, start, finish, stopped } = s;
  let phase = phaseFrom(events);
  let stopReason = finish?.stopped ?? stopped?.reason ?? null;
  const out = {
    run_id,
    objective: start.objective ?? null,
    audience: start.audience ?? null,
    send: Boolean(start.send),
    recipients: start.recipients ?? null,
    budget_usd: start.budget ?? null,
    max_rounds: start.maxRounds ?? null,
    started_at: start.at ?? null,
    last_activity_at: events.at(-1)?.at ?? null,
    phase,
    rounds: roundsFrom(events),
    spent_usd: spentFrom(events),
    finished: Boolean(finish),
    stop_reason: stopReason,
    process_running: s.running,
  };
  if (!finish && s.running === false) {
    out.phase = "stopped";
    out.stop_reason = stopReason ?? "the process ended without writing a finish line (crashed or was killed)";
    out.console_tail = consoleTail(dir);
  }
  if (stopped?.message) out.stop_message = mask(stopped.message);
  if (finish) {
    const rec = finish.recommendation;
    out.recommendation = rec?.recommendation ?? null;
    if (rec?.confidence) out.confidence = `${rec.confidence}${rec.confidence_reason ? ` — ${rec.confidence_reason}` : ""}`;
    out.paid_calls = finish.calls ?? null;
    out.minutes = finish.minutes ?? null;
    out.report_available = fs.existsSync(path.join(dir, "RUN.md"));
  }
  if (!finish && out.last_activity_at) {
    // A long wait for replies is legitimately silent, so this is a fact for the
    // caller to weigh, not a verdict.
    out.quiet_for_minutes = Math.round((Date.now() - Date.parse(out.last_activity_at)) / 6000) / 10;
  }
  if (s.running === null && !finish) {
    out.process_note = "This server instance did not start this run, so it cannot tell whether its process is still alive; quiet_for_minutes says how long the log has been silent.";
  }
  return text(out);
}

// ── get_research_report ─────────────────────────────────────────────────

async function getReport({ run_id }) {
  const dir = runDir(run_id);
  const file = path.join(dir, "RUN.md");
  if (fs.existsSync(file)) return text(fs.readFileSync(file, "utf8"));
  const s = summarise(run_id, dir);
  const phase = s ? (s.finish ? "finished" : s.running === false ? "stopped" : phaseFrom(s.events)) : "starting";
  return text(
    `Run ${run_id} has not finished, so there is no RUN.md yet (current phase: ${phase}). ` +
      "Use get_research_status to follow it; the report appears when the run ends.",
  );
}

// ── list_research_runs ──────────────────────────────────────────────────

async function listRuns() {
  if (!fs.existsSync(RUNS)) return text([]);
  const rows = [];
  for (const name of fs.readdirSync(RUNS)) {
    if (!RUN_ID.test(name)) continue;
    const dir = path.join(RUNS, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const s = summarise(name, dir);
    if (!s) continue;
    rows.push({
      run_id: name,
      objective: s.start.objective ?? null,
      started_at: s.start.at ?? null,
      send: Boolean(s.start.send),
      finished: Boolean(s.finish),
      spent_usd: spentFrom(s.events),
      ...(s.running === null ? {} : { process_running: s.running }),
    });
  }
  rows.sort((a, b) => String(b.started_at ?? b.run_id).localeCompare(String(a.started_at ?? a.run_id)));
  return text(rows);
}

// ── wiring ──────────────────────────────────────────────────────────────

const server = new McpServer({ name: "lionmatch-research", version: "1.0.0" });

server.registerTool(
  "run_research",
  {
    title: "Start a research run (spends real USDC)",
    description: [
      "Start the LionMatch research agent on one objective. It designs a survey, publishes it through Flashpoint, optionally emails it, reads the answers, iterates for up to `rounds` rounds, and writes a recommendation.",
      "WARNING: this SPENDS REAL USDC from a real wallet, up to `budget` dollars, even on a dry run (designing and publishing the survey are paid calls).",
      "With send: true it EMAILS THE REAL PEOPLE in `emails`, which is IRREVERSIBLE. Only use addresses of people who agreed to hear from you, and only when the user has explicitly asked for a real send.",
      "Returns immediately with a run_id; the run takes many minutes in the background. Poll get_research_status, then read get_research_report. Only one run at a time.",
    ].join(" "),
    inputSchema: {
      objective: z.string().min(1).max(500).describe("What you want to find out, in one sentence (max 500 characters)."),
      audience: z.string().max(500).optional().describe("Who should answer, e.g. 'Columbia undergraduates in the AI Club'."),
      emails: z.array(z.string().max(254)).max(500).optional().describe("Recipients who agreed to hear from you. Only emailed when send is true."),
      send: z.boolean().default(false).describe("true = really email everyone in `emails` (irreversible). Default false: a dry run that emails nobody but still spends on designing and publishing."),
      rounds: z.number().int().min(1).max(5).default(2).describe("Maximum survey rounds, 1-5 (default 2)."),
      budget: z.number().min(0.1).max(50).describe("REQUIRED hard spending cap in US dollars (USDC), 0.1-50. A real one-round send cost about $4.09."),
      wait_seconds: z.number().min(0).max(86400).default(600).describe("How long to wait for replies each round, 0-86400 seconds (default 600)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  safe(runResearch),
);

const runIdSchema = { run_id: z.string().describe("The run id, e.g. from run_research or list_research_runs.") };

server.registerTool(
  "get_research_status",
  {
    title: "Research run status",
    description:
      "Compact status of a research run: objective, whether real email was on, phase (planning, building/publishing, sending, waiting, collecting, analysing, recommending, finished, stopped), rounds so far with completes and enough_to_answer, dollars spent, stop reason, and the recommendation once finished. Free; reads local files only.",
    inputSchema: runIdSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  safe(getStatus),
);

server.registerTool(
  "get_research_report",
  {
    title: "Research run report",
    description: "The finished run's write-up (RUN.md, markdown), or a message saying the run has not finished yet. Free; reads local files only.",
    inputSchema: runIdSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  safe(getReport),
);

server.registerTool(
  "list_research_runs",
  {
    title: "List research runs",
    description: "Every run in runs/, newest first: run id, objective, started at, whether real email was on, finished or not, dollars spent. Free; reads local files only.",
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  safe(listRuns),
);

process.on("uncaughtException", (error) => note(`uncaught: ${error?.stack ?? error}`));
process.on("unhandledRejection", (error) => note(`unhandled: ${error?.stack ?? error}`));
// When the client goes away, so does this server. Runs it started carry on:
// they are detached and write to their own console.txt.
process.stdin.on("end", () => process.exit(0));

await server.connect(new StdioServerTransport());
note(`ready (agent script: ${path.relative(ROOT, SCRIPT) || SCRIPT})`);
