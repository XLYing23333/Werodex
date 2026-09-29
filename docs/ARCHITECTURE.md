# Architecture

Local `werodex` reads a workspace config and speaks to local `werodexd` over a UID-checked Unix socket. The daemon controls SSH Master creation, connection backoff and channel leases. Connection identity hashes the effective hostname, port, user, identity files, ProxyJump and ProxyCommand. Source transfers use rsync over this SSH Master. Remote execution uses SSH Bash channels. No remote TCP listener or Codex installation is needed.

The shared PathPolicyEngine classifies paths as PROTECTED, IGNORED, LARGE, ARTIFACT or SOURCE. Automatic operations apply Protected > Werodex Exclude > `.gitignore` > Large > Source. Explicit `fetch` handles one Artifact file. A successful sync records a per-file size and SHA-256 baseline in `.werodex/state.json`. Conflicts compare both sides with that baseline and record Git HEAD, ancestry and dirty state in a report. mtime is never conflict truth.

Detached jobs run in tmux and write metadata plus rotated log segments under the remote user's `~/.local/state/werodex/jobs/<workspace-id>/`. The daemon can restart without terminating jobs and lists them from remote metadata after reconnecting. Logs are capped at four 64 MB segments by default and completed jobs are pruned after seven days when jobs are listed. Short commands bypass tmux.
