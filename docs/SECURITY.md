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

## Accepted third-party findings

Findings we have looked at and decided not to act on, with the reasoning, so the decision can be re-checked instead of re-litigated.

### An older DOMPurify inside the Mermaid webview bundles

There is an advisory against DOMPurify covering versions before 3.4.9: an element removed by a caller-registered hook can be left in a detached subtree that is still executable.

The workbench's own vendored copy was inside that range and was updated to 3.4.13. A second copy is not ours to update. `@zenuml/core` (reached through `@mermaid-js/mermaid-zenuml`) ships DOMPurify 3.3.1 already bundled inside its own distributed JavaScript rather than importing it, so npm cannot dedupe it against the hoisted 3.4.13 and a lockfile change has no effect. It lands in the built `markdown-preview-out/index.js` and `notebook-out/index.js`, which are build output and not tracked in the repository.

The advisory needs a hook that removes an element. Reading the built bundles:

- Nothing registers a hook against the bundled 3.3.1 at all. There are no `addHook` invocations anywhere in `@zenuml/core`'s distributed JavaScript; its single `sanitize` call is on ZenUML diagram comment text.
- The only hooks in the shipped bundles are Mermaid's `beforeSanitizeAttributes` and `afterSanitizeAttributes`. Both read and write attributes on anchor tags to preserve `target` and add `rel="noopener"`. Neither removes or detaches an element, so neither meets the precondition whichever copy they bind to.

We are leaving it. Aliasing the import would not reach code that is already bundled, and swapping a sanitizer underneath a vendor's pre-bundled code risks breaking diagram rendering to fix something that cannot fire. Dropping `@mermaid-js/mermaid-zenuml` would remove the copy, but that is a decision about whether to support ZenUML diagrams, not a security fix.

Re-check this if `@zenuml/core` starts registering a sanitizer hook, or if a future advisory against 3.3.1 does not depend on one.
