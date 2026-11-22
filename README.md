# flashpoint-agent

Give it one objective. It decides what survey would settle that objective, has the Flashpoint
MCP build and publish it, emails it to a list you supply, reads the answers back, judges whether
they are enough, writes a follow-up round aimed at whatever it could not answer, and commits to a
recommendation. No question text, no analysis template and no stopping rule is written anywhere in
this repo — all four are produced by the model at run time.

Team **LionMatch** (Alex, Jun, Max, Peter, Ayan) — Columbia AI Club MCP Challenge, judged 22
November 2026. (Our main-hackathon project, which placed 3rd, is a separate opportunity-matching
app: github.com/4amGrind/LionMatch. This is not that.)

---

## 1. What the agent does and how to run it

```
objective ──▶ Brain.planFirstRound ──▶ ResearchAgent.converse ──▶ tool_survey builds + publishes
                  (writes the                  (negotiates with                      │
                   questions)                   the survey agent)                    ▼
                                                                            distribute to list
                                                                             (only with --send)
                                                                                     │
      ┌──────────────────────────────────────────────────────────────────────────── collect
      │                                                                                │
      ▼                                                                                ▼
Brain.planFollowUp ◀── enough_to_answer: false ──── Brain.analyse ◀────────── results
                                                          │
                                        enough_to_answer: true, or rounds spent
                                                          │
                                                          ▼
                                                   Brain.recommend ──▶ runs/<stamp>/RUN.md
```

### Setup

```bash
npm install
cp .env.example .env
# put a Base-mainnet wallet key holding USDC in FLASHPOINT_WALLET_KEY
```

`.env` is gitignored and must never be committed. The only other variable is the optional
`ANTHROPIC_API_KEY` (below). `runs/` is **not** ignored — the logs are the evidence, so they are
committed on purpose.

### Run

```bash
node run.mjs --objective "Figure out the best event to run next spring" \
             --audience "Columbia undergraduates in the AI Club" \
             --emails me@example.com,friend@example.com \
             --rounds 2 --budget 8 --send
```

| flag | meaning |
|---|---|
| `--objective` | the one high-level goal. Required; without it the agent prints usage and exits 1 |
| `--audience` | who should answer. Default: `the people on the invitation list` |
| `--emails` | comma- or space-separated recipients who agreed to hear from you. Anything that fails address validation is silently dropped |
| `--rounds` | **maximum** survey rounds, default 2. The agent routinely uses fewer |
| `--budget` | hard USD cap, default 8 |
| `--wait` | seconds to wait for replies before collecting, default 120 |
| `--send` | actually email people. Off by default |
| `--help` | usage |

**Without `--send`** the agent does everything except put mail in front of a human: it writes the
survey, pays Flashpoint to build and publish it at a real public URL, collects whatever results
exist (skipping the wait, since nothing was sent), analyses them and writes a recommendation. A dry
run therefore costs money and produces a live survey, but mails nobody. Passing `--send` with no
valid `--emails` degrades to a dry run and says so.

### Where the decisions actually are

Five places, all traceable in the source:

- **`Brain.planFirstRound`** (`src/brain.mjs:73`) is handed the objective and audience and nothing
  else. It returns the survey title, 5–8 questions with types and options, its own `reasoning`, and
  a `success_looks_like` prediction. There is no question bank, template or fixture in this repo —
  `grep -rn "questions" run.mjs src/*.mjs` returns only the JSON schema inside the prompts and the
  code that formats whatever came back.
- **`Brain.analyse`** (`src/brain.mjs:101`) reads the results and returns `findings`, `surprises`
  (things that contradict what it assumed when it wrote the questions), `gaps`, and a boolean
  `enough_to_answer` it has to justify.
- **The loop in `ResearchAgent.run`** (`src/agent.mjs:200`) is controlled by that boolean. If the
  agent says it has enough, the run stops early with `stopped: "answered"` and unspent budget.
- **`Brain.planFollowUp`** (`src/brain.mjs:126`) gets the full history and is told not to repeat
  itself: round two chases one named gap or surprise from round one, and declares which.
