/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ExtensionManagementErrorCode } from '../../../../../platform/extensionManagement/common/extensionManagement.js';
import { isClaudeCodePluginInstalled, isExtensionInstalled, isSignatureFailure, shouldInstallExtension } from '../../browser/clawdiusPluginSetup.js';

suite('clawdiusPluginSetup', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('isSignatureFailure matches the signature error ids by .code or .name, tolerates junk', () => {
		assert.deepStrictEqual(
			[
				isSignatureFailure({ code: ExtensionManagementErrorCode.PackageNotSigned }),
				isSignatureFailure({ code: ExtensionManagementErrorCode.SignatureVerificationInternal }),
				isSignatureFailure({ code: ExtensionManagementErrorCode.SignatureVerificationFailed }),
				isSignatureFailure({ code: ExtensionManagementErrorCode.DownloadSignature }),
				isSignatureFailure({ name: ExtensionManagementErrorCode.SignatureVerificationFailed }), // IPC: .name kept, custom .code dropped
				isSignatureFailure({ code: ExtensionManagementErrorCode.NotFound }),                     // a non-signature failure
				isSignatureFailure(new Error('boom')),                                                   // name 'Error', no code
				isSignatureFailure({ code: 42 }),                                                        // non-string code, no name
				isSignatureFailure(undefined),
				isSignatureFailure(null),
			],
			[true, true, true, true, true, false, false, false, false, false],
		);
	});

	test('isExtensionInstalled / isClaudeCodePluginInstalled are present/absent + case-insensitive on id', () => {
		const local = [
			{ identifier: { id: 'foo.bar' } },
			{ identifier: { id: 'Anthropic.Claude-Code' } }, // installed list spells the id with different casing
		];
		assert.deepStrictEqual(
			[
				isExtensionInstalled(local, 'foo.bar'),
				isExtensionInstalled(local, 'anthropic.claude-code'), // matches the mixed-case entry
				isExtensionInstalled(local, 'missing.ext'),
				isExtensionInstalled([], 'foo.bar'),
				isClaudeCodePluginInstalled(local),
				isClaudeCodePluginInstalled([{ identifier: { id: 'foo.bar' } }]),
			],
			[true, true, false, false, true, false],
		);
	});

	test('shouldInstallExtension gates by when()/installed and only re-offers critical after first run', () => {
		assert.deepStrictEqual(
			[
				shouldInstallExtension({ critical: true }, false, false),  // first run installs the critical plugin
				shouldInstallExtension({ critical: true }, true, false),   // re-offer heals the critical plugin
				shouldInstallExtension({ critical: true }, true, true),    // already installed -> skip
				shouldInstallExtension({}, false, false),                  // first run installs an optional one
				shouldInstallExtension({}, true, false),                   // re-offer skips optional first-run-only ones
				shouldInstallExtension({}, false, true),                   // already installed -> skip
				shouldInstallExtension({ when: () => false }, false, false), // platform-gated off -> skip
				shouldInstallExtension({ when: () => true }, false, false),  // platform-gated on -> install
			],
			[true, true, false, true, false, false, false, true],
		);
	});
});
