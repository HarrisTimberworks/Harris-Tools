# Harris-Tools — working agreement

Token spend here is ~86% context (cache reads/writes), ~13% output. The lever is
**keeping the main thread's context small**, not writing less. Optimize for that.

## Delegate heavy reading to subagents
- Use the **Agent** tool for codebase exploration, multi-file/grep sweeps, sifting
  test or log output, and verification passes. Subagents run in isolated context
  and return only a conclusion — the big reads never enter this thread.
- Do **not** run wide `Grep`/`Read` sweeps inline when a subagent can return the answer.
- Verification/exploration subagents may use a lighter model via the Agent `model` param.

## Cap tool output — every result is re-read on every later turn
- Pipe noisy commands to `tail`/`head` or filter; never dump full test logs, full
  board pulls, or raw `node -e` output when a slice answers the question.
- monday.com: request only the columns/fields needed; paginate — avoid `get_full_board_data`.
- Prefer dedicated MCPs (Bluebeam, monday, chrome) over **computer-use**: its
  screenshot/UI dumps are ~150K tokens each and ride along for the rest of the session.

## Keep the thread focused
- Answer the task asked. Don't re-read files already in context or re-summarize prior work.
- One discrete task per session. When a task is done, suggest `/clear`; when context
  grows large mid-task, suggest `/compact`.
