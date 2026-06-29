# Contributing to Clawdius

Clawdius is a personal, independent fork of [microsoft/vscode](https://github.com/microsoft/vscode), kept Claude-only. It follows a specific direction rather than open-ended feature requests, but issues and pull requests are welcome.

## Before you start

- Build and run from source: [BUILD.md](BUILD.md).
- What the fork changes and why: [CHANGES_AGAINST_UPSTREAM.md](CHANGES_AGAINST_UPSTREAM.md).
- Pulling in a newer upstream: [MERGING.md](MERGING.md).

## Guidelines

- Keep edits against upstream marked and auditable with the `CLAWDIUS-BEGIN` / `CLAWDIUS-END` convention, so they survive a merge and stay easy to review.
- Match the existing style: tabs, single-quoted strings, the copyright header on new files. The pre-commit hygiene hook enforces this.
- Don't reintroduce Copilot, Codex, telemetry, or uninitiated network calls. The branding guard, the forbidden-content scanner, and the brand ratchet enforce this in CI.

## Reporting elsewhere

For bugs in unmodified VS Code behavior, report upstream at [microsoft/vscode](https://github.com/microsoft/vscode/issues). For the Claude Code extension, see [Anthropic](https://www.anthropic.com/).
