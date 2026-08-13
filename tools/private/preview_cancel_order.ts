/**
 * preview_cancel_order — 注文キャンセルのプレビュー。
 *
 * キャンセル対象の注文情報を表示する。実際のキャンセルは行わない。
 *
 * 内部的に confirmation_token も生成する。配送先は接続ホストによって 3 通りに分かれる:
 *   - elicitation 対応ホスト: ハンドラ内の accept 経路で cancel_order へ非公開のまま
 *     引き渡し、preview → ユーザー確認 → cancel_order までを完結させる（第一選択）
 *   - MCP Apps 実行経路が有効なホスト: ツール結果の `_meta` にのみ載せて iframe へ配送する
 *     （`BITBANK_MCP_APPS_EXECUTE=1` + MCP Apps UI 宣言の 2 段ゲート。ADR-0007）
 *   - どちらでもないホスト: キャンセル実行は行わずプレビューのみ返し、token はクライアントに渡さない
 *
 * いずれの場合も **content / structuredContent には token を載せない**（LLM から読めない）。
 *
 * 詳細は docs/private-api.md「`confirmation_token` の受け渡し」節を参照。
 */

import { formatOrderPositionLabel, formatPair, formatPrice } from '../../lib/formatter.js';
import { isJpyQuotedPair } from '../../lib/pair-code.js';
import { fail, ok, toStructured } from '../../lib/result.js';
import { generateToken } from '../../src/private/confirmation.js';
import { withElicitedConfirmation } from '../../src/private/elicitation.js';
import type { OrderResponse } from '../../src/private/schemas.js';
import { PreviewCancelOrderInputSchema, PreviewCancelOrderOutputSchema } from '../../src/private/schemas.js';
import type { ToolDefinition } from '../../src/tool-definition.js';
import cancelOrder from './cancel_order.js';
import getOrder from './get_order.js';

/** 注文詳細をキャンセルプレビューのサマリ行に整形する */
function formatOrderDetailLines(order: OrderResponse, pair: string): string[] {
	const sideLabel = order.side === 'buy' ? '買' : '売';
	const posLabel = formatOrderPositionLabel(order.position_side);
	const isJpy = isJpyQuotedPair(pair);
	const price = order.price ? (isJpy ? formatPrice(Number(order.price)) : order.price) : '成行';
	const amount = order.start_amount ?? order.executed_amount ?? '?';
	const lines: string[] = [];
	lines.push(`  方向: ${posLabel}${sideLabel} / タイプ: ${order.type}`);
	lines.push(`  数量: ${amount}（残: ${order.remaining_amount ?? '0'} / 約定: ${order.executed_amount}）`);
	lines.push(`  価格: ${price}`);
	if (order.trigger_price) {
		lines.push(`  トリガー価格: ${isJpy ? formatPrice(Number(order.trigger_price)) : order.trigger_price}`);
	}
	if (order.average_price && order.average_price !== '0') {
		lines.push(`  平均約定価格: ${isJpy ? formatPrice(Number(order.average_price)) : order.average_price}`);
	}
	lines.push(`  ステータス: ${order.status}`);
	return lines;
}

export default async function previewCancelOrder(args: { pair: string; order_id: number }) {
	const { pair, order_id } = args;

	// 注文詳細を取得して preview にも同梱する。失敗してもキャンセル自体は可能なので、
	// エラーは握りつぶしてフォールバック表示にとどめる（ネットワーク不調や認証異常で
	// キャンセル不能になる方が UX として悪いため）。
	let orderDetail: OrderResponse | undefined;
	const detailResult = await getOrder({ pair, order_id });
	if (detailResult.ok) {
		orderDetail = detailResult.data.order;
	}

	// 既にキャンセル済みの注文はプレビュー段階で拒否する（復元された古いカードや
	// 重複依頼による二重キャンセルを bitbank へ届く前に止める）。
	if (orderDetail?.status?.startsWith('CANCELED')) {
		return PreviewCancelOrderOutputSchema.parse(
			fail(`この注文は既にキャンセル済みです（status: ${orderDetail.status}）`, 'validation_error'),
		);
	}

	const tokenParams = { pair, order_id };
	const { token, expiresAt } = generateToken('cancel_order', tokenParams);

	const lines: string[] = [];
	lines.push(`📋 キャンセルプレビュー: ${formatPair(pair)}`);
	lines.push(`  注文ID: ${order_id}`);
	if (orderDetail) {
		lines.push(...formatOrderDetailLines(orderDetail, pair));
	}
	lines.push('');
	lines.push('⚠️ このキャンセルはユーザーの最終確認を経るまで実行されません。');

	const summary = lines.join('\n');

	const data: Record<string, unknown> = {
		confirmation_token: token,
		expires_at: expiresAt,
		preview: { pair, order_id },
	};
	if (orderDetail) data.order = orderDetail;

	return PreviewCancelOrderOutputSchema.parse(ok(summary, data, { action: 'cancel_order' as const }));
}

