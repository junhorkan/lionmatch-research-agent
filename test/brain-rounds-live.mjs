// Live check of every reasoning step in a two-round run, against the real
// Flashpoint chat tool, hard-capped at $0.10. No survey is built and no email
// is sent. PAID — not part of the free suite.
//
//   node test/brain-rounds-live.mjs "<objective>"
//
// The "results" fed in below are INVENTED TEST DATA. They exist only to see
// whether round 2 chases what round 1 left open. They are printed, never
// saved, and must never be presented as findings.
import { Flashpoint } from "../src/flashpoint.mjs";
import { Brain } from "../src/brain.mjs";

process.env.ANTHROPIC_API_KEY = "";
const objective =
  process.argv[2] ??
  "Figure out what LionMatch should build next so Columbia students use it to find internships, research, clubs and fellowships";
const audience = "Columbia undergraduates looking for internships, research, clubs and fellowships";

const events = [];
const log = async (e) => {
  events.push(e);
};
const flashpoint = new Flashpoint({ budget: 0.1, log });
const brain = new Brain({ flashpoint, log });
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

console.log(`objective: ${objective}\n`);

const plan1 = await brain.planFirstRound(objective, audience);
console.log(`[${secs()}] ROUND 1 PLAN — ${plan1.title}`);
console.log(`  why: ${plan1.reasoning}`);
plan1.questions.forEach((q, i) => console.log(`  ${i + 1}. ${q.text}`));

const FIXTURE_1 = `TEST FIXTURE — INVENTED DATA.
**8 completes**
Biggest problem finding opportunities: heard about it after the deadline 50% (4), too many places to check 38% (3), didn't know if I qualified 12% (1).
Most wanted: deadline reminders 50% (4), a single list of everything 25% (2), knowing who to ask 25% (2).
Would use weekly: yes 38% (3), maybe 50% (4), no 12% (1).
Free text: "I'd use it if it told me before things closed", "LinkedIn already does this?", "only if my friends were on it".`;

const a1 = await brain.analyse(objective, 1, FIXTURE_1, []);
console.log(`\n[${secs()}] ROUND 1 READ — enough_to_answer=${a1.enough_to_answer}`);
(a1.gaps ?? []).forEach((g) => console.log(`  gap: ${g}`));

const history = [{ round: 1, plan: plan1, completes: 8, analysis: a1 }];
const plan2 = await brain.planFollowUp(objective, history);
console.log(`\n[${secs()}] ROUND 2 PLAN — ${plan2.title}`);
console.log(`  why: ${plan2.reasoning}`);
plan2.questions.forEach((q, i) => console.log(`  ${i + 1}. ${q.text}`));

const asked = new Set(plan1.questions.map((q) => q.text.toLowerCase().trim()));
const repeats = plan2.questions.filter((q) => asked.has(q.text.toLowerCase().trim()));

const FIXTURE_2 = `TEST FIXTURE — INVENTED DATA.
**6 completes**
Preferred reminder: email 2 days before 50% (3), push notification 33% (2), calendar invite 17% (1).
Would reminders make you use it weekly: yes 67% (4), maybe 33% (2).
Free text: "only for things I actually swiped on", "don't spam me".`;

const a2 = await brain.analyse(objective, 2, FIXTURE_2, history);
console.log(`\n[${secs()}] ROUND 2 READ — enough_to_answer=${a2.enough_to_answer}`);
console.log(`  changed since round 1: ${a2.changed_since_last_round ?? "(not given)"}`);

history.push({ round: 2, plan: plan2, completes: 6, analysis: a2 });
const rec = await brain.recommend(objective, history);
console.log(`\n[${secs()}] RECOMMENDATION (${rec.confidence})`);
console.log(`  ${rec.recommendation}`);

const wandered = JSON.stringify([plan1, plan2, a1, a2, rec]).match(/synthetic panel|run the panel|LionMatch friends|panel_id/i);
console.log("\n── checks ──");
console.log(`  round 2 repeats a round 1 question: ${repeats.length ? `YES (${repeats.length})` : "no"}`);
console.log(`  round 2 read compares to round 1:  ${a2.changed_since_last_round ? "yes" : "NO"}`);
console.log(`  wandered into panels/other work:   ${wandered ? `YES ("${wandered[0]}")` : "no"}`);
console.log(`  retries ${events.filter((e) => e.type === "retry").length} · timeouts ${events.filter((e) => e.type === "timeout").length} · spent $${flashpoint.spentUsd.toFixed(2)} · ${secs()}`);
