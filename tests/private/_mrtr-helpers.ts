/**
 * MRTR (SEP-2322) 確認フローのテスト用ヘルパー。
 *
 * withElicitedConfirmation の round 2（confirm 応答つき再入）を模した
 * ハンドラ ctx（ToolHandlerExtra 相当）を組み立てる。
 * requestState アクセサは verify フック通過後の decoded payload を返す想定
 * （HMAC / 期限の検証は SDK 層の責務のため、ここでは検証済み値を直接渡す）。
 */

import { digestArgs } from '../../src/private/request-state.js';

/** elicitation 対応ホストの round 1 用 ctx（confirm 応答なし）。 */
export function mrtrRound1Ctx(): Record<string, unknown> {
	return {
		server: { getClientCapabilities: () => ({ elicitation: {} }) },
	};
}

/**
 * round 2 用 ctx を組み立てる。
 *
 * @param action - withElicitedConfirmation に渡る action（'create_order' 等）
 * @param args - ハンドラに渡す引数（bindArgs と同一オブジェクト内容にすること）
 * @param nonce - one-time nonce。テストごとに一意な値を使う
 * @param confirmResponse - inputResponses.confirm の応答（省略時は accept + confirmed=true）
 */
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
