// Regression test built from a real run.
//
// In run 2026-11-22T01-04-17 Flashpoint's surveys agent took four turns to
// publish: built it, asked to confirm, asked to confirm "one more time", then
// went live. Turns 2 and 3 both contain the word "live" ("publishing will
// make it live") while still waiting on a confirmation. A word match calls
// those published. This replays the four real replies and checks that only
// the fourth counts.
import fs from "node:fs";
import { textOf, asksToConfirm, publishedFrom } from "../src/agent.mjs";

const LOG = new URL("../runs/2026-11-22T01-04-17/log.jsonl", import.meta.url);
const replies = fs
  .readFileSync(LOG, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l))
  .filter((e) => e.type === "result" && e.tool === "tool_survey")
  .map((e) => e.result);

const expected = [false, false, false, true];
let failed = 0;

replies.forEach((reply, i) => {
  const text = textOf(reply);
  const { live, url } = publishedFrom(reply);
  const ok = live === expected[i];
  if (!ok) failed++;
  console.log(
    `turn ${i + 1}: live=${String(live).padEnd(5)} confirm-pending=${String(asksToConfirm(text)).padEnd(5)} ` +
      `mentions "live"=${String(/\blive\b/i.test(text)).padEnd(5)} ${ok ? "ok" : "WRONG"}` +
      (url ? `  ${url}` : ""),
  );
});

console.log(replies.length === 4 ? "" : `expected 4 replies, found ${replies.length}`);
console.log(failed === 0 && replies.length === 4 ? "PASS — only the turn that actually went live counts" : `FAIL — ${failed} wrong`);
process.exit(failed === 0 && replies.length === 4 ? 0 : 1);
