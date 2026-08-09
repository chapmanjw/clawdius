/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claude Code Config store - watch relevance + edge-triggered change
// Drives the REAL `ClawdiusConfigStore` over a real `FileService` + `InMemoryFileSystemProvider`, so the watch
// filter and the change emitter are exercised as the workbench actually runs them rather than reimplemented here.
// The obligation these tests hold the store to - the signature invariant - is stated once, on
// `IClawdiusConfigService.onDidChange`; the bullets below only name which instance of it each test pins.
// Two regressions are pinned:
//   - the transcript corpus under `~/.claude/projects` must never schedule a config rescan (it is Claude Code
//     runtime state the store never opens, and it is appended to continuously while an agent session runs), while
//     a real config edit next to it still must. Note what that claim is about: the RESCAN, not the event. The two
//     have to be measured separately, because `onDidChange` is edge-triggered on the snapshot and a journal append
//     changes nothing the snapshot models - so a fire count alone reads 0 whether the filter is there or not, and
//     would pin nothing at all. The scan itself is what costs (roughly 1.7 MB of reads across settings.json, every
//     SKILL.md and the plugins tree, on every append during a live session), so the scan is what is asserted on.
//   - `onDidChange` must be EDGE-triggered, so a rescan that produced an identical configuration does not make
//     every consumer tear down and rebuild - while the FIRST resolve still fires, because that is what releases
//     consumers from their "scanning..." state, and while an edit the snapshot only SUMMARISES (a settings.json
//     key no section scans) still fires, because the Effective and MCP surfaces re-read on nothing else.
//   - the same must hold for a source the snapshot does not summarise but the Effective tab still RESOLVES: a
//     server-managed policy push to `~/.claude/remote-settings.json` has to fire even though no section models it.
//   - and for the plugin registry indexes the Plugins tab re-reads on this event (PLUGIN_REGISTRY_FILES), and for a
//     nested workspace CLAUDE.md the context-budget surfaces re-walk on it. Both are the same defect shape as the
//     one above - watched, re-read on the event, absent from the fired signature - and each new test below pairs its
//     positive with a transcript append, because the obvious repair for any of them (fire on every scan) passes
//     every positive half and silently undoes the filter the first test pins.
//   - a watcher event that arrives while a scan is running must not be absorbed by that scan. The scan may already
//     have read the file that changed, so joining it silently drops the edit; the watcher therefore queues a rerun
//     while a plain consumer `refresh()` still coalesces. That test carries a transcript append too, for the same
//     reason: making EVERY caller queue a rerun would pass its positive half and put the storm straight back.

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService, IWatchOptions } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { TestPathService } from '../../../../test/browser/workbenchTestServices.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { ClawdiusConfigStore, encodeProjectDir } from '../../browser/clawdiusConfigStore.js';
import { ConfigSection, PLUGIN_REGISTRY_FILES } from '../../common/clawdiusConfig.js';
import { REMOTE_SETTINGS_JSON } from '../../common/clawdiusTierPaths.js';

/**
 * An in-memory provider that records what the store asks of the filesystem: how many files it read, and which
 * paths it asked to watch.
 *
 * The read count is how a test asserts that a config SCAN ran - a fact `onDidChange` cannot report now that it is
 * edge-triggered on the snapshot. `readFile` is the right probe on two counts. It is always called:
 * `FileService.readFile` asks for the unbuffered path on a provider with `FileReadWrite`, and that path issues
 * `provider.readFile` unconditionally, even for a path that does not exist (the ENOENT surfaces on the stream
 * instead). And nothing else in a test calls it - `writeFile`, `createFolder` and `watch` never read - so the count
 * moves only when the store scans, which it opens by reading `<claudeDir>/settings.json` for every scope.
 *
 * The watch set is asserted on DIRECTLY rather than through delivered events, and that is deliberate: this provider
 * fires every change to every listener regardless of what was requested, so an event-shaped assertion cannot tell a
 * path the store watches from one it merely used to hear about because some other component watched it broadly.
 *
 * It can also HOLD a read open ({@link gateNextReadOf}), which is what turns "a change landed while a scan was
 * running" from a race a test hopes to win into a fact it controls.
 */
