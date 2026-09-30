<div align="center">
  <img src="https://raw.githubusercontent.com/XLYing23333/Werodex/main/assets/WerodexBar.jpg" alt="Werodex — local-first remote development bridge" width="860" />

  <h1>Werodex</h1>
  <p><strong>A local-first SSH bridge for remote development and coding agents.</strong></p>
  <p>Keep your editor, agent, and credentials local. Run code, Git, and long jobs on your Linux server.</p>
  <p><a href="README-CN.md">简体中文</a></p>
</div>

---

Werodex gives Codex and other coding agents a consistent way to work with a remote Linux project. The user installs the tool and describes the task; the agent edits local files, uses Werodex to transfer Source and run remote commands, and reports the result. Datasets, checkpoints, and generated outputs can stay remote.

Werodex does not run Codex remotely, copy model credentials to the server, or require an extra remote TCP service.

## Highlights

- **Local-first workflow:** Keep your editor, coding agent, and model authentication on your local machine.
- **Persistent SSH:** A local daemon manages SSH ControlMaster connections and bounded channel leases.
- **Conservative Source sync:** Sync and pull use per-file SHA-256 baselines to detect conflicts. Sync does not delete files by default.
- **Protected remote data:** Dataset, checkpoint, output, and other configured remote-only paths are excluded from automatic Source operations.
- **Long-running jobs:** Start detached jobs with `tmux`, then wait, inspect bounded logs, or attach when needed.
- **Explicit artifact downloads:** Fetch a named regular file into `.werodex/artifacts/` rather than mirroring output directories.
- **Credential handling:** The optional local Vault encrypts secrets; workspace config stores a reference, not the secret.

## Requirements

Werodex currently supports **Linux** and **Node.js 20 or later**. Install these tools locally:

- OpenSSH client
- Git
- rsync
- Python 3

The remote host needs OpenSSH, Git, rsync, tmux, Bash, and GNU core utilities. Configure and verify an OpenSSH host alias and authentication before setup. The remote project directory must already exist. If it has no independent Git repository, `init` creates one on `main`; existing repositories and branches are unchanged. Both projects must be independent Git working-tree roots (linked worktrees are supported). A parent repository triggers `WDX_GIT_PARENT`; first run `git init -b main` in the project directory explicitly.

## Install the CLI and Skill

