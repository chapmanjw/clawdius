// Clawdius public-repo commit-message hygiene gate. Wired through husky 0.13: package.json has a
// "commitmsg" script and the installed .git/hooks/commit-msg dispatcher runs `npm run -s commitmsg`
// with the commit-message file path exported as $GIT_PARAMS. Rejects an over-long subject, a missing
// Co-authored-by trailer, a private session URL, or a known internal review/roadmap reference. The
// deeper succinctness + public-visibility review (the judgment pass that tells a real internal leak
// apart from a legitimate public mention) runs before push. Run manually: npm run commitmsg.
import fs from 'node:fs';

const file: string | undefined = process.env.GIT_PARAMS || process.argv[2];
if (!file) {
	process.exit(0);
}

let raw: string;
try {
	raw = fs.readFileSync(file, 'utf8');
} catch {
	process.exit(0);
}

// Drop comment lines and the verbose-diff scissors section git may append.
const lines = raw.split(/\r?\n/);
const scissors = lines.findIndex(l => l.startsWith('# ------------------------ >8'));
const kept = (scissors >= 0 ? lines.slice(0, scissors) : lines).filter(l => !l.startsWith('#'));
const msg = kept.join('\n').trim();
if (!msg) {
	process.exit(0);
}

const subject = (kept.find(l => l.trim().length > 0) ?? '').trim();

// Machinery commits keep conventional shapes; do not gate them.
if (/^(Merge |Revert |fixup! |squash! |amend! )/.test(subject)) {
	process.exit(0);
}

const errors: string[] = [];

const MAX_SUBJECT = 72;
if (subject.length > MAX_SUBJECT) {
	errors.push(`Subject is ${subject.length} chars (max ${MAX_SUBJECT}): "${subject}"`);
}

if (!/^Co-authored-by:\s*.+<.+>/im.test(msg)) {
	errors.push('Missing a "Co-authored-by:" trailer.');
}

// A private session URL must never reach public history.
if (/claude\.ai\/code\/session|Claude-Session:/i.test(msg)) {
	errors.push('Private Claude session URL present (must be omitted in a public repo).');
}

// Internal references that do not belong in public commit history, scoped to the forms our internal
// labels actually take so legitimate text (e.g. "Remove the OpenAI Codex agent subsystem") is allowed.
const INTERNAL: [RegExp, string][] = [
	[/\bconsensus\b/i, 'consensus (internal review process)'],
	[/\bRutherford\b/i, 'Rutherford (internal orchestrator)'],
	[/\(\s*Codex\b/i, '(Codex ...) (internal review tool)'],
	[/\bCodex review\b/i, 'Codex review (internal)'],
	[/\bCodex MINOR/i, 'Codex MINOR (internal review label)'],
	[/\bper Codex\b/i, 'per Codex (internal)'],
	[/\bmust-fix\b/i, 'must-fix (internal review label)'],
	[/\bUltracode P\d/i, 'Ultracode P# (internal phase label)'],
	[/\bPhase [A-Z]\b/, 'Phase <letter> (internal roadmap)'],
	[/\bPhase \d/, 'Phase <n> (internal roadmap)'],
	[/\bPhase \d retro\b/i, 'Phase <n> retro (internal)'],
	[/\barea \d\b/i, 'area <n> (internal roadmap)'],
	[/\bN[23]-\d/i, 'N2-/N3- (internal roadmap)'],
	[/\bWave \d\b/i, 'Wave <n> (internal roadmap)'],
	[/\bINC-\d/i, 'INC-<n> (internal roadmap)'],
	[/\bpre-import\b/i, 'pre-import (internal roadmap)'],
	[/\btest\d+ findings\b/i, 'testN findings (ephemeral run name)'],
	[/\.research\b/i, '.research (private receipts dir)'],
	[/\bprivate (notes|docs)\b/i, 'private notes/docs (internal)'],
	[/\bclawdius-private\b/i, 'clawdius-private (private repo)'],
	[/\bhomework\b/i, 'homework (internal)'],
];
for (const [re, label] of INTERNAL) {
	if (re.test(msg)) {
		errors.push(`Internal reference: ${label}`);
	}
}

if (errors.length) {
	console.error('\n  Clawdius commit-message gate (public repo) - rejected:\n');
	for (const e of errors) {
		console.error('   - ' + e);
	}
	console.error('\n  A public commit message must plainly state the change, carry a');
	console.error('  Co-authored-by trailer, keep the subject <= 72 chars, and contain no');
	console.error('  internal review/roadmap references or session URLs.');
	console.error('  See .github/clawdius-instructions.md > Commit message hygiene.');
	console.error('  (Bypass only for a genuine exception: git commit --no-verify)\n');
	process.exit(1);
}

process.exit(0);
