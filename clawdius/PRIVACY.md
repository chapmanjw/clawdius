# Privacy and Network Egress in Clawdius

Clawdius is a privacy-first fork of Code - OSS. It removes the telemetry, experimentation,
crash-reporting, and vendor-account machinery the upstream editor ships, and adds nothing of its own
that phones home. This document is the ledger of what Clawdius neutralizes and the short, exhaustive list
of the only network calls it makes - each one initiated by you.

## The guarantee

Clawdius collects no usage analytics, runs no experiments or A/B assignment, reports no crashes to a
vendor, and has no IDE sign-in or account. It ships no first-party telemetry. With one disclosed exception
- the automatic plugin setup (see below) - every outbound network call is either something you configured
(your model provider), something you explicitly triggered (installing an extension, opening the usage view
or Control Center, checking for updates), or something you opted into.

## What Clawdius neutralizes

Each item below is verifiable in the source tree; the marked edits carry a `// CLAWDIUS-BEGIN` comment and
are catalogued in [CHANGES_AGAINST_UPSTREAM.md](../docs/CHANGES_AGAINST_UPSTREAM.md).

- **Telemetry, off at the source.** `product.json` sets `enableTelemetry: false` and ships no
  instrumentation key.
- **No Microsoft Marketplace egress.** The extension gallery points only at Open VSX
  (`open-vsx.org`); the Microsoft Marketplace is blocked by build hygiene.
- **No IDE account or vendor sign-in.** The default-account provider is not registered
  (`defaultAccount.ts`) when the vendor entitlement URL is empty, which closes all startup account egress
  at the source - including the enterprise `api.{host}/copilot_internal/*` path that reconstructs URLs
  from settings. The five vendor entitlement URLs in `product.json` (entitlement, token-entitlement,
  MCP-registry, managed-settings, signup-limit) are emptied, so the managed-settings and entitlement
  fetches do not occur.
- **No GitHub Copilot.** The Copilot chat extension is removed wholesale. The agent host does not
  advertise GitHub authentication (`getProtectedResources()` returns empty) and authenticates the Claude
  backend through your local `~/.claude` OAuth, not a vendor proxy.
- **No inherited CI phone-home.** The sixteen upstream `microsoft/vscode` workflows are removed.

## The only outbound calls Clawdius makes

The complete list, with the single automatic one named first:

1. **Plugin setup (automatic).** On its first run, Clawdius installs Anthropic's official Claude Code
   plugin (`anthropic.claude-code`) from Open VSX if it is not already present - that plugin owns the
   visible chat pane. On desktop it also installs the Remote - SSH helper (`jeanp413.open-remote-ssh`),
   and on Windows desktop the Remote - WSL helper (`jeanp413.open-remote-wsl`), from Open VSX if absent;
   those two are best-effort and first-run only. The critical Claude Code plugin is additionally
   re-installed from Open VSX automatically on a later launch if it goes missing (a safety net so a removed
   chat pane heals itself). The setup runs a few seconds after startup, while idle. This is the one thing
   Clawdius fetches without your asking: a setup fetch from Open VSX, not telemetry.
2. **Your model provider.** When you send a message, the Claude backend (the local `claude` CLI / SDK
   subprocess) talks to the Anthropic API using your own `~/.claude` credentials, exactly like the CLI.
   If you configure a different provider (for example Amazon Bedrock, Google Vertex, or a custom base
   URL), it talks to that instead. Nothing else routes your prompts.
3. **Extensions, on explicit action.** Apart from the one-time first-run set above, installing or updating
   an extension fetches from Open VSX only, and only when you ask.
4. **The usage view, on open or hover.** Opening the Claude Code usage dashboard or hovering the
   status-bar usage entry triggers one on-demand refresh of your subscription limits: a
   `GET https://api.anthropic.com/api/oauth/usage` sent with your `~/.claude` CLI OAuth bearer token. It
   runs only when the engine is Anthropic's own API - it is skipped entirely for Amazon Bedrock, Google
   Vertex, or a custom base URL - is throttled by a 60-second cache, and never runs on restore, on a
   timer, or while idle. Your token and session counts are computed from local `~/.claude` files; only the
   subscription limits come from that call, and are then cached locally. Opening the dashboard also runs a
   local `claude -p /usage` command through your model-provider CLI to fetch the "what's contributing to
   your usage" breakdown; that reads your usage data with your `~/.claude` credentials through the CLI and,
   unlike the direct limits call, is not gated to Anthropic - it uses whatever provider CLI you configured.
   No cost figure is sent or shown.
5. **The Control Center star count, on open.** Opening the Control Center makes one unauthenticated read
   of the Clawdius repository's public star count from the GitHub API (`api.github.com`) for the "Star on
   GitHub" button. It fires only on that open, never on a timer or at startup, is fetched once per
   session, and fails silently when offline.
6. **The update check, when you ask or opt in.** Clawdius has no auto-update server and never downloads or
   installs an update. "Check for Updates" makes one read of the GitHub Releases API to compare your
   running version against the latest release and, if newer, shows a notification linking to the release
   page. It runs only when you invoke it - or at startup only if you opt in with
   `clawdius.update.checkOnStartup` (off by default).
7. **MCP and agent connections you configure.** Any Model Context Protocol server or agent connection you
   add makes exactly the calls you configured, to the hosts you named.

## Honest scope

This document describes Clawdius's own behavior. It does not restrict what a model provider, an MCP
server, or a third-party extension you install does once you connect it - those make the calls their own
terms describe. Clawdius adds no hidden egress on top of them.

The standing guarantee is enforced by review today; the forming automated backstop is a boot-time
idle-egress check that asserts zero uninitiated egress on a packaged build, tracked on the roadmap. Until
it ships, this ledger and the marked source edits are the auditable record.
