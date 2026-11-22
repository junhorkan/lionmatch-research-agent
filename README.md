# flashpoint-agent

Give it one objective and an email list. It writes its own survey and gets Flashpoint's surveys
agent to build and publish it. It emails the survey to the list, reads the answers and decides
whether they settle the objective. If they don't, it writes a follow-up aimed at what is still open
and sends that to the same people. Then it commits to a recommendation.

No survey question, analysis or stopping rule is written in this repo. The model produces them at
run time, and code checks the facts its decisions rest on.

Team **LionMatch** (Alex, Jun, Max, Peter, Ayan), Columbia AI Club MCP Challenge, judged 22
November 2026. (Our main-hackathon project, which placed 3rd, is a separate opportunity-matching
app: github.com/4amGrind/LionMatch. This is not that.)

---

## 1. What the agent does and how to run it

```
objective ─▶ Brain.planFirstRound ─▶ converse: build + publish ─▶ converse: create panel + send
             (writes the questions)   (answers "confirm" itself;    (only with --send and only if live;
                                       live = checked in code)       answers "confirm"; sent = checked)
                                                                               │
                                               nothing sent? stop ("not-sent") ◀┤
                                                                               ▼
  0 completes? wait once more, re-read ◀────── converse: collect ◀──── wait --wait seconds
  (still 0: stop, "no-responses")              (results = checked)
                         │
                         ▼
                  Brain.analyse (sees earlier rounds) ── enough_to_answer: true ──┐
                         │ false, rounds left                                     │
                         ▼                                                        ▼
                  Brain.planFollowUp ─▶ round 2: new survey, same named panel   Brain.recommend
                                                                                  ─▶ runs/<stamp>/RUN.md
```

### Setup

You need Node 22.19 or later (`undici` 8 requires it).

```bash
npm install
cp .env.example .env
# set FLASHPOINT_WALLET_KEY=0x<64 hex> to a Base-mainnet wallet holding USDC
```

- `.env` is gitignored, so never commit it. `run.mjs` loads it at start-up without overriding
  anything already set in the shell. Setting `ANTHROPIC_API_KEY` there switches on the optional
  Claude backend.
- `runs/` is committed on purpose: the logs are the evidence.
- Payment is x402. The wallet signs an EIP-3009 authorisation (a message, not a transaction), and
  Flashpoint pays the gas, so the wallet needs USDC but no ETH.

### Run

```bash
node run.mjs --objective "Figure out the best event to run next spring" \
             --audience "Columbia undergraduates in the AI Club" \
             --emails me@example.com,friend@example.com \
             --rounds 2 --budget 10 --wait 120 --send
```

| flag | meaning |
|---|---|
| `--objective` | the one high-level goal. Required; without it, prints usage and exits 1 |
| `--audience` | who should answer. Default `the people on the invitation list` |
| `--emails` | comma- or space-separated recipients who agreed to be contacted. Entries that are not addresses are left out, and the run says how many |
| `--rounds` | **maximum** survey rounds, a whole number from 1 to 5, default 2 |
| `--budget` | hard USD cap, 0.1–50, default 10 |
| `--wait` | seconds to wait after sending before reading results, 0–86400, default 120 |
| `--send` | actually email people. **Off by default** |
| `--help` | usage |

A malformed number or a missing wallet key stops the run before anything is created or spent.

**The default is a dry run.** Without `--send`, the agent still writes, builds and publishes the
survey, which costs money and leaves it live at a public URL. Then it stops with `not-sent` and
writes its recommendation. It sends nothing and reads no results.

Prices are $0.50 per `tool_survey` turn and $0.01 per `chat` call. The one complete round with a
real send cost $4.09 over 17 paid calls, so two rounds should come to about $8–9.

### Where the agent decides

- **It writes the questions from the objective alone.**
  - `Brain.planFirstRound` (`src/brain.mjs:139`) gets only the objective and audience.
  - It returns 5–8 typed questions, its `reasoning`, and a prediction of what success looks like.
  - There is no question bank. `grep -rn questions run.mjs src/` finds only the JSON shape inside
    prompts and the code that formats the answer.
