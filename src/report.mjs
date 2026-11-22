// Turns a finished run into RUN.md, the readable half of the evidence.
// Kept apart from run.mjs so it can be tested, and so an old run can be
// re-rendered from the summary in its log.

/**
 * @param {object} o
 * @param {object} o.summary  what ResearchAgent.run() returned
 * @param {string} o.stamp    the run's folder name
 * @param {boolean} o.send    whether --send was on
 */
export function renderRun({ summary, stamp, send }) {
  // A run is only evidence if someone can read it.
  //
  // `null` marks a line to leave out; "" is a deliberate blank line. The first
  // version filtered out every "", which collapsed the whole file on GitHub:
  // markdown joins lines that have no blank line between them, so the header
  // ran together into one paragraph.
  const STOPPED = {
    answered: "the agent decided it had enough to answer",
    "no-responses": "nobody answered, even after a second wait, so there was nothing to follow up on",
    "not-sent": "nothing was sent (a dry run, or the send could not be confirmed), so nobody was asked",
    budget: "it reached its spending cap",
    flashpoint: "Flashpoint stopped responding",
    error: "an unexpected error (the stack is in log.jsonl)",
  };
  const sentLine = (r) =>
    r.distributed ? "Sent to the list." : send ? "_Not sent: it could not confirm the email went out._" : "_Not sent: dry run._";

  return [
    `# Run — ${stamp}`,
    "",
    `**Objective given to the agent:** ${summary.objective}`,
    "",
    `- **Audience:** ${summary.audience}`,
    `- **Reasoning backend:** ${summary.backend}`,
    `- **Rounds run:** ${summary.rounds.length}`,
    `- **Paid calls:** ${summary.calls} · **spent:** $${summary.spentUsd.toFixed(2)} · **wall clock:** ${summary.minutes} min`,
    summary.stopped ? `- **Stopped because:** ${STOPPED[summary.stopped] ?? summary.stopped}` : null,
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
      r.survey_url ? `Published: ${r.survey_url}` : "_Not published._",
      "",
      sentLine(r),
      "",
      r.completes === null || r.completes === undefined ? null : `**Completes:** ${r.completes}${r.waited_twice ? " (after waiting a second time)" : ""}`,
      "",
      "What it made of the answers:",
      "",
      ...(r.analysis?.findings ?? []).map((f) => `- ${f}`),
      ...(r.analysis?.changed_since_last_round ? ["", `**What this round changed:** ${r.analysis.changed_since_last_round}`] : []),
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
          summary.recommendation.next_question ? `**Would ask next:** ${summary.recommendation.next_question}` : null,
        ]
          .filter((l) => l !== null)
          .join("\n")
      : "_The agent did not get far enough to write one._",
    "",
    "## Payments",
    "",
    summary.receipts.length === 0
      ? "_No payments recorded._"
      : ["| tool | $ | receipt |", "|---|---|---|", ...summary.receipts.map((r) => `| ${r.tool} | ${r.price.toFixed(2)} | ${r.url ?? "—"} |`)].join("\n"),
    "",
    `Full machine-readable log: \`log.jsonl\` beside this file.`,
    "",
  ]
    .filter((l) => l !== null)
    .join("\n")
    // Leaving lines out can leave two blanks in a row; one is enough.
    .replace(/\n{3,}/g, "\n\n");
}
