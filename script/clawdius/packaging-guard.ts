// Clawdius packaging guard. Asserts that customizations the DESKTOP PACKAGING depends on are still wired in.
//
// Why this exists: an upstream merge can silently drop a packaging customization, and nothing notices until a
// release is cut, because CI builds the tree but never packages it. The 1.132.0 merge dropped THREE separate
// onnxruntime customizations - the arch filter, the asar unpack rule, and the bundled-dependency
// declaration - and four of the ten release legs failed after a public tag was already pushed. They were
// found one at a time, each fix revealing the next, which is the argument for asserting all three here.
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

// The addon dlopen's sibling shared libraries (libonnxruntime.so.1 / .dylib / onnxruntime.dll) which the OS
// loader resolves by on-disk path, so the WHOLE bin/ tree must be unpacked from the asar - not just the
// `.node` file that the generic '**/*.node' rule covers. With only the addon unpacked, dlopen fails at
// runtime and dpkg-shlibdeps cannot resolve libonnxruntime.so.1 when building the .deb.
//
// This is a SEPARATE customization from the filter above and the 1.132.0 merge dropped BOTH. Restoring only
// the filter still failed the Linux legs, on the target arch's own binary, so both are asserted here.
ok(/'\*\*\/onnxruntime-node\/bin\/\*\*'/.test(gulpfile),
	"build/gulpfile.vscode.ts no longer unpacks '**/onnxruntime-node/bin/**' from the asar (the addon's shared libraries stay archived, breaking dlopen at runtime and the .deb build)")

// The exclude list is built by subtracting the target from this table, so a missing entry means that
// platform's binary is never excluded from the OTHER targets' packages.
for (const [platform, arch] of [['darwin', 'arm64'], ['linux', 'x64'], ['linux', 'arm64'], ['win32', 'x64'], ['win32', 'arm64']]) {
	ok(new RegExp(`\\['${platform}',\\s*'${arch}'\\]`).test(gulpfile),
		`build/gulpfile.vscode.ts onnxRuntimeShippedTargets is missing ['${platform}', '${arch}'] (that binary would ship inside every other package)`)
}

// dpkg-shlibdeps resolves every shared library an ELF needs against system packages unless the library is
// declared as one we bundle. libonnxruntime.so.1 ships beside the addon, so without this entry the .deb build
// fails with "cannot find library libonnxruntime.so.1" even when the binary and its library are both staged
// correctly. This was the third onnxruntime customization the 1.132.0 merge dropped.
const linuxDeps = read('build/linux/dependencies-generator.ts')
ok(/'libonnxruntime\.so\.1'/.test(linuxDeps),
	"build/linux/dependencies-generator.ts no longer lists 'libonnxruntime.so.1' as a bundled dependency (dpkg-shlibdeps will fail the .deb build looking for a system package that provides it)")

if (fail.length) {
	console.error('PACKAGING GUARD FAILED:')
	for (const f of fail) { console.error(`  - ${f}`) }
	console.error('\nThese are packaging customizations a merge can revert without any test noticing.')
	console.error('Restore the wiring rather than updating this guard, unless the packaging genuinely changed.')
	process.exit(1)
}

console.log('packaging guard passed: onnxruntime is arch-filtered, unpacked from the asar, and declared as a bundled Linux dependency')
