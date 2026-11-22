# Runs

Every run of the agent leaves a folder here: `log.jsonl` (every event, decision, price and payment
receipt) and, once it finishes, `RUN.md` (the readable write-up). Email addresses are masked as
`<address at domain>` throughout.

**The judged run is listed first once it has happened.** The rest are the development runs. Each one
hit a real failure of the live system, and the fix for it is in `git log`. They are kept on purpose:
two of them are replayed by the regression tests.

| run | what it was | what it showed |
|---|---|---|
| _judged run: added after the live kickoff_ | | |
| `2026-11-22T01-20-38` | **One-round test, real send to one recipient.** $4.09 | The full loop worked: designed, published, emailed, collected one real answer, and recommended. It declined to generalise from one response. It also leaked the tester's address into the log, which is why masking now happens at the exit; the log here was scrubbed. Replayed by `test/send-detection`. |
| `2026-11-22T01-09-41` | Dry run. $3.58 | It published, then while collecting tried to borrow a different project's panel. That is why the reasoning backend is now fenced to reasoning only. |
| `2026-11-22T01-04-17` | Dry run. $2.06 | It published after a four-turn confirm exchange it handled itself, then crashed when the judge answered in prose. That is why facts are now checked in code. Replayed by `test/publish-detection`. |
| `2026-11-22T00-56-37` | Dry run. $1.54 | A Flashpoint call never answered and the run hung. That is why every call now has a ceiling and a retry. |
| `2026-11-22T00-53-37` | Dry run. $0.01 | It crashed reading its first decision, because the chat tool wraps its answer in an envelope. |
| `2026-11-22T00-52-48` | Dry run, stopped at start. $0 | Superseded by the run above. |
