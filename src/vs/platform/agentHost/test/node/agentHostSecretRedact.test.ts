/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { redactSecrets } from '../../node/agentHostSecretRedact.js';

suite('agentHostSecretRedact / redactSecrets', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('redacts distinctive-prefix provider secrets and known-secret env assignments; leaves ordinary text intact', () => {
		const cases: [string, string][] = [
			['engine key sk-ant-api03-AbC123_def-XYZ890abcdef here', 'engine key <redacted> here'],
			['oauth sk-ant-oat01-Tok_en-1234567890 done', 'oauth <redacted> done'],
			['id AKIAIOSFODNN7EXAMPLE used', 'id <redacted> used'],
			['sts ASIAIOSFODNN7EXAMPLE used', 'sts <redacted> used'],
			['lwa amzn1.application-oa2-client.abc123DEF456ghi789 secret', 'lwa <redacted> secret'],
			['refresh Atzr|IwEBIAabc_123-DEF456ghijk token', 'refresh <redacted> token'],
			['ANTHROPIC_API_KEY=sk-ant-api03-secret_value-abcdefgh', 'ANTHROPIC_API_KEY=<redacted>'],
			['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY end', 'AWS_SECRET_ACCESS_KEY=<redacted> end'],
			['plain diagnostic line, no secrets, path C:/tmp/x', 'plain diagnostic line, no secrets, path C:/tmp/x'],
			['two AKIAIOSFODNN7EXAMPLE and sk-ant-oat01-second_tok_12345', 'two <redacted> and <redacted>'],
			['ANTHROPIC_AUTH_TOKEN=opaque_token_value_1234 x', 'ANTHROPIC_AUTH_TOKEN=<redacted> x'],
			['AWS_SESSION_TOKEN=FQoGZXIvYXdzEExampleOpaqueSession y', 'AWS_SESSION_TOKEN=<redacted> y'],
			['AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE z', 'AWS_ACCESS_KEY_ID=<redacted> z'],
			['sha 356a192b7913b04c54574d18c28d46e6395428ab kept', 'sha 356a192b7913b04c54574d18c28d46e6395428ab kept'],
			['b64 YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo= kept', 'b64 YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo= kept'],
			['uuid 550e8400-e29b-41d4-a716-446655440000 kept', 'uuid 550e8400-e29b-41d4-a716-446655440000 kept']
		];
		assert.deepStrictEqual(
			cases.map(([input]) => redactSecrets(input)),
			cases.map(([, expected]) => expected),
		);
	});
});
