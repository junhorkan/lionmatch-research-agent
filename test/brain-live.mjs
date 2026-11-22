// Live check of the two brain steps that hung in the dry runs, against the
// real Flashpoint chat tool. Hard-capped at $0.10.
//
//   node test/brain-live.mjs
import { Flashpoint } from "../src/flashpoint.mjs";
import { Brain } from "../src/brain.mjs";

// Test the chat backend specifically, whatever the environment says.
process.env.ANTHROPIC_API_KEY = "";

const events = [];
const log = async (e) => {
  events.push(e);
};
const flashpoint = new Flashpoint({ budget: 0.1, log });
const brain = new Brain({ flashpoint, log });

const objective = "Figure out the best event to put on for the Columbia AI Club next spring";
// The exact reply Flashpoint gave in the real dry run.
const zero = "Nobody has answered yet. The survey has **0 completes** and 0 responses across all 7 questions.";

let t = Date.now();
const analysis = await brain.analyse(objective, 1, zero);
console.log(`analyse    ${((Date.now() - t) / 1000).toFixed(1)}s  enough_to_answer=${analysis.enough_to_answer}`);
console.log(`           ${analysis.reasoning}`);

t = Date.now();
const rec = await brain.recommend(objective, [{ round: 1, plan: { title: "Spring Event Planning" }, analysis }]);
console.log(`recommend  ${((Date.now() - t) / 1000).toFixed(1)}s  confidence=${rec.confidence}`);
console.log(`           ${rec.recommendation}`);
console.log(`           next: ${rec.next_question}`);

const acted = JSON.stringify(rec).match(/panel run|run the panel|synthetic|LionMatch/i);
console.log("");
console.log(
  `spent $${flashpoint.spentUsd.toFixed(2)} · retries ${events.filter((e) => e.type === "retry").length} · timeouts ${events.filter((e) => e.type === "timeout").length}`,
);
console.log(acted ? `WARNING: still mentions "${acted[0]}"` : "stayed on its own study: no panels, no other projects");
