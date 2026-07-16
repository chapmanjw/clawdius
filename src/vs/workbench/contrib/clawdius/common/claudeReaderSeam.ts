/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Reader-seam interface, labels, read-model types, config-root resolver
// The pure `common/` core of the reader seam: the single read interface every Clawdius surface (the Missions
// fleet, the transcript vault, local cost) binds to for the user's own Claude Code activity. This module holds
// ONLY the vocabulary and the pure config-root resolver - the label enums, the adapter-version stamp, the
// labeled result wrapper, the index-only read-model entity types, the request shape, the `IReaderSeam`
// interface, and `resolveConfigRoot`. There is NO file access and NO parsing here (that comes later): this
// layer stays pure so it can be unit-tested without a host. Purity is enforced by `valid-layers-check`, whose
// browser tsconfig has no `@types/node`, so a Node/`process`/renderer import here fails it. The only imports
// are `URI` (base/common) and the `CLAUDE_DIR` constant, reused from `clawdiusTierPaths.ts`.

import { URI } from '../../../../base/common/uri.js';
import { CLAUDE_DIR } from './clawdiusTierPaths.js';

/**
 * How much of the requested data is in view. Distinct from {@link CompletenessState}: coverage is about
 * scope/ownership (is this run mine, someone else's, or outside what I can read), completeness is about
 * whether this particular read got everything it tried to.
 */
export enum CoverageLabel {
	/** Belongs to and is readable within the active scope. */
	InScope = 'in-scope',
	/** Exists but belongs to another workspace/scope - surfaced (not silently dropped), not read as ours. */
	Foreign = 'foreign',
	/** Outside what the seam can reach at all under the current scope. */
	OutOfScope = 'out-of-scope',
}

/** How current a result is: preferred live events, a lagging on-disk poll, or known-stale index data. */
export enum FreshnessLabel {
	/** Sourced from preferred live SDK/plugin events (active runs). */
	Live = 'live',
	/** Sourced from an on-disk read taken at poll time (lagging behind live). */
	Polled = 'polled',
	/** Known to be behind - index/recovery data only. */
	Stale = 'stale',
}

/**
 * The honest-degradation dimension: whether this read is whole, and if not, why. Every result carries one -
 * the seam degrades to a labeled state instead of throwing or fabricating a value.
 */
export enum CompletenessState {
	/** The read got everything it asked for. */
	Complete = 'complete',
	/** Read, but with a known gap (e.g. a referenced out-of-band file was missing). */
	Partial = 'partial',
	/** The source did not exist (a fresh install / empty tree) - empty, not an error. */
	Absent = 'absent',
	/** The user's Claude settings suppress this history - deliberately withheld, not missing. */
	Suppressed = 'suppressed',
	/** The on-disk shape was not recognized by any adapter version - the canary tripped. */
	UnknownShape = 'unknown-shape',
}

/**
 * Identifies which format adapter and which recognized on-disk shape produced a result, so a consumer can
 * detect a schema shift across Claude CLI versions.
 */
export interface AdapterVersionStamp {
	/** Which on-disk format the adapter reads (e.g. the transcript JSONL format). */
	readonly format: string;
	/** The recognized shape's version key (or the canary's key when the shape was unknown). */
	readonly versionKey: string;
}

/**
 * Every value the seam returns, wrapped with the four honesty labels. A consumer MUST be able to read
 * coverage, freshness, completeness, and the adapter-version stamp off any result.
 */
export interface IReaderResult<T> {
	/** The read-model entity (index-only; never an authoritative copy of Claude state). */
	readonly entity: T;
	/** How much of the requested data is in view. */
	readonly coverage: CoverageLabel;
	/** How current the entity is. */
	readonly freshness: FreshnessLabel;
	/** Whether this read is whole, and if not, why. */
	readonly completeness: CompletenessState;
	/** Which adapter/shape produced the result. */
	readonly adapterVersion: AdapterVersionStamp;
}

/**
 * A durable index handle into a transcript JSONL file: the stable file identity plus a byte offset into it.
 * This LOCATES a record; it is not a copy of the record's content. `fileIdentity` is the durable index key
 * while `mtime` (used at read time, not stored here) selects the active/newest file.
 */
export interface TranscriptIndexKey {
	/** Durable identity of the transcript file (stable as the append-only file grows). */
	readonly fileIdentity: string;
	/** Byte offset of the indexed record within that file. */
	readonly byteOffset: number;
}

// The read-model entities below are INDEX-ONLY: they carry the identity + index handle needed to locate a
// record under the resolved config root. They deliberately hold NO authoritative live state (status,
// needs-input/completed signals, worktree, resolved cost) - that state arrives from live SDK/plugin events or
// later slices; the seam is never a second copy of Claude's authoritative state.

/** A fleet run: its identity, the session it belongs to, and where it is indexed on disk. */
export interface Run {
	readonly runId: string;
	readonly sessionId: string;
	readonly index: TranscriptIndexKey;
}

/** A session: its identity and where its transcript is indexed on disk. */
export interface Session {
	readonly sessionId: string;
	readonly index: TranscriptIndexKey;
}

/** A subagent spawned by a run: its identity, its parent run, and where its transcript is indexed. */
export interface Subagent {
	readonly subagentId: string;
	readonly parentRunId: string;
	readonly index: TranscriptIndexKey;
}

