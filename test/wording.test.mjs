// Every phrasing that has fooled one version or another of the "is it live?"
// and "was it sent?" checks, pinned so no later change can quietly regress.
// The real captured replies are in publish-detection and send-detection;
// these are the near misses around them.
//   node test/wording.test.mjs
import { publishedFrom, sentFrom } from "../src/agent.mjs";

const URL = "flashpointopinions.com/170d47ff-104b-4f59-b013-4eb8355a8d70";

const live = [
  // [text, expected, why it is here]
  [`${URL} Reply 'confirm' to publish.`, false, "single-quoted confirm request"],
  [`Publishing will make it live. Reply **confirm**. ${URL}`, false, '"will make it live" is a promise'],
  [`Publish confirmed. The survey is live at ${URL}`, true, '"confirmed" is past tense, not a request'],
  [`The survey is live: ${URL}. To email it, reply confirm with your list.`, true, "live, and asking about a later step"],
  ["The survey is live.", false, "no URL, so nothing to send people"],
];

const sent = [
  ["Sent to all 3 panel members. None were suppressed.", true, "plain past tense"],
  ["Done — emailed the survey to 3 recipients.", true, "emailed"],
  ["The invitations were dispatched to 3 people.", true, "dispatched"],
  ["All 4 invitations are queued for delivery.", true, "queued for delivery"],
  ["Sending confirmed: invitation is on its way to 3 people.", true, "Flashpoint's real wording, plus 'confirmed'"],
  ["Invitation is on its way to **x**. I will confirm once responses arrive.", true, "a mention of confirm, not a request"],
  ["Invitation is on its way. Reply confirm to send a reminder.", true, "sent, and asking about a later step"],
  ["It will be sent once you reply 'confirm'.", false, "future tense, single quotes"],
  ["The survey will be sent when you confirm.", false, "future tense, unquoted"],
  ['Ready to send to 3 people. Please reply **"confirm"** to proceed.', false, "still waiting"],
  ["The invitations have not been sent yet.", false, "negated"],
  ["Panel created with 3 members.", false, "a panel is not a send"],
  ["I could not send the survey: the panel has no deliverable addresses.", false, "failed"],
];

let bad = 0;
for (const [text, want, why] of live) {
  const got = publishedFrom(text).live;
  if (got !== want) bad++;
  console.log(`${got === want ? "ok   " : "WRONG"}  live=${String(got).padEnd(5)} ${why}`);
}
for (const [text, want, why] of sent) {
  const got = sentFrom(text).sent;
  if (got !== want) bad++;
  console.log(`${got === want ? "ok   " : "WRONG"}  sent=${String(got).padEnd(5)} ${why}`);
}
console.log(bad === 0 ? "PASS" : `FAIL — ${bad} wrong`);
process.exit(bad === 0 ? 0 : 1);
