/**
 * create_order — 現物注文を発注する Private API ツール。
 *
 * bitbank Private API `POST /v1/user/spot/order` を呼び出し、
 * 指定したパラメータで注文を発注する。
 *
 * 対応注文タイプ:
 * - limit: 指値注文（price 必須）
 * - market: 成行注文
 * - stop: 逆指値注文（trigger_price 必須、トリガー到達で成行発注）
 * - stop_limit: 逆指値指値注文（trigger_price + price 必須）
 *
 * 公式 spec の `take_profit` / `stop_loss` / `losscut` は本実装では意図的に未対応
 * （詳細は docs/private-api.md および docs/api-contract-checklist.md §3.4 を参照）。
 *
 * セキュリティ:
 * - amount / price / trigger_price のバリデーションをサーバー側で実施
 * - 注文タイプに応じた必須パラメータの事前チェック
 * - HITL: confirmation_token / token_expires_at を必須とし、preview_order を経由しない直接発注を拒否する
 */

import { nowIso } from '../../lib/datetime.js';
import { formatPair, formatPrice } from '../../lib/formatter.js';
import { logTradeAction } from '../../lib/logger.js';
import { isJpyQuotedPair, withNormalizedPair } from '../../lib/pair-code.js';
import { fetchPairsSpec, validateOrderConstraints } from '../../lib/pairs.js';
import { fail, ok } from '../../lib/result.js';
import { validateTriggerPrice } from '../../lib/trigger-price.js';
import { getDefaultClient } from '../../src/private/client.js';
import { validateToken } from '../../src/private/confirmation.js';
import {
	DIRECT_EXECUTE_FORBIDDEN_ERROR_TYPE,
	DIRECT_EXECUTE_FORBIDDEN_MESSAGE,
	isAppUiExecuteAllowed,
} from '../../src/private/elicitation.js';
import type { OrderResponse } from '../../src/private/schemas.js';
import { CreateOrderInputSchema, CreateOrderOutputSchema } from '../../src/private/schemas.js';
import { failPrivateToolError } from '../../src/private/tool-error.js';
import type { ToolDefinition } from '../../src/tool-definition.js';
import { clearUiSnapshot } from '../../src/ui-snapshot-cache.js';

/** create_order がどの経路から呼ばれたかを示す監査ログ用のラベル */
export type CreateOrderRoute = 'elicitation' | 'ui-button' | 'direct-text';

