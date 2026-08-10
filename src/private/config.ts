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
 * @deprecated `BITBANK_TRUST_HOST_APPROVAL` による UI 実行経路は撤去済み。
 *
 * SEP-1865 iframe 起源の `tools/call` をサーバー側で安全に識別できないため、
 * token を `structuredContent` に載せる妥協モードはセキュリティ上無効化した。
 * 環境変数が設定されていても常に `false` を返す（後方互換のため関数は残す）。
 * 取引実行は elicitation / MRTR 経路のみ許可する。詳細は ADR-0007。
 */
export function isHostApprovalTrusted(): boolean {
	return false;
}
