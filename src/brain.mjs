// Where the agent decides things.
//
// Four decisions, in order: what to ask in round one, what the answers mean,
// what is still missing, and what to tell the human at the end. Nothing in
// here is scripted — the questions that go into a survey are written by the
// model at run time from the objective it was handed.
//
// Two backends. By default the reasoning itself runs through the Flashpoint
// MCP's `chat` tool, so every thought the agent has is a paid call and shows
// up in the same ledger as the research. Set ANTHROPIC_API_KEY and it reasons
// with Claude instead, which is sharper but spends outside the MCP.
//
// The two are not alike, and the difference bit us. `chat` is not a plain
// model: it is Flashpoint's orchestrator, with its own tools and a memory of
// everything this wallet has ever done. Asked to think, it sometimes acts —
// in one dry run it tried to run a synthetic panel from a different project,
// and in another it hung for minutes trying to. So on that backend every
// prompt opens with REASONING_ONLY, and the run treats facts it can check
// itself (is the survey live? are there results?) as facts, not questions.

import Anthropic from "@anthropic-ai/sdk";
import { BudgetExhausted, FlashpointError } from "./flashpoint.mjs";

const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5";

const REASONING_ONLY = [
  "THIS IS A REASONING REQUEST, NOT A TASK.",
  "Do not call any tool. Do not create, publish, send, run or look up any survey, panel or study.",
  "Do not use anything you remember from earlier conversations or other projects on this account.",
  "Work only from the text below, and reply with only the JSON object it asks for.",
  "",
].join("\n");

/** Pull the first JSON object out of a reply that may be wrapped in prose. */
function extractJson(raw) {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text.match(/\{[\s\S]*\}/)?.[0], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate.trim());
    } catch {
      // try the next shape
    }
  }
  throw new Error(`Could not read a decision out of: ${text.slice(0, 400)}`);
}

export class Brain {
  /**
   * @param {object} o
   * @param {import("./flashpoint.mjs").Flashpoint} o.flashpoint
   * @param {(entry: object) => Promise<void>} o.log
   * @param {(line: string) => void} [o.say]
   */
  constructor({ flashpoint, log, say }) {
    this.flashpoint = flashpoint;
    this.log = log;
    this.say = say;
    this.useClaude = Boolean(process.env.ANTHROPIC_API_KEY);
    // The SDK reads ANTHROPIC_API_KEY itself; retries 429s, 5xx and dropped
    // connections twice; and gets its own ceiling so a stalled reply cannot
    // freeze the run any more than a stalled Flashpoint call can.
    this.anthropic = this.useClaude ? new Anthropic({ timeout: 120_000, maxRetries: 2 }) : null;
    this.backend = this.useClaude ? `claude (${CLAUDE_MODEL})` : "flashpoint chat";
  }