- **It holds the conversation with Flashpoint's surveys agent.**
  - `converse` (`src/agent.mjs:178`) reads each reply and decides what to say back.
  - Publishing and sending each need two separate "confirm" replies. The agent gives all four
    itself (`src/agent.mjs:211`).
  - In the one real send, nobody typed anything after the command.
- **It judges the evidence.** `Brain.analyse` (`src/brain.mjs:167`) returns findings with numbers,
  surprises, gaps, and an `enough_to_answer` verdict it must justify.
- **It stops, waits, or follows up** (`src/agent.mjs:426`).
  - If it has enough, it stops early with budget left.
  - If not, `Brain.planFollowUp` (`src/brain.mjs:210`) gets the full history. It must name the gap
    it is chasing and not repeat earlier questions.
- **Round 2 learns from round 1.** Its analysis sees the earlier findings and must say what was
  confirmed or overturned (`src/brain.mjs:183`).
- **It commits to an answer.** `Brain.recommend` (`src/brain.mjs:236`) may say "more research is
  needed" only if it names the next question. It must give a confidence level and the sample size.

### Facts are checked in code; judgement goes to the model

Code, not the model, reads four facts from Flashpoint's replies: is the survey live, was it sent,
are there results, how many completes. The functions are `publishedFrom`, `sentFrom`, `resultsFrom`
and `completesFrom` (`src/agent.mjs:64–125`). The model decides what to say next, never whether a
fact is true. Each check replaced something that failed against the real system:

- **Live means the public URL is present, and either Flashpoint says outright that it is live or
  nothing is waiting on a confirm.**
  - In the dry runs, every publish reply contained the word "live", e.g. "publishing will make it
    live". A plain word match declared victory on turn 1.
