// The decisions between rounds, with the rounds themselves faked.
//
// Round 2 has never run against Flashpoint, so the logic that decides whether
// it happens is checked here instead: when to stop, when to go again, and
// when to wait rather than write a follow-up to answers that do not exist.
//   node test/control-flow.test.mjs
import { ResearchAgent, completesFrom } from "../src/agent.mjs";

process.env.ANTHROPIC_API_KEY = "";
process.env.WAIT_MS = "0";

async function scenario(name, { send, rounds, afterWait }, expect) {
  const agent = new ResearchAgent({
    objective: "test",
    audience: "test",
    emails: send ? ["someone@example.com"] : [],
    budget: 10,
    maxRounds: 2,
    send,
    log: async () => {},
    say: () => {},
  });
  let waits = 0;
  agent.runRound = async (r) => {
    const round = { round: r, distributed: send, ...rounds[r - 1] };
    agent.history.push(round);
    return round;
  };
  agent.waitAgain = async (round) => {
    waits++;
    return Object.assign(round, afterWait, { waited_twice: true });
  };
  agent.brain.recommend = async () => ({ recommendation: "x", confidence: "low" });

  const out = await agent.run();
  const got = { rounds: out.rounds.length, stopped: out.stopped, waits };
  const ok = Object.entries(expect).every(([k, v]) => got[k] === v);
  console.log(`${ok ? "ok   " : "WRONG"}  ${name.padEnd(46)} ${JSON.stringify(got)}`);
  return ok;
}

const enough = { analysis: { enough_to_answer: true } };
const notEnough = { analysis: { enough_to_answer: false } };

const results = [
  await scenario(
    "dry run: nothing sent, no second survey",
    { send: false, rounds: [{ completes: 0, ...notEnough }] },
    { rounds: 1, stopped: "no-responses", waits: 0 },
  ),
  await scenario(
    "answers in, not enough: runs the follow-up",
    { send: true, rounds: [{ completes: 6, ...notEnough }, { completes: 5, ...notEnough }] },
    { rounds: 2, stopped: null, waits: 0 },
  ),
  await scenario(
    "answers in and enough: stops after round 1",
    { send: true, rounds: [{ completes: 8, ...enough }] },
    { rounds: 1, stopped: "answered", waits: 0 },
  ),
  await scenario(
    "silence, then answers on the second look",
    { send: true, rounds: [{ completes: 0, ...notEnough }, { completes: 4, ...notEnough }], afterWait: { completes: 3, ...notEnough } },
    { rounds: 2, stopped: null, waits: 1 },
  ),
  await scenario(
    "silence twice: no follow-up mailed",
    { send: true, rounds: [{ completes: 0, ...notEnough }], afterWait: { completes: 0, ...notEnough } },
    { rounds: 1, stopped: "no-responses", waits: 1 },
  ),
];

// Completes as Flashpoint actually writes them.
const counts = [
  ["**1 complete** (completion rate: 100%, median time: ~55 seconds)", 1],
  ["Nobody has answered yet. The survey has **0 completes** and 0 responses.", 0],
  ["12 completes so far.", 12],
  ["The results card is open above.", null],
];
for (const [text, want] of counts) {
  const got = completesFrom(text);
  results.push(got === want);
  console.log(`${got === want ? "ok   " : "WRONG"}  completes from "${text.slice(0, 40)}…" = ${got}`);
}

const pass = results.every(Boolean);
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
