#!/usr/bin/env node
// Entry point.
//
//   node run.mjs --objective "Figure out what LionMatch should build next"
//                --audience "Columbia undergraduates"
//                --emails me@example.com,friend@example.com
//                --rounds 2 --budget 10 --send
//
// Without --send it does everything except put email in front of a human:
// it still designs the survey, publishes it and pays for the calls.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ResearchAgent } from "./src/agent.mjs";
import { renderRun } from "./src/report.mjs";
import { balance, redact, wallet } from "./src/flashpoint.mjs";

// .env.example tells people to put ANTHROPIC_API_KEY in .env, but only the
// wallet key was ever read from it; the Claude backend silently stayed off.
// Load every KEY=value line that the shell has not already set. Nothing here
// is printed.
const envFile = new URL("./.env", import.meta.url);
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

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

// "--objective --send" would otherwise set the objective to true and run a
// paid survey about the word "true".
for (const key of ["objective", "audience", "emails"]) {
  if (a[key] === true) {
    console.error(`  --${key} needs a value.`);
    process.exit(1);
  }
}

if (a.help || !a.objective) {
  console.log(`
LionMatch research agent — give it one objective, it does the research.

  --objective  "<what you want to know>"        (required)
  --audience   "<who should answer>"            (default: the people on the list)
  --emails     a@b.com,c@d.com                  recipients who agreed to hear from you
  --rounds     <n>                              max survey rounds (default 2)
  --budget     <usd>                            hard spending cap (default 10)
  --wait       <seconds>                        how long to wait for replies (default 120)
  --send                                        actually email people. Without it, a dry run.

Cost: the one measured round with a real send cost $4.09, so two rounds come
to about $8-9; extra confirmations, a second wait or retries can push a round
past $5. The cap is checked before every call and a few cents are held back
for the recommendation, so the agent stops cleanly and still writes it rather
than overspending.

Dry run first. --send puts real mail in real inboxes and cannot be undone.
`);
  process.exit(a.help === true || a.objective ? 0 : 1);
}

const emails = String(a.emails ?? "")
  .split(/[,\s]+/)
  .map((e) => e.trim())
  .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));

const dropped = String(a.emails ?? "").split(/[,\s]+/).filter((e) => e.trim()).length - emails.length;

// A typo here used to be dangerous: "--budget 10usd" is NaN, and no price is
// ever greater than NaN, so the spending cap silently never fired.
function number(name, fallback, { min, max, integer = false }) {
  const raw = a[name];
  const n = raw === undefined ? fallback : Number(raw);
  const bad = raw === true || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n));
  if (bad) {
    console.error(`  --${name} must be ${integer ? "a whole number" : "a number"} from ${min} to ${max} (got "${raw}").`);
    process.exit(1);
  }
  return n;
}
const budget = number("budget", 10, { min: 0.1, max: 50 });
const maxRounds = number("rounds", 2, { min: 1, max: 5, integer: true });
const waitSeconds = number("wait", 120, { min: 0, max: 24 * 3600 });
process.env.WAIT_MS = String(waitSeconds * 1000);

// Fail on a missing key before a run folder exists, not after.
let address;
try {
  address = wallet().address;
} catch (error) {
  console.error(`  ${error.message}`);
  process.exit(1);
}

// --run-id lets a caller (the MCP server) name the run up front, so it can
// report on a run it started. It may have created the folder already, to
// catch this process's output; it must not already hold a run.
let stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
if (a["run-id"] !== undefined) {
  if (typeof a["run-id"] !== "string" || !/^[A-Za-z0-9-]{6,64}$/.test(a["run-id"])) {
    console.error('  --run-id must be 6-64 letters, digits or hyphens.');
    process.exit(1);
  }
  stamp = a["run-id"];
}
// fileURLToPath, not URL.pathname: a checkout under a folder with a space in
// its name would otherwise write to a "%20" folder.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "runs", stamp);
if (fs.existsSync(path.join(dir, "log.jsonl"))) {
  console.error(`  runs/${stamp} already holds a run; pick another --run-id.`);
  process.exit(1);
}
fs.mkdirSync(dir, { recursive: true });
const logPath = path.join(dir, "log.jsonl");
const stream = fs.createWriteStream(logPath, { flags: "a" });

// Every byte the run writes — the log, the screen, the write-up — passes
// through one of these, so addresses are masked here rather than wherever
// someone remembered to. Masking field by field leaked: the brain's own
// notes repeated an address it had read ("ready to send to …"), and notes
// were never on the list. On a live demo the screen is shared too.
const log = async (entry) => {
  stream.write(`${JSON.stringify(redact({ at: new Date().toISOString(), ...entry }))}\n`);
};
const say = (line) => console.log(redact(line));

let opening = null;
try {
  opening = await balance();
} catch {
  // A balance read is a nicety, not a requirement.
}

say("");
say("  LionMatch research agent (Flashpoint MCP)");
say(`  wallet ${address}${opening === null ? "" : ` · ${opening.toFixed(2)} USDC`}`);
say(`  log: ${logPath}`);
say("");

if (dropped > 0) {
  say(`  ${dropped} of the --emails did not look like addresses and were left out.`);
}
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

const md = renderRun({ summary, stamp, send: Boolean(a.send) && emails.length > 0 });

fs.writeFileSync(path.join(dir, "RUN.md"), redact(md));
stream.end();

say("");
say(`  spent $${summary.spentUsd.toFixed(2)} over ${summary.calls} paid calls`);
say(`  write-up: ${path.join(dir, "RUN.md")}`);
say("");