export const toolDef: ToolDefinition = {
	name: 'preview_cancel_order',
	description: [
		'[Preview Cancel Order] 注文キャンセルのプレビュー。実際のキャンセルは行わない。Private API。',
		'⚠️ confirmation_token は content / structuredContent には決して含めない。LLM がトークンを読み取って cancel_order を直接呼ぶことはできない。',
		'実際のキャンセルはユーザーの明示確認（対応ホストの確認ダイアログ、または確認カードのボタン操作）を経てのみ完結する。',
		'いずれにも対応しないホストではプレビューのみ返し、キャンセル実行は受け付けない。その場合は対応クライアントでの操作を第一に案内し、bitbank アプリ/ウェブでのキャンセルは任意の代替手段として扱う。',
		'このツールの応答を受け取った後、LLM がキャンセル完了を宣言してはならない。実行結果はユーザー確認後の応答で別途返る。',
	].join(' '),
	inputSchema: PreviewCancelOrderInputSchema,
	// MCP Apps (SEP-1865): 対応ホストでは iframe 内にキャンセルプレビュー UI を表示する。
	// 非対応ホストでは無視される（Progressive Enhancement）。
	// 注: iframe 起源の tools/call はサーバー側で識別できない。UI からの cancel_order は
	// 「LLM が読めない `_meta` にしか出していないトークンを提示できるか」で認可する
	// （`BITBANK_MCP_APPS_EXECUTE=1` + MCP Apps UI 宣言時のみ。ADR-0007）。
	_meta: {
		ui: {
			resourceUri: 'ui://cancel/confirm.html',
		},
	},
	handler: async (args, extra) => {
		const typedArgs = args as { pair: string; order_id: number };
		const result = await previewCancelOrder(typedArgs);
		if (!result.ok) return result;

		// elicitation 非対応 かつ MCP Apps 実行経路も無効なホスト向けのフォールバック。
		// キャンセル実行はこのホストでは行えない旨を明示し、トークンの存在は仄めかさない。
		const fallbackText = [
			result.summary,
			'',
			'※ このホストでは取引実行に対応していません。',
			'  実際にキャンセルするには、elicitation/MRTR 対応クライアントで同じ操作を行うか、bitbank アプリ/ウェブで該当注文をキャンセルしてください。',
		].join('\n');

		// elicitation 非対応だが MCP Apps 実行経路が有効なホスト向け。確認カードの
		// ボタンでキャンセルできるため、案内が上と正反対になる。トークンは含めない。
		const appUiFallbackText = [
			result.summary,
			'',
			'※ 上部の確認カードで内容を確認し、「キャンセルを確定する」ボタンを押すと取消が実行されます。',
			'  ボタンを押さない限り実行されません。確認は 60 秒で期限切れになるため、その場合は preview_cancel_order をやり直してください。',
		].join('\n');

		// elicitation 対応ホストでは preview → ユーザー確認 → cancel_order までを
		// このハンドラ内で完結させる。confirmation_token / expires_at は
		// withElicitedConfirmation が structuredContent / declinedStructured / fallback
		// から必ず剥がすため caller 側で sanitize する必要はない（最終ガードは helper 側）。
		return withElicitedConfirmation({
			extra,
			action: 'cancel_order',
			bindArgs: typedArgs as unknown as Record<string, unknown>,
			summary: result.summary,
			confirmTitle: 'この注文をキャンセルする',
			// 内部的に cancel_order を実行。監査ログには route='elicitation' で記録される。
			// confirmation_token / expires_at は previewCancelOrder() が必ず生成するため non-null 断定して渡す。
			onConfirmed: () =>
				cancelOrder(
					{
						...typedArgs,
						confirmation_token: result.data.confirmation_token!,
						token_expires_at: result.data.expires_at!,
					},
					'elicitation',
					{ sessionId: (extra as { sessionId?: string } | undefined)?.sessionId },
				),
			onDeclinedText: 'ユーザーがキャンセル操作を取り消しました（elicitation）',
			declinedStructured: toStructured(result),
			fallback: {
				content: [{ type: 'text', text: fallbackText }],
				structuredContent: toStructured(result),
			},
			// MCP Apps ホスト向けのトークン配送。実際に載るのは有効化ゲート 2 段を
			// 満たし、かつ elicitation 非対応と判定された場合のみ（helper 側で制御）。
			metaConfirmation: {
				confirmation_token: result.data.confirmation_token!,
				expires_at: result.data.expires_at!,
			},
			appUiFallbackText,
		});
	},
};
