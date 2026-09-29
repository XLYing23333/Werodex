---
name: werodex-init
description: Initialize a local Linux project with Werodex and an SSH remote when the user asks for Werodex setup or says /Werodex Init HOST PATH. Covers first directory review, data exclusions, and initial Source transfer; not routine sync or job management.
---

# Initialize a Werodex workspace

Work in the local project directory that Codex is meant to edit. Werodex keeps `.werodex/` state in that directory, so a different checkout or worktree is a different workspace. Use the installed `werodex` CLI for remote operations; do not replace its workflow with direct `ssh`, `scp`, or `rsync` commands.

## Establish the target

- Identify the local project directory, SSH target, and absolute remote project path from the user's request or current workspace. Ask for any of these that cannot be determined; never guess a remote path.
- Check `werodex help` for the `tree`, `exclude`, and `review` commands. If the CLI or a required remote dependency is missing, report the exact prerequisite. Do not expand the task into system package installation.
- The remote directory must already exist. If it has no independent Git repository, `werodex init` creates one on `main`; if it belongs to a parent repository, stop and report the boundary. Do not create a Git commit during setup.

## Initialize, then review before transfer

1. Run `werodex init --target HOST --project /absolute/remote/project` from the local project directory. `init` creates configuration and an `AGENTS.md` block; it does not transfer Source. **Read the generated block immediately in this task** because a newly created AGENTS.md may not be reinjected into an already running conversation.
2. Run `werodex tree` for a bounded local view. For a populated remote project with an empty local workspace, use bounded `werodex exec` commands to inspect the remote top level, for example `werodex exec -- bash -c 'find . -mindepth 1 -maxdepth 1 -printf "%f\n" | head -40'`. Inspect relevant subdirectories one at a time. Do not recursively inspect `datasets`, `data`, `pretrained`, `checkpoints`, `outputs`, `wandb`, `runs`, or `artifacts`.
3. Identify additional downloaded data, caches, model weights, archives, and generated-output paths before the first transfer. Add each project-relative literal path with `werodex exclude add PATH --reason "why it is remote-only"`. This updates Werodex's `sync.exclude` and managed `.gitignore` blocks on both sides. `.gitignore` alone is not the Werodex protection rule. Do not exclude a directory merely because it contains many source files.
4. Replace the pending overview in `.werodex/project-tree.md` with a short account of inspected Source directories and remote-only paths. Remove `<!-- WERODEX:REVIEW_PENDING -->` and the template sentence; preserve the managed exclusion block. Run `werodex review complete`, then confirm `werodex status` reports `reviewed: true`.
5. Choose the first transfer based on where Source currently lives: `werodex pull` for a populated remote and empty local workspace, or `werodex sync` for the opposite. Inspect `skippedLarge` and `werodex diff`. Non-source files over the configured limit (32 MB by default) are skipped; common code/documentation extensions remain eligible regardless of size. Use `--allow-large` only for a deliberate transfer after reviewing exclusions.

If the first transfer reports a conflict, read `.werodex/conflicts/<id>/report.json` and the staged remote copies. Merge the files in the current workspace, then run `werodex sync --resolve <id>`; repeat `pull` if the intended first direction was remote-to-local. Existing remote `.gitignore` or `AGENTS.md` may need this merge. Never choose `--keep-local` or `--keep-remote` automatically.

Report the initialized workspace, Git initialization performed, exclusions and reasons, review status, transfer result, skipped large files, and any unresolved conflicts. For later tasks, follow the generated AGENTS.md block: keep expressly local deliverables excluded, verify features, commit only named remote Source paths with `checkpoint`, refresh `git-tree`, and explicitly write a local work log. If credential unlocking requires a terminal, stop at that point and ask the user to perform the interactive unlock; do not request a password in chat.
