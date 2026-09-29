# Threat model

Protected assets include local model credentials, SSH credentials, remote datasets, outputs, checkpoints, source history and remote long jobs. Risks include accidental large-file transfer or deletion, untrusted paths, shell injection, cross-user daemon access, repeated SSH authentication, and unbounded output.

Mitigations include fail-closed workspace and path validation, a shared path policy, no default delete, bounded output, persistent SSH multiplexing, UID-checked local IPC, mode 0700/0600 state, encrypted Vault secrets, and explicit conflict recovery with snapshots. Remote command arguments and paths are shell quoted; command execution itself is intentionally user-authorized. A compromised local Unix account can still read that account's files and processes. A compromised remote account can read its own project and jobs but receives no OpenAI or Codex credential from Werodex.
