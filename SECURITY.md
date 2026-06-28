# Security

Clawdius is a personal, independent fork of [microsoft/vscode](https://github.com/microsoft/vscode), provided as-is with no warranty.

## Reporting a vulnerability

For a security issue in Clawdius's own changes, please report it privately through this repository's [GitHub Security Advisories](https://github.com/chapmanjw/clawdius/security/advisories/new) rather than a public issue.

Vulnerabilities elsewhere belong with their owners:

- Unmodified upstream VS Code code: Microsoft, per their [security policy](https://aka.ms/SECURITY.md).
- The Claude Code extension: [Anthropic](https://www.anthropic.com/).
- Any extension you installed: that extension's maintainer.

## Network posture

Clawdius runs with zero network egress by default: no telemetry, no crash reporting, no marketplace or update pings. Network traffic happens only when you start it, such as a Claude turn through your `~/.claude` login or an extension you choose to install.
