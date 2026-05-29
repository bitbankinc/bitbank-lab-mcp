/**
 * Private API の有効化チェック。
 * BITBANK_API_KEY と BITBANK_API_SECRET の両方が設定されている場合のみ有効。
 */

export interface PrivateApiConfig {
	apiKey: string;
	apiSecret: string;
}

/** Private API が有効かどうかを返す */
export function isPrivateApiEnabled(): boolean {
	return !!(process.env.BITBANK_API_KEY?.trim() && process.env.BITBANK_API_SECRET?.trim());
}

/**
 * 環境変数から Private API 設定を読み込む。
 * 未設定・空白のみの場合は null を返す。
 */
export function getPrivateApiConfig(): PrivateApiConfig | null {
	const apiKey = process.env.BITBANK_API_KEY?.trim();
	const apiSecret = process.env.BITBANK_API_SECRET?.trim();
	if (!apiKey || !apiSecret) return null;
	return { apiKey, apiSecret };
}

/**
 * 「ホスト承認 UI を最終 gate と認める」モードのフラグ。
 *
 * `BITBANK_TRUST_HOST_APPROVAL=1` のとき、preview_* 系ツールは
 * `confirmation_token` / `expires_at` を `structuredContent` に含めて返す
 * （旧挙動相当）。SEP-1865 対応ホスト上で iframe ボタンを動作させるための
 * オプトイン妥協モード。
 *
 * セキュリティ上の含意:
 *   - LLM が `structuredContent` 経由で token を入手可能になる
 *   - 「LLM は preview_* 経由でしか execute ツールを呼ばない」という前提と、
 *     「ホスト（Claude Desktop 等）のツール承認 UI が必ず人間の click を要求する」
 *     前提に依存する
 *   - 詳細は docs/adr/0002-hitl-confirmation-token-delivery.md を参照
 *
 * デフォルト（unset）では従来通り token を strip するセーフ側挙動を保つ。
 */
export function isHostApprovalTrusted(): boolean {
	return process.env.BITBANK_TRUST_HOST_APPROVAL === '1';
}
