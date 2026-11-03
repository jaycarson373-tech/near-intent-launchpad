---
name: context-save
description: Save shared session state for this repo without creating tool-specific context drift. Use before ending a session, switching tools, or compacting context.
---

# Context Save

Task headers use `**Status:** assigned | in-progress | done | parked | dropped`, `**Owner:** <tool>--<checkout-root-basename>`, `**Branch:** <actual branch>`, and `**Next:** <one resume step>`. Use Detail for prose. Match Owner and Branch to select canonical tasks; never overwrite another owner without authorized takeover. Get the checkout basename from `git rev-parse --show-toplevel`, not the current subdirectory. Keep Next current through replace-if-hash. Without a verified turn-end hook, run `python3 ~/.claude/scripts/context_state.py heartbeat-task --tool <your-tool>` on save or turn end.

Write only shared context files. Never create tool-specific session or copied progress files. Gather git status, current branch, and recent commits. Identify actor as Claude Code, Codex, OpenCode, Pi, Cline, or Agent. Update only this session's direct-child `.claude/sessions/<worktree>--<stamp>-<rand4>.md` file directly. For task logs and decisions, hash the canonical version read and use `python3 .claude/scripts/context_state.py replace-if-hash --path <repo-relative-path> --expected-sha <64-lowercase-hex> --content-file <file>`; reread and reapply on conflict. Record in `PROGRESS.md` only when a durable project fact exists, as one concise record via `python3 .claude/scripts/context_state.py prepend --path PROGRESS.md --record-file <file>`; observations and run preparation need only the private session file, and a save never justifies a new branch, commit, or PR. Never log secrets or PII.
