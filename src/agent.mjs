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

/**
 * What the surveys agent actually said, in words. Its reply arrives wrapped:
 * { conversation_id, task_id, status, result: { survey_id, final_text, … } }.
 * Judging the wrapper instead of final_text buries the sentence that matters
 * under a page of token counts.
 */
function textOf(reply) {
  if (typeof reply === "string") return reply;
  const t = reply?.result?.final_text ?? reply?.final_text ?? reply?.reply ?? reply?.message;
  return typeof t === "string" ? t : JSON.stringify(reply ?? "");
}

/** Is it asking us to say "confirm"? Flashpoint gates publishing on it. */
function asksToConfirm(text) {
  return /reply\s*\**\s*["“]?confirm|type\s*["“]?confirm|please confirm|confirm one more time|to proceed/i.test(text);
}

/**
 * Is the survey actually live? This is a fact, not a judgement, so it is
 * checked directly instead of asked of a model.
 *
 * It needs the public URL itself. Matching the word "live" is not enough:
 * mid-dance the surveys agent writes "publishing will make it live", while
 * still waiting on a confirmation — a word match would declare victory with
 * nothing published. Flashpoint also writes the link without https://.
 */
function publishedFrom(reply) {
  const text = textOf(reply);
  const hit = text.match(/(?:https?:\/\/)?flashpointopinions\.com\/([0-9a-f-]{36})/i);
  const url = hit ? `https://flashpointopinions.com/${hit[1]}` : null;
  return { url, live: Boolean(url) && !asksToConfirm(text) };
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

// Exported for the regression test, which replays real Flashpoint replies.
export { textOf, asksToConfirm, publishedFrom };

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
  /**
   * Keep talking to the surveys agent until it has done what we asked or we
   * run out of turns.
   *
   * Two kinds of reading happen here. Hard facts — is the survey live? — are
   * checked directly by `isDone`, because a fact does not need an opinion
   * and a model asked to confirm one can answer in prose and break the run.
   * Everything genuinely ambiguous — it asked a question, it wants a choice,
   * it pushed back — goes to the brain, which decides what to say. That is
   * where the agent is holding the conversation rather than replaying one.
   */
  async converse(firstMessage, goal, { fresh = false, maxTurns = TURNS.build, isDone = null } = {}) {
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
      const said = textOf(last);

      if (isDone?.(last)) {
        await this.log?.({ type: "turn", goal, turn, note: "goal met (checked directly)", done: true });
        this.say?.(`    turn ${turn}: done — checked directly, no judgement needed`);
        break;
      }

      let verdict;
      try {
        verdict = await this.brain.think(
          [
            "You are a research agent mid-conversation with Flashpoint's survey agent.",
            `YOUR GOAL FOR THIS EXCHANGE: ${goal}`,
            "WHAT IT JUST SAID TO YOU:",
            said.slice(0, 3000),
            "",
            "Has your goal been met? If not, what do you say back to move it along?",
            "When it asks you to confirm an action you want, reply with exactly the word it asks for —",
            'Flashpoint expects the single word "confirm".',
            "",
            "You must reply with the JSON object below in every case, including when the goal is met.",
            "Do not summarise, do not answer in a sentence, do not add anything outside the braces.",
            '{"done": true|false, "reply": "<what to say next, empty if done>", "note": "<one short line on what just happened>"}',
          ].join("\n"),
          `judging the survey agent's reply (${goal})`,
          ["done"],
        );
      } catch (error) {
        // The judge failed twice. Fall back on what can be read without it,
        // rather than losing the whole run over one unparseable sentence.
        const confirming = asksToConfirm(said);
        verdict = {
          done: !confirming,
          reply: confirming ? "confirm" : "",
          note: confirming
            ? "judge unreadable; it is asking to confirm, so confirming"
            : "judge unreadable; nothing pending, treating this exchange as finished",
        };
        await this.log?.({ type: "fallback", goal, turn, problem: error.message, verdict });
      }

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

    // Defend against a model that answers in a shape we did not ask for:
    // better a thin round than a stack trace in front of judges.
    plan.questions = Array.isArray(plan.questions) ? plan.questions.filter((q) => q && q.text) : [];
    if (plan.questions.length === 0) throw new FlashpointError("The planner returned no usable questions.");

    this.say?.(`  decided: ${plan.reasoning ?? "(no reasoning given)"}`);
    this.say?.(`  survey: "${plan.title}" — ${plan.questions.length} questions`);
    plan.questions.forEach((q, i) => this.say?.(`    ${i + 1}. ${q.text}`));

    // Build and publish. A later round starts its own conversation, because
    // the surveys agent would otherwise try to edit the first survey.
    this.say?.("  building and publishing…");
    const built = await this.converse(
      briefFrom(plan, this.objective, "Publish it as soon as it is ready."),
      `create and publish the round ${roundNumber} survey`,
      { fresh: roundNumber > 1, maxTurns: TURNS.build, isDone: (reply) => publishedFrom(reply).live },
    );
    const published = publishedFrom(built);
    if (published.live) this.say?.(`  live: ${published.url}`);
    else this.say?.("  could not confirm it went live — carrying on, and saying so in the write-up");

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

    // The analysis reads what the surveys agent wrote, not its envelope.
    const analysis = await this.brain.analyse(this.objective, roundNumber, textOf(results));
    this.say?.(`  read them: ${analysis.reasoning}`);
    (analysis.findings ?? []).forEach((f) => this.say?.(`    • ${f}`));

    const round = {
      round: roundNumber,
      plan,
      survey_url: published.live ? published.url : null,
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
      // Whatever went wrong, the rounds that did finish are real evidence and
      // the money for them is already spent. Stop, keep them, and still write
      // the recommendation and RUN.md — a crash here would throw all of it
      // away. The stack goes in the log so the cause is not lost either.
      stopped = error instanceof BudgetExhausted ? "budget" : error instanceof FlashpointError ? "flashpoint" : "error";
      this.say?.(`\n  stopped: ${error.message}`);
      await this.log?.({ type: "stopped", reason: stopped, message: error.message, stack: error.stack });
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
