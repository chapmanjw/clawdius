# Clawdius overlay

This directory holds Clawdius-specific assets and configuration that live in new paths so they
never conflict on an upstream merge (the small-diff doctrine). Contents grow over time:

- `branding/`: drop-in logos, icons, watermark, walkthrough imagery. Replacing an asset
  is dropping a file here.
- `themes/`: `clawdius-dark.json`, `clawdius-light.json`, and the accent tokens file
  (canonical orange `#d97757`).
- `SECURITY-SCANNING.md`: the secret and forbidden-content scan standards.

Anything Clawdius-authored that can live in a new path belongs here or under
`src/vs/workbench/contrib/clawdius/**`, not as an in-place edit to an upstream file. In-place edits
are wrapped in `// CLAWDIUS-BEGIN <reason>` / `// CLAWDIUS-END` markers and recorded in
`CHANGES_AGAINST_UPSTREAM.md`.