  /**
   * Ask for a decision and insist on getting one back in the shape we need.
   * A model that answers in prose, or drops a field, costs a cent to correct
   * — far better than a run dying halfway through a live demo.
   *
   * `effort` only matters on the Claude backend. Designing a survey and
   * weighing evidence deserve "high"; reading whether a reply said "confirm"
   * does not, and "low" keeps those checks quick.
   */
  async think(prompt, why, required = [], effort = "high") {
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const ask =
        attempt === 1
          ? prompt
          : `${prompt}\n\nYour previous reply could not be used: ${lastError}. Reply with the JSON object only — no explanation, no code fence, nothing before or after it.`;
      try {
        let raw;
        if (this.useClaude) {
          try {
            raw = await this.#askClaude(ask, effort);
          } catch (error) {
            if (!(error instanceof Anthropic.APIError)) throw error;
            // The key failed after the SDK's own retries: a usage limit, a
            // revoked key, an outage. The hackathon keys share one org limit
            // that teams were warned they might hit. A decision is still
            // needed, so make it through Flashpoint's chat for the rest of
            // the run rather than stop mid-study with people already mailed.
            await this.#dropClaude(error, why);
            raw = await this.#askFlashpoint(REASONING_ONLY + ask, why);
          }
        } else {
          raw = await this.#askFlashpoint(REASONING_ONLY + ask, why);
        }
        const decision = extractJson(raw);
        const missing = required.filter((key) => decision[key] === undefined);
        if (missing.length > 0) throw new Error(`missing field(s): ${missing.join(", ")}`);
        return decision;
      } catch (error) {
        // This loop exists to correct a garbled answer. A dead connection or
        // an empty budget is not that: the network layer has already retried
        // the call, and asking again here would multiply the wait — one hung
        // call became eight minutes before this line existed.
        if (error instanceof FlashpointError || error instanceof BudgetExhausted || error instanceof Anthropic.APIError) {
          throw error;
        }
        lastError = error.message;
        await this.log?.({ type: "retry", why, attempt, problem: lastError });
      }
    }
    throw new Error(`Could not get a usable decision for "${why}": ${lastError}`);
  }

  async #dropClaude(error, why) {
    const reason = `${error.status ?? error.name}${error.message ? `: ${String(error.message).slice(0, 160)}` : ""}`;
    this.useClaude = false;
    this.anthropic = null;
    this.backend = `flashpoint chat (switched from claude mid-run: ${reason})`;
    await this.log?.({ type: "backend-switch", why, from: "claude", to: "flashpoint chat", problem: reason });
    this.say?.(`  Claude unavailable (${reason}); reasoning through Flashpoint chat from here on`);
  }

  async #askFlashpoint(prompt, why) {
    const result = await this.flashpoint.call("chat", { message: prompt }, why);
    // chat answers as { conversation_id, reply }. The decision is in `reply`;
    // handing the whole envelope to the JSON reader finds the envelope.
    if (result && typeof result === "object") {
      return result.reply ?? result.response ?? result.message ?? result.text ?? result;
    }
    return result;
  }

  async #askClaude(prompt, effort) {
    // Opus 5.5 always thinks (adaptive); effort is the only dial, and its
    // default is "medium", so it is set explicitly. `fallbacks: "default"`
    // lets the API re-run a declined request on a fallback model inside the
    // same call, rather than this run stopping on a false-positive refusal.
    const response = await this.anthropic.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort },
      messages: [{ role: "user", content: prompt }],
    });
    if (response.stop_reason === "refusal") {
      throw new Error(`Claude declined (${response.stop_details?.category ?? "no category"})`);
    }
    return response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
  }

  /** Round one: turn a one-line objective into a survey worth running. */
  async planFirstRound(objective, audience) {
    const prompt = [
      "You are a research agent. You have been given one objective and a budget, and you must",
      "decide what to ask people to meet it. Nobody will correct you; whatever you write goes out.",
      "",
      `OBJECTIVE: ${objective}`,
      `AUDIENCE: ${audience}`,
      "",
      "Design a short survey that would actually settle this objective. Between 5 and 8 questions.",
      "Prefer multiple choice and rating scales over free text, because you must analyse the answers",
      "yourself afterwards. Include at least one open question so you can learn something you did",
      "not think to ask about. Do not ask for names or contact details.",
      "",
      "Reply with JSON only, no prose outside it:",
      "{",
      '  "reasoning": "<2-3 sentences: what has to be true for the objective to be met, and what you',
      '                therefore need to find out>",',
      '  "title": "<short survey title>",',
      '  "questions": [{"text": "<question>", "type": "single|multi|scale|open", "options": ["..."]}],',
      '  "success_looks_like": "<one sentence: what pattern in the answers would give you a clear answer>"',
      "}",
    ].join("\n");
    const decision = await this.think(prompt, "deciding what to ask in round 1", ["title", "questions", "reasoning"]);
    await this.log?.({ type: "decision", stage: "plan", round: 1, decision });
    return decision;
  }

  /** Read the results and say honestly whether they settle anything. */
  async analyse(objective, round, results, history = []) {
    // Earlier rounds, compressed to what they found, so this round can say
    // what it confirmed or overturned instead of being read in isolation.
    const earlier = history.map((r) => ({
      round: r.round,
      asked: r.plan?.title,
      completes: r.completes ?? null,
      findings: r.analysis?.findings ?? [],
      gaps: r.analysis?.gaps ?? [],
    }));
    const prompt = [
      "You are a research agent reading back the results of a survey you designed yourself.",
      "Be strict. Small samples do not support confident claims, and you must say so.",
      "",
      `OBJECTIVE: ${objective}`,
      `ROUND: ${round}`,
      ...(earlier.length
        ? ["WHAT EARLIER ROUNDS FOUND:", JSON.stringify(earlier, null, 2), ""]
        : []),
      // Without this the reasoning-only fence makes it distrust numbers it
      // cannot look up itself: a real run hedged every figure as "needs to be
      // re-fetched". These are the fetched figures.
      "RESULTS — fetched from Flashpoint moments ago. They are the real data; rely on the numbers as given:",
      typeof results === "string" ? results : JSON.stringify(results, null, 2),
      "",
      "Reply with JSON only:",
      "{",
      '  "findings": ["<specific thing the data shows, with the number attached>"],',
      '  "surprises": ["<anything that contradicts what you assumed when you wrote the questions>"],',
      ...(earlier.length
        ? ['  "changed_since_last_round": "<what this round confirmed or overturned from earlier rounds>",']
        : []),
      '  "gaps": ["<what you still cannot answer, and why>"],',
      '  "enough_to_answer": true|false,',
      '  "reasoning": "<2-3 sentences justifying that true or false>"',
      "}",
    ].join("\n");
    const decision = await this.think(prompt, `reading round ${round} results`, ["findings", "enough_to_answer"]);
    await this.log?.({ type: "decision", stage: "analyse", round, decision });
    return decision;
  }

  /** Round two onward: ask about what round one left open. */
  async planFollowUp(objective, history) {
    const prompt = [
      "You are a research agent. Your first survey is in and it did not fully settle the objective.",
      "Write the follow-up. Do not repeat questions you have already asked — the point of this round",
      "is to resolve what the last one left open, or to test an explanation for what you saw.",
      "",
      `OBJECTIVE: ${objective}`,
      "WHAT YOU HAVE LEARNED SO FAR:",
      JSON.stringify(history, null, 2),
      "",
      "Between 3 and 6 questions, shorter than last time — people are answering you twice.",
      "The same people answer every round, so never re-ask anything from an earlier round, background",
      "questions included (year, major, prior use): you already have those answers.",
      "",
      "Reply with JSON only:",
      "{",
      '  "reasoning": "<2-3 sentences: which gap or surprise from the last round you are chasing, and why that one>",',
      '  "title": "<short survey title>",',
      '  "questions": [{"text": "<question>", "type": "single|multi|scale|open", "options": ["..."]}],',
      '  "what_would_change_my_answer": "<one sentence>"',
      "}",
    ].join("\n");
    const decision = await this.think(prompt, "deciding what to ask in the follow-up round", ["title", "questions", "reasoning"]);
    await this.log?.({ type: "decision", stage: "plan", round: history.length + 1, decision });
    return decision;
  }

  /**
   * Too few answers. Remind, wait, or carry on — with the costs in front of
   * it, because a reminder can eat the budget round 2 needs.
   */
  async decideNudge(objective, { round, completes, recipients, remainingUsd, roundsLeft, waitSeconds }) {
    const prompt = [
      "You are a research agent. A survey you sent has had too few answers to learn much from yet.",
      "Decide what to do next. You have three options:",
      `- "remind": email a reminder to everyone who has not answered, then wait ${waitSeconds}s and read again.`,
      "  Costs about $2. Worth it if more answers would change what you can conclude, and you can afford it.",
      `- "wait": wait another ${waitSeconds}s without emailing anyone, then read again. Costs about $0.52.`,
      "  Better when people may simply not have had time yet, or a second email would be pushy.",
      '- "proceed": carry on with the answers you have. Costs nothing now. Only possible if at least one',
      "  person has answered.",
      "",
      `OBJECTIVE: ${objective}`,
      `ROUND: ${round} · ANSWERED: ${completes} of ${recipients} · BUDGET LEFT: $${remainingUsd.toFixed(2)}`,
      `ROUNDS STILL ALLOWED AFTER THIS ONE: ${roundsLeft} (a full round costs about $4, and none starts with less than $3.50 left)`,
      "",
      "Reply with JSON only:",
      '{"action": "remind"|"wait"|"proceed", "reasoning": "<one or two sentences, mentioning the cost trade-off>"}',
    ].join("\n");
    const decision = await this.think(prompt, `deciding how to handle too few answers in round ${round}`, ["action"]);
    await this.log?.({ type: "decision", stage: "nudge", round, decision });
    return decision;
  }

  /** The thing the human actually asked for. */
  async recommend(objective, history) {
    const prompt = [
      "You are a research agent delivering your answer to the person who set the objective.",
      "Answer the question they asked. Commit to a recommendation — 'more research is needed' is",
      "only acceptable if you say what specifically you would ask next and why it matters.",
      "State the evidence honestly, including how thin it is.",
      "",
      `OBJECTIVE: ${objective}`,
      "EVERY ROUND YOU RAN:",
      JSON.stringify(history, null, 2),
      "",
      "Reply with JSON only:",
      "{",
      '  "recommendation": "<your answer to the objective, 2-4 sentences, specific and actionable>",',
      '  "because": ["<the evidence behind it, each with its number>"],',
      '  "confidence": "high|medium|low",',
      '  "confidence_reason": "<one sentence, mentioning the sample size>",',
      '  "caveats": ["<what could make this wrong>"],',
      '  "next_question": "<the one thing you would ask if you had another round>"',
      "}",
    ].join("\n");
    const decision = await this.think(prompt, "writing the final recommendation", ["recommendation", "confidence"]);
    await this.log?.({ type: "decision", stage: "recommend", decision });
    return decision;
  }
}
