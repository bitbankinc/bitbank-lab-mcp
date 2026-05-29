/**
 * preview 系ツール（preview_order / preview_cancel_order / preview_cancel_orders）の
 * elicitation/create フローを共通化するヘルパー。
 *
 * 各 preview ツールは以下のパターンを同じ手順で実装していた:
 *   1. クライアントが elicitation/create に対応しているかを判定
 *   2. 対応していれば elicitInput でユーザー確認を取り、accept なら execute を実行
 *   3. 非対応 / decline / cancel / elicit 例外時は `fallback`（実行不可通知）を返す
 *
 * 取引系 HITL（Human-in-the-Loop）の中核であり、3 箇所に散らばっていると
 * 仕様ドリフトで事故になるため、本モジュールに集約する。
 *
 * 取引系に強く紐づくため汎用 `lib/` ではなく `src/private/` 配下に置く。
 *
 * セキュリティ設計（重要）:
 *   - `confirmation_token` / `expires_at` は本ヘルパー経路のサーバープロセス内に閉じる。
 *     呼び出し側が誤って `fallback` / `declinedStructured` に token を含めても、
 *     `withElicitedConfirmation` 内の `stripConfirmationTokenFields` で必ず除去される
 *     （多層防御。caller convention だけに依存しない最終ガード）。
 *   - 「`structuredContent` は LLM 非可視」をホストの仕様保証として扱わない。
 *     SEP-1624 / 各ホスト挙動の詳細は docs/private-api.md「content /
 *     structuredContent / `_meta` の役割と HITL の境界」節を参照。
 */

import { toStructured } from '../../lib/result.js';
import type { Result } from '../schema/types.js';
import type { McpResponse, ToolHandlerExtra } from '../tool-definition.js';
import { isHostApprovalTrusted } from './config.js';

/** SDK の elicitInput を呼び出すための最小限の interface */
export interface ElicitCapableServer {
	elicitInput: (params: {
		message: string;
		requestedSchema: Record<string, unknown>;
	}) => Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }>;
}

/**
 * クライアントが elicitation/create に対応しているかを判定する。
 * 非対応ホストでは取引実行を行わず、呼び出し側が用意した `fallback`
 * （実行不可通知レスポンス）を返す。
 */
export function clientSupportsElicitation(extra: ToolHandlerExtra | undefined): boolean {
	const server = (extra as { server?: { getClientCapabilities?: () => unknown } } | undefined)?.server;
	const caps = typeof server?.getClientCapabilities === 'function' ? server.getClientCapabilities() : undefined;
	const elicitation = (caps as { elicitation?: unknown } | undefined)?.elicitation;
	return Boolean(elicitation);
}

/**
 * structuredContent / declinedStructured から `confirmation_token` / `expires_at` を
 * 除去する。`withElicitedConfirmation` の最終ガードとして使用し、caller が誤って
 * これらのフィールドを含めて渡しても外部に漏れないことを保証する。
 *
 * preview ツールの structuredContent は `{ ok, summary, data: { confirmation_token,
 * expires_at, preview, ... }, meta }` の Result 形式をとるため、最上位と `data`
 * 配下の 2 階層を剥がす。深いネストに `confirmation_token` を埋める caller は想定して
 * いないが、最上位も対象にしておくことで形状違いの caller 追加にも耐える。
 */
function stripConfirmationTokenFields(value: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...value };
	delete result.confirmation_token;
	delete result.expires_at;
	const data = result.data;
	if (data && typeof data === 'object' && !Array.isArray(data)) {
		const sanitizedData: Record<string, unknown> = { ...(data as Record<string, unknown>) };
		delete sanitizedData.confirmation_token;
		delete sanitizedData.expires_at;
		result.data = sanitizedData;
	}
	return result;
}