- **Sent means Flashpoint said it was sent, and only `sentFrom` decides** (`src/agent.mjs:339`).
  - Flashpoint's real wording for a send is "Invitation is on its way".
  - "Will be sent" is a promise, not a send.
  - A request to confirm ("reply 'confirm'", "when you confirm"), however it is quoted, means
    nothing has gone out yet, unless the reply also says plainly that it already went ("on its
    way", "has been sent"). A mention is not a request: "I will confirm once responses arrive"
    does not block a send.
  - If the model judge says the send is done but the reply does not say so, the reply wins and a
    `disagreement` is logged.
- **"0 completes" counts as an answer.** In one dry run, the judge heard exactly that, then asked
  Flashpoint to run another project's panel to manufacture data. Now the judge is told that
  "nothing has happened yet is the answer" only while it reads results (`src/agent.mjs:221`).

### The reasoning backend

By default, every decision goes through the Flashpoint MCP's own `chat` tool, so each one is itself
a paid MCP call.

`chat` is not a plain model but Flashpoint's orchestrator, with tools and a memory of everything
this wallet has done. Asked to reason, it sometimes acts: in testing it reached for a panel from a
different project, and a recommendation call hung while it tried.

So every prompt on this backend opens with a `REASONING_ONLY` fence (`src/brain.mjs:26`): no tools,
no surveys or panels, nothing from other conversations, JSON only. Replies and results reach the
model with email addresses masked.

If `ANTHROPIC_API_KEY` is set, the agent reasons with Claude instead (`claude-opus-5-5` via the
official `@anthropic-ai/sdk`, `src/brain.mjs:116`). That spending happens outside the MCP ledger.
`RUN.md` records which backend ran.

### Silence is not a gap

If a sent round gets zero completes, the agent does not mail a "follow-up" to answers that don't
exist. It waits once more and re-reads the same survey (`src/agent.mjs:411`). If there are still
none, it stops with `no-responses`.

A round that sent nothing stops with `not-sent` and pays nothing to read an empty survey. RUN.md
says why it was not sent: dry run, not confirmed live, or send unconfirmed.

### Guard rails

- **Budget cap, checked before every call** (`src/flashpoint.mjs:215`).
  - A call is charged as soon as its payment receipt arrives, even if it then fails.
  - The cap is measured against a local price table, not the amount Flashpoint quotes.
  - A reserve of up to $0.05 is held back so the recommendation can always be written
    (`src/agent.mjs:155`).
- **`--send` is off by default.** With it, the run says how many people will be mailed and pauses
  five seconds for Ctrl-C. Nothing is emailed unless the survey is confirmed live.
- **Timeouts and tool failures are retried once.**
  - `chat` gets 2 minutes and `tool_survey` 5 minutes, covering the whole response, not just the
    headers.
  - A tool error reported inside an HTTP 200 counts as a failure. One dry run had parsed one as an
    answer.
  - A failed call is retried once on a fresh session, and both tries are charged
    (`src/flashpoint.mjs:189`).
  - A second failure stops the run cleanly. The exception is a failure while the model is judging
    a reply: there, code falls back to the facts it can read itself.
  - **Sending is never retried automatically.** A send that went out and then timed out would,
    retried, mail everyone twice. If a send fails, the agent asks Flashpoint whether it already
    went out and sends only if it did not; if that fails too, the round is recorded as unconfirmed.
- **Masking at the exit.** Every log line, every printed line and `RUN.md` pass through `redact()`,
  which writes `<address at domain>` (`run.mjs:118`, `:175`). Masking field by field had leaked an
  address on the first real send. Only Flashpoint, which sends the mail, sees real addresses.
- **One named panel across rounds** (`src/agent.mjs:162`).
  - Later rounds send to the same panel by name, and recreate it only if it is missing.
  - Briefs tell Flashpoint to add nobody and buy no paid respondents.
- **Turn caps per phase:** build 5, send 5, collect 3 (`src/agent.mjs:21`).
- **A round is recorded as soon as it is sent.** If reading its results fails, RUN.md still shows
  it, marked "sent, but the results were never read".

### Tests

None of these call Flashpoint or spend anything:

```bash
node test/control-flow.test.mjs       # decisions between rounds (faked): dry run stops, not enough
                                      # -> follow-up, enough -> stop, silence -> wait, silence twice
                                      # -> nothing more mailed; completes parsing
node test/guards.test.mjs             # bad flags refused before anything exists; tool errors raise,
                                      # retry once, stay charged; sends make exactly one attempt;
                                      # empty error fields ignored; the reserve; a sent round
                                      # survives a failure while being read
node test/wording.test.mjs            # 18 near-miss phrasings for "live" and "sent": future tense,
                                      # quoting styles, a mention of confirm vs a request for one
node test/publish-detection.test.mjs  # replays the 4 real publish replies (runs/2026-11-22T01-04-17):
                                      # only the 4th is live
node test/send-detection.test.mjs     # replays the 3 real send replies (runs/2026-11-22T01-20-38):
                                      # only "Invitation is on its way" is sent
node test/timeout.test.mjs            # real x402 wrapper vs a silent and a stalling local server
```

`test/brain-live.mjs` calls the real `chat` tool, capped at $0.10.

### How it was built

Every run against the live system surfaced a real failure. Each was fixed and, where possible,
pinned with a test that replays the real replies from `runs/`. Two independent reviews of the code
then tightened what decides "sent", retries and the budget. `git log` has each case.

Round 2 has not yet run against Flashpoint. Its control flow is covered by `test/control-flow`.

### What it produces

`runs/<stamp>/log.jsonl` (every event, price and receipt) and `runs/<stamp>/RUN.md` (the readable
write-up, with basescan receipts).

**Example only, not the judged run:** `runs/2026-11-22T01-20-38/RUN.md` is a one-round test sent to
a single recipient.

It wrote seven questions, published, emailed, and got one response for $4.09. It declined to
generalise from one answer and recommended collecting more before choosing, at low confidence. It
predates the fix telling the analysis to trust fetched figures, so its findings hedge every
number.

---

## 2. The high-level objective given to it

<!-- FILLED IN AFTER THE LIVE RUN -->

To be filled in from the `start` line of the judged run's log: the exact `--objective` and
`--audience`, the recipient count, and the flags. It is left empty until then, so the input cannot
be reverse-engineered from the output.

---

## 3. What the agent decided

<!-- FILLED IN AFTER THE LIVE RUN -->

To be filled in round by round from the judged run's `RUN.md` and `log.jsonl`:

- the questions it wrote and its reasoning
- the survey URL and the number of completes
- what it made of the answers, and whether it judged them sufficient
- the follow-up it chose and what changed
- the final recommendation, with confidence and caveats
- the payment table with basescan receipts
