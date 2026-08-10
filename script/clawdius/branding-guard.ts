// Clawdius branding guard. Asserts the product is branded Clawdius, uses Open VSX, ships no telemetry,
// drops the GitHub/Copilot default chat agent, and defaults to the Clawdius theme. Source-level guard;
// a companion guard extends it to scan the BUILT product (and the egress guarantee). Run with: node branding-guard.ts
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
// The agent-host GitHub/Aria telemetry senders are inert ONLY because supportsTelemetry() is false, which needs
// BOTH enableTelemetry:false (above) AND no aiConfig.ariaKey. Pin the second factor so a merge cannot re-arm them.
ok(!p.aiConfig || !p.aiConfig.ariaKey, 'product.json aiConfig.ariaKey is present (would re-arm the agent-host telemetry senders)');
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

// Recommended-extension supply-chain guard (GlassWorm risk). Two invariants:
//  (A) The fork must NOT inherit upstream's user-facing recommended-extension machinery - the large
//      curated `*Tips` families product.json ships to steer users at the marketplace. Those keys stay
//      stripped, so an upstream merge cannot silently re-seed a marketplace recommendation list.
//  (B) Every extension the fork DOES recommend (its contributor-facing .vscode/extensions.json set) must
//      live in a namespace we have verified on Open VSX. A recommendation resolves to whatever publisher
//      currently owns that namespace on the gallery, so recommending an unverified namespace is a
//      supply-chain foothold - a squatted or hijacked namespace, as in the GlassWorm Open VSX campaign.
//      The allowlist FAILS CLOSED: a new namespace trips the guard until it is verified and added here
//      deliberately (confirm on Open VSX who owns the namespace first).
const RECOMMENDATION_TIP_KEYS = ['extensionTips', 'extensionImportantTips', 'keymapExtensionTips',
	'configBasedExtensionTips', 'exeBasedExtensionTips', 'webExtensionTips', 'languageExtensionTips',
	'virtualWorkspaceExtensionTips', 'remoteExtensionTips', 'extensionRecommendations'];
for (const k of RECOMMENDATION_TIP_KEYS) {
	const v = p[k];
	const empty = v === undefined || (Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0);
	ok(empty, `product.json carries an inherited recommended-extension list "${k}" (upstream marketplace recommendations must stay stripped)`);
}
const VERIFIED_NAMESPACES = new Set(['clawdius', 'anthropic', 'ms-vscode', 'github', 'dbaeumer', 'typescriptteam', 'connor4312']);
// .vscode/extensions.json is JSONC (line + block comments); strip them before parsing. The recommendation
// ids carry no "//", so removing full-line "//" comments and /* */ blocks is safe for this file.
const recText = fs.readFileSync('.vscode/extensions.json', 'utf8')
	.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
let recommendations: string[] = [];
try { recommendations = (JSON.parse(recText).recommendations || []) as string[]; }
catch { ok(false, '.vscode/extensions.json is not parseable (the recommended-extension namespace guard cannot verify it)'); }
for (const id of recommendations) {
	const ns = id.split('.')[0].toLowerCase();
	ok(VERIFIED_NAMESPACES.has(ns), `.vscode/extensions.json recommends "${id}" from unverified namespace "${ns}" (GlassWorm risk: verify who owns the Open VSX namespace, then add it to VERIFIED_NAMESPACES)`);
}

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

// Zero-egress guarantee. Each of these product.json keys is the
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
// every 60s.) A regression to a timer or a bare activation call trips this.
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

