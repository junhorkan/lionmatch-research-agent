#!/usr/bin/env node
// Entry point.
//
//   node run.mjs --objective "Figure out the best event to run next spring"
//                --audience "Columbia undergraduates in the AI Club"
//                --emails me@example.com,friend@example.com
//                --rounds 2 --budget 8 --send
//
// Without --send it does everything except put email in front of a human:
// it still designs the survey, publishes it and pays for the calls.

import fs from "node:fs";
import path from "node:path";
import { ResearchAgent } from "./src/agent.mjs";
import { balance, wallet } from "./src/flashpoint.mjs";

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const a = args(process.argv.slice(2));

if (a.help || !a.objective) {
  console.log(`
flashpoint-agent — give it one objective, it does the research.

  --objective  "<what you want to know>"        (required)
  --audience   "<who should answer>"            (default: the people on the list)
  --emails     a@b.com,c@d.com                  recipients who agreed to hear from you
  --rounds     <n>                              max survey rounds (default 2)
  --budget     <usd>                            hard spending cap (default 10)
  --wait       <seconds>                        how long to wait for replies (default 120)
  --send                                        actually email people. Without it, a dry run.

A round costs about $3 and at worst $5.63, so the default covers two rounds
with room to spare. The cap is checked before every call: the agent stops and
still writes its recommendation rather than overspending.

Dry run first. --send puts real mail in real inboxes and cannot be undone.
`);
  process.exit(a.objective ? 0 : 1);
}

const emails = String(a.emails ?? "")
  .split(/[,\s]+/)
  .map((e) => e.trim())
  .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));

const budget = Number(a.budget ?? 10);
const maxRounds = Number(a.rounds ?? 2);
if (a.wait) process.env.WAIT_MS = String(Number(a.wait) * 1000);

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "runs", stamp);
fs.mkdirSync(dir, { recursive: true });
const logPath = path.join(dir, "log.jsonl");
const stream = fs.createWriteStream(logPath, { flags: "a" });

const log = async (entry) => {
  stream.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
};
const say = (line) => console.log(line);

const address = wallet().address;
let opening = null;
try {
  opening = await balance();
} catch {
  // A balance read is a nicety, not a requirement.
}

say("");
say("  Flashpoint research agent");
say(`  wallet ${address}${opening === null ? "" : ` · ${opening.toFixed(2)} USDC`}`);
say(`  log: ${logPath}`);
say("");

if (a.send && emails.length === 0) {
  say("  --send was passed but no valid --emails. Nothing would be sent; continuing as a dry run.");
}
if (a.send && emails.length > 0) {
  say(`  SENDING IS ON. ${emails.length} people will get real email. Ctrl-C now if that is wrong.`);
  await new Promise((r) => setTimeout(r, 5000));
}

await log({
  type: "start",
  objective: a.objective,
  audience: a.audience ?? null,
  recipients: emails.length,
  budget,
  maxRounds,
  send: Boolean(a.send),
  wallet: address,
  openingBalance: opening,
});

const agent = new ResearchAgent({
  objective: String(a.objective),
  audience: String(a.audience ?? "the people on the invitation list"),
  emails,
  budget,
  maxRounds,
  send: Boolean(a.send),
  log,
  say,
});

const summary = await agent.run();
await log({ type: "finish", ...summary });

// A run is only evidence if someone can read it.
const md = [
  `# Run — ${stamp}`,
  "",
  `**Objective given to the agent:** ${summary.objective}`,
  "",
  `**Audience:** ${summary.audience}`,
  `**Reasoning backend:** ${summary.backend}`,
  `**Rounds run:** ${summary.rounds.length}`,
  `**Paid calls:** ${summary.calls} · **spent:** $${summary.spentUsd.toFixed(2)} · **wall clock:** ${summary.minutes} min`,
  summary.stopped ? `**Stopped because:** ${summary.stopped}` : "",
  "",
  "## What the agent decided, round by round",
  "",
  ...summary.rounds.flatMap((r) => [
    `### Round ${r.round} — ${r.plan?.title ?? "(untitled)"}`,
    "",
    `*Why it asked this:* ${r.plan?.reasoning ?? "—"}`,
    "",
    "Questions it wrote:",
    "",
    ...(r.plan?.questions ?? []).map((q, i) => `${i + 1}. ${q.text}${q.options?.length ? ` — *${q.options.join(" / ")}*` : ""}`),
    "",
    r.survey_url ? `Published: ${r.survey_url}` : "_not published_",
    r.distributed ? "Sent to the list." : "_Not sent (dry run)._",
    "",
    "What it made of the answers:",
    "",
    ...(r.analysis?.findings ?? []).map((f) => `- ${f}`),
    ...(r.analysis?.surprises?.length ? ["", "Surprises:", "", ...r.analysis.surprises.map((s) => `- ${s}`)] : []),
    ...(r.analysis?.gaps?.length ? ["", "Still open:", "", ...r.analysis.gaps.map((g) => `- ${g}`)] : []),
    "",
    `*Enough to answer?* **${r.analysis?.enough_to_answer ? "yes" : "no"}** — ${r.analysis?.reasoning ?? "—"}`,
    "",
  ]),
  "## Final recommendation",
  "",
  summary.recommendation
    ? [
        summary.recommendation.recommendation,
        "",
        "**Because:**",
        "",
        ...(summary.recommendation.because ?? []).map((b) => `- ${b}`),
        "",
        `**Confidence:** ${summary.recommendation.confidence} — ${summary.recommendation.confidence_reason}`,
        "",
        ...(summary.recommendation.caveats?.length
          ? ["**Caveats:**", "", ...summary.recommendation.caveats.map((c) => `- ${c}`), ""]
          : []),
        summary.recommendation.next_question ? `**Would ask next:** ${summary.recommendation.next_question}` : "",
      ].join("\n")
    : "_The agent did not get far enough to write one._",
  "",
  "## Payments",
  "",
  summary.receipts.length === 0
    ? "_No payments recorded._"
    : ["| tool | $ | receipt |", "|---|---|---|", ...summary.receipts.map((r) => `| ${r.tool} | ${r.price.toFixed(2)} | ${r.url} |`)].join("\n"),
  "",
  `Full machine-readable log: \`log.jsonl\` beside this file.`,
  "",
].filter((l) => l !== "").join("\n");

fs.writeFileSync(path.join(dir, "RUN.md"), md);
stream.end();

say("");
say(`  spent $${summary.spentUsd.toFixed(2)} over ${summary.calls} paid calls`);
say(`  write-up: ${path.join(dir, "RUN.md")}`);
say("");