/** A transcript stream located by index handle under the resolved config root. */
export interface Transcript {
	readonly sessionId: string;
	readonly index: TranscriptIndexKey;
}

// The teams/tasks/cost read model. Like the transcript entities above, these are INDEX-ONLY and
// derived: a live-and-recent view of local Claude state, never an authoritative copy. Teams/tasks ship behind
// an experimental probe; cost is token-first.

/** One teammate in a team roster: a stable id and a coarse status string. */
export interface TeamMember {
	readonly id: string;
	readonly status: string;
}

/** One message in a team's mailbox traffic, reduced to routing fields (never the message body). */
export interface MailboxMessage {
	readonly from: string;
	readonly to: string;
	readonly seq: number;
}

/** A team roster: the team identity, its members, and its mailbox traffic (the Mailbox sub-view). */
export interface TeamRoster {
	readonly teamId: string;
	readonly members: readonly TeamMember[];
	readonly mailbox: readonly MailboxMessage[];
}

/** One task in a file-locked task list: identity, status, an optional claimant, and the files it locks. */
export interface TaskEntry {
	readonly id: string;
	readonly status: string;
	readonly claimedBy?: string;
	readonly fileLocks: readonly string[];
}

/** A task list: the file-locked tasks with their claims. */
export interface TaskList {
	readonly tasks: readonly TaskEntry[];
}

/** A per-model token rollup: authoritative token counts, never a derived US-dollar figure. */
export interface ModelTokenRollup {
	readonly model: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
}

/**
 * The token-first local cost read model. Authoritative TOKEN counts only, computed locally from the
 * transcript; it deliberately carries NO US-dollar field. Per the no-estimated-USD-cost decision, a
 * list-price USD figure is never shown; only an authoritative, provider-accurate USD may ever appear (labeled,
 * and suppressed where a list price is meaningless - subscription / Bedrock / wrapper), and that is out of this
 * read model's scope.
 */
export interface CostRecord {
	readonly totalInputTokens: number;
	readonly totalOutputTokens: number;
	readonly perModel: readonly ModelTokenRollup[];
}

/** The entity a caller can request from the seam. */
export type ReaderEntityKind =
	| 'runs'
	| 'session'
	| 'subagent'
	| 'transcript-slice'
	| 'team-roster'
	| 'task-list'
	| 'cost-rollup';

/**
 * The optional scope filter on a request. NOTE: consent-scope ENFORCEMENT (and the identity-join across id
 * namespaces) is out of scope for the seam - this flag is carried, not enforced, here.
 */
export type ReaderScope = 'workspace' | 'all-consented';

/**
 * The resolved config root, or an explicit "no Claude config found here" outcome. The resolved root preserves
 * its URI scheme + authority, so a remote (WSL/SSH) window resolves the remote host's root.
 */
export type ReaderConfigRoot =
	| { readonly kind: 'resolved'; readonly root: URI }
	| { readonly kind: 'no-config' };

/** A single read request: which entity, against which resolved root, at which optional scope. */
export interface IReaderRequest {
	readonly kind: ReaderEntityKind;
	readonly root: ReaderConfigRoot;
	readonly scope?: ReaderScope;
}

/**
 * The single read interface the Missions fleet, transcript vault, and local-cost surfaces consume. Read-only
 * and index-only: it never writes under the config root and is never the SDK `sessionStore`.
 */
export interface IReaderSeam {
	/** Read one entity, returning it wrapped with the four honesty labels. Never throws for a degraded read. */
	read<T>(request: IReaderRequest): Promise<IReaderResult<T>>;
}

/**
 * Resolve the config root of the ACTIVE window's host, purely over injected inputs. When `env`
 * (`CLAUDE_CONFIG_DIR`) is a non-empty string, that directory is used - but it is REBASED onto the active
 * window's host: when a home URI is provided the env path is resolved against the home's scheme + authority, so
 * a `CLAUDE_CONFIG_DIR` set inside a remote (WSL/SSH) window resolves the REMOTE host, not the local one;
 * only when there is no home is a bare local `file:` URI used. When `env` is unset, the `CLAUDE_DIR`
 * (`.claude`) default under the home is used - and because {@link URI.joinPath} preserves the URI's scheme +
 * authority, a remote-authority home again resolves the remote host's root. Else (no env AND no home - e.g. an
 * unresolvable/headless host) an honest `no-config` result is returned. Never hardcodes `~/.claude`.
 * No Node/`process`/renderer import - pure over its arguments.
 */
export function resolveConfigRoot(env: string | undefined, homeUri: URI | undefined): ReaderConfigRoot {
	if (env !== undefined && env.length > 0) {
		// Rebase the env path onto the active window's host so a remote window keeps the remote scheme +
		// authority (mirrors how the config store resolves an absolute path onto the importer's provider);
		// `URI.file(env).path` normalizes the native path, then `.with` swaps only the path.
		if (homeUri) {
			return { kind: 'resolved', root: homeUri.with({ path: URI.file(env).path }) };
		}
		return { kind: 'resolved', root: URI.file(env) };
	}
	if (homeUri) {
		return { kind: 'resolved', root: URI.joinPath(homeUri, CLAUDE_DIR) };
	}
	return { kind: 'no-config' };
}
// CLAWDIUS-END
