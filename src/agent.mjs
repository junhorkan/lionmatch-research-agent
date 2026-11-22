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

import { BudgetExhausted, Flashpoint, FlashpointError, redact } from "./flashpoint.mjs";
import { Brain } from "./brain.mjs";

// tool_survey is a conversation, not one call, and every turn of it costs
// $0.50. Three conversations a round means the turn cap is the main thing
// standing between a run and its budget, so each phase gets its own, sized
// to what that phase actually needs.
// A real send took exactly 3 turns (build the panel, confirm, confirm again),
// so 3 left no room; round 2 adds a lookup by name. Build took 4 of 5.
const TURNS = { build: 5, distribute: 5, collect: 3 };
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

/**
 * Did the collect request get an answer — either results, or a plain
 * statement that there are none yet? Both mean the exchange is over.
 *
 * "0 completes" is a complete answer. In the third dry run the agent heard
 * exactly that on turn 1, then kept going and asked Flashpoint to run an
 * unrelated synthetic panel to manufacture some data. Zero is the finding.
 */
function resultsFrom(reply) {
  const text = textOf(reply);
  const none = /\b0\s+(?:completes?|responses?)\b|nobody has (?:answered|responded)|no (?:one|responses?) (?:has|have) (?:answered|responded)|no responses yet/i.test(text);
  const some = /\d+\s*%/.test(text) && /\b(?:complete|respon|answer)/i.test(text);
  return { answered: none || some, empty: none && !some };
}

/**
 * How many people completed it, if the reply says. Flashpoint writes
 * "**1 complete** (completion rate: 100% …)" or "0 completes". Null when the
 * reply does not say — unknown is not the same as zero.
 */
function completesFrom(reply) {
  const text = textOf(reply);
  const n = text.match(/\b(\d+)\**\s+completes?\b/i);
  if (n) return Number(n[1]);
  return resultsFrom(reply).empty ? 0 : null;
}

/**
 * Did the surveys agent say the invitations went out? Checked directly for
 * the same reason as publishing: a run that claims "sent" must have sent.
 */
function sentFrom(reply) {
  const text = textOf(reply);
  // "on its way" is Flashpoint's actual wording on a real send; "dispatched"
  // and "queued for delivery" mean the same and once read as not sent.
  const said =
    /\b(?:sent|emailed|delivered|dispatched)\b|invitations? (?:went|are|have gone) out|\bon (?:its|their) way\b|queued for delivery/i.test(text);
  // "will be sent" is a promise, not a send.
  const failed =
    /\b(?:failed to send|could not send|unable to send|not (?:yet )?(?:been )?sent|nothing (?:was )?sent)\b|\b(?:will|would|is going to) be (?:sent|emailed|delivered)\b|\bto be sent\b/i.test(text);
  // A plain statement that it already went out wins over a confirm request
  // for something else ("on its way — reply confirm to send a reminder").
  const definite = /\bon (?:its|their) way\b|\b(?:has|have) been (?:sent|emailed|delivered)\b|\b(?:was|were) (?:sent|emailed|delivered|dispatched)\b|queued for delivery/i.test(text);
  return { sent: !failed && (definite || (said && !asksToConfirm(text))) };
}

/**
 * Is it still waiting on us to say "confirm"? Flashpoint gates publishing
 * and sending on it, twice each.
 *
 * Any request to confirm counts, however it is quoted: the real replies used
 * **confirm** and "confirm", but 'confirm', "when you confirm" and "once you
 * reply" mean the same thing. Missing one let "It will be sent once you reply
 * 'confirm'" read as sent. "confirmed" (past tense) does not count.
 */