Repository: [XLYing23333/Werodex](https://github.com/XLYing23333/Werodex). Its root is this `Werodex/` package directory, so a fresh clone already contains `package.json` and `werodex_skills/`; there is no second `Werodex/` directory inside it. After the first npm release, install the published package with `npm install -g werodex`. Until then, use the source installation below.

Install from the Werodex package directory:

```bash
git clone https://github.com/XLYing23333/Werodex.git
cd Werodex
npm ci
npm install -g .
werodex help
```

Install the [bundled `werodex-init` Skill](werodex_skills/werodex-init/SKILL.md) directly from the GitHub checkout above into Codex's user-wide Skills directory. If you only need the Skill now, the `git clone` and `cd Werodex` steps above are sufficient; npm is not needed to copy it.

```bash
# Run from the cloned Werodex repository root.
skill_dir="${CODEX_HOME:-$HOME/.codex}/skills"
mkdir -p "$skill_dir"
cp -a werodex_skills/werodex-init "$skill_dir/"
```

After installing `werodex` globally from npm, you can copy the same Skill from the installed package instead:

```bash
skill_dir="${CODEX_HOME:-$HOME/.codex}/skills"
mkdir -p "$skill_dir"
cp -a "$(npm root -g)/werodex/werodex_skills/werodex-init" "$skill_dir/"
```

Both methods install to `$CODEX_HOME/skills/werodex-init`, or `~/.codex/skills/werodex-init` when `CODEX_HOME` is unset. Copying again updates an existing Skill. Start a new Codex conversation to use it, then ask `/Werodex Init HOST /absolute/remote/project` from the local project workspace. The Werodex CLI must also be installed before the Skill can initialize a workspace.

## Use Werodex with a coding agent

### `AGENTS.md`: the agent's remote-work rules

`werodex init` creates or updates a managed block in the **local project root** `AGENTS.md`, preserving instructions outside that block. This is the main project-specific operating guide for Codex and other agents. The `werodex-init` Skill guides first setup; after initialization, the agent should **read the new `AGENTS.md` block immediately** and follow it for later tasks in that workspace. A newly created file should not be assumed to appear automatically in an already-running agent conversation.

The block tells the agent when to inspect the project tree, exclude datasets and local-only files, sync Source, run remote jobs, handle conflicts, and use bounded logs. After a feature is verified, it directs the agent to commit the named remote Source paths with `checkpoint`, refresh `git-tree`, and write a local work log. Werodex enforces transfer and path rules in the CLI; the agent decides what code to change and how to resolve conflicts. `AGENTS.md` supplies workspace instructions within the agent's normal instruction hierarchy.

### Agent workflow

1. **Start a new conversation with the Skill enabled.** If you just installed the Skill, start a new Codex conversation so it loads. Confirm `werodex help` runs locally before initializing a workspace.
2. **Open a local workspace and initialize it.** Use a new local project folder or the agent's own local workspace. From there, tell the agent: `/Werodex Init MY-SERVER /home/me/demo`. The agent uses the `werodex-init` Skill to review the tree, mark exclusions, make the first transfer, and immediately read the generated `AGENTS.md`. This is an agent prompt; the underlying CLI command is `werodex init --target MY-SERVER --project /home/me/demo`.
3. **Continue with normal remote development requests.** The agent follows the workspace `AGENTS.md`: edit local Source, sync with Werodex, verify and commit remotely, and write a work log. It excludes explicitly local-only files first. The CLI examples and command reference follow this section.

## CLI commands and features

For reference, these are the CLI steps the agent performs to initialize a local workspace and connect it to an existing remote project:

```bash
mkdir -p ~/Projects/demo
cd ~/Projects/demo
werodex init --target MY-SERVER --project /home/me/demo
werodex tree
# Review and fill .werodex/project-tree.md; mark discovered data/output paths:
werodex exclude add downloads --reason "Downloaded dataset"
werodex review complete
werodex status
```

`init` does not transfer Source. The first `sync`, `pull`, `rebuild`, or `checkpoint` requires the local project-tree review. `werodex tree [PATH]` displays at most two levels, 40 entries per directory, and 200 entries total; it does not recurse into protected data directories. Edit `.werodex/project-tree.md` to replace the pending overview before `review complete`. Existing workspaces with a successful Sync Manifest remain approved.

`--target` is an OpenSSH host alias or hostname. `--project` is the absolute path of the project on the remote host. If the remote project has no independent Git repository, `init` creates `main` automatically. `--init-git` remains accepted for older scripts.

Sync Source and run remote commands:

```bash
werodex sync
werodex exec -- python3 -V
werodex run --detach -- python3 train.py
werodex jobs
werodex wait <job-id> --timeout 3600
werodex logs <job-id>
```

After a feature is complete, commit only its remote Source paths and record the work locally:

```bash
werodex checkpoint -m "Complete example feature" -- src/main.py
werodex git-tree
# First write Changes, Benefits, Verification, and Next steps to .werodex/entry.md.
werodex log add --file .werodex/entry.md --asset /home/me/demo/outputs/preview.png
```

Use repeatable `--local-asset PATH` for local plots, screenshots, or videos; it can be mixed with remote `--asset`. Purely local logging needs no remote connection. State the reason in the entry if no visual applies. For a local-only document, run `werodex exclude add PATH --reason "local-only: ..."` before creating it. Use `werodex help` for the complete command list. Existing reviewed workspaces can rerun `werodex review complete` to refresh the generated `AGENTS.md` block.

### Common commands

| Command | Purpose |
| --- | --- |
| `werodex init --target HOST --project PATH` | Configure this local workspace for a remote project |
| `werodex status` | Show connection, Git, sync, and job status |
| `werodex tree [PATH]`, `review complete` | Inspect a bounded local tree and approve the first sync |
| `werodex exclude add PATH --reason TEXT`, `exclude remove PATH`, `exclude list` | Manage literal project-relative exclusions |
| `werodex sync` / `werodex pull` | Transfer Source in either direction with conflict detection |
| `werodex diff` | Inspect Source differences |
| `werodex exec -- CMD` | Run a short command remotely |
| `werodex run --detach -- CMD` | Start a persistent remote job |
| `werodex jobs`, `wait`, `logs`, `kill` | Manage jobs and retrieve bounded output |
| `werodex fetch ABSOLUTE_PATH` | Download one explicitly selected remote file |
| `werodex checkpoint -m "message" -- PATH...` | Sync and commit only the named remote Source files |
| `werodex git-tree` | Save a bounded remote Git graph and status to local `.werodex/git-tree.md` |
| `werodex log add --file ENTRY.md [--asset REMOTE_PATH]... [--local-asset PATH]...` | Prepend a daily log, archive local or remote assets, and embed media |
| `werodex doctor` | Check local and remote prerequisites |
| `werodex credential` | Inspect or manage the optional local Vault |

For conflicts, `sync` writes a report and a remote copy under `.werodex/conflicts/<id>/`. Merge the files and run `werodex sync --resolve <id>`, or explicitly choose `--keep-local <id>` / `--keep-remote <id>`. Werodex does not invoke an AI agent to resolve conflicts.

### Sync and data boundaries

Werodex classifies files as Source, ignored, large, protected remote-only data, or explicitly fetched artifacts. Protected-path rules take precedence over `.gitignore`; adding a data folder to `.gitignore` is not the protection mechanism.

- `AGENTS.md`, `.gitignore`, `.ignore`, `.dockerignore`, and `.rgignore` at every level remain separate on each side: sync, pull, rebuild, diff, and checkpoint exclude them. Old conflict reports cannot overwrite them either. `exclude add/remove` updates only the managed root `.gitignore` block on each side, preserving user rules and permissions. Successful sync removes legacy rule-file baselines from the Manifest.
- Automatic Source operations skip remote-only directories such as `datasets/`, `data/`, `pretrained/`, `checkpoints/`, `outputs/`, `wandb/`, `runs/`, and `artifacts/`.
- `.werodex/`, `.git/`, `node_modules/`, environment files, SSH directories, and configured exclusions are not synced as Source.
- Non-source files over 32 MB are reported and skipped by default. Common code and documentation extensions such as `.py`, `.c`, `.cpp`, `.html`, `.js`, `.go`, `.ts`, and `.md` remain Source regardless of size. `.pth`, `.tar.gz`, and `.json` are not automatically classified as artifacts; mark their data/output directories explicitly. Use `sync --allow-large` or `pull --allow-large` when needed for a non-source file.
- `exclude add` writes `sync.exclude` and managed `.gitignore` blocks on both sides, and records the reason in the local project tree. Exclude a specific path before creating a file that the user wants to keep only locally. Werodex enforces `sync.exclude` on both sides; `.gitignore` also affects Git. Exclusions are literal paths, not glob patterns. There is no cumulative directory-size limit.
- `fetch` accepts one explicitly named regular file within the remote project. It refuses symbolic-link paths, existing destinations, and dataset/pretrained bulk fetches. Files over 32 MB require `--allow-large`.
- Transfers must pass both endpoints’ ignore and file-size policies before any files are written. A path ignored on either side (including tracked files) blocks the batch with `WDX_TRANSFER_POLICY`. Review both sides’ rules, or use `exclude add PATH --reason TEXT` to exclude the path consistently, then retry.
- Pause other writers to Source during a sync. Werodex rechecks transferred files but cannot create an atomic snapshot across independent processes.

### Jobs and output

After a feature is verified, the agent should sync, run `checkpoint -m "message" -- PATH...` for only that feature's remote Source, and refresh `git-tree`. Local Git serves ignore and status checks; no local commit is required. At every stage verification, experiment result, completed feature, or local-only delivery, the agent must immediately write Changes, Benefits, Verification, and Next steps and call `log add --file`; recording must not wait until the whole task ends. Attach representative plots, screenshots, images, animations, and videos whenever relevant visuals exist; otherwise state why none applies. Each work day has one `.werodex/logs/logs-YYYY-MM-DD.md`, with a 04:00 Asia/Shanghai boundary and newest entries first. Repeat `--asset` for remote files and `--local-asset` for local files, up to five combined files, each capped at 32 MB. Local assets are copied rather than moved; both kinds are archived in `.werodex/assets/<work-day>/` with size and SHA-256. Images use Markdown embeds; MP4/WebM use HTML video plus a fallback file link; other formats retain links. Read the saved log and verify media previews, recording any video-preview limitation and checking the fallback link. Use absolute local paths for media displayed in chat.

Short commands run directly over SSH. Detached jobs use remote `tmux` and survive disconnection of the local terminal or daemon. Job logs are retained remotely with a default 256 MB per-job limit and seven-day completed-job retention. `logs` returns bounded output; `logs --raw` is available for explicit diagnosis.

## Security

Werodex keeps secrets out of the workspace and remote project. SSH host-key verification stays enabled. When configured, the local Vault uses scrypt and AES-256-GCM and requires an interactive unlock. The local daemon communicates through a UID-checked Unix socket. See [Security](SECURITY.md) and the [threat model](docs/THREAT_MODEL.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Workspace configuration](docs/CONFIG.md)
- [Security policy](SECURITY.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Example configuration](examples/config.example.json)
- [简体中文 README](README-CN.md)

## Release preparation

Run `npm run release:check` to build, test, inspect the actual tarball for sensitive files and common credential patterns, and install it into an isolated global prefix. The package includes the CLI, daemon, documentation, banner and bundled skill files. After reviewing the package and authenticating to npm, run `npm publish`; its prepublish check runs the same verification. See [release notes](docs/RELEASING.md).

## Development

```bash
npm install
npm test
```

The package build uses TypeScript. Tests run with Node.js's built-in test runner.

## License

Werodex is distributed under the [Apache License 2.0](LICENSE).
