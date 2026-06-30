// Clawdius branding guard. Asserts the product is branded Clawdius, uses Open VSX, ships no telemetry,
// drops the GitHub/Copilot default chat agent, and defaults to the Clawdius theme. Source-level guard for
// M1; Phase 6 extends it to scan the BUILT product (and the egress guarantee). Run with: node branding-guard.ts
import fs from 'node:fs';

const fail: string[] = [];
const ok = (cond: boolean, msg: string) => { if (!cond) { fail.push(msg); } };

const productText = fs.readFileSync('product.json', 'utf8');
const p = JSON.parse(productText);
ok(p.nameShort === 'Clawdius' && p.nameLong === 'Clawdius', 'product name is not Clawdius');
ok(p.applicationName === 'clawdius', 'applicationName is not clawdius');
ok(p.dataFolderName === '.clawdius', 'dataFolderName is not .clawdius');

// Open VSX gallery, checked by exact host prefix (a substring match would accept open-vsx.org.evil.com).
const OPEN_VSX = /^https:\/\/open-vsx\.org\//;
const gal = p.extensionsGallery || {};
ok(OPEN_VSX.test(gal.serviceUrl || ''), 'gallery serviceUrl is not Open VSX (https://open-vsx.org/)');
ok(!gal.itemUrl || OPEN_VSX.test(gal.itemUrl), 'gallery itemUrl is not Open VSX');
ok(!gal.resourceUrlTemplate || OPEN_VSX.test(gal.resourceUrlTemplate), 'gallery resourceUrlTemplate is not Open VSX');

ok(p.enableTelemetry === false, 'enableTelemetry is not false');
ok(!p.voiceWsUrl, 'voiceWsUrl (Microsoft voice endpoint) is present');
ok(!p.defaultChatAgent || !/GitHub\.copilot/i.test(p.defaultChatAgent.extensionId || ''), 'defaultChatAgent still points at GitHub.copilot');
ok(Object.keys(p.trustedExtensionAuthAccess || {}).length === 0, 'trustedExtensionAuthAccess is not empty');

// The RUNTIME gate that blocks Copilot from Open VSX and uninstall-protects Claude Code lives in these
// product.json arrays (enforced in extension-management source). An upstream merge that regenerates
// product.json could silently drop them, re-enabling github.copilot install with NO other CI signal - pin them.
const blockedExts = new Set((p.clawdiusBlockedExtensions || []).map((s: string) => s.toLowerCase()));
ok(blockedExts.has('github.copilot') && blockedExts.has('github.copilot-chat'),
	'clawdiusBlockedExtensions no longer blocks github.copilot / github.copilot-chat (Copilot re-installable)');
ok(((p.clawdiusUninstallProtectedExtensions || []) as string[]).map(s => s.toLowerCase()).includes('anthropic.claude-code'),
	'clawdiusUninstallProtectedExtensions no longer protects anthropic.claude-code');
const trustedPubs = ((p.trustedExtensionPublishers || []) as string[]).map(s => s.toLowerCase());
ok(!trustedPubs.includes('microsoft') && !trustedPubs.includes('github'),
	'trustedExtensionPublishers re-added a Microsoft/GitHub publisher');

// The startup-fetch URLs DefaultAccountProviderContribution would call at BlockStartup with the user's session
// must stay empty strings (each call site short-circuits on ''). Pin them empty rather than relying on host
// matching, since a repopulated entitlement/registry URL on a non-denied host would otherwise pass.
const dca = p.defaultChatAgent || {};
for (const k of ['entitlementUrl', 'entitlementSignupLimitedUrl', 'tokenEntitlementUrl', 'mcpRegistryDataUrl', 'managedSettingsUrl']) {
	ok(dca[k] === undefined || dca[k] === '', `defaultChatAgent.${k} is not empty (startup egress vector)`);
}

