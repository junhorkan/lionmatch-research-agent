// Replies that deny a send or a publish must never read as one.
//
// A review found "Nothing has been sent yet" read as sent (it contains "has
// been sent"), "shall I go ahead?" not read as a wait, and a draft link read
// as live. Each wrong "sent" puts a false claim in the write-up; each wrong
// "live" mails people a survey that is not up. The real replies are covered
// by send-detection and publish-detection; these are the denials.
import { sentFrom, publishedFrom } from "../src/agent.mjs";

const LINK = "flashpointopinions.com/123e4567-e89b-12d3-a456-426614174000";

const cases = [
  // [what is checked, reply, expected]
  ["sent", "Nothing has been sent yet.", false],
  ["sent", "No invitations have been sent yet.", false],
  ["sent", "No emails were sent.", false],
  ["sent", "The invitation has not been sent.", false],
  ["sent", "Emails haven't been sent — shall I go ahead?", false],
  ["sent", "Your panel is ready. Would you like me to send the survey now?", false],
  ["sent", "The invitations weren't delivered.", false],
  ["sent", "Invitations were sent to 5 people.", true],
  ["sent", "Done — the survey has been sent to your panel.", true],
  ["sent", "No problem — it has been sent.", true],
  ["sent", "Invitation is on its way. Shall I send a reminder later?", true],
  ["live", `Draft ready at ${LINK} - it is not live yet.`, false],
  ["live", `It isn't published yet: ${LINK}`, false],
  ["live", `Your survey is still a draft: ${LINK}`, false],
  ["live", `Here it is: ${LINK}. Shall I publish it?`, false],
  ["live", `Your survey is live at ${LINK}`, true],
  ["live", `Published: ${LINK}`, true],
  ["live", `Your survey is now live at ${LINK}. Shall I email it to the panel?`, true],
];

let failed = 0;
for (const [kind, reply, expected] of cases) {
  const got = kind === "sent" ? sentFrom(reply).sent : publishedFrom(reply).live;
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? "ok   " : "WRONG"}  ${kind}=${String(got).padEnd(5)} ${reply}`);
}

console.log(failed === 0 ? "PASS: denials never read as sent or live" : `FAIL: ${failed} wrong of ${cases.length}`);
process.exit(failed === 0 ? 0 : 1);