class RecordingInMemoryFileSystemProvider extends InMemoryFileSystemProvider {

	private _reads = 0;
	/** Total `readFile` calls since construction. */
	get reads(): number { return this._reads; }

	/** Every path a watch was requested for, as its URI string. */
	readonly watched = new Set<string>();

	/** The armed one-shot gate: the URI whose next read parks, the promise that read waits on, and the callback
	 *  that tells the test the read has been reached. Undefined whenever no gate is armed. */
	private _gate: { readonly key: string; readonly held: Promise<void>; readonly signalArrived: () => void } | undefined;

	/**
	 * Park the NEXT read of `resource` until `release()` is called; `parked` resolves once the store has actually
	 * reached that read, so a test can act on a scan it KNOWS is suspended mid-flight.
	 *
	 * One-shot deliberately: the rerun a test is measuring re-reads the same file, and gating that too would just
	 * deadlock the assertion it exists to make.
	 */
	gateNextReadOf(resource: URI): { readonly parked: Promise<void>; readonly release: () => void } {
		let release: () => void = () => { };
		const held = new Promise<void>(resolve => { release = resolve; });
		let signalArrived: () => void = () => { };
		const parked = new Promise<void>(resolve => { signalArrived = resolve; });
		this._gate = { key: resource.toString(), held, signalArrived };
		return { parked, release };
	}

	override async readFile(resource: URI): Promise<Uint8Array> {
		this._reads++;
		const gate = this._gate;
		if (gate && gate.key === resource.toString()) {
			this._gate = undefined;
			gate.signalArrived();
			await gate.held;
		}
		return super.readFile(resource);
	}

	override watch(resource: URI, opts: IWatchOptions): IDisposable {
		this.watched.add(resource.toString());
		return super.watch(resource, opts);
	}
}

