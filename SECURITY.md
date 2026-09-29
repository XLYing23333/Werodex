# Security

Werodex never copies Codex, OpenAI, or SSH secrets to a remote project. Workspace config may contain only a credential reference. The optional local Vault uses scrypt and AES-256-GCM; unlocking requires an interactive terminal. A non-interactive locked Vault returns `WDX_CREDENTIAL_LOCKED`. The local daemon socket is mode 0600 inside a mode 0700 directory and validates the connecting Linux UID with `SO_PEERCRED`.

OpenSSH host-key verification remains enabled. Werodex prefers keys and ssh-agent. Password login is an explicit Vault fallback and uses a short-lived local `SSH_ASKPASS` socket; the password is never placed in process arguments or the remote workspace. Shared Unix accounts do not provide strong isolation between their users.

Protected paths are never part of automatic Source sync, pull, rebuild, diff or checkpoint. Source operations do not delete by default. Conflict overwrites require explicit flags and create backups first. Do not use `logs --raw` or `attach` as a default agent action. `doctor --fix` does not silently install packages.

Report vulnerabilities privately to the project maintainers. Do not include credentials in reports.

Common credential paths (`.env`/`.env.*`, `.ssh`, `.aws`, `.gnupg`, `.npmrc`, `.pypirc`, `.netrc`, and standard private-key filenames) are excluded from automatic Source transfer. This is path protection, not content-based secret detection: explicitly exclude credentials stored under custom names before synchronization. Do not put secrets in job commands, log entries or diagnostic output.
