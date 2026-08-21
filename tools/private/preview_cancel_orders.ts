/**
 * preview_cancel_orders — 一括キャンセルのプレビュー。
 *
 * キャンセル対象の注文ID一覧を表示する。実際のキャンセルは行わない。
 *
 * 内部的に confirmation_token も生成する。配送先は接続ホストによって 3 通りに分かれる:
 *   - elicitation 対応ホスト: ハンドラ内の accept 経路で cancel_orders へ非公開のまま
 *     引き渡し、preview → ユーザー確認 → cancel_orders までを完結させる（第一選択）
 *   - MCP Apps 実行経路が有効なホスト: ツール結果の `_meta` にのみ載せて iframe へ配送する
 *     （`BITBANK_MCP_APPS_EXECUTE=1` + MCP Apps UI 宣言の 2 段ゲート。ADR-0007）
 *   - どちらでもないホスト: キャンセル実行は行わずプレビューのみ返し、token はクライアントに渡さない
 *
 * いずれの場合も **content / structuredContent には token を載せない**（LLM から読めない）。
 *
 * 詳細は docs/private-api.md「`confirmation_token` の受け渡し」節を参照。
 */

import { formatPair } from '../../lib/formatter.js';
import { fail, ok, toStructured } from '../../lib/result.js';
import { generateToken } from '../../src/private/confirmation.js';
import { withElicitedConfirmation } from '../../src/private/elicitation.js';
import { PreviewCancelOrdersInputSchema, PreviewCancelOrdersOutputSchema } from '../../src/private/schemas.js';
import type { ToolDefinition } from '../../src/tool-definition.js';
import cancelOrders from './cancel_orders.js';

export default function previewCancelOrders(args: { pair: string; order_ids: number[] }) {
	const { pair, order_ids } = args;

	const tokenParams = { pair, order_ids };
	const { token, expiresAt } = generateToken('cancel_orders', tokenParams);

	const lines: string[] = [];
	lines.push(`📋 一括キャンセルプレビュー: ${formatPair(pair)} ${order_ids.length}件`);
	for (const id of order_ids) {
		lines.push(`  注文ID: ${id}`);
	}
	lines.push('');
	lines.push('⚠️ この一括キャンセルはユーザーの最終確認を経るまで実行されません。');

	const summary = lines.join('\n');

	return PreviewCancelOrdersOutputSchema.parse(
		ok(
			summary,
			{ confirmation_token: token, expires_at: expiresAt, preview: { pair, order_ids } },
			{ action: 'cancel_orders' as const },
		),
	);
}

export const toolDef: ToolDefinition = {
	name: 'preview_cancel_orders',
	description: [
		'[Preview Cancel Orders] 一括キャンセルのプレビュー。実際のキャンセルは行わない。Private API。',
		'⚠️ confirmation_token は content / structuredContent には決して含めない。LLM がトークンを読み取って cancel_orders を直接呼ぶことはできない。',
		'実際のキャンセルはユーザーの明示確認（対応ホストの確認ダイアログ、または確認カードのボタン操作）を経てのみ完結する。',
		'いずれにも対応しないホストではプレビューのみ返し、キャンセル実行は受け付けない。その場合は対応クライアントでの操作を第一に案内し、bitbank アプリ/ウェブでのキャンセルは任意の代替手段として扱う。',
		'このツールの応答を受け取った後、LLM が一括キャンセル完了を宣言してはならない。実行結果はユーザー確認後の応答で別途返る。',
	].join(' '),
	inputSchema: PreviewCancelOrdersInputSchema,
	// MCP Apps (SEP-1865): 対応ホストでは iframe 内にキャンセルプレビュー UI を表示する。
	// 非対応ホストでは無視される（Progressive Enhancement）。
	// 注: iframe 起源の tools/call はサーバー側で識別できない。UI からの cancel_orders は
	// 「LLM が読めない `_meta` にしか出していないトークンを提示できるか」で認可する
	// （`BITBANK_MCP_APPS_EXECUTE=1` + MCP Apps UI 宣言時のみ。ADR-0007）。
	_meta: {
		ui: {
			resourceUri: 'ui://cancel/confirm.html',
		},
	},
	handler: async (args, extra) => {
		const typedArgs = args as { pair: string; order_ids: number[] };
		const result = previewCancelOrders(typedArgs);
		if (!result.ok) return result;

		// スキーマ上 optional だが preview 成功時は必ず生成される。ここで 1 度だけ narrowing し、
		// 以降の非 null 断定を無くす。万一生成されていなければ fail-closed で実行させない
		// （トークン無しで execute 経路へ進ませないため）。
		const { confirmation_token, expires_at } = result.data;
		if (!confirmation_token || expires_at == null) {
			return PreviewCancelOrdersOutputSchema.parse(fail('確認トークンを生成できませんでした', 'internal'));
		}

		// elicitation 非対応 かつ MCP Apps 実行経路も無効なホスト向けのフォールバック。
		// キャンセル実行はこのホストでは行えない旨を明示し、トークンの存在は仄めかさない。
		const fallbackText = [
			result.summary,
			'',
			'※ このホストでは取引実行に対応していません。',
			'  実際に一括キャンセルするには、elicitation/MRTR 対応クライアントで同じ操作を行うか、bitbank アプリ/ウェブで該当注文をキャンセルしてください。',
		].join('\n');

		// elicitation 非対応だが MCP Apps 実行経路が有効なホスト向け。確認カードの
		// ボタンで一括キャンセルできるため、案内が上と正反対になる。トークンは含めない。
		const appUiFallbackText = [
			result.summary,
			'',
			'※ 上部の確認カードで内容を確認し、「一括キャンセルを確定する」ボタンを押すと取消が実行されます。',
			'  ボタンを押さない限り実行されません。確認は 60 秒で期限切れになるため、その場合は preview_cancel_orders をやり直してください。',
		].join('\n');

		// elicitation 対応ホストでは preview → ユーザー確認 → cancel_orders までを
		// このハンドラ内で完結させる。confirmation_token / expires_at は
		// withElicitedConfirmation が structuredContent / declinedStructured / fallback
		// から必ず剥がすため caller 側で sanitize する必要はない（最終ガードは helper 側）。
		return withElicitedConfirmation({
			extra,
			action: 'cancel_orders',
			bindArgs: typedArgs as unknown as Record<string, unknown>,
			summary: result.summary,
			confirmTitle: `これら ${typedArgs.order_ids.length} 件の注文を一括キャンセルする`,
			// 内部的に cancel_orders を実行。監査ログには route='elicitation' で記録される。
			// confirmation_token / expires_at は previewCancelOrders() が必ず生成するため non-null 断定して渡す。
			onConfirmed: () =>
				cancelOrders(
					{
						...typedArgs,
						confirmation_token,
						token_expires_at: expires_at,
					},
					'elicitation',
					{ sessionId: (extra as { sessionId?: string } | undefined)?.sessionId },
				),
			onDeclinedText: 'ユーザーが一括キャンセル操作を取り消しました（elicitation）',
			declinedStructured: toStructured(result),
			fallback: {
				content: [{ type: 'text', text: fallbackText }],
				structuredContent: toStructured(result),
			},
			// MCP Apps ホスト向けのトークン配送。実際に載るのは有効化ゲート 2 段を
			// 満たし、かつ elicitation 非対応と判定された場合のみ（helper 側で制御）。
			metaConfirmation: {
				confirmation_token,
				expires_at,
			},
			appUiFallbackText,
		});
	},
};