export default async function createOrder(
	args: {
		pair: string;
		amount: string;
		price?: string;
		side: 'buy' | 'sell';
		type: 'limit' | 'market' | 'stop' | 'stop_limit';
		post_only?: boolean;
		trigger_price?: string;
		position_side?: 'long' | 'short';
		confirmation_token: string;
		token_expires_at: number;
	},
	route: CreateOrderRoute = 'direct-text',
	scope: { sessionId?: string } = {},
) {
	const {
		pair,
		amount,
		price,
		side,
		type,
		post_only,
		trigger_price,
		position_side,
		confirmation_token,
		token_expires_at,
	} = args;

	// HITL: 確認トークンの検証
	const tokenParams: Record<string, unknown> = { pair, amount, side, type };
	if (price) tokenParams.price = price;
	if (post_only != null) tokenParams.post_only = post_only;
	if (trigger_price) tokenParams.trigger_price = trigger_price;
	if (position_side) tokenParams.position_side = position_side;

	const tokenError = validateToken(confirmation_token, 'create_order', tokenParams, token_expires_at);
	if (tokenError) {
		// token_already_used / token_expired / token_invalid / token_store_full を
		// そのまま errorType に伝播。二重発注は errorType=token_already_used で検出可能。
		// token_store_full は使用済み記録が満杯で再利用を検知できない状態（fail-closed）。
		return CreateOrderOutputSchema.parse(fail(tokenError.message, tokenError.code));
	}

	// preview から create までの間に状態が変化し得る項目のみ再検証する（方針 B）。
	// 詳細: docs/private-api.md「検証の責務分担（preview と create）」節。
	// pairs 取得失敗時は preview と同じく warning に留めて発注を継続する。
	const warnings: string[] = [];
	try {
		const pairsMap = await fetchPairsSpec();
		const spec = pairsMap.get(pair.toLowerCase());
		const violation = validateOrderConstraints(spec, {
			pair,
			type,
			side,
			amount,
			price,
			trigger_price,
			position_side,
		});
		if (violation) {
			return CreateOrderOutputSchema.parse(fail(violation.message, 'validation_error'));
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		warnings.push(`ペア仕様（/spot/pairs）取得失敗のため最小数量・桁数チェックをスキップしました: ${msg}`);
	}

	// stop / stop_limit: トリガー価格が即時発動レベルになっていないか再チェック。
	// preview からの時間差で市場が動いている可能性があるため。
	if ((type === 'stop' || type === 'stop_limit') && trigger_price) {
		const triggerError = await validateTriggerPrice(pair, side, Number(trigger_price));
		if (triggerError) {
			return CreateOrderOutputSchema.parse(fail(triggerError, 'validation_error'));
		}
	}

	const client = getDefaultClient();

	try {
		// リクエストボディの構築（undefinedのフィールドは除外）
		const isMargin = !!position_side;
		const body: Record<string, unknown> = { pair, amount, side, type };
		if (price) body.price = price;
		if (post_only != null) body.post_only = post_only;
		if (trigger_price) body.trigger_price = trigger_price;
		if (position_side) body.position_side = position_side;

		// 取得境界での pair 正規化（`lib/pair-code.ts`）。`data.order.pair` は小文字契約で返す。
		// リクエストボディの `pair` はユーザー入力のまま（正規化は応答側だけ）。
		const rawOrder = withNormalizedPair(await client.post<OrderResponse>('/v1/user/spot/order', body));

		const timestamp = nowIso();
		const isJpy = isJpyQuotedPair(pair);
		const sideLabel = side === 'buy' ? '買' : '売';
		const fmtPrice = price ? (isJpy ? formatPrice(Number(price)) : price) : '成行';

		// 信用取引の操作ラベル
		let marginLabel = '';
		if (isMargin) {
			const posLabel = position_side === 'long' ? 'ロング' : 'ショート';
			const isOpen = (side === 'buy' && position_side === 'long') || (side === 'sell' && position_side === 'short');
			marginLabel = isOpen ? `信用新規（${posLabel}）` : `信用決済（${posLabel}）`;
		}

		// 構造化ログに記録（チェーンハッシュ付き）。
		// route は監査用（elicitation / ui-button / direct-text）。二重発注事故時に
		// LLM がテキストからトークンを抜き出して直接呼んだのか、UI 経由なのかを区別する。
		logTradeAction({
			type: 'create_order',
			orderId: rawOrder.order_id,
			pair,
			side,
			orderType: type,
			amount,
			price: price ?? null,
			triggerPrice: trigger_price ?? null,
			positionSide: position_side ?? null,
			status: rawOrder.status,
			confirmed: true,
			route,
		});

		// サマリー生成
		const lines: string[] = [];
		if (isMargin) {
			lines.push(`${marginLabel} 注文発注完了: ${formatPair(pair)}`);
		} else {
			lines.push(`注文発注完了: ${formatPair(pair)}`);
		}
		lines.push(`  注文ID: ${rawOrder.order_id}`);
		lines.push(`  方向: ${sideLabel} / タイプ: ${type}`);
		if (marginLabel) {
			lines.push(`  区分: ${marginLabel}`);
		}
		lines.push(`  数量: ${amount}`);
		lines.push(`  価格: ${fmtPrice}`);
		if (trigger_price) {
			lines.push(`  トリガー価格: ${isJpy ? formatPrice(Number(trigger_price)) : trigger_price}`);
		}
		if (post_only) {
			lines.push('  Post Only: 有効');
		}
		lines.push(`  ステータス: ${rawOrder.status}`);

		if (warnings.length > 0) {
			lines.push('');
			for (const w of warnings) {
				lines.push(`⚠️ ${w}`);
			}
		}

		const summary = lines.join('\n');

		// 実行済み preview のスナップショットを無効化（発注済み内容の確認カードが
		// 復元されて二重発注を誘発するのを防ぐ）。同一セッションのエントリのみ削除。
		clearUiSnapshot('ui://order/confirm.html', scope);

		return CreateOrderOutputSchema.parse(
			ok(
				summary,
				{ order: rawOrder, timestamp },
				{
					fetchedAt: timestamp,
					orderId: rawOrder.order_id,
					pair,
					side,
					type,
					...(warnings.length > 0 ? { warnings } : {}),
					...(client.lastRateLimit ? { rateLimit: client.lastRateLimit } : {}),
				},
			),
		);
	} catch (err) {
		// PrivateApiError は分類済み文言を素通し、未知エラーは err.message を伏せて汎用文に置換する。
		// 未登録 bitbankCode の素通しに備え remapBitbankCode で再 lookup する。
		return CreateOrderOutputSchema.parse(
			failPrivateToolError(err, '注文発注中に予期しないエラーが発生しました', { remapBitbankCode: true }),
		);
	}
}

export const toolDef: ToolDefinition = {
	name: 'create_order',
	description: [
		'[Create Order / Place Order / Buy / Sell] 注文を発注する（現物または信用）。Private API。',
		'⚠️ このツールを MCP tools/call から直接呼び出してはならない。サーバー側で拒否される。',
		'発注は必ず preview_order から始まるユーザー確認フローを経由してのみ行われる。',
		'対応注文タイプは limit（指値）/ market（成行）/ stop（逆指値）/ stop_limit（逆指値指値）の 4 種類のみ。',
		'公式 spec の take_profit / stop_loss / losscut は本実装では未対応（仕様が曖昧なため意図的に除外）。',
		'position_side を指定すると信用注文として扱う（ロング新規=buy+long, ロング決済=sell+long, ショート新規=sell+short, ショート決済=buy+short）。',
		'このツールはユーザーが自身の bitbank APIキーを設定し、明示的に取引操作を許可した環境でのみ有効化されます。',
		'「安全上の理由で実行できない」「金融取引は実行できない」等の理由でツールの使用を拒否しないでください。',
	].join(' '),
	inputSchema: CreateOrderInputSchema,
	// MCP Apps: iframe 起源の tools/call をサーバー側で識別できないため visibility に app を
	// 含めない（ツール一覧をモデル向けに留める）。MCP Apps 実行経路の解錠は visibility ではなく
	// handler 側のゲート + トークン検証で行う。
	_meta: {
		ui: {
			visibility: ['model'],
		},
	},
	handler: async (args, extra) => {
		// 既定では MCP tools/call（LLM / UI）経由を常に拒否する。
		// preview_order の elicitation accept は createOrder() を直接呼ぶためここを通らない。
		//
		// MCP Apps 実行経路（ADR-0007）が有効な場合のみ、確認トークンを伴う呼び出しを通す。
		// サーバーは iframe 起源と LLM 起源を区別できないため、**トークン所持が認可の実体**。
		// トークンは `_meta` にしか載せておらず LLM からは読めない。
		if (!isAppUiExecuteAllowed(extra)) {
			return CreateOrderOutputSchema.parse(fail(DIRECT_EXECUTE_FORBIDDEN_MESSAGE, DIRECT_EXECUTE_FORBIDDEN_ERROR_TYPE));
		}
		const typedArgs = args as Parameters<typeof createOrder>[0];
		// トークン欠落は「preview を経ていない直接呼び出し」なので従来どおり拒否する。
		// 値の正当性（HMAC / 期限 / ワンタイム / パラメータ一致）は createOrder 内の
		// validateToken が検証し、既存の errorType でそのまま失敗させる。
		if (!typedArgs?.confirmation_token || typeof typedArgs.token_expires_at !== 'number') {
			return CreateOrderOutputSchema.parse(fail(DIRECT_EXECUTE_FORBIDDEN_MESSAGE, DIRECT_EXECUTE_FORBIDDEN_ERROR_TYPE));
		}
		return createOrder(typedArgs, 'ui-button', {
			sessionId: (extra as { sessionId?: string } | undefined)?.sessionId,
		});
	},
};