// Host ALLOWLIST (not a denylist): every https?:// host in product.json must be one we expect. A denylist of
// a few known-bad Microsoft hosts let any OTHER host (1DS telemetry events.data.microsoft.com, App Insights
// dc.services.visualstudio.com, *.githubcopilot.com, exp-tas, blob.core.windows.net, ...) slip in on an
// upstream merge. The allowlist fails CLOSED: a newly merged host that isn't listed trips the guard. Templated
// subdomains (e.g. {{uuid}}.vscode-cdn.net for webview content) match by registrable suffix. Update the list
// deliberately when a new legitimate host is added.
// claude.ai / claude.com are the deliberately-trusted plugin-login domains (product.json
// linkProtectionTrustedDomains) - link-trust entries for the Claude Code sign-in flow, not egress endpoints.
const ALLOWED_HOST_SUFFIXES = ['open-vsx.org', 'github.com', 'nodejs.org', 'vscode-cdn.net', 'claude.ai', 'claude.com'];
const urlHostRe = /https?:\/\/([^/"'\s)]+)/gi;
const badHosts: string[] = [];
let hm: RegExpExecArray | null;
while ((hm = urlHostRe.exec(productText))) {
	const host = hm[1].toLowerCase();
	if (!ALLOWED_HOST_SUFFIXES.some(s => host === s || host.endsWith('.' + s))) { badHosts.push(host); }
}
ok(badHosts.length === 0, `product.json has URL host(s) outside the allowlist (possible Microsoft/telemetry/Copilot egress): ${[...new Set(badHosts)].join(', ')}`);

// Phase 6 zero-egress guarantee (audit: .research/egress-audit.md). Each of these product.json keys is the
// SOLE source of an uninitiated outbound request (startup/idle/background poll); when the key is absent the
// call site short-circuits and no request is built. Asserting them absent locks in the "robustly dead"
// Microsoft telemetry/experiment/update/crash/survey surface so an upstream merge cannot silently
// reintroduce a phone-home endpoint. (`commit`/`quality` are legitimate build fields and are NOT asserted;
// the update gate already relies on `updateUrl` absence.)
const NO_EGRESS_KEYS = ['aiConfig', 'ariaKey', 'tasConfig', 'updateUrl', 'appCenter', 'npsSurveyUrl',
	'cesSurveyUrl', 'surveys', 'releaseNotesUrl', 'settingsSearchUrl', 'tipsAndTricksUrl',
	'introductoryVideosUrl', 'newsletterSignupUrl', 'keybindingsReferenceUrl', 'requestFeatureUrl'];
for (const k of NO_EGRESS_KEYS) {
	ok(p[k] === undefined, `product.json carries an uninitiated-egress endpoint key "${k}" (zero-egress guarantee)`);
}
ok(!gal.controlUrl, 'product.json extensionsGallery.controlUrl is set (extension control/malicious-manifest egress)');

// Zero-egress RUNTIME backstop (not just product keys): the clawdius-chat usage-capacity fetch to
// api.anthropic.com must be ON DEMAND only - wired to the `clawdius.refreshUsageCapacity` command the usage
// tooltip invokes - with NO startup call and NO background timer. (It previously fetched at activate() +
// every 60s; see .research/egress-audit.md.) A regression to a timer or a bare activation call trips this.
const chatExt = fs.readFileSync('extensions/clawdius-chat/src/extension.ts', 'utf8');
ok(/registerCommand\('clawdius\.refreshUsageCapacity'/.test(chatExt), 'clawdius-chat: the on-demand usage-refresh command is missing');
ok(!/setInterval\([^)]*fetchUsageCapacity/.test(chatExt), 'clawdius-chat: usage capacity is fetched on a background timer (uninitiated egress)');
ok(!/^\s*fetchUsageCapacity\(\);\s*$/m.test(chatExt), 'clawdius-chat: fetchUsageCapacity() is called directly (likely at activation) - it must run on demand only');

// Hand-mirror parity backstop. The clawdius-chat extension can't import src/vs, so its copy of the provider gate +
// capacity fetch is a DELIBERATE hand-mirror of src/vs/platform/clawdius/common/claudeUsageProvider.ts (the shared
// source of truth that the node service and the renderer both import). Assert the extension copy still carries the
// same provider env keys, base-URL check, usage URL, cache filename, and anthropic-beta header value, so a drift in
// the mirror trips CI instead of silently letting the local-window copy diverge from the shared spec.
for (const key of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_BASE_URL']) {
	ok(chatExt.includes(key), `clawdius-chat: provider gate drifted from the shared spec (missing env key ${key})`);
}
ok(/api\\?\.anthropic\\?\.com/.test(chatExt), 'clawdius-chat: provider gate drifted (the api.anthropic.com base-URL check is missing)');
ok(chatExt.includes('api.anthropic.com/api/oauth/usage'), 'clawdius-chat: capacity fetch drifted (the OAuth usage URL is missing)');
ok(chatExt.includes('.clawdius-usage-cache.json'), 'clawdius-chat: capacity cache filename drifted from the shared spec');
ok(chatExt.includes('oauth-2025-04-20'), 'clawdius-chat: the anthropic-beta header value drifted from the shared spec');

// Same zero-egress backstop for the REMOTE-side mirror of the capacity fetch: the REH server's capacity service
// (which serves WSL/SSH windows against the remote ~/.claude) must be ON DEMAND only - invoked via its IPC
// channel, with NO background timer and NO constructor/startup self-call. A regression to a timer or a self-call
// trips this, exactly as for the clawdius-chat copy above.
const capSvc = fs.readFileSync('src/vs/platform/clawdius/node/claudeUsageCapacityService.ts', 'utf8');
ok(/refreshCapacity\s*\(/.test(capSvc), 'claudeUsageCapacityService: the on-demand refreshCapacity entry point is missing');
ok(!/setInterval/.test(capSvc), 'claudeUsageCapacityService: usage capacity is fetched on a background timer (uninitiated egress)');
ok(!/this\.refreshCapacity\(/.test(capSvc), 'claudeUsageCapacityService: refreshCapacity() is self-invoked - it must run on demand only, via the IPC channel');

// CLAWDIUS-BEGIN cli backend resolution must stay file-existence-only (zero process spawn, zero network)
const cliSvc = fs.readFileSync('src/vs/platform/clawdius/node/clawdiusCliConfigService.ts', 'utf8');
ok(!/child_process/.test(cliSvc), 'clawdiusCliConfigService: must not import child_process - CLI resolution spawns no process');
ok(!/\bfetch\s*\(|['"]node:https?['"]|['"]https?:\/\//.test(cliSvc), 'clawdiusCliConfigService: must not perform network I/O during CLI resolution');
// The Claude Code Config store reads the user's local config files only: no agent-host, no network egress.
const cfgStore = fs.readFileSync('src/vs/workbench/contrib/clawdius/browser/clawdiusConfigStore.ts', 'utf8');
ok(!/platform\/agentHost|IAgentHostService/.test(cfgStore), 'clawdius config store: must stay local-file-only - no agent-host import');
ok(!/\bfetch\s*\(|['"]node:https?['"]|['"]https?:\/\//.test(cfgStore), 'clawdius config store: must not perform network I/O');
// CLAWDIUS-END

const themeSvc = fs.readFileSync('src/vs/workbench/services/themes/common/workbenchThemeService.ts', 'utf8');
ok(/COLOR_THEME_DARK = 'Clawdius Dark'/.test(themeSvc), 'default dark theme is not Clawdius Dark');
ok(/COLOR_THEME_LIGHT = 'Clawdius Light'/.test(themeSvc), 'default light theme is not Clawdius Light');
ok(/COLOR_THEME_HC_DARK = 'Clawdius High Contrast'/.test(themeSvc), 'default HC dark theme is not Clawdius High Contrast');
ok(/COLOR_THEME_HC_LIGHT = 'Clawdius High Contrast Light'/.test(themeSvc), 'default HC light theme is not Clawdius High Contrast Light');

// All four Clawdius themes exist on disk and are contributed by the bundled theme extension.
for (const f of ['clawdius-dark.json', 'clawdius-light.json', 'clawdius-hc-dark.json', 'clawdius-hc-light.json']) {
	ok(fs.existsSync(`extensions/clawdius-themes/themes/${f}`), `theme file ${f} missing`);
}
const themesPkg = JSON.parse(fs.readFileSync('extensions/clawdius-themes/package.json', 'utf8'));
const themeIds: string[] = (themesPkg.contributes?.themes || []).map((t: { id: string }) => t.id);
for (const id of ['Clawdius Dark', 'Clawdius Light', 'Clawdius High Contrast', 'Clawdius High Contrast Light']) {
	ok(themeIds.includes(id), `clawdius-themes does not contribute "${id}"`);
}
// Each contributed theme's JSON "name" matches its contributed id (the id is the settings value the COLOR_THEME_* constants set).
for (const t of (themesPkg.contributes?.themes || []) as { id: string; path: string }[]) {
	const tj = JSON.parse(fs.readFileSync(`extensions/clawdius-themes/${t.path.replace(/^\.\//, '')}`, 'utf8'));
	ok(tj.name === t.id, `theme file ${t.path} name "${tj.name}" does not match contributed id "${t.id}"`);
}

// The welcome "Pick a Color Theme" walkthrough tiles (full + small variants) are rebranded to the Clawdius
// themes, with no leftover upstream "Dark Modern"/"Light Modern" labels, and the four preview PNGs exist.
const PICKER_DIR = 'src/vs/workbench/contrib/welcomeGettingStarted/common/media';
for (const f of ['theme_picker.ts', 'theme_picker_small.ts']) {
	const src = fs.readFileSync(`${PICKER_DIR}/${f}`, 'utf8');
	ok(/"Clawdius Dark"/.test(src) && /"Clawdius Light"/.test(src), `welcome ${f} tiles are not labeled Clawdius`);
	ok(/"Clawdius High Contrast"/.test(src) && /"Clawdius High Contrast Light"/.test(src), `welcome ${f} HC tiles are not labeled Clawdius`);
	ok(!/"Dark Modern"|"Light Modern"/.test(src), `welcome ${f} still carries upstream Dark/Light Modern labels`);
}
for (const png of ['dark.png', 'light.png', 'dark-hc.png', 'light-hc.png']) {
	ok(fs.existsSync(`${PICKER_DIR}/${png}`), `welcome theme preview ${png} missing`);
}

// "Only Clawdius themes" guarantee: NO bundled extension may contribute a color theme other than the
// four Clawdius themes. Upstream theme extensions were removed (theme-abyss/monokai/solarized/...) and
// theme-defaults was decontributed of its color themes (its icon theme is kept). A future upstream merge
// that re-introduces a bundled color theme trips this gate.
const ALLOWED_THEMES = new Set(['Clawdius Dark', 'Clawdius Light', 'Clawdius High Contrast', 'Clawdius High Contrast Light']);
const offendingThemes: string[] = [];
for (const dir of fs.readdirSync('extensions')) {
	const manifestPath = `extensions/${dir}/package.json`;
	if (!fs.existsSync(manifestPath)) { continue; }
	let manifest: { contributes?: { themes?: { id?: string; label?: string }[] } };
	try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { continue; }
	for (const t of manifest.contributes?.themes || []) {
		const id = t.id || t.label || '(unnamed)';
		if (!ALLOWED_THEMES.has(id)) { offendingThemes.push(`${dir}: ${id}`); }
	}
}
ok(offendingThemes.length === 0, `non-Clawdius color theme(s) still bundled: ${offendingThemes.join(', ')}`);

// The onboarding theme picker (product.json onboardingThemes) offers only the Clawdius themes.
for (const t of (p.onboardingThemes || []) as { themeId: string }[]) {
	ok(ALLOWED_THEMES.has(t.themeId), `onboardingThemes references non-Clawdius theme "${t.themeId}"`);
}

// "Copilot eliminated" guarantee (Phase 2): the GitHub Copilot Chat extension (extensions/copilot) was
// removed wholesale. The chat panel is powered by the bundled clawdius-chat extension, whose handler shells
// out to the local Claude Code CLI. A future upstream merge that re-introduces extensions/copilot trips this
// gate (it would re-register six competing isDefault panel participants + nine sign-in welcome views).
ok(!fs.existsSync('extensions/copilot'), 'extensions/copilot was re-introduced - Copilot must stay eliminated');
ok(p.defaultChatAgent?.extensionId === 'vscode.clawdius-chat', 'defaultChatAgent.extensionId is not the clawdius-chat backend');
ok(fs.existsSync('extensions/clawdius-chat/package.json'), 'the clawdius-chat extension (Claude CLI chat backend) is missing');

// Phase 6 brand backstop: the user-visible Copilot/GitHub strings + logo icons rebranded by the brand
// sweeps must STAY rebranded, so an upstream merge can't silently re-introduce them in shipped UI. Each
// site asserts the Claude/neutral wording is PRESENT and the exact old brand string/icon is ABSENT. The
// `absent` patterns target the rebranded VALUE precisely (not the localize key or internal id), so the
// deliberately-left gated strings (e.g. chat.sessionSync) and Copilot-suffixed command ids don't trip it.
const brandSites: { file: string; present: RegExp; absent: RegExp; what: string }[] = [
	{ file: 'src/vs/workbench/contrib/welcomeGettingStarted/common/gettingStartedContent.ts',
		present: /"Use AI features with Claude"/, absent: /Use AI features with Copilot for free/, what: 'welcome walkthrough title' },
	{ file: 'src/vs/workbench/contrib/welcomeGettingStarted/common/gettingStartedContent.ts',
		present: /\[Claude\]\(\{0\}\)/, absent: /\[Copilot\]\(\{0\}\)/, what: 'welcome walkthrough description link' },
	{ file: 'src/vs/workbench/contrib/welcomeGettingStarted/common/gettingStartedContent.ts',
		present: /altText: 'Claude multi file edits'/, absent: /altText: 'VS Code Copilot multi file edits'/, what: 'welcome walkthrough media alt text' },
	{ file: 'src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts',
		present: /provided by Claude, including chat/, absent: /provided by GitHub Copilot/, what: 'chat.disableAIFeatures description' },
	{ file: 'src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts',
		present: /Sandbox mode for the agent SDK/, absent: /Sandbox mode for the Copilot SDK/, what: 'chat.agentHost.sdkSandbox description' },
	{ file: 'src/vs/workbench/contrib/chat/browser/actions/chatActions.ts',
		present: /"Show Extensions using Claude"/, absent: /"Show Extensions using Copilot"/, what: 'Show Extensions command title' },
	{ file: 'src/vs/workbench/contrib/chat/browser/actions/openCopilotCliStateFileAction.ts',
		// Match the localize() VALUE, not the JSDoc comment that still names the upstream helper.
		present: /localize2\('openSessionEventsFile', "Open Agent Session State File"\)/, absent: /localize2\('openSessionEventsFile', "Open Copilot CLI State File"\)/, what: 'open-session-state command title' },
	{ file: 'src/vs/workbench/contrib/chat/browser/actions/openCopilotCliStateFileAction.ts',
		present: /"No agent session is active\."/, absent: /"No Copilot CLI session is active\."/, what: 'open-session-state no-session toast' },
	{ file: 'src/vs/workbench/contrib/chat/browser/widget/input/permissionPickerActionItem.ts',
		present: /"Claude uses your configured settings"/, absent: /"Copilot uses your configured settings"/, what: 'approvals picker subtext' },
	{ file: 'src/vs/workbench/contrib/chat/common/languageModelStats.ts',
		present: /localize\('Language Models', "Claude"\)/, absent: /localize\('Language Models', "Copilot"\)/, what: 'extension Features-tab label' },
	{ file: 'src/vs/workbench/contrib/chat/browser/actions/createPluginAction.ts',
		present: /localize\('agents', "Agents"\), Codicon\.claude/, absent: /localize\('agents', "Agents"\), Codicon\.copilot/, what: 'create-plugin Agents group icon' },
];
for (const s of brandSites) {
	let src = '';
	try { src = fs.readFileSync(s.file, 'utf8'); } catch { ok(false, `brand-guard: cannot read ${s.file}`); continue; }
	ok(s.present.test(src), `brand regressed (${s.what}): expected Claude/neutral wording missing in ${s.file}`);
	ok(!s.absent.test(src), `brand regressed (${s.what}): the old Copilot string/icon re-appeared in ${s.file}`);
}

if (fail.length) {
	console.error('BRANDING GUARD FAILED:');
	for (const m of fail) { console.error('  - ' + m); }
	process.exit(1);
}
console.log('branding guard passed: Clawdius branding, Open VSX gallery, no telemetry, Clawdius default theme');
