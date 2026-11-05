// requestState アクセサは verify フック通過後の decoded payload を返す想定（HMAC / 期限の検証は SDK 層の責務なので、検証済み値を直接渡す）。

import { digestArgs } from '../../src/private/request-state.js';

export function mrtrRound1Ctx(): Record<string, unknown> {
	return {
		server: { getClientCapabilities: () => ({ elicitation: {} }) },
	};
}

/** args は bindArgs と同じ内容にすること。nonce はテストごとに一意な値を使う。 */
export function mrtrRound2Ctx(
	action: string,
	args: Record<string, unknown>,
	nonce: string,
	confirmResponse: Record<string, unknown> = { action: 'accept', content: { confirmed: true } },
): Record<string, unknown> {
	return {
		server: { getClientCapabilities: () => ({ elicitation: {} }) },
		mcpReq: {
			inputResponses: { confirm: confirmResponse },
			requestState: () => ({ action, argsDigest: digestArgs(action, args), nonce }),
		},
	};
}