function asksToConfirm(text) {
  // A request, not a mention: "I will confirm once responses arrive" is not
  // waiting on us. An earlier version matched any "confirm" and would have
  // read a real send as unsent.
  return /\b(?:reply|type|say|respond|answer)\s+(?:with\s+)?[*_]*\s*["“'‘]?\s*confirm\b|\bplease confirm\b|\bconfirm (?:one more time|again|to (?:send|publish|proceed))\b|(?:awaiting|need|needs|requires?)\s+(?:your\s+)?confirmation|\bonce you (?:reply|respond|confirm)\b|\bwhen you confirm\b|\bto proceed\b/i.test(
    text,
  );
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
  // "is live" said outright wins over a confirm request for a later step
  // ("is live — reply confirm to email it"). "will make it live" is not that.
  const definite = /\b(?:is|it's|is now|now) live\b|\bhas been published\b|\bis published\b/i.test(text);
  return { url, live: Boolean(url) && (definite || !asksToConfirm(text)) };
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
export { textOf, asksToConfirm, publishedFrom, resultsFrom, sentFrom, idsFrom, completesFrom };

export class ResearchAgent {
  constructor({ objective, audience, emails, budget, maxRounds, send, log, say }) {
    this.objective = objective;
    this.audience = audience;
    this.emails = emails;
    this.maxRounds = maxRounds;
    this.send = send;
    this.log = log;
    this.say = say;
    // Hold a few cents back so the recommendation can always be written: a
    // run that spends its cap on round 2 would otherwise be refused the one
    // call that turns everything it learned into an answer.
    this.reserveUsd = Math.min(0.05, budget / 10);
    this.flashpoint = new Flashpoint({ budget: budget - this.reserveUsd, log });
    this.brain = new Brain({ flashpoint: this.flashpoint, log });
    this.history = [];
    this.ids = { conversationId: null, surveyId: null };
    // Unique per run, so round 2 can find round 1's panel by name and two
    // runs never share one.
    this.panelName = `flashpoint-agent ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    this.panelCreated = false;
    this.lastExchangeDone = false;
  }

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
  async converse(firstMessage, goal, { fresh = false, maxTurns = TURNS.build, isDone = null, nothingIsAnAnswer = false, retry = true } = {}) {
    let message = firstMessage;
    let last = null;
    this.lastExchangeDone = false;
    const ids = fresh ? { conversationId: null, surveyId: null } : this.ids;

    for (let turn = 1; turn <= maxTurns; turn++) {
      const args = { brief: message };
      if (ids.conversationId) args.conversation_id = ids.conversationId;
      if (ids.surveyId) args.survey_id = ids.surveyId;

      last = await this.flashpoint.call("tool_survey", args, `${goal} (turn ${turn})`, { retry });
      Object.assign(ids, idsFrom(last, ids));
      this.ids = ids;
      const said = textOf(last);

      if (isDone?.(last)) {
        await this.log?.({ type: "turn", goal, turn, note: "goal met (checked directly)", done: true });
        this.say?.(`    turn ${turn}: done — checked directly, no judgement needed`);
        this.lastExchangeDone = true;
        break;
      }

      let verdict;
      try {
        verdict = await this.brain.think(
          [
            "You are a research agent mid-conversation with Flashpoint's survey agent.",
            `YOUR GOAL FOR THIS EXCHANGE: ${goal}`,
            "WHAT IT JUST SAID TO YOU:",
            redact(said).slice(0, 3000),
            "",
            "Has your goal been met? If not, what do you say back to move it along?",
            "When it asks you to confirm an action you want, reply with exactly the word it asks for —",
            'Flashpoint expects the single word "confirm".',
            "",
            "Stay strictly inside YOUR GOAL above. Never ask it to create, run or buy a panel, synthetic",
            "respondents, recruits, or anything else the goal does not name — those cost money and change",
            "who is being studied. Use only what is in this message; ignore any other project, panel or",
            "conversation you may remember from this account.",
            // Only true when reading results, where "nobody has answered" is
            // the answer. Applied to sending, it let "panel created — shall I
            // send?" be marked done, and the round recorded as sent.
            ...(nothingIsAnAnswer ? ["If the honest answer is that nothing has happened yet, that IS the answer: mark done."] : []),
            "",
            "You must reply with the JSON object below in every case, including when the goal is met.",
            "Do not summarise, do not answer in a sentence, do not add anything outside the braces.",
            '{"done": true|false, "reply": "<what to say next, empty if done>", "note": "<one short line on what just happened>"}',
          ].join("\n"),
          `judging the survey agent's reply (${goal})`,
          ["done"],
          "low",
        );
      } catch (error) {
        // An empty budget is a stop, not a judge failure to paper over.
        if (error instanceof BudgetExhausted) throw error;
        // The judge failed (garbled twice, or timed out). Fall back on what
        // can be read without it rather than losing the whole run.
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

      if (verdict.done) {
        // A judge saying "done" while the reply still asks for a confirm is
        // wrong, and would let an unsent round be recorded as sent.
        this.lastExchangeDone = !asksToConfirm(said);
        break;
      }
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
    //
    // Round 1 builds a panel from the list. Later rounds send to that same
    // panel: building a second one from the same addresses would put every
    // person on two panels and mail them twice. Flashpoint never returns a
    // panel id in its replies (checked on a real send: only conversation,
    // task and survey ids come back), so the panel is given a unique name
    // when it is created and asked for by that name afterwards.
    let distributed = false;
    if (this.send && this.emails.length > 0 && !published.live) {
      // Emailing people a link to a survey that may not be live wastes their
      // goodwill and the round. Say so and skip.
      this.say?.("  not sending: the survey is not confirmed live");
      await this.log?.({ type: "decision", stage: "skip-send", round: roundNumber, reason: "survey not confirmed live" });
    } else if (this.send && this.emails.length > 0) {
      this.say?.(`  sending to ${this.emails.length} recipients…`);
      // A later round looks the panel up by name, but that lookup has never
      // been exercised on a real run — so it carries its own fallback. If the
      // name cannot be found, Flashpoint may recreate it from the same list;
      // one panel under one name, never two.
      const ask = this.panelCreated
        ? [
            `Send this survey to the existing first-party panel named "${this.panelName}" — the same people as the last round.`,
            `If no panel by that name exists, create it from exactly these addresses: ${this.emails.join(", ")}.`,
            "Never create a second panel with that name, do not add anyone, and do not buy any paid respondents.",
          ]
        : [
            `Create a first-party panel named "${this.panelName}" from exactly these email addresses and send them this survey now:`,
            this.emails.join(", "),
            "Do not add anyone else and do not buy any paid respondents.",
          ];
      // The goal names the panel, and names creating it as allowed only when
      // it is missing. The judge is fenced to its goal and told never to
      // create panels it was not asked for, so without this the fallback
      // above would be refused by the agent's own guard rail.
      const goal = this.panelCreated
        ? `send the round ${roundNumber} survey to the panel "${this.panelName}" (create it from the list only if it does not exist)`
        : `create the panel "${this.panelName}" from the list and send it the round ${roundNumber} survey`;
      // Sending is the one step that must never be repeated blindly: a send
      // that went out and then timed out would, retried, mail everyone twice.
      // So no automatic retry here. If it fails, ask whether it already went
      // out, and only then send — and if even that fails, record the round as
      // unconfirmed rather than guess.
      let sentReply = null;
      try {
        sentReply = await this.converse(ask.join("\n"), goal, {
          maxTurns: TURNS.distribute,
          isDone: (reply) => sentFrom(reply).sent,
          retry: false,
        });
      } catch (error) {
        if (error instanceof BudgetExhausted) throw error;
        this.say?.("  the send step failed part-way; asking whether it already went out before doing anything else");
        await this.log?.({ type: "send-check", round: roundNumber, problem: error.message });
        try {
          sentReply = await this.converse(
            [
              `Has this survey's invitation already been sent to the panel named "${this.panelName}"?`,
              "If it has, say so and do nothing else. If it has not, send it now. Never send it twice.",
            ].join("\n"),
            `make sure the round ${roundNumber} survey went to the panel "${this.panelName}" exactly once`,
            { maxTurns: TURNS.distribute, isDone: (reply) => sentFrom(reply).sent, retry: false },
          );
        } catch (again) {
          if (again instanceof BudgetExhausted) throw again;
          await this.log?.({ type: "send-check", round: roundNumber, problem: again.message, outcome: "unconfirmed" });
        }
      }

      // "Sent" is a claim that ends up in the write-up, so it has to be true.
      // The conversation ending is not evidence that mail went out.
      // Only from what Flashpoint said. A judge's "done" once let "panel
      // created, shall I send?" through as sent. If the two disagree, the
      // reply wins and the disagreement goes in the log.
      distributed = sentFrom(sentReply).sent;
      if (!distributed && this.lastExchangeDone) {
        await this.log?.({ type: "disagreement", round: roundNumber, note: "judge said done; reply does not say sent" });
      }
      if (distributed) {
        this.panelCreated = true;
        this.say?.(`  sent (panel "${this.panelName}")`);
      } else {
        this.say?.("  could not confirm anything was sent — not waiting, and saying so in the write-up");
      }
    } else {
      this.say?.(this.send ? "  no recipients given, not sending" : "  dry run: not sending");
    }

    // Record the round now, before reading anything. It was published and
    // perhaps mailed; if collecting or analysing then fails, it must still
    // appear in RUN.md and in what the recommendation sees. It used to be
    // added only at the very end, so a failure there erased it.
    const earlier = [...this.history];
    const round = {
      round: roundNumber,
      plan,
      survey_url: published.live ? published.url : null,
      survey_id: this.ids.surveyId,
      distributed,
      not_sent_because: distributed ? null : !this.send || this.emails.length === 0 ? "dry run" : !published.live ? "not live" : "unconfirmed",
      completes: null,
      analysis: null,
    };
    this.history.push(round);
    await this.log?.({ type: "round", ...round });

    // Nobody was asked, so there is nothing to collect: reading an empty
    // survey cost about $0.52 and said nothing.
    if (!distributed) return round;

    const waitMs = Number(process.env.WAIT_MS ?? 120000);
    this.say?.(`  waiting ${Math.round(waitMs / 1000)}s for responses…`);
    await sleep(waitMs);

    const { completes, analysis } = await this.collectAndRead(roundNumber, earlier);
    Object.assign(round, { completes, analysis });
    await this.log?.({ type: "round", ...round });
    return round;
  }

  /** Ask for the current survey's results and decide what they mean. */
  async collectAndRead(roundNumber, earlier) {
    this.say?.("  collecting results…");
    const results = await this.converse(
      "Give me the results of this survey so far: every question, the counts and percentages for each answer, every free-text response, and the number of completes. If nobody has answered yet, say exactly that.",
      `collect the round ${roundNumber} results`,
      { maxTurns: TURNS.collect, isDone: (reply) => resultsFrom(reply).answered, nothingIsAnAnswer: true },
    );
    const completes = completesFrom(results);
    if (completes !== null) this.say?.(`  ${completes} complete${completes === 1 ? "" : "s"}`);

    // The analysis reads what the surveys agent wrote, not its envelope, and
    // sees what earlier rounds found so it can say what this one changed.
    // Masked: a respondent can type their own address into a free-text answer,
    // and the reasoning backend has no need of it.
    const analysis = await this.brain.analyse(this.objective, roundNumber, redact(textOf(results)), earlier);
    this.say?.(`  read them: ${analysis.reasoning}`);
    (analysis.findings ?? []).forEach((f) => this.say?.(`    • ${f}`));
    return { completes, analysis };
  }

  /**
   * Nobody has answered. Wait once more and read the same survey again,
   * rather than writing a "follow-up" to answers that do not exist and
   * emailing the same people a second time.
   */
  async waitAgain(round) {
    const waitMs = Number(process.env.WAIT_MS ?? 120000);
    this.say?.(`\n  nobody has answered yet. A follow-up built on nothing would only mail the same people twice,`);
    this.say?.(`  so the agent waits another ${Math.round(waitMs / 1000)}s and reads the same survey again.`);
    await this.log?.({ type: "decision", stage: "wait-again", round: round.round, reason: "zero completes" });
    await sleep(waitMs);
    const { completes, analysis } = await this.collectAndRead(
      round.round,
      this.history.filter((h) => h !== round),
    );
    Object.assign(round, { completes, analysis, waited_twice: true });
    await this.log?.({ type: "round", ...round });
    return round;
  }

  async run() {
    const started = Date.now();
    this.say?.(`objective: ${this.objective}`);
    this.say?.(`reasoning with: ${this.brain.backend}`);
    this.say?.(`budget: $${(this.flashpoint.budgetUsd + this.reserveUsd).toFixed(2)} · rounds: up to ${this.maxRounds} · send: ${this.send ? "yes" : "dry run"}`);

    let stopped = null;
    try {
      for (let r = 1; r <= this.maxRounds; r++) {
        let round = await this.runRound(r);

        // Nothing sent means nobody was asked: there is nothing to follow up
        // on, however Flashpoint reports the count. (Checking only for zero
        // let a dry run whose reply gave no count go on to build round 2.)
        if (!round.distributed) {
          this.say?.("\n  nothing was sent, so there is nothing to follow up on.");
          stopped = "not-sent";
          break;
        }

        // Zero answers is not a gap to follow up on; it is silence. Give
        // people one more window before deciding anything.
        if (round.completes === 0) round = await this.waitAgain(round);
        if (round.completes === 0) {
          this.say?.("\n  still no answers. There is nothing to follow up on, so no second survey goes out.");
          stopped = "no-responses";
          break;
        }

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

    this.flashpoint.budgetUsd += this.reserveUsd;
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