// Credential-resolution parity + the "never a native keychain binding" rule.
// The Claude Code CLI stores its OAuth credentials in the macOS LOGIN KEYCHAIN (plaintext ~/.claude/.credentials.json
// is only its FALLBACK when the Keychain write fails, and the only store at all on Windows/Linux). A regression to a
// file-only read reports every signed-in mac user as "Signed out". claudeCredentials.ts (node, serves remote windows)
// and the clawdius-chat hand-mirror (serves local windows) must both keep the full resolution: the env-token
// short-circuit, the Keychain service name, and the /usr/bin/security spawn.
// Assert on CODE, never a bare substring: both files NAME "/usr/bin/security" and the service in the long comments
// explaining this design, so a plain `.includes(...)` would be satisfied by the PROSE and would happily pass a
// file-only regression (verified: it does). Each pattern below matches a construct only real code can produce.
const credSvc = fs.readFileSync('src/vs/platform/clawdius/node/claudeCredentials.ts', 'utf8');
const CREDENTIAL_SPEC: ReadonlyArray<{ readonly re: RegExp; readonly what: string }> = [
	{ re: /const SECURITY_BIN = '\/usr\/bin\/security'/, what: "the /usr/bin/security ABSOLUTE path (a bare 'security' is PATH-hijackable)" },
	{ re: /const KEYCHAIN_SERVICE = 'Claude Code-credentials'/, what: 'the Keychain service name' },
	{ re: /'find-generic-password'/, what: 'the `security find-generic-password` read' },
	{ re: /platform === 'darwin'/, what: 'the darwin gate that decides to read the Keychain at all' },
	{ re: /claudeAiOauth\?\.accessToken/, what: 'the OAuth access-token read' },
	{ re: /env\['CLAUDE_CODE_OAUTH_TOKEN'\]/, what: 'the CLAUDE_CODE_OAUTH_TOKEN short-circuit (such a user has NEITHER a Keychain item NOR a file)' },
	// The RETURN, not the type union that also spells 'transient' - otherwise mapping exit 36 to a definitive
	// 'absent' (the exact "Signed out" lie) would still satisfy this. Behavioural backstop: claudeCredentials.test.ts
	// ("exit 36 is INDETERMINATE - undefined, never false"); this grep is defense in depth.
	{ re: /return \{ kind: 'transient' \}/, what: 'the INDETERMINATE result (exit 36 / a locked keychain must never render "Signed out")' },
];
for (const { re, what } of CREDENTIAL_SPEC) {
	ok(re.test(chatExt), `clawdius-chat: credential resolution drifted from the shared spec (missing ${what})`);
	ok(re.test(credSvc), `claudeCredentials: credential resolution drifted from the clawdius-chat mirror (missing ${what})`);
}
ok(/registerCommand\('clawdius\.hasClaudeCredentials'/.test(chatExt), 'clawdius-chat: the local signed-in credential probe command is missing');
// Registering the command is NOT enough: without an onCommand activation event the renderer's FIRST probe races
// extension-host activation (onStartupFinished always fires after `*`), rejects with "command not found", and the
// status bar paints "Signed out" until the 15s poll self-heals. Pin the activation events so that can't regress.
const chatPkg = fs.readFileSync('extensions/clawdius-chat/package.json', 'utf8');
for (const command of ['clawdius.hasClaudeCredentials', 'clawdius.refreshUsageCapacity']) {
	ok(chatPkg.includes(`"onCommand:${command}"`), `clawdius-chat: ${command} has no onCommand activation event - the renderer would race the extension host and mis-render the signed-in state`);
}
// Ban NATIVE keychain bindings outright. macOS evaluates a Keychain item's ACL against the process that CALLS the
// Keychain API: the item's trusted-application list contains /usr/bin/security and nothing else, so spawning that
// binary reads silently, while a native binding makes Clawdius.app the caller and pops a blocking "wants to use your
// confidential information" dialog at EVERY launch. This is a dev-only trap - once a developer clicks "Always Allow"
// they can never reproduce the prompt - so it is pinned here rather than left to review.
// Match on actual USE (import/require, or a safeStorage member access), NOT a bare mention, so both files can still
// NAME these bindings in the comment explaining why they are forbidden. (A substring ban self-trips on that comment.)
const NATIVE_KEYCHAIN_USE = /(?:from|require\(|import\()\s*['"](?:keytar|node-keychain|@napi-rs\/keyring)['"]|\bsafeStorage\s*\./;
ok(!NATIVE_KEYCHAIN_USE.test(credSvc), 'claudeCredentials: must read the Keychain via /usr/bin/security, never a native binding (keytar/safeStorage/node-keychain/@napi-rs/keyring)');
ok(!NATIVE_KEYCHAIN_USE.test(chatExt), 'clawdius-chat: must read the Keychain via /usr/bin/security, never a native binding (keytar/safeStorage/node-keychain/@napi-rs/keyring)');
// The credential resolver spawns the Apple keychain CLI and reads a local file - it must never reach the network.
ok(!/\bfetch\s*\(|['"]node:https?['"]|['"]https?:\/\//.test(credSvc), 'claudeCredentials: must not perform network I/O');

// Same zero-egress backstop for the REMOTE-side mirror of the capacity fetch: the REH server's capacity service
// (which serves WSL/SSH windows against the remote ~/.claude) must be ON DEMAND only - invoked via its IPC
// channel, with NO background timer and NO constructor/startup self-call. A regression to a timer or a self-call
// trips this, exactly as for the clawdius-chat copy above.
const capSvc = fs.readFileSync('src/vs/platform/clawdius/node/claudeUsageCapacityService.ts', 'utf8');
ok(/refreshCapacity\s*\(/.test(capSvc), 'claudeUsageCapacityService: the on-demand refreshCapacity entry point is missing');
ok(!/setInterval/.test(capSvc), 'claudeUsageCapacityService: usage capacity is fetched on a background timer (uninitiated egress)');
ok(!/this\.refreshCapacity\(/.test(capSvc), 'claudeUsageCapacityService: refreshCapacity() is self-invoked - it must run on demand only, via the IPC channel');

// Same zero-egress backstop for the "Check for Updates" GitHub-releases check. The single GitHub request must
// fire ONLY on the user action or the opt-in startup check - never on a timer. Assert the service carries NO
// setInterval, and that the startup trigger gates on `getValue(...checkOnStartup...) === true` (the correct
// DIRECTION - an inverted `!== true` or a dropped gate would not match, so it trips CI; a plain substring grep
// could not tell the direction). The falsifiable behavioural backstop is clawdiusUpdate.test.ts (checkOnStartup
// false -> 0 calls, true -> exactly 1); this grep is defense in depth. Paired with the contribution.ts
// default-false assertion below, a regression to a timer or an on-by-default startup check trips CI.
const updateSvc = fs.readFileSync('src/vs/workbench/contrib/clawdius/browser/update/clawdiusUpdateService.ts', 'utf8');
ok(!/setInterval/.test(updateSvc), 'clawdiusUpdateService: the update check runs on a background timer (uninitiated egress)');
ok(/getValue\([^)]*checkOnStartup[^)]*\)\s*===\s*true/.test(updateSvc),
	'clawdiusUpdateService: the startup check must gate on getValue(...checkOnStartup...) === true (an inverted or dropped gate would fire an uninitiated launch request)');
// The startup check defaults OFF: the `clawdius.update.checkOnStartup` property must register `default: false`,
// so a regression to on-by-default (a single uninitiated GitHub request at every launch) trips this guard.
const updateContrib = fs.readFileSync('src/vs/workbench/contrib/clawdius/browser/clawdius.contribution.ts', 'utf8');
ok(/checkOnStartup'\s*:\s*\{[^}]*default:\s*false/.test(updateContrib),
	'clawdius.contribution: clawdius.update.checkOnStartup is not registered with default:false (startup zero-egress regression)');

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

// "Copilot eliminated" guarantee: the GitHub Copilot Chat extension (extensions/copilot) was
// removed wholesale. The chat panel is powered by the bundled clawdius-chat extension, whose handler shells
// out to the local Claude Code CLI. A future upstream merge that re-introduces extensions/copilot trips this
// gate (it would re-register six competing isDefault panel participants + nine sign-in welcome views).
ok(!fs.existsSync('extensions/copilot'), 'extensions/copilot was re-introduced - Copilot must stay eliminated');
ok(p.defaultChatAgent?.extensionId === 'vscode.clawdius-chat', 'defaultChatAgent.extensionId is not the clawdius-chat backend');
ok(fs.existsSync('extensions/clawdius-chat/package.json'), 'the clawdius-chat extension (Claude CLI chat backend) is missing');

// Brand backstop: the user-visible Copilot/GitHub strings + logo icons rebranded by the brand
// sweeps must STAY rebranded, so an upstream merge can't silently re-introduce them in shipped UI. Each
// site asserts the Claude/neutral wording is PRESENT and the exact old brand string/icon is ABSENT. The
// `absent` patterns target the rebranded VALUE precisely (not the localize key or internal id), so the
// deliberately-left gated strings (e.g. chat.sessionSync) and Copilot-suffixed command ids don't trip it.
const brandSites: { file: string; present: RegExp; absent: RegExp; what: string }[] = [
	// The transcript hides the responder username only when it equals the default participant's fullName.
	// These two must agree or every assistant turn grows a redundant username + avatar. A comment did not
	// hold them together - they drifted apart during de-Copiloting and shipped broken - so assert both ends.
	{ file: 'src/vs/workbench/contrib/chat/browser/widget/chatListRenderer.ts',
		present: /const DEFAULT_AGENT_USERNAME = 'Clawdius';/, absent: /'Clawdius Copilot'/, what: 'default-agent username' },
	{ file: 'extensions/clawdius-chat/package.json',
		present: /"fullName":\s*"Clawdius"/, absent: /"fullName":\s*"Clawdius Copilot"/, what: 'default chat participant fullName' },
	{ file: 'src/vs/workbench/contrib/welcomeGettingStarted/common/gettingStartedContent.ts',
		present: /"Use AI features with Claude"/, absent: /Use AI features with Copilot for free/, what: 'welcome walkthrough title' },
	{ file: 'src/vs/workbench/contrib/welcomeGettingStarted/common/gettingStartedContent.ts',
		present: /\[Claude\]\(\{0\}\)/, absent: /\[Copilot\]\(\{0\}\)/, what: 'welcome walkthrough description link' },
	{ file: 'src/vs/workbench/contrib/welcomeGettingStarted/common/gettingStartedContent.ts',
		present: /altText: 'Claude multi file edits'/, absent: /altText: 'VS Code Copilot multi file edits'/, what: 'welcome walkthrough media alt text' },
	{ file: 'src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts',
		present: /provided by Claude, including chat/, absent: /provided by GitHub Copilot, including chat/, what: 'chat.disableAIFeatures description' },
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
	// The 1.127 deep "VS Code" -> "Clawdius" display-text sweep. These are the most prominent user-visible
	// product self-references (update flow, install/reinstall errors, model-picker, getting-started); pin them
	// so an upstream merge cannot silently reintroduce "VS Code" in shipped UI. Full list: docs ledger row.
	{ file: 'src/vs/platform/update/common/update.config.contribution.ts',
		present: /download and install new Clawdius versions/, absent: /download and install new VS Code versions/, what: 'Windows background-update setting' },
	{ file: 'src/vs/platform/extensionManagement/node/extensionManagementService.ts',
		present: /not compatible with Clawdius/, absent: /not compatible with VS Code/, what: 'extension-incompatible install error' },
	{ file: 'src/vs/platform/extensionManagement/node/extensionManagementService.ts',
		present: /restart Clawdius before reinstalling/, absent: /restart VS Code before reinstalling/, what: 'reinstall restart error' },
	{ file: 'src/vs/workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerItemPrimitives.ts',
		present: /Update Clawdius\]\(command:update\.checkForUpdate\)/, absent: /Update VS Code\]\(command:update\.checkForUpdate\)/, what: 'model-picker update prompt' },
	// The seeded plugin marketplaces: upstream ships two GitHub-hosted catalogs as the default, which the
	// marketplace service then background-polls (and PluginAutoUpdate silently installs from) once any plugin
	// is installed. An upstream merge re-seeds this default silently, so pin the empty list here.
	{ file: 'src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts',
		present: /default: \[\],\s*\/\/ CLAWDIUS-END/, absent: /'github\/(copilot-plugins|awesome-copilot)/, what: 'seeded plugin marketplaces' },
	// The OAuth/loopback sign-in pages: the `class="branding"` wordmark link must point at the fork, not
	// code.visualstudio.com (an upstream merge silently reverts these, and the wordmark text is a variable so a
	// name-only sweep misses the URL leak).
	{ file: 'src/vs/workbench/api/node/loopbackServer.ts',
		present: /class="branding" href="https:\/\/github\.com\/chapmanjw\/clawdius"/, absent: /class="branding" href="https:\/\/code\.visualstudio\.com/, what: 'github-auth sign-in page branding href' },
	{ file: 'extensions/microsoft-authentication/src/node/loopbackTemplate.ts',
		present: /class="branding" href="https:\/\/github\.com\/chapmanjw\/clawdius"/, absent: /class="branding" href="https:\/\/code\.visualstudio\.com/, what: 'ms-auth loopback page branding href' },
	{ file: 'extensions/microsoft-authentication/media/index.html',
		present: /class="branding" href="https:\/\/github\.com\/chapmanjw\/clawdius"/, absent: /class="branding" href="https:\/\/code\.visualstudio\.com/, what: 'ms-auth landing page branding href' },
	// The Claude agent-host session type must never require Copilot sign-in: with requiresCopilotSignIn:true a leaked
	// entitlement=Unknown state renders "Sign in to GitHub Copilot to use this agent" on the Claude agent in the Agents window.
	{ file: 'src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostChatContribution.ts',
		present: /requiresCopilotSignIn: false/, absent: /requiresCopilotSignIn: true/, what: 'Claude agent-host session-type sign-in requirement' },
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
