// Regression test built from a real send.
//
// In run 2026-11-22T01-20-38 Flashpoint took three turns to email the survey:
// built the panel and asked to confirm, asked for "one final system
// confirmation", then reported "Invitation is on its way". The first two
// talk about sending while nothing has gone out yet; the third does not use
// the word "sent" at all. This replays the three real replies and checks
// that only the third counts as sent.
import fs from "node:fs";
import { sentFrom } from "../src/agent.mjs";

const LOG = new URL("../runs/2026-11-22T01-20-38/log.jsonl", import.meta.url);
const entries = fs
  .readFileSync(LOG, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

// The tool_survey results that answered a "send" call.
const replies = [];
let sending = false;
for (const e of entries) {
  if (e.type === "call" && e.tool === "tool_survey") sending = /send/.test(e.why ?? "");
  if (e.type === "result" && e.tool === "tool_survey" && sending) replies.push(e.result);
}

const expected = [false, false, true];
let failed = 0;
replies.forEach((reply, i) => {
  const { sent } = sentFrom(reply);
  const ok = sent === expected[i];
  if (!ok) failed++;
  console.log(`send turn ${i + 1}: sent=${String(sent).padEnd(5)} ${ok ? "ok" : "WRONG"}`);
});

const pass = failed === 0 && replies.length === 3;
console.log(pass ? "PASS: only the turn that actually sent counts" : `FAIL: ${failed} wrong of ${replies.length}`);
process.exit(pass ? 0 : 1);
