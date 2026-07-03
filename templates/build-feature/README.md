# build-feature — Codex executes, Claude Code reviews

Rides the Claude Code and Codex CLIs you are already logged into — no API
keys. Codex implements (contained by its own workspace-write sandbox);
Claude Code reviews the working tree and returns a strict verdict; the loop
runs until approve (max 3 rounds).

1. Have `codex` and `claude` on PATH, logged in.
2. Run: oma run build-feature --input feature="add a retry helper with tests"
3. Watch: oma tail <sessionId> — or close the terminal and check later.
4. Adjust models in the workflow: codex:gpt-5.5#medium, claude-code:opus, etc.

Note: the reviewer runs Claude Code with permissions bypassed so it can read
and run tests unattended — run this in a checkout you'd trust an agent in.
