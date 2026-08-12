// Clawdius packaging guard. Asserts that customizations the DESKTOP PACKAGING depends on are still wired in.
//
// Why this exists: an upstream merge can silently drop a packaging customization, and nothing notices until a
// release is cut, because CI builds the tree but never packages it. That has now happened twice. The 1.132.0
// merge dropped the filter that keeps only the target arch's onnxruntime binary; four of the ten release legs
// then failed - Linux because dpkg-shlibdeps walks every ELF in the staged tree and cannot resolve a
// foreign-arch binding's libraries, Windows because rcedit cannot load a Mach-O file. Both failures surfaced
// only after a public tag was pushed.
//
// Each assertion below is a claim about a file that a merge could quietly revert. Keep them cheap and
// specific: a guard that reads the whole build graph would rot faster than the thing it protects.
// Run with: node --experimental-strip-types packaging-guard.ts
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const fail: string[] = []
const ok = (cond: boolean, msg: string) => { if (!cond) { fail.push(msg) } }

function read(rel: string): string {
	try {
		return fs.readFileSync(path.join(repoRoot, rel), 'utf8')
	} catch {
		fail.push(`cannot read ${rel} (moved or deleted?)`)
		return ''
	}
}

// --- onnxruntime: ship only the target platform/arch binary -------------------------------------------
// onnxruntime-node carries prebuilt binaries for every platform/arch in its tarball. Shipping them all adds
// ~170MB of unusable native code per package AND breaks the Linux and Windows packaging steps outright.
const gulpfile = read('build/gulpfile.vscode.ts')

ok(/function getOnnxRuntimeExcludeFilter\s*\(/.test(gulpfile),
	'build/gulpfile.vscode.ts no longer defines getOnnxRuntimeExcludeFilter (onnxruntime binaries for every platform would ship, breaking the .deb and Windows legs)')

// Defining it is not enough - it has to be applied to the packaged stream.
ok(/\.pipe\(\s*filter\(\s*getOnnxRuntimeExcludeFilter\(/.test(gulpfile),
	'build/gulpfile.vscode.ts defines getOnnxRuntimeExcludeFilter but never pipes it into the packaging stream (the filter is inert)')

// The exclude list is built by subtracting the target from this table, so a missing entry means that
// platform's binary is never excluded from the OTHER targets' packages.
for (const [platform, arch] of [['darwin', 'arm64'], ['linux', 'x64'], ['linux', 'arm64'], ['win32', 'x64'], ['win32', 'arm64']]) {
	ok(new RegExp(`\\['${platform}',\\s*'${arch}'\\]`).test(gulpfile),
		`build/gulpfile.vscode.ts onnxRuntimeShippedTargets is missing ['${platform}', '${arch}'] (that binary would ship inside every other package)`)
}

if (fail.length) {
	console.error('PACKAGING GUARD FAILED:')
	for (const f of fail) { console.error(`  - ${f}`) }
	console.error('\nThese are packaging customizations a merge can revert without any test noticing.')
	console.error('Restore the wiring rather than updating this guard, unless the packaging genuinely changed.')
	process.exit(1)
}

console.log('packaging guard passed: onnxruntime binaries are filtered to the target platform/arch')
