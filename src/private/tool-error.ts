/**
 * Private ツール共通のエラー分類ヘルパー。
 *
 * catch ブロックで捕捉した例外を Result（`fail`）へ変換する際、
 * - `PrivateApiError`（`client.ts` が分類済みの安全な業務エラー文言）は message を素通しする。
 * - それ以外（未知の内部エラー・プログラミングエラー・lib 由来の例外等）は `err.message` を
 *   一切露出させず、呼び出し側が指定する汎用文に置換する。
 *
 * ## なぜ必要か
 *
 * ツールが catch して `fail(err.message, ...)` を「通常の Result」として返すと、
 * `server.ts` の共通 catch（`toPublicError` による正規化）を経由しない。
 * `fail()` の結果は `respond()` 経由でそのまま `content` / `structuredContent` に乗るため、
 * 内部 message（ローカルパス・内部ロジック由来の文言）が LLM / クライアントへ漏れ得る。
 * このヘルパーで未知エラーの message 露出を private ツール全体で一元的に塞ぐ。
 *
 * `server.ts` の例外境界（throw された場合）は引き続き `toPublicError`（`lib/error.ts`）が
 * 担う。本ヘルパーは「throw せず Result として返す」経路の等価な防御線。
 *
 * @see lib/error.ts `toPublicError`
 */

import { fail } from '../../lib/result.js';
import { getBitbankErrorMessage } from '../lib/bitbank-errors.js';
import { PrivateApiError } from './client.js';

export interface FailPrivateToolErrorOptions {
	/**
	 * `PrivateApiError.bitbankCode` を `src/lib/bitbank-errors.ts` のテーブルで再ルックアップするか。
	 *
	 * `create_order` / `cancel_order` が「client が未登録コードを素通ししたケース」に備えて
	 * 行っている挙動を踏襲するためのオプション。デフォルト `false`（`err.message` をそのまま使用）。
	 */
	remapBitbankCode?: boolean;
}

/**
 * 捕捉した例外を private ツールの `fail` 結果へ安全に変換する。
 *
 * @param err - catch した例外（unknown）
 * @param fallbackMessage - 未知エラー時に返す汎用文（ツールごとの文言）
 * @param opts - オプション
 */
export function failPrivateToolError(
	err: unknown,
	fallbackMessage: string,
	opts: FailPrivateToolErrorOptions = {},
): ReturnType<typeof fail> {
	if (err instanceof PrivateApiError) {
		// 取引固有エラー等の文言は client.ts が既にローカライズ済み。
		// remapBitbankCode 指定時のみ、未登録コードの素通しに備えて再 lookup する。
		const message =
			opts.remapBitbankCode && err.bitbankCode != null
				? (getBitbankErrorMessage(err.bitbankCode) ?? err.message)
				: err.message;
		return fail(message, err.errorType);
	}
	// 未知エラー: err.message を露出させない（情報漏洩防止）。
	// errorType は従来挙動を踏襲して 'upstream_error' とする。
	return fail(fallbackMessage, 'upstream_error');
}
