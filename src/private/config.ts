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
 *
 * **`isAppUiExecuteEnabled()` とは別物**。2026-08-13 に再導入した MCP Apps 実行経路は
 * token を `_meta` にのみ載せる別設計で、本関数とは一切連動しない（ADR-0007）。
 * 「撤去済み・設定しても無視される」という本変数の意味は変更していない。
 */
export function isHostApprovalTrusted(): boolean {
	return false;
}

/**
 * MCP Apps（SEP-1865）ホスト向けの `_meta` 経由 execute 経路が有効かを返す。
 *
 * `BITBANK_MCP_APPS_EXECUTE=1` を設定した場合のみ true（既定 off）。これは
 * **有効化ゲート 2 段のうち 1 段目（運用者の明示的オプトイン）**であり、
 * これだけでは token は配送されない。2 段目のクライアント capability 判定
 * （`clientSupportsAppUi`。`src/private/elicitation.ts`）と AND で評価すること。
 *
 * セキュリティ上の前提（ADR-0007）:
 *   - この経路は「結果 `_meta` は LLM に渡らない」というホスト実装の**観測された挙動**に
 *     依存する。ext-apps 仕様の該当記述は Best Practices 配下で MUST/SHOULD を伴わないため
 *     適合要件ではない。ホストのアップデートで壊れてもサーバー側では検知できない
 *   - したがって既定 off。有効化は運用者の明示的な判断とする
 *
 * `'1'` 以外（`true` / `yes` 等）は受け付けない。表記ゆれを許すと「設定したつもりで
 * 有効になっていない / その逆」が起きるが、取引実行の解錠スイッチでそれは許容できない。
 */
export function isAppUiExecuteEnabled(): boolean {
	return process.env.BITBANK_MCP_APPS_EXECUTE?.trim() === '1';
}
