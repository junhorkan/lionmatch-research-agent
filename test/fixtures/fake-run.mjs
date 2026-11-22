#!/usr/bin/env node
// Stands in for run.mjs in test/mcp-server.test.mjs. It spends nothing,
// contacts nobody and never loads a wallet: it only writes a small, plausible
// run to runs/<run-id>/ and exits.
//
//   node test/fixtures/fake-run.mjs --objective "…" … --run-id mcp-…
//
// It reads --run-id and --objective and ignores everything else, but records
// its whole argv in argv.json so the test can check what the server passed.
// FAKE_RUN_SLEEP_MS (default 3000) keeps it alive for a while between the
// start line and the finish line, so the test can see a run in progress.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const value = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

const runId = value("--run-id");
if (!runId || !/^[A-Za-z0-9-]{6,64}$/.test(runId)) {
  console.error("fake-run: --run-id must be 6-64 letters, digits or hyphens");
  process.exit(1);
}
const objective = value("--objective") ?? "(none)";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = path.join(root, "runs", runId);
fs.mkdirSync(dir, { recursive: true });
const logPath = path.join(dir, "log.jsonl");
if (fs.existsSync(logPath)) {
  console.error(`fake-run: runs/${runId} already holds a run`);
  process.exit(1);
}

fs.writeFileSync(path.join(dir, "argv.json"), JSON.stringify(argv, null, 2));
const log = (entry) => fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);

console.log("fake-run: started (no wallet, no network, no email)");
log({
  type: "start",
  objective,
  audience: value("--audience") ?? null,
  recipients: 0,
  budget: Number(value("--budget") ?? 0),
  maxRounds: Number(value("--rounds") ?? 1),
  send: false,
  fake: true,
});

await new Promise((r) => setTimeout(r, Number(process.env.FAKE_RUN_SLEEP_MS ?? 3000)));

const round = {
  round: 1,
  plan: { title: "Fake survey", reasoning: "fixture", questions: [{ type: "single", text: "Which event?", options: ["A", "B"] }] },
  survey_url: null,
  distributed: false,
  not_sent_because: "dry run",
  completes: null,
  analysis: null,
};
log({ type: "round", ...round });
const recommendation = {
  recommendation: "Fake recommendation: run event A.",
  because: ["the fixture says so"],
  confidence: "low",
  confidence_reason: "this is a test fixture",
  caveats: [],
};
log({ type: "decision", stage: "recommend", decision: recommendation });
log({
  type: "finish",
  objective,
  audience: value("--audience") ?? "the people on the invitation list",
  backend: "fake",
  rounds: [round],
  recommendation,
  stopped: "not-sent",
  spentUsd: 0,
  calls: 0,
  receipts: [],
  minutes: 0,
});
fs.writeFileSync(
  path.join(dir, "RUN.md"),
  `# Run — ${runId}\n\n**Objective given to the agent:** ${objective}\n\n## Final recommendation\n\n${recommendation.recommendation}\n\n_Written by test/fixtures/fake-run.mjs; nothing was spent._\n`,
);
console.log("fake-run: finished");
