export interface PrivateApiConfig {
	apiKey: string;
	apiSecret: string;
}

export function isPrivateApiEnabled(): boolean {
	return !!(process.env.BITBANK_API_KEY?.trim() && process.env.BITBANK_API_SECRET?.trim());
}

export function getPrivateApiConfig(): PrivateApiConfig | null {
	const apiKey = process.env.BITBANK_API_KEY?.trim();
	const apiSecret = process.env.BITBANK_API_SECRET?.trim();
	if (!apiKey || !apiSecret) return null;
	return { apiKey, apiSecret };
}

/**
 * @deprecated `BITBANK_TRUST_HOST_APPROVAL` による UI 実行経路は撤去済み。
 * `isAppUiExecuteEnabled()` とは別物で、本関数とは一切連動しない（ADR-0007）。
 */
export function isHostApprovalTrusted(): boolean {
	return false;
}

/**
 * 結果 `_meta` は LLM に渡らないというホストの観測された挙動（仕様の適合要件ではない）に依存する経路なので既定 off（ADR-0007）。
 * `'1'` 以外（`true` / `yes` 等）は受け付けない。取引実行の解錠スイッチで表記ゆれを許すと「設定したつもりで有効になっていない / その逆」が起きる。
 */
export function isAppUiExecuteEnabled(): boolean {
	return process.env.BITBANK_MCP_APPS_EXECUTE?.trim() === '1';
}
