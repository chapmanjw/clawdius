# Clawdius

Clawdius is a Claude-only build of VS Code. It forks [microsoft/vscode](https://github.com/microsoft/vscode) (the open-source "Code - OSS" base), strips out GitHub Copilot and OpenAI Codex, and rebuilds the AI surface around Anthropic's Claude Code.

The assistant is the official **Claude Code** extension from Anthropic, installed from Open VSX on first run and driven by your existing `~/.claude` login. There is no Copilot sign-in, no Codex, and no Microsoft telemetry.

> Status: alpha. It builds and runs from source on Windows; signed installers are not published yet. See [BUILD.md](BUILD.md).

## What's different from Code - OSS

- Claude takes Copilot's place. The GitHub Copilot agent, the OpenAI Codex agent, and the `@vscode/copilot-api` CAPI transport are removed. Claude reaches Anthropic directly through the bundled `claude` CLI using your `~/.claude` credentials, not through GitHub.
- Extensions install from [Open VSX](https://open-vsx.org) instead of the Microsoft Marketplace.
- Zero network egress by default: no telemetry, no crash reporting, no marketplace or update pings. The only traffic is the kind you start yourself, such as a Claude turn or an extension you choose to install.
- A Claude Code Control Center pane edits your `~/.claude` configuration (permissions, MCP servers, skills, plugins, hooks) so you don't have to hand-edit JSON.
- A usage dashboard reports session and weekly token use, computed locally from your Claude Code transcripts.
- A Context Budget Inspector shows what Claude loads for the active file: memory, rules, skills, and the measured cached prefix.
- The status bar carries the live permission mode, the effort/Ultracode level, and a usage meter.

## Build and run

Clawdius builds with the upstream VS Code toolchain. On Windows that means Visual Studio 2022 C++ Build Tools and the Node version pinned in `.nvmrc` (24.15.x). [BUILD.md](BUILD.md) lists the exact components.

```
npm ci
npm run compile
scripts\code.bat
```

`scripts\code.bat` launches the dev build. For day-to-day work use the watch tasks (`npm run watch`) for incremental rebuilds.

## Tracking upstream

Clawdius pins a specific upstream version (see `UPSTREAM_VERSION`) and keeps its divergence auditable:

- [CHANGES_AGAINST_UPSTREAM.md](CHANGES_AGAINST_UPSTREAM.md) records every in-tree edit against the base.
- [MERGING.md](MERGING.md) covers pulling in a newer upstream.

## License and trademarks

Clawdius is licensed under the MIT License, the same as Code - OSS; see [LICENSE.txt](LICENSE.txt).

"Visual Studio Code", "VS Code", and the Microsoft logos are trademarks of Microsoft and are not used by this fork. "Claude" and "Claude Code" are products of Anthropic. Clawdius is an independent fork, not affiliated with or endorsed by Anthropic or Microsoft.
