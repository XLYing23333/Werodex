# Werodex development

This directory builds the `werodex` npm package. Run `npm test` after changing core behavior. Keep remote-only path rules centralized in `PathPolicyEngine`; use the same policy for each file operation. Do not invoke an AI agent from the ordinary sync flow. Use isolated temporary directories for remote tests and never modify an existing remote project.
