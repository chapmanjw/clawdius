/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 John Chapman (Clawdius). All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CLAWDIUS-BEGIN Claims-to-receipts registry unit tests
// Covers the registry's well-formedness (no duplicate or empty claims, valid status), the known-vs-estimated
// discipline in both directions (an estimated receipt states it is not yet shipped; a known receipt does
// not), the public-safety rule that a receipt carries no internal task id, and the lookup helpers.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CLAIM_RECEIPTS, findClaimReceipt, hasReceipt } from '../../common/claudeClaimsRegistry.js';

/** Wording that marks a receipt as resting on something not yet shipped. */
const PENDING = /not yet|stays estimated until|until .*\blands\b/i;

suite('Clawdius claims-to-receipts registry', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the registry is non-empty', () => {
		assert.ok(CLAIM_RECEIPTS.length > 0);
	});

	test('every entry is well-formed with a valid status', () => {
		for (const entry of CLAIM_RECEIPTS) {
			assert.ok(entry.claim.trim().length > 0, 'claim must be non-empty');
			assert.ok(entry.receipt.trim().length > 0, `receipt must be non-empty for: ${entry.claim}`);
			assert.ok(entry.surface.trim().length > 0, `surface must be non-empty for: ${entry.claim}`);
			assert.ok(entry.status === 'known' || entry.status === 'estimated', `invalid status for: ${entry.claim}`);
		}
	});

	test('no two entries claim the same thing', () => {
		const claims = CLAIM_RECEIPTS.map(entry => entry.claim);
		assert.strictEqual(new Set(claims).size, claims.length, 'duplicate claim in the registry');
	});

	test('an estimated receipt states it is not yet shipped', () => {
		for (const entry of CLAIM_RECEIPTS.filter(e => e.status === 'estimated')) {
			assert.ok(PENDING.test(entry.receipt), `estimated receipt must state it is pending: ${entry.claim}`);
		}
	});

	test('a known receipt does not rest on something not yet shipped', () => {
		for (const entry of CLAIM_RECEIPTS.filter(e => e.status === 'known')) {
			assert.ok(!PENDING.test(entry.receipt), `known receipt must not use pending wording: ${entry.claim}`);
		}
	});

	test('no receipt leaks an internal task id (public-safety)', () => {
		for (const entry of CLAIM_RECEIPTS) {
			assert.ok(!/\bT\d{3}\b|\bP[1-5]\b/.test(entry.receipt), `receipt must not embed an internal task id: ${entry.claim}`);
		}
	});

	test('findClaimReceipt returns the entry for a registered claim and undefined otherwise', () => {
		const known = CLAIM_RECEIPTS[0];
		assert.strictEqual(findClaimReceipt(known.claim), known);
		assert.strictEqual(findClaimReceipt('a claim no surface makes'), undefined);
	});

	test('hasReceipt is true only for a registered claim', () => {
		assert.strictEqual(hasReceipt(CLAIM_RECEIPTS[0].claim), true);
		assert.strictEqual(hasReceipt('an unregistered marketed claim'), false);
	});
});

// CLAWDIUS-END