- **`ResearchAgent.converse`** (`src/agent.mjs:79`) is a real conversation, not a script. Flashpoint's
  survey agent replies in prose; the brain reads each reply and returns `{done, reply, note}`,
  deciding whether the goal is met and what to say next, for up to 7 turns.

### How it reasons

Two backends. By default the reasoning *is* an MCP call: `Brain.think` routes to the Flashpoint
`chat` tool at $0.01 a time, so every decision the agent makes — every plan, every verdict on a
survey-agent reply, the final recommendation — lands in the same payment ledger as the research
itself. Set `ANTHROPIC_API_KEY` and it reasons with Claude instead, which is sharper but spends
outside the MCP and so is invisible to the ledger. The run log and `RUN.md` both record which
backend was used.

### How it pays

x402 with EIP-3009. The wallet signs an authorisation *message*, not a transaction; Flashpoint's
facilitator submits it and pays the gas. That is why this wallet holds only USDC and has never
needed ETH. When a response carries a `payment-response` header the agent decodes it into a
basescan link and files it under `receipts`, which `RUN.md` prints as a table.

### Guard rails

This spends real money and emails real people.

- `Flashpoint.call` checks the price against the remaining budget *before* connecting and raises
  `BudgetExhausted` rather than overspending; `spentUsd` increments only after a call succeeds.
- Sending is opt-in at the command line. With `--send` the run prints
  `SENDING IS ON. N people will get real email. Ctrl-C now if that is wrong.` and pauses five
  seconds first.
- The distribution brief tells the survey agent to use exactly the addresses given and to buy no
  paid respondents.
- `redact()` in `src/flashpoint.mjs:74` walks every outgoing tool argument and rewrites email
  addresses to `<address at domain.com>` before they reach the log.

### What it produces

`runs/<timestamp>/log.jsonl` — one JSON object per line, every call, decision, price and receipt —
and `runs/<timestamp>/RUN.md`, the readable write-up. The entry types are `start`, `call`, `result`,
`decision`, `turn`, `round`, `stopped` and `finish`; every line carries an `at` timestamp. The shape
(model output elided):

```jsonl
{"at":"…","type":"start","objective":"…","audience":"…","recipients":2,"budget":8,"maxRounds":2,"send":true,"wallet":"0x…","openingBalance":12.5}
{"at":"…","type":"call","tool":"chat","why":"deciding what to ask in round 1","price":0.01,"args":{"message":"…"}}
{"at":"…","type":"decision","stage":"plan","round":1,"decision":{"reasoning":"…","title":"…","questions":[…],"success_looks_like":"…"}}
{"at":"…","type":"result","tool":"tool_survey","price":0.5,"receipt":"https://basescan.org/tx/0x…","seconds":41.2,"spentUsd":0.52,"result":"…"}
{"at":"…","type":"turn","goal":"create and publish the round 1 survey","turn":2,"note":"…","done":true}
{"at":"…","type":"round","round":1,"plan":{…},"survey_url":"…","survey_id":"…","distributed":true,"analysis":{"findings":[…],"gaps":[…],"enough_to_answer":false,"reasoning":"…"}}
{"at":"…","type":"finish","spentUsd":2.04,"calls":14,"receipts":[…],"minutes":9.3,"stopped":"answered"}
```

---

## 2. The high-level objective given to it

<!-- FILLED IN AFTER THE LIVE RUN -->

The exact `--objective` string, `--audience`, recipient count and flags, copied from the `start`
line of the run log. Nothing is written here before the run, because the agent's output is only
worth anything if the input was not reverse-engineered from it.

See `runs/<timestamp>/RUN.md`.

---

## 3. What the agent decided

<!-- FILLED IN AFTER THE LIVE RUN -->

Round by round, from the log: the questions it wrote and the `reasoning` it gave for writing them,
the published survey URL, what it made of the answers, whether it judged them sufficient and why,
the follow-up round it chose (and which specific gap it chased), its final recommendation with
confidence and caveats, and the payment table with basescan receipts.

`RUN.md` is generated in exactly this shape by `run.mjs`, so this section will be that file's
contents rather than a retelling of it.

See `runs/<timestamp>/RUN.md` and `runs/<timestamp>/log.jsonl`.
