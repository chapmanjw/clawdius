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
ok(fs.existsSync('extensions/clawdius-themes/themes/clawdius-dark.json'), 'Clawdius Dark theme file missing');
ok(fs.existsSync('extensions/clawdius-themes/themes/clawdius-light.json'), 'Clawdius Light theme file missing');

if (fail.length) {
	console.error('BRANDING GUARD FAILED:');
	for (const m of fail) { console.error('  - ' + m); }
	process.exit(1);
}
console.log('branding guard passed: Clawdius branding, Open VSX gallery, no telemetry, Clawdius default theme');