export interface WithElicitedConfirmationOptions {
	/** ハンドラに渡される MCP リクエストコンテキスト */
	extra: ToolHandlerExtra | undefined;
	/** elicitation の message に渡す preview 結果サマリ */
	summary: string;
	/** elicitation スキーマの confirmed フィールドに付ける title（例: 'この注文を発注する'） */
	confirmTitle: string;
	/**
	 * accept + confirmed=true のとき呼ぶ execute 本体。
	 * `Result`（create_order / cancel_order / cancel_orders の戻り値）を返す。
	 * **例外が出た場合は捕捉せずそのまま伝播させる**（呼び出し側で扱う）。
	 */
	onConfirmed: () => Promise<Result>;
	/** decline / cancel / confirmed=false のときに content[0].text として返す案内文 */
	onDeclinedText: string;
	/**
	 * decline / cancel / confirmed=false のときに structuredContent として返すオブジェクト。
	 * preview の Result を `toStructured()` で変換したものを渡してよい。
	 * `confirmation_token` / `expires_at` は本ヘルパー内で必ず除去されるため caller 側で
	 * 取り除く必要はないが、防御的に最小限のフィールドだけ含めることを推奨する。
	 */
	declinedStructured: Record<string, unknown>;
	/**
	 * elicitation 非対応ホスト向けの「実行不可通知」レスポンス。以下のケースで返る:
	 *   - クライアントが elicitation 非対応
	 *   - server.elicitInput が無い
	 *   - elicitInput が例外を投げた
	 *
	 * セマンティクス: 取引実行は行わずプレビュー内容のみ返し、対応ホストで実行するよう
	 * ユーザー / LLM に促す。`structuredContent` 内の `confirmation_token` / `expires_at`
	 * は本ヘルパー内で必ず除去される（caller convention だけに依存しない最終ガード）。
	 * `content[0].text` 側は caller の責任で token を含めないこと。
	 */
	fallback: McpResponse;
	/**
	 * `BITBANK_TRUST_HOST_APPROVAL=1`（`isHostApprovalTrusted()`）が true、かつ
	 * クライアントが elicitation 非対応のときに `fallback` の代わりに返されるレスポンス。
	 * SEP-1865 iframe ボタン経由の execute を許す妥協モード:
	 *   - `confirmation_token` / `expires_at` を含む `structuredContent` を返す（strip しない）
	 *   - 通常の `fallback` は LLM が触れない preview-only セマンティクス、
	 *     こちらは LLM にも token が見える前提で iframe ボタンへの案内テキストを含める
	 *
	 * セキュリティ前提:
	 *   - LLM は preview_* 経由でしか execute ツールを呼ばない（description で明示）
	 *   - ホスト（Claude Desktop 等）のツール承認 UI が最終 gate
	 *
	 * 詳細は docs/adr/0002-hitl-confirmation-token-delivery.md を参照。
	 * オプトインフラグが false のとき、または本フィールド未指定のときは無視され、
	 * 従来通り `fallback` が返る。
	 */
	trustHostFallback?: McpResponse;
}

/**
 * preview 結果に対するユーザー確認（elicitation）フローを実行する高レベルラッパー。
 *
 * 責務:
 *   1. capability 判定
 *   2. elicitInput 呼び出し
 *   3. ユーザー応答（accept / decline / cancel / confirmed=false）による分岐返却
 *
 * 実 API 呼び出し（create_order / cancel_order / cancel_orders）は呼び出し側が
 * `onConfirmed` 内で行う。bitbank のキャンセル系は単数/複数で execute シグネチャが
 * 異なるため、ラッパーはシグネチャを縛らずクロージャに委ねる。
 *
 * 挙動の統一:
 *   - decline / cancel / accept-without-confirmed はすべて「ユーザー拒否」として
 *     同一処理にする（既存 3 ツールはこの分岐ロジック自体は同じだった）。
 *   - `onConfirmed` の例外は捕捉せず呼び出し側に伝播させる
 *     （elicitInput 自体の例外のみフォールバックさせる）。
 */
export async function withElicitedConfirmation(opts: WithElicitedConfirmationOptions): Promise<McpResponse> {
	// fallback / declinedStructured は caller convention だけに依頼せず、ここで必ず
	// confirmation_token / expires_at を剥がす（多層防御の最終ガード）。
	const safeFallback: McpResponse = {
		...opts.fallback,
		structuredContent: stripConfirmationTokenFields(opts.fallback.structuredContent),
	};
	const safeDeclinedStructured = stripConfirmationTokenFields(opts.declinedStructured);

	// elicitation 非対応 + BITBANK_TRUST_HOST_APPROVAL=1 + trustHostFallback 指定の三者揃いで
	// 「ホスト承認 UI を最終 gate として信頼する」妥協モードに入る。
	// この経路では token を strip せず caller が用意したレスポンスをそのまま返す。
	// 詳細は docs/adr/0002-hitl-confirmation-token-delivery.md を参照。
	const trustHostMode = isHostApprovalTrusted() && opts.trustHostFallback != null;

	if (!clientSupportsElicitation(opts.extra)) {
		return trustHostMode ? opts.trustHostFallback! : safeFallback;
	}

	const server = (opts.extra as { server?: ElicitCapableServer } | undefined)?.server;
	if (!server || typeof server.elicitInput !== 'function') {
		return trustHostMode ? opts.trustHostFallback! : safeFallback;
	}

	let elicit: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };
	try {
		elicit = await server.elicitInput({
			message: opts.summary,
			requestedSchema: {
				type: 'object',
				properties: {
					confirmed: { type: 'boolean', title: opts.confirmTitle },
				},
				required: ['confirmed'],
			},
		});
	} catch {
		// elicitInput が想定外に失敗した場合はフォールバックに進む。
		// trust-host モード ON なら iframe ボタン経路を残す trustHostFallback を返す。
		return trustHostMode ? opts.trustHostFallback! : safeFallback;
	}

	if (elicit.action !== 'accept' || !elicit.content?.confirmed) {
		return {
			content: [{ type: 'text', text: opts.onDeclinedText }],
			structuredContent: safeDeclinedStructured,
		};
	}

	const execResult = await opts.onConfirmed();
	const text = execResult.ok ? execResult.summary : `Error: ${execResult.summary}`;
	// onConfirmed の Result（create_order 等の戻り値）には confirmation_token は含まれない
	// 想定だが、念のため同じ最終ガードを通す。
	return {
		content: [{ type: 'text', text }],
		structuredContent: stripConfirmationTokenFields(toStructured(execResult)),
	};
}
