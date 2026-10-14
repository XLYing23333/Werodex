# Werodex development

This directory builds the `werodex` npm package. Run `npm test` after changing core behavior. Keep remote-only path rules centralized in `PathPolicyEngine`; use the same policy for each file operation. Do not invoke an AI agent from the ordinary sync flow. Use isolated temporary directories for remote tests and never modify an existing remote project.

## Major-stage commits

For Source development, declare coherent major stages, their verification criteria and named file scopes before editing. After each stage passes verification, immediately run `werodex finish -m "STAGE: result" --log .werodex/plan/STAGE-entry.md -- PATH...` (or MCP `finish`) before advancing; do not defer all commits until the task ends. Commit only that stage's work and preserve unrelated or pre-existing user changes.

Require checkpoint status `complete`, and record the stage, checkpoint ID, both local and remote SHAs, committed paths and verification in the plan/log and stage update. Because `finish` returns its ID after logging, append a receipt with those returned fields via `log add --file RECEIPT.md --source PATH` (repeat `--source` for the scope); preserve existing immutable entries. A verified skipped side records its existing HEAD and reason; do not create empty commits. Resume partial checkpoints with `checkpoint --resume ID`; complete failed post-commit logging without committing again. If remote configuration, identity or authentication is missing, mark the stage blocked and report the prerequisite; do not invent SHAs, silently substitute a local-only commit, or claim dual completion. Read-only work, initial setup and work without Source changes need no checkpoint.
