// The loop.
//
// One objective in. The agent decides what to ask, has Flashpoint build and
// publish the survey, sends it to the list it was given, waits for answers,
// reads them, decides whether it knows enough, and if not writes a follow-up
// round aimed at whatever it could not answer. Then it commits to a
// recommendation.
//
// Nothing below contains a survey question. Every question that goes out is
// written by the model at run time from the objective.

import { BudgetExhausted, Flashpoint, FlashpointError } from "./flashpoint.mjs";
import { Brain } from "./brain.mjs";

// tool_survey is a conversation, not one call, and every turn of it costs
// $0.50. Three conversations a round means the turn cap is the main thing
// standing between a run and its budget, so each phase gets its own, sized
// to what that phase actually needs.
const TURNS = { build: 5, distribute: 3, collect: 3 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Turn the brain's question list into the natural-language brief the surveys agent takes. */
function briefFrom(plan, objective, extra = "") {
  const questions = plan.questions
    .map((q, i) => {
      const options = q.options?.length ? ` Options: ${q.options.join(" / ")}.` : "";
      return `${i + 1}. [${q.type}] ${q.text}${options}`;
    })
    .join("\n");
  return [
    `Create a survey titled "${plan.title}".`,
    `It exists to answer this objective: ${objective}`,
    "",
    "Use exactly these questions, in this order:",
    questions,
    "",
    "Keep it short and plain. Do not add demographic questions I have not asked for.",
    extra,
  ].join("\n").trim();
}

/** Did the surveys agent just tell us the survey is live? */
function publishedFrom(reply) {
  const text = typeof reply === "string" ? reply : JSON.stringify(reply);
  const url = text.match(/https:\/\/flashpointopinions\.com\/[0-9a-f-]{36}/i)?.[0] ?? null;
  const id = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? null;
  const live = /\b(published|live|is now live|publicly available)\b/i.test(text);
  return { url, id, live: Boolean(url) || live };
}

function idsFrom(reply, current = {}) {
  const pick = (key) => {
    if (reply && typeof reply === "object" && typeof reply[key] === "string") return reply[key];
    const text = typeof reply === "string" ? reply : JSON.stringify(reply ?? "");
    return text.match(new RegExp(`"?${key}"?\\s*[:=]\\s*"?([0-9a-f-]{36})`, "i"))?.[1] ?? null;
  };
  return {
    conversationId: current.conversationId ?? pick("conversation_id"),
    surveyId: current.surveyId ?? pick("survey_id"),
  };
}

export class ResearchAgent {
  constructor({ objective, audience, emails, budget, maxRounds, send, log, say }) {
    this.objective = objective;
    this.audience = audience;
    this.emails = emails;
    this.maxRounds = maxRounds;
    this.send = send;
    this.log = log;
    this.say = say;
    this.flashpoint = new Flashpoint({ budget, log });
    this.brain = new Brain({ flashpoint: this.flashpoint, log });
    this.history = [];
    this.ids = { conversationId: null, surveyId: null };
  }

  /**
   * Keep talking to the surveys agent until it has done what we asked or we
   * run out of turns. Each reply is read and answered by the brain, so the
   * agent is holding the conversation, not replaying a script.
   */
  async converse(firstMessage, goal, { fresh = false, maxTurns = TURNS.build } = {}) {
    let message = firstMessage;
    let last = null;
    const ids = fresh ? { conversationId: null, surveyId: null } : this.ids;

    for (let turn = 1; turn <= maxTurns; turn++) {
      const args = { brief: message };
      if (ids.conversationId) args.conversation_id = ids.conversationId;
      if (ids.surveyId) args.survey_id = ids.surveyId;

      last = await this.flashpoint.call("tool_survey", args, `${goal} (turn ${turn})`);
      Object.assign(ids, idsFrom(last, ids));
      this.ids = ids;

      const verdict = await this.brain.think(
        [
          "You are a research agent mid-conversation with Flashpoint's survey agent.",
          `YOUR GOAL FOR THIS EXCHANGE: ${goal}`,
          "ITS LATEST REPLY:",
          (typeof last === "string" ? last : JSON.stringify(last)).slice(0, 4000),
          "",
          "Has your goal been met? If not, what do you say back to move it along?",
          "If it is asking you to confirm something you want, confirm it plainly.",
          "",
          "Reply with JSON only:",
          '{"done": true|false, "reply": "<what to say next, empty if done>", "note": "<one short line on what just happened>"}',
        ].join("\n"),
        `judging the survey agent's reply (${goal})`,
      );

      await this.log?.({ type: "turn", goal, turn, note: verdict.note, done: verdict.done });
      this.say?.(`    turn ${turn}: ${verdict.note ?? "(no note)"}`);

      if (verdict.done) break;
      if (!verdict.reply) break;
      message = verdict.reply;
    }
    return last;
  }

  async runRound(roundNumber) {
    this.say?.(`\n── Round ${roundNumber} ──`);

    const plan =
      roundNumber === 1
        ? await this.brain.planFirstRound(this.objective, this.audience)
        : await this.brain.planFollowUp(this.objective, this.history);

    this.say?.(`  decided: ${plan.reasoning}`);
    this.say?.(`  survey: "${plan.title}" — ${plan.questions.length} questions`);
    plan.questions.forEach((q, i) => this.say?.(`    ${i + 1}. ${q.text}`));

    // Build and publish. A later round starts its own conversation, because
    // the surveys agent would otherwise try to edit the first survey.
    this.say?.("  building and publishing…");
    const built = await this.converse(
      briefFrom(plan, this.objective, "Publish it as soon as it is ready."),
      `create and publish the round ${roundNumber} survey`,
      { fresh: roundNumber > 1, maxTurns: TURNS.build },
    );
    const published = publishedFrom(built);
    if (published.url) this.say?.(`  live: ${published.url}`);

    // Distribute. Real email to real people, so it is opt-in at the command line.
    let distributed = false;
    if (this.send && this.emails.length > 0) {
      this.say?.(`  sending to ${this.emails.length} recipients…`);
      await this.converse(
        [
          "Create a first-party panel from exactly these email addresses and send them this survey now:",
          this.emails.join(", "),
          "Do not add anyone else and do not buy any paid respondents.",
        ].join("\n"),
        `send the round ${roundNumber} survey to the list`,
        { maxTurns: TURNS.distribute },
      );
      distributed = true;
    } else {
      this.say?.(this.send ? "  no recipients given, not sending" : "  dry run: not sending");
    }

    // Wait for answers, then read them.
    if (distributed) {
      const waitMs = Number(process.env.WAIT_MS ?? 120000);
      this.say?.(`  waiting ${Math.round(waitMs / 1000)}s for responses…`);
      await sleep(waitMs);
    }

    this.say?.("  collecting results…");
    const results = await this.converse(
      "Give me the results of this survey so far: every question, the counts and percentages for each answer, every free-text response, and the number of completes. If nobody has answered yet, say exactly that.",
      `collect the round ${roundNumber} results`,
      { maxTurns: TURNS.collect },
    );

    const analysis = await this.brain.analyse(this.objective, roundNumber, results);
    this.say?.(`  read them: ${analysis.reasoning}`);
    (analysis.findings ?? []).forEach((f) => this.say?.(`    • ${f}`));

    const round = {
      round: roundNumber,
      plan,
      survey_url: published.url,
      survey_id: this.ids.surveyId,
      distributed,
      analysis,
    };
    this.history.push(round);
    await this.log?.({ type: "round", ...round });
    return round;
  }

  async run() {
    const started = Date.now();
    this.say?.(`objective: ${this.objective}`);
    this.say?.(`reasoning with: ${this.brain.backend}`);
    this.say?.(`budget: $${this.flashpoint.budgetUsd.toFixed(2)} · rounds: up to ${this.maxRounds} · send: ${this.send ? "yes" : "dry run"}`);

    let stopped = null;
    try {
      for (let r = 1; r <= this.maxRounds; r++) {
        const round = await this.runRound(r);
        if (round.analysis?.enough_to_answer) {
          this.say?.("\n  the agent says it has enough to answer. Stopping early.");
          stopped = "answered";
          break;
        }
        if (r < this.maxRounds) {
          this.say?.("\n  not enough yet — going again on what it could not answer.");
        }
      }
    } catch (error) {
      stopped = error instanceof BudgetExhausted ? "budget" : "error";
      this.say?.(`\n  stopped: ${error.message}`);
      await this.log?.({ type: "stopped", reason: stopped, message: error.message });
      if (!(error instanceof BudgetExhausted) && !(error instanceof FlashpointError)) throw error;
    }

    this.say?.("\n── Recommendation ──");
    let recommendation = null;
    try {
      recommendation = await this.brain.recommend(this.objective, this.history);
      this.say?.(`  ${recommendation.recommendation}`);
      this.say?.(`  confidence: ${recommendation.confidence} — ${recommendation.confidence_reason}`);
    } catch (error) {
      this.say?.(`  could not write one: ${error.message}`);
    }

    return {
      objective: this.objective,
      audience: this.audience,
      backend: this.brain.backend,
      rounds: this.history,
      recommendation,
      stopped,
      spentUsd: Number(this.flashpoint.spentUsd.toFixed(2)),
      calls: this.flashpoint.calls,
      receipts: this.flashpoint.receipts,
      minutes: Math.round((Date.now() - started) / 6000) / 10,
    };
  }
}
