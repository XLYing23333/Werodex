# Threat model

Protected assets include local model credentials, SSH credentials, remote datasets, outputs, checkpoints, source history and remote long jobs. Risks include accidental large-file transfer or deletion, untrusted paths, shell injection, cross-user daemon access, repeated SSH authentication, and unbounded output.

Mitigations include fail-closed workspace and path validation, a shared path policy, no default delete, bounded output, persistent SSH multiplexing, UID-checked local IPC, mode 0700/0600 state, encrypted Vault secrets, and explicit conflict recovery with snapshots. Remote command arguments and paths are shell quoted; command execution itself is intentionally user-authorized. A compromised local Unix account can still read that account's files and processes. A compromised remote account can read its own project and jobs but receives no OpenAI or Codex credential from Werodex.

Native tools return files, names, logs, Git text and errors as untrusted result data. None of these enter tool descriptions or generated instructions. The compact managed AGENTS block applies only to its workspace; read-only work has no commit obligation. Marking data untrusted reduces instruction mixing; it is not a claim that every agent will resist every malicious text. Ordinary sync never calls an AI.

Raw output streams use backpressure, byte limits and bounded queues instead of giant JSON output. Both daemon and MCP admission limit outstanding request count and encoded input. Unknown write IDs survive result cleanup in durable metadata; exhaustion rejects new work rather than replaying it. Credential paths cannot be read, searched, patched or attached, even with explicit preview.
