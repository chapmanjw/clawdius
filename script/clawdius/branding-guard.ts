// Clawdius branding guard. Asserts the product is branded Clawdius, uses Open VSX, ships no telemetry,
// drops the GitHub/Copilot default chat agent, and defaults to the Clawdius theme. Source-level guard for
// M1; Phase 6 extends it to scan the BUILT product (and the egress guarantee). Run with: node branding-guard.ts
import fs from 'node:fs';

const fail: string[] = [];
const ok = (cond: boolean, msg: string) => { if (!cond) { fail.push(msg); } };

const p = JSON.parse(fs.readFileSync('product.json', 'utf8'));
ok(p.nameShort === 'Clawdius' && p.nameLong === 'Clawdius', 'product name is not Clawdius');
ok(p.applicationName === 'clawdius', 'applicationName is not clawdius');
ok(p.dataFolderName === '.clawdius', 'dataFolderName is not .clawdius');
ok(p.extensionsGallery && /open-vsx\.org/.test(p.extensionsGallery.serviceUrl || ''), 'gallery is not Open VSX');
ok(p.enableTelemetry === false, 'enableTelemetry is not false');
ok(!p.voiceWsUrl, 'voiceWsUrl (Microsoft voice endpoint) is present');
ok(!p.defaultChatAgent || !/GitHub\.copilot/i.test(p.defaultChatAgent.extensionId || ''), 'defaultChatAgent still points at GitHub.copilot');
ok(Object.keys(p.trustedExtensionAuthAccess || {}).length === 0, 'trustedExtensionAuthAccess is not empty');

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
