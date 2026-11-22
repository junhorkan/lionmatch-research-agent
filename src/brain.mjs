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

const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5";

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
   */
  constructor({ flashpoint, log }) {
    this.flashpoint = flashpoint;
    this.log = log;
    this.useClaude = Boolean(process.env.ANTHROPIC_API_KEY);
    this.backend = this.useClaude ? `claude (${CLAUDE_MODEL})` : "flashpoint chat";
  }

  async think(prompt, why) {
    const reply = this.useClaude ? await this.#askClaude(prompt) : await this.#askFlashpoint(prompt, why);
    return extractJson(reply);
  }

  async #askFlashpoint(prompt, why) {
    return this.flashpoint.call("chat", { message: prompt }, why);
  }

  async #askClaude(prompt) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Claude returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    return body.content?.map((b) => b.text ?? "").join("") ?? "";
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
    const decision = await this.think(prompt, "deciding what to ask in round 1");
    await this.log?.({ type: "decision", stage: "plan", round: 1, decision });
    return decision;
  }

  /** Read the results and say honestly whether they settle anything. */
  async analyse(objective, round, results) {
    const prompt = [
      "You are a research agent reading back the results of a survey you designed yourself.",
      "Be strict. Small samples do not support confident claims, and you must say so.",
      "",
      `OBJECTIVE: ${objective}`,
      `ROUND: ${round}`,
      "RESULTS:",
      typeof results === "string" ? results : JSON.stringify(results, null, 2),
      "",
      "Reply with JSON only:",
      "{",
      '  "findings": ["<specific thing the data shows, with the number attached>"],',
      '  "surprises": ["<anything that contradicts what you assumed when you wrote the questions>"],',
      '  "gaps": ["<what you still cannot answer, and why>"],',
      '  "enough_to_answer": true|false,',
      '  "reasoning": "<2-3 sentences justifying that true or false>"',
      "}",
    ].join("\n");
    const decision = await this.think(prompt, `reading round ${round} results`);
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
      "",
      "Reply with JSON only:",
      "{",
      '  "reasoning": "<2-3 sentences: which gap or surprise from the last round you are chasing, and why that one>",',
      '  "title": "<short survey title>",',
      '  "questions": [{"text": "<question>", "type": "single|multi|scale|open", "options": ["..."]}],',
      '  "what_would_change_my_answer": "<one sentence>"',
      "}",
    ].join("\n");
    const decision = await this.think(prompt, "deciding what to ask in the follow-up round");
    await this.log?.({ type: "decision", stage: "plan", round: history.length + 1, decision });
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
    const decision = await this.think(prompt, "writing the final recommendation");
    await this.log?.({ type: "decision", stage: "recommend", decision });
    return decision;
  }
}
