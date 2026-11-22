// The Claude backend failing mid-run. The hackathon's Anthropic keys share one
// organisation limit that teams were warned they might hit; a run that has
// already mailed people must not stop because of it. Claude and Flashpoint
// are both faked: nothing leaves this machine.
//   node test/backend-fallback.test.mjs
import Anthropic from "@anthropic-ai/sdk";

process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
const { Brain } = await import("../src/brain.mjs");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "ok   " : "WRONG"}  ${name}${detail ? `  (${detail})` : ""}`);
};

function setup(claudeReplies) {
  const seen = { claude: 0, chat: 0, logs: [], said: [] };
  const flashpoint = {
    call: async () => {
      seen.chat++;
      return { conversation_id: "c", reply: '{"answer": "from chat"}' };
    },
  };
  const brain = new Brain({ flashpoint, log: async (e) => seen.logs.push(e), say: (l) => seen.said.push(l) });
  brain.anthropic = {
    beta: {
      messages: {
        create: async () => {
          const next = claudeReplies[Math.min(seen.claude, claudeReplies.length - 1)];
          seen.claude++;
          if (next instanceof Error) throw next;
          return { stop_reason: "end_turn", content: [{ type: "text", text: next }] };
        },
      },
    },
  };
  return { brain, seen };
}

const limit = new Anthropic.RateLimitError(429, { type: "error", error: { type: "rate_limit_error", message: "org usage limit" } }, "org usage limit", new Headers());

// 1. Usage limit: the decision still comes back, through chat.
{
  const { brain, seen } = setup([limit]);
  check("starts on Claude", brain.useClaude && brain.backend.startsWith("claude"));
  const d = await brain.think("decide", "test decision", ["answer"]);
  check("a usage limit still yields a decision", d.answer === "from chat", JSON.stringify(d));
  check("it came from Flashpoint chat, asked once", seen.chat === 1, `chat calls ${seen.chat}`);
  check("the switch is in the backend name RUN.md prints", /switched from claude/.test(brain.backend), brain.backend);
  check("the switch is logged", seen.logs.some((e) => e.type === "backend-switch"));
  check("and said on screen", seen.said.some((l) => /Claude unavailable/.test(l)));
  await brain.think("decide again", "second decision", ["answer"]);
  check("later decisions skip Claude entirely", seen.claude === 1 && seen.chat === 2, `claude ${seen.claude}, chat ${seen.chat}`);
}

// 2. A connection failure is treated the same way.
{
  const { brain, seen } = setup([new Anthropic.APIConnectionError({ message: "connection reset" })]);
  const d = await brain.think("decide", "test decision", ["answer"]);
  check("a dropped connection falls back too", d.answer === "from chat" && seen.chat === 1);
}

// 3. A garbled reply is not an outage: Claude is asked again, no switch.
{
  const { brain, seen } = setup(["here are my thoughts, no JSON", '{"answer": "from claude"}']);
  const d = await brain.think("decide", "test decision", ["answer"]);
  check("a garbled reply is retried on Claude", d.answer === "from claude" && seen.claude === 2 && seen.chat === 0);
  check("and the backend is unchanged", brain.useClaude && !/switched/.test(brain.backend));
}

// 4. Working Claude never touches the wallet.
{
  const { brain, seen } = setup(['{"answer": "from claude"}']);
  const d = await brain.think("decide", "test decision", ["answer"]);
  check("a working key costs no Flashpoint call", d.answer === "from claude" && seen.chat === 0);
}

const pass = results.every(Boolean);
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