suite('Clawdius config store - watch relevance and change emission', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const HOME = URI.file('/home/tester');
	const CLAUDE_DIR = URI.joinPath(HOME, '.claude');
	const FOLDER = URI.file('/work/proj');
	const SESSION = '5c2af930-2a73-4f6b-9011-72fdfa851624';

	/** Comfortably past the store's own 250ms debounce plus one scan, so "no fire" means no fire. */
	const SETTLE_MS = 700;

	function makeFs(): { fs: FileService; provider: RecordingInMemoryFileSystemProvider } {
		const fs = store.add(new FileService(new NullLogService()));
		const provider = store.add(new RecordingInMemoryFileSystemProvider());
		store.add(fs.registerProvider(Schemas.file, provider));
		return { fs, provider };
	}

	function makeStore(fs: IFileService): ClawdiusConfigStore {
		return store.add(new ClawdiusConfigStore(
			fs,
			new TestPathService(HOME, HOME.scheme),
			new TestContextService(testWorkspace(FOLDER)),
			new NullLogService(),
		));
	}

	async function write(fs: IFileService, uri: URI, content: string): Promise<void> {
		await fs.writeFile(uri, VSBuffer.fromString(content));
	}

	/** The run journal a live workflow appends to, four levels under its project dir. */
	function journalUri(): URI {
		return URI.joinPath(
			CLAUDE_DIR, 'projects', encodeProjectDir(FOLDER), SESSION, 'subagents', 'workflows', 'wf_a1b2c3d4-e5f', 'journal.jsonl');
	}

	/** The per-project auto memory the scan DOES read from inside the transcript tree - the one carve-out in the
	 *  `projects/` rejection, and the reason that rejection cannot be a blanket prefix match. */
	function autoMemoryUri(): URI {
		return URI.joinPath(CLAUDE_DIR, 'projects', encodeProjectDir(FOLDER), 'memory', 'MEMORY.md');
	}

	/** Every directory and file the measurement window will only OVERWRITE, staged before the first scan so the
	 *  window sees a single `UPDATED` event rather than the `ADDED` burst a fresh tree would also emit. */
	async function stageTree(fs: IFileService): Promise<void> {
		await fs.createFolder(URI.joinPath(journalUri(), '..'));
		await write(fs, journalUri(), '{"type":"started","agentId":"a1"}\n');
		await write(fs, autoMemoryUri(), '# Auto memory\n');
		await write(fs, URI.joinPath(CLAUDE_DIR, 'CLAUDE.md'), '# Memory\n');
	}

	test('a transcript write under projects/ never schedules a config rescan, while real config beside it still does', async function () {
		this.timeout(20000);
		const { fs, provider } = makeFs();
		await stageTree(fs);
		const configStore = makeStore(fs);
		await configStore.refresh();
		// The in-memory provider batches its change events on a timer, so the staging writes above are still in
		// flight here. Drain them before counting, or the first measurement inherits a refresh it did not cause.
		await timeout(SETTLE_MS);

		let fired = 0;
		store.add(configStore.onDidChange(() => { fired++; }));
		/** The state a step is measured against: fires so far, and reads so far (see the suite header for why both). */
		let mark = { fired, reads: provider.reads };
		const since = () => {
			const step = { fired: fired - mark.fired, rescanned: provider.reads > mark.reads };
			mark = { fired, reads: provider.reads };
			return step;
		};

		// The corpus churn: an agent session appends to its run journal. `FileChangesEvent.affects(~/.claude)` is a
		// subtree prefix match, so before the filter was narrowed this alone forced a full rescan of every scope.
		await write(fs, journalUri(), '{"type":"started","agentId":"a1"}\n{"type":"result","agentId":"a1"}\n');
		await timeout(SETTLE_MS);
		const transcript = since();

		// The carve-out: the per-project auto memory lives INSIDE `projects/`, and the scan really does read it.
		await write(fs, autoMemoryUri(), '# Auto memory\n\nA second paragraph that changes the measured size.\n');
		await timeout(SETTLE_MS);
		const autoMemory = since();

		// And a plain config edit outside `projects/` must still get through unchanged.
		await write(fs, URI.joinPath(CLAUDE_DIR, 'CLAUDE.md'), '# Memory\n\nA second paragraph that changes the measured size.\n');
		await timeout(SETTLE_MS);

		assert.deepStrictEqual(
			{ transcript, autoMemory, memoryEdit: since() },
			{
				transcript: { fired: 0, rescanned: false },
				autoMemory: { fired: 1, rescanned: true },
				memoryEdit: { fired: 1, rescanned: true },
			},
		);
	});

	test('the per-project auto memory is watched by this store, and the transcript tree around it is not', async function () {
		this.timeout(15000);
		// The store reads `~/.claude/projects/<enc>/memory/MEMORY.md` as a real config item, and until this watch
		// existed it only ever heard about that file as collateral: `ClaudeWorkflowObservationService` held an
		// UNCORRELATED recursive watch over the whole `projects` corpus, so every transcript append in it was
		// broadcast on the global bus and this store's subtree-prefix filter accepted the lot - the coupling that
		// drove the Control Center rebuild storm. That request is correlated now and its events never reach the bus,
		// so the auto memory needs a watch this store owns. It has to be the `memory` FOLDER and not the tree above
		// it: watching `projects` recursively is exactly the request that was just severed.
		const { fs, provider } = makeFs();
		await stageTree(fs);
		const configStore = makeStore(fs);
		await configStore.refresh();

		const projectsDir = URI.joinPath(CLAUDE_DIR, 'projects');
		assert.deepStrictEqual(
			{
				autoMemoryFolder: provider.watched.has(URI.joinPath(projectsDir, encodeProjectDir(FOLDER), 'memory').toString()),
				projectsTree: provider.watched.has(projectsDir.toString()),
			},
			{ autoMemoryFolder: true, projectsTree: false },
		);
	});

	test('onDidChange is edge-triggered: the first resolve fires, an identical rescan does not', async function () {
		this.timeout(15000);
		const { fs } = makeFs();
		await stageTree(fs);
		const configStore = makeStore(fs);

		let fired = 0;
		store.add(configStore.onDidChange(() => { fired++; }));

		await configStore.refresh();
		const afterFirst = fired;
		// Nothing on disk moved, so this scan produces an identical configuration. Firing on it is what made the
		// Control Center clear its caches and rebuild its whole tab for no change at all.
		await configStore.refresh();

		assert.deepStrictEqual(
			{ afterFirst, afterIdenticalRescan: fired, hasResolved: configStore.hasResolved },
			{ afterFirst: 1, afterIdenticalRescan: 1, hasResolved: true },
		);
	});

	test('an edit the snapshot only SUMMARISES still fires: a settings.json key no section scans, and an MCP server def', async function () {
		this.timeout(15000);
		const { fs } = makeFs();
		await stageTree(fs);
		// `model` appears in no `CONFIG_SECTIONS` scan and `mcpServers` entries are modelled by NAME alone, so both
		// of the edits below leave the snapshot byte-identical. They still have to fire: the Control Center's
		// Effective tab re-resolves the whole settings chain, and its MCP rows re-read each server's command/args,
		// and BOTH drop those caches on this event and on nothing else short of a manual Refresh button.
		await fs.createFolder(FOLDER);
		await write(fs, URI.joinPath(CLAUDE_DIR, 'settings.json'), '{"model":"opus"}\n');
		await write(fs, URI.joinPath(FOLDER, '.mcp.json'), '{"mcpServers":{"srv":{"command":"serve","args":["--port","9000"]}}}\n');
		const configStore = makeStore(fs);
		await configStore.refresh();

		let fired = 0;
		store.add(configStore.onDidChange(() => { fired++; }));

		await write(fs, URI.joinPath(CLAUDE_DIR, 'settings.json'), '{"model":"sonnet"}\n');
		await configStore.refresh(true);
		const afterSettingsEdit = fired;

		await write(fs, URI.joinPath(FOLDER, '.mcp.json'), '{"mcpServers":{"srv":{"command":"serve","args":["--port","9001"]}}}\n');
		await configStore.refresh(true);
		const afterMcpEdit = fired;

		// And the edge trigger still holds for a rescan that changed nothing at all.
		await configStore.refresh(true);

		assert.deepStrictEqual(
			{ afterSettingsEdit, afterMcpEdit, afterIdenticalRescan: fired },
			{ afterSettingsEdit: 1, afterMcpEdit: 2, afterIdenticalRescan: 2 },
		);
	});

	test('a server-managed policy push fires, and a transcript append still does not', async function () {
		this.timeout(20000);
		// The two halves belong in ONE test because they are the two sides of the same trade. `remote-settings.json`
		// is a source the Effective tab RESOLVES but no section scans, so before its body joined the fired signature a
		// policy push produced a byte-identical scan and the tab kept serving pre-push values for the rest of the
		// session. The obvious repair - fire on every scan - would have passed the first half and silently undone the
		// second, which is the whole point of the edge trigger, so both are measured against the same store.
		//
		// Driven through the WATCHER (write, then settle) rather than a forced refresh, so the push is pinned end to
		// end: the write has to reach `isRelevant` as a direct child of `~/.claude` AND then move the signature. A
		// forced refresh would skip the first half and still pass.
		const { fs } = makeFs();
		await stageTree(fs);
		const remoteSettings = URI.joinPath(CLAUDE_DIR, REMOTE_SETTINGS_JSON);
		await write(fs, remoteSettings, '{"permissions":{"defaultMode":"plan"}}\n');
		const configStore = makeStore(fs);
		await configStore.refresh();
		// Drain the staging writes, which the in-memory provider batches on a timer, before the window opens.
		await timeout(SETTLE_MS);

		let fired = 0;
		store.add(configStore.onDidChange(() => { fired++; }));

		await write(fs, remoteSettings, '{"permissions":{"defaultMode":"acceptEdits"}}\n');
		await timeout(SETTLE_MS);
		const afterPolicyPush = fired;

		await write(fs, journalUri(), '{"type":"started","agentId":"a1"}\n{"type":"result","agentId":"a1"}\n');
		await timeout(SETTLE_MS);

		assert.deepStrictEqual(
			{ afterPolicyPush, afterTranscriptAppend: fired },
			{ afterPolicyPush: 1, afterTranscriptAppend: 1 },
		);
	});

	/** `~/.claude/plugins/<file>` - the registry indexes the Plugins tab re-reads whenever the store fires. */
	function pluginsUri(file: string): URI {
		return URI.joinPath(CLAUDE_DIR, 'plugins', file);
	}

	/** One marketplace catalog, three levels under `plugins/` - read by the Plugins tab, deliberately NOT recorded. */
	function catalogUri(marketplace: string): URI {
		return URI.joinPath(CLAUDE_DIR, 'plugins', 'marketplaces', marketplace, '.claude-plugin', 'marketplace.json');
	}

	test('a marketplace add fires, the catalog beside it rides on that write, and a transcript append does not', async function () {
		this.timeout(30000);
		// `known_marketplaces.json` reached no part of the snapshot - no scan opens it - while the Plugins tab re-reads
		// it on `onDidChange` and on nothing else short of its own Refresh button. The tab's "Add marketplace" button
		// stages `claude plugin marketplace add` in a terminal and returns without re-reading anything, so the CLI's
		// write was the only thing that could refresh the list: it scheduled a scan (a direct child of the watched
		// `~/.claude`), the scan came out byte-identical, and the new marketplace never appeared.
		//
		// The third step pins the deliberate exception rather than a limitation to fix. A catalog rewrite ALONE does
		// not fire, because `marketplaces/<name>/.claude-plugin/marketplace.json` is ~170KB for the official
		// marketplace and putting that through every scan's signature comparison is not worth it. It does not need to
		// be: the CLI stamps `lastUpdated` in known_marketplaces.json on every marketplace refresh (manual update and
		// background autoUpdate alike), so the real sequence is step 2 - catalog plus registry, one fire, and the
		// tab's re-read picks up every catalog in that same pass.
		const { fs } = makeFs();
		await stageTree(fs);
		await write(fs, pluginsUri('known_marketplaces.json'), '{"acme":{"source":{"source":"github","repo":"acme/plugins"},"lastUpdated":"2026-01-01T00:00:00.000Z"}}\n');
		await write(fs, catalogUri('acme'), '{"plugins":[{"name":"one"}]}\n');
		const configStore = makeStore(fs);
		await configStore.refresh();
		await timeout(SETTLE_MS);

		let fired = 0;
		store.add(configStore.onDidChange(() => { fired++; }));

		// `claude plugin marketplace add beta/plugins` - a new key, and nothing in the snapshot models this file.
		await write(fs, pluginsUri('known_marketplaces.json'),
			'{"acme":{"source":{"source":"github","repo":"acme/plugins"},"lastUpdated":"2026-01-01T00:00:00.000Z"},'
			+ '"beta":{"source":{"source":"github","repo":"beta/plugins"},"lastUpdated":"2026-01-02T00:00:00.000Z"}}\n');
		await timeout(SETTLE_MS);
		const afterMarketplaceAdd = fired;

		// `claude plugin marketplace update acme` - the catalog is rewritten AND `lastUpdated` is restamped.
		await write(fs, catalogUri('acme'), '{"plugins":[{"name":"one"},{"name":"two"}]}\n');
		await write(fs, pluginsUri('known_marketplaces.json'),
			'{"acme":{"source":{"source":"github","repo":"acme/plugins"},"lastUpdated":"2026-03-03T00:00:00.000Z"},'
			+ '"beta":{"source":{"source":"github","repo":"beta/plugins"},"lastUpdated":"2026-01-02T00:00:00.000Z"}}\n');
		await timeout(SETTLE_MS);
		const afterMarketplaceUpdate = fired;

		await write(fs, catalogUri('acme'), '{"plugins":[{"name":"one"},{"name":"two"},{"name":"three"}]}\n');
		await timeout(SETTLE_MS);
		const afterCatalogOnlyWrite = fired;

		await write(fs, journalUri(), '{"type":"started","agentId":"a1"}\n{"type":"result","agentId":"a1"}\n');
		await timeout(SETTLE_MS);

		assert.deepStrictEqual(
			{ afterMarketplaceAdd, afterMarketplaceUpdate, afterCatalogOnlyWrite, afterTranscriptAppend: fired },
			{ afterMarketplaceAdd: 1, afterMarketplaceUpdate: 2, afterCatalogOnlyWrite: 2, afterTranscriptAppend: 2 },
		);
	});

	test('an installed-plugin version bump fires even though the snapshot models only the keys, and a transcript append does not', async function () {
		this.timeout(20000);
		// The store models `installed_plugins.json` by its `plugins` KEYS plus each entry's `installPath` (and the
		// bundled files scanned out of that directory). The Plugins tab renders each row's `version`, which reaches no
		// snapshot field - so a rewrite that relabels an entry in place, leaving the keys and the install path alone,
		// produced a byte-identical scan and left the installed rows showing the old version. The edit below is
		// exactly that shape: same key, same installPath, `version` only.
		const { fs } = makeFs();
		await stageTree(fs);
		const installed = (version: string) =>
			`{"version":1,"plugins":{"demo@acme":[{"installPath":"/plugins/cache/acme/demo","version":"${version}"}]}}\n`;
		await write(fs, pluginsUri('installed_plugins.json'), installed('1.0.0'));
		const configStore = makeStore(fs);
		await configStore.refresh();
		await timeout(SETTLE_MS);

		let fired = 0;
		store.add(configStore.onDidChange(() => { fired++; }));

		await write(fs, pluginsUri('installed_plugins.json'), installed('1.1.0'));
		await timeout(SETTLE_MS);
		const afterVersionBump = fired;

		await write(fs, journalUri(), '{"type":"started","agentId":"a1"}\n{"type":"result","agentId":"a1"}\n');
		await timeout(SETTLE_MS);

		assert.deepStrictEqual(
			{ afterVersionBump, afterTranscriptAppend: fired },
			{ afterVersionBump: 1, afterTranscriptAppend: 1 },
		);
	});

	test('every PLUGIN_REGISTRY_FILES entry is in the fired signature, and a transcript append still is not', async function () {
		this.timeout(30000);
		// The structural half of the two tests above: it walks the SHARED list the store records from and the Plugins
		// tab's typed reader reads through, so a registry file added to that list arrives here already covered without
		// anyone writing a test for it. It does NOT cover a file the tab reads around that list - see
		// `PluginRegistryFile` for why the typed reader is a landing spot rather than a compiler gate. The edit is
		// whitespace only, which is the point: it cannot move any snapshot field, so a fire proves the file's RAW BODY
		// reaches the signature rather than something the scan happens to model.
		const { fs } = makeFs();
		await stageTree(fs);
		for (const file of PLUGIN_REGISTRY_FILES) {
			await write(fs, pluginsUri(file), '{}\n');
		}
		const configStore = makeStore(fs);
		await configStore.refresh();
		await timeout(SETTLE_MS);

		let fired = 0;
		store.add(configStore.onDidChange(() => { fired++; }));

		// Forced refreshes here, one file at a time: relevance for `~/.claude/plugins/**` is already pinned by the
		// marketplace test driving through the watcher, so what is left to measure per file is the SIGNATURE.
		const perFile: Record<string, number> = {};
		for (const file of PLUGIN_REGISTRY_FILES) {
			const before = fired;
			await write(fs, pluginsUri(file), '{ }\n');
			await configStore.refresh(true);
			perFile[file] = fired - before;
		}
		const expectedPerFile: Record<string, number> = {};
		for (const file of PLUGIN_REGISTRY_FILES) { expectedPerFile[file] = 1; }

		// Drain the watcher events the writes above queued, so the transcript window measures only itself.
		await timeout(SETTLE_MS);
		const beforeTranscript = fired;
		await write(fs, journalUri(), '{"type":"started","agentId":"a1"}\n{"type":"result","agentId":"a1"}\n');
		await timeout(SETTLE_MS);

		assert.deepStrictEqual(
			{ perFile, transcriptFires: fired - beforeTranscript },
			{ perFile: expectedPerFile, transcriptFires: 0 },
		);
	});

	test('a nested workspace CLAUDE.md the budget panel is showing fires, an unwatched one does not, and neither does a transcript append', async function () {
		this.timeout(30000);
		// Nested (subtree) CLAUDE.md files are the one config the scan cannot enumerate: they are found by walking up
		// from the ACTIVE FILE, so `nestedMemoriesFor` reads them outside the scan and nothing they contain reached the
		// snapshot. The context-budget panel and its status-bar pill both cache the walk per active file and clear that
		// cache only in their `onDidChange` handler - switching editors selects another key, it does not clear anything
		// - so an edit to the nested file left the token count frozen until some unrelated config change fired the
		// event. Under the old unconditional fire any `~/.claude` write did that incidentally, which made the staleness
		// intermittent instead of permanent.
		const { fs } = makeFs();
		await stageTree(fs);
		const nested = URI.joinPath(FOLDER, 'src', 'CLAUDE.md');
		await write(fs, nested, '# Nested\n');
		const configStore = makeStore(fs);
		await configStore.refresh();
		await timeout(SETTLE_MS);

		let fired = 0;
		store.add(configStore.onDidChange(() => { fired++; }));

		// Nobody has asked about this file yet, so no surface can be stale on it. Accepting the event here would
		// schedule a scan for a signature that cannot move - which is the half-fix this store must not ship.
		await write(fs, nested, '# Nested\n\nEdited before anything asked for it.\n');
		await timeout(SETTLE_MS);
		const beforeAnyoneAsked = fired;

		// The budget panel resolves the chain for the active file, which is what puts it in scope. The chain arriving
		// grows the recorded set, so the next scan legitimately sees a new signature and fires once - the documented
		// one-per-directory-change cost of tracking only the most recent chain.
		await configStore.nestedMemoriesFor(URI.joinPath(FOLDER, 'src', 'app.ts'), [FOLDER]);
		// That scan has to land HERE, between the probe and the edit, or the assertion below proves much less than it
		// reads as. Without it, one scan absorbs both changes and the resulting signature differs for two independent
		// reasons - a new key appeared AND its body changed - so a store that recorded any constant per probed URI
		// would pass. Running it now banks the file's CURRENT body, which leaves the body CHANGING as the only thing
		// left that can move the signature afterwards.
		await configStore.refresh(true);
		const afterChainEnteredScope = fired;

		await write(fs, nested, '# Nested\n\nA longer body that changes this file\'s token estimate.\n');
		await timeout(SETTLE_MS);
		const afterNestedEdit = fired;

		await write(fs, journalUri(), '{"type":"started","agentId":"a1"}\n{"type":"result","agentId":"a1"}\n');
		await timeout(SETTLE_MS);

		assert.deepStrictEqual(
			{ beforeAnyoneAsked, afterChainEnteredScope, afterNestedEdit, afterTranscriptAppend: fired },
			{ beforeAnyoneAsked: 0, afterChainEnteredScope: 1, afterNestedEdit: 2, afterTranscriptAppend: 2 },
		);
	});

	/** The Global scope's Memories items by label - the surface a `claudeMdExcludes` edit is visible in, and the
	 *  reason the mid-scan test edits that key rather than something only the fired signature would notice. */
	function globalMemoryLabels(configStore: ClawdiusConfigStore): string[] {
		return configStore.snapshot.scopes
			.find(scope => scope.key === 'global')?.sections
			.find(group => group.section === ConfigSection.Memories)?.items.map(item => item.label) ?? [];
	}

	test('a watcher change landing mid-scan is not absorbed by that scan, and a transcript append still schedules no rescan', async function () {
		this.timeout(30000);
		// A watcher event says the FILESYSTEM changed, and the running scan may already have read the file that
		// changed - so coalescing onto it drops the edit outright: the snapshot keeps the pre-edit content, the
		// signature does not move, `onDidChange` never fires, and every consumer stays stale until some unrelated
		// config event starts another scan. The watcher therefore queues a rerun where a plain consumer `refresh()`
		// still coalesces, which is why the second half of this test matters as much as the first: making EVERY
		// caller queue a rerun would pass the first half, give each of the eight section views a redundant second
		// startup scan, and re-arm the transcript-driven rebuild storm the whole suite exists to keep out.
		const { fs, provider } = makeFs();
		await stageTree(fs);
		const settings = URI.joinPath(CLAUDE_DIR, 'settings.json');
		const globalMemory = URI.joinPath(CLAUDE_DIR, 'CLAUDE.md');
		await write(fs, settings, '{}\n');
		const configStore = makeStore(fs);
		await configStore.refresh();
		// Drain the staging writes, which the in-memory provider batches on a timer, before the window opens.
		await timeout(SETTLE_MS);
		const beforeMidScanEdit = globalMemoryLabels(configStore);

		// Park a scan on its read of `~/.claude/CLAUDE.md`. That read happens in `scanScope`, which `_doRefresh`
		// starts only AFTER the settings.json pass has fully resolved - so at this point the running scan has
		// already banked `claudeMdExcludes: []` and can no longer notice the edit below. That ordering is what
		// makes this a real mid-scan change rather than a hopeful one.
		const gate = provider.gateNextReadOf(globalMemory);
		const scan = configStore.refresh();
		await gate.parked;

		// The edit itself: `claudeMdExcludes` suppresses the Global CLAUDE.md, so a scan that sees it drops that
		// item from the snapshot. Chosen over a signature-only edit because it is visible in the snapshot the
		// Control Center actually renders, which is where the staleness was.
		await write(fs, settings, `{"claudeMdExcludes":[${JSON.stringify(globalMemory.fsPath)}]}\n`);
		// Past the watcher's delivery plus the store's 250ms coalescing timer, so the refresh this write schedules
		// definitely lands WHILE the gated scan is still parked - the exact moment the defect discarded it.
		await timeout(SETTLE_MS);
		gate.release();
		// `refresh()` returns the LOOP promise, so this also awaits the rerun the watcher queued behind the scan.
		await scan;
		await timeout(SETTLE_MS);
		const afterMidScanEdit = globalMemoryLabels(configStore);

		let fired = 0;
		store.add(configStore.onDidChange(() => { fired++; }));
		const readsBeforeTranscript = provider.reads;
		await write(fs, journalUri(), '{"type":"started","agentId":"a1"}\n{"type":"result","agentId":"a1"}\n');
		await timeout(SETTLE_MS);

		assert.deepStrictEqual(
			{
				beforeMidScanEdit, afterMidScanEdit,
				transcript: { fired, rescanned: provider.reads > readsBeforeTranscript },
			},
			{
				beforeMidScanEdit: ['CLAUDE.md'], afterMidScanEdit: [],
				transcript: { fired: 0, rescanned: false },
			},
		);
	});
});
// CLAWDIUS-END
