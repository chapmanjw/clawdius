// Clawdius packaging guard. Asserts that customizations the DESKTOP PACKAGING depends on are still wired in.
//
// Why this exists: an upstream merge can silently drop a packaging customization, and nothing notices until a
// release is cut, because CI builds the tree but never packages it. Cutting 1.132.0 lost THREE separate
// onnxruntime customizations this way - the arch filter, the asar unpack rule, and the bundled-dependency
// declaration - and four of the ten release legs failed after a public tag was already pushed. They were found
// one at a time, each fix revealing the next.
//
// onnxruntime-node has since been REMOVED as a dependency: nothing in src/ or extensions/ ever imported it or
// @huggingface/transformers (its only consumer), because on-device dictation moved to Foundry Local, which
// downloads its own ONNX Runtime at runtime instead. With the package gone, all three customizations were dead
// code and were deleted with it.
//
// So this guard is now CONDITIONAL, and that is the point: if a future merge reintroduces onnxruntime-node, the
// three customizations must come back with it, and this fails until they do. If the package is absent it passes
// trivially. Deleting the guard along with the code would have thrown away the protection that made the problem
// findable in the first place.
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

// --- Is onnxruntime-node back? ---------------------------------------------------------------------------
const pkg = JSON.parse(read('package.json') || '{}')
const declaredDeps: Record<string, string> = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
const hasOnnxRuntime = 'onnxruntime-node' in declaredDeps
const hasTransformers = '@huggingface/transformers' in declaredDeps

if (!hasOnnxRuntime && !hasTransformers) {
	console.log('packaging guard passed: onnxruntime-node is not a dependency, so its packaging customizations are correctly absent')
	process.exit(0)
}

// --- It is back. Every customization it needs must be back too. -------------------------------------------
// The three below are NOT interchangeable; each fixes a different failure, which is why restoring them one at a
// time cost two release cycles:
//   arch filter  -> stops foreign-arch binaries shipping. Without it the Windows legs fail (rcedit cannot load a
//                   Mach-O binary) and the .deb build walks a foreign-arch ELF.
//   unpack rule  -> puts libonnxruntime.so.1 beside its addon. THIS is what stops dpkg-shlibdeps erroring: each
//                   binary is passed with -l<its own directory>, so the library has to be in that directory.
//   bundled dep  -> keeps the resolved library out of the .deb's DECLARED system dependencies, so the package
//                   does not ask the host for a library it ships itself.
console.log(`onnxruntime-node is a dependency again (${declaredDeps['onnxruntime-node'] ?? 'via @huggingface/transformers'}); checking its packaging customizations are present...`)

const gulpfile = read('build/gulpfile.vscode.ts')

ok(/function getOnnxRuntimeExcludeFilter\s*\(/.test(gulpfile),
	'build/gulpfile.vscode.ts no longer defines getOnnxRuntimeExcludeFilter (onnxruntime binaries for every platform would ship, breaking the .deb and Windows legs)')

ok(/\.pipe\(\s*filter\(\s*getOnnxRuntimeExcludeFilter\(/.test(gulpfile),
	'build/gulpfile.vscode.ts defines getOnnxRuntimeExcludeFilter but never pipes it into the packaging stream (the filter is inert)')

ok(/'\*\*\/onnxruntime-node\/bin\/\*\*'/.test(gulpfile),
	"build/gulpfile.vscode.ts no longer unpacks '**/onnxruntime-node/bin/**' from the asar (the addon's shared libraries stay archived, so dlopen fails at runtime and dpkg-shlibdeps cannot resolve libonnxruntime.so.1)")

for (const [platform, arch] of [['darwin', 'arm64'], ['linux', 'x64'], ['linux', 'arm64'], ['win32', 'x64'], ['win32', 'arm64']]) {
	ok(new RegExp(`\\['${platform}',\\s*'${arch}'\\]`).test(gulpfile),
		`build/gulpfile.vscode.ts onnxRuntimeShippedTargets is missing ['${platform}', '${arch}'] (that binary would ship inside every other package)`)
}

ok(/'libonnxruntime\.so\.1'/.test(read('build/linux/dependencies-generator.ts')),
	"build/linux/dependencies-generator.ts no longer lists 'libonnxruntime.so.1' as a bundled dependency (the .deb would declare a system dependency the host cannot satisfy)")

if (fail.length) {
	console.error('PACKAGING GUARD FAILED:')
	for (const f of fail) { console.error(`  - ${f}`) }
	console.error('\nonnxruntime-node is a dependency again, but the packaging customizations it needs are missing.')
	console.error('Either restore them, or drop the dependency again if nothing imports it.')
	process.exit(1)
}

console.log('packaging guard passed: onnxruntime-node is back and all three of its packaging customizations are present')
