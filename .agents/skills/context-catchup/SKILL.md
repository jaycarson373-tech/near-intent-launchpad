---
name: context-catchup
description: Load this repo's canonical shared context without writing files. Use at session start, after switching tools, or whenever project state is uncertain.
---

# Context Catchup

Run `python3 ~/.claude/scripts/context_state.py read-stale-tasks` from the current checkout. Report stale paths, owners, ages, resume steps and invalid headers. Stale file activity does not prove owner death: inspect the session/worktree before manual pickup. Never auto-claim or respawn.

Read `AGENTS.md`, `CLAUDE.md`, and `.claude/CONTEXT.md` if present. Load active sessions with `python3 .claude/scripts/context_state.py read-live-sessions --limit 10 --max-bytes 5120`; its raw output excludes `README.md` and archived sessions. Read bounded recent entries from `PROGRESS.md` and `DECISIONS.md`, then check `git status --short`, `git log -3 --oneline`, and `git branch --show-current`. Summarize current branch, dirty files, current focus, recent work, blockers, decisions affecting the task, and next likely action. Do not modify files.
