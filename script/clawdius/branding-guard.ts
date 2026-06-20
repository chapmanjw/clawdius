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

// Negative: no live Microsoft/GitHub-Copilot egress endpoints or external Microsoft links in product.json.
// The 'github.copilot.*' command/output identifiers are deferred to Phase 2 and intentionally NOT asserted
// here; these checks target URLs/hosts, which are the network-egress + external-link surface. The headline
// offender was defaultChatAgent.entitlementUrl/tokenEntitlementUrl/mcpRegistryDataUrl/managedSettingsUrl,
// fetched by core (DefaultAccountProviderContribution at BlockStartup) on startup with the user's session.
ok(!/:\/\/api\.github\.com/i.test(productText), 'product.json has an api.github.com URL (Copilot egress)');
ok(!/:\/\/aka\.ms/i.test(productText), 'product.json has an aka.ms (Microsoft) URL');
ok(!/marketplace\.visualstudio\.com|vsassets\.io/i.test(productText), 'product.json references the Microsoft Marketplace');

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

if (fail.length) {
	console.error('BRANDING GUARD FAILED:');
	for (const m of fail) { console.error('  - ' + m); }
	process.exit(1);
}
console.log('branding guard passed: Clawdius branding, Open VSX gallery, no telemetry, Clawdius default theme');
