# Publishing Werodex

The intended repository is https://github.com/XLYing23333/Werodex. Repository creation and npm publication are separate manual release actions; these instructions do not imply a release already exists.

1. Review the version in `package.json` and `package-lock.json`. A published version cannot be reused.
2. Run `npm ci`, then `npm run release:check` on Linux with Node.js 20 or newer, Git, Bash, GNU tar, OpenSSH client/server, tmux and rsync. Tests start an unprivileged localhost sshd with disposable host/client keys, a temporary HOME and tmux sockets; they never use an existing remote project. This runs tests, builds the package, checks its actual file allowlist and common secret patterns, then globally installs the tarball under an isolated temporary prefix and runs its CLI. Temporary files are removed afterwards.
3. Review source and documentation for private hostnames, personal paths, real credentials and diagnostic output. Automated pattern scanning cannot identify every secret. Never add `.werodex`, `.env`, SSH keys or npm credentials to the package.
4. Commit and tag the reviewed release in GitHub. Configure npm authentication interactively outside the repository, confirm package ownership/name availability, and run `npm publish`. The prepublish hook repeats `release:check`.
5. After successful publication, verify `npm view werodex version` and `npm install -g werodex` in a clean environment. Update both READMEs to remove the pre-release installation note.

The package is Linux-only. Installing it does not install system SSH, Git, rsync, Python or tmux dependencies. Publication checks do not contact or modify existing remote projects. For SSH acceptance tests, use disposable local and remote project directories and remove only those test resources afterwards.
