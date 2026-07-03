# issue-to-pr

1. Configure a real model in .oma/config.json.
2. Run: oma run issue-to-pr --input issue="fix the login timeout"
3. It pauses after planning: oma approve <sessionId> (or deny --reason ...).
4. The execute/review loop runs until the judge approves (max 3 rounds).
5. Route models per stage with `model:` inside a stage's agent, or run the
   execute stage elsewhere with `runs_on: worker:<name>` plus
   `oma worker --name <name>` on that machine.
