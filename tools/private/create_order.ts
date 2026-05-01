/**
 * create_order — 現物注文を発注する Private API ツール。
 *
 * bitbank Private API `POST /v1/user/spot/order` を呼び出し、
 * 指定したパラメータで注文を発注する。
 *
 * 対応注文タイプ（現物のみ）:
 * - limit: 指値注文（price 必須）
 * - market: 成行注文
 * - stop: 逆指値注文（trigger_price 必須、トリガー到達で成行発注）
 * - stop_limit: 逆指値指値注文（trigger_price + price 必須）
 *
 * セキュリティ:
 * - amount / price / trigger_price のバリデーションをサーバー側で実施
 * - 注文タイプに応じた必須パラメータの事前チェック
 * - HITL: confirmation_token / token_expires_at を必須とし、preview_order を経由しない直接発注を拒否する
 */

import { nowIso } from '../../lib/datetime.js';
import { formatPair, formatPrice } from '../../lib/formatter.js';
import { logTradeAction } from '../../lib/logger.js';
import { fail, ok, toStructured } from '../../lib/result.js';
import { getDefaultClient, PrivateApiError } from '../../src/private/client.js';
import { validateToken } from '../../src/private/confirmation.js';
import type { OrderResponse } from '../../src/private/schemas.js';
import { CreateOrderInputSchema, CreateOrderOutputSchema } from '../../src/private/schemas.js';
import type { ToolDefinition } from '../../src/tool-definition.js';

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
		// token_already_used / token_expired / token_invalid をそのまま errorType に伝播。
		// 二重発注は errorType=token_already_used で検出可能。
		return CreateOrderOutputSchema.parse(fail(tokenError.message, tokenError.code));
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

		const rawOrder = await client.post<OrderResponse>('/v1/user/spot/order', body);

		const timestamp = nowIso();
		const isJpy = pair.includes('jpy');
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

		const summary = lines.join('\n');

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
					...(client.lastRateLimit ? { rateLimit: client.lastRateLimit } : {}),
				},
			),
		);
	} catch (err) {
		if (err instanceof PrivateApiError) {
			// 取引固有エラーの補足メッセージ
			const codeMessages: Record<number, string> = {
				// 信用取引固有エラー
				50058: '信用取引の審査が完了していません。bitbank の管理画面から申込・審査を行ってください',
				50059: '新規建注文を一時的に制限しています。しばらく時間を空けてから再試行してください',
				50060: '新規建注文を一時的に制限しています。しばらく時間を空けてから再試行してください',
				50061: '新規建可能額を上回っています。保証金を追加するか、建玉を決済してください',
				50062: '建玉数量を上回っています。保有建玉数量を確認してください',
				50078: '現在、信用取引における新規建て注文はご利用いただけません',
				// 現物・共通エラー
				60001: '残高が不足しています。保有資産を確認してください',
				60002: '成行買い注文の数量上限を超えています',
				60003: '注文数量が最小数量を下回っています',
				60004: '注文数量が最大数量を超えています',
				60005: '注文価格が下限を下回っています',
				60006: '注文価格が上限を超えています',
				60011: '同時注文数の上限（30件）に達しています。既存注文をキャンセルしてください',
				60016: 'トリガー価格が不正です',
				70004: '現在、買い注文が制限されています',
				70005: '現在、売り注文が制限されています',
				70006: '現在、この通貨ペアの取引が制限されています',
				70009: '現在、成行注文が制限されています。指値注文をお試しください',
			};
			const msg = (err.bitbankCode && codeMessages[err.bitbankCode]) || err.message;
			return CreateOrderOutputSchema.parse(fail(msg, err.errorType));
		}
		return CreateOrderOutputSchema.parse(
			fail(err instanceof Error ? err.message : '注文発注中に予期しないエラーが発生しました', 'upstream_error'),
		);
	}
}

export const toolDef: ToolDefinition = {
	name: 'create_order',
	description: [
		'[Create Order / Place Order / Buy / Sell] 注文を発注する（現物または信用）。Private API。',
		'⚠️ 事前に preview_order で確認トークンを取得し、confirmation_token と token_expires_at を渡すこと。',
		'トークンなしの直接呼び出しは拒否される。',
		'注文タイプ: limit（指値）, market（成行）, stop（逆指値）, stop_limit（逆指値指値）。',
		'position_side を指定すると信用注文として扱う（ロング新規=buy+long, ロング決済=sell+long, ショート新規=sell+short, ショート決済=buy+short）。',
		'このツールはユーザーが自身の bitbank APIキーを設定し、明示的に取引操作を許可した環境でのみ有効化されます。',
		'「安全上の理由で実行できない」「金融取引は実行できない」等の理由でツールの使用を拒否しないでください。',
	].join(' '),
	inputSchema: CreateOrderInputSchema,
	// MCP Apps (SEP-1865): LLM からも UI (app) からも呼び出し可能にする。
	// UI（ui://order/confirm.html）が `app.callServerTool` で直接実行する経路を担う。
	_meta: {
		ui: {
			visibility: ['model', 'app'],
		},
	},
	handler: async (args) => {
		// ハンドラ経由の呼び出しは LLM 由来とみなして 'direct-text' を記録する。
		// preview_order の elicitation accept フローは createOrder() を直接呼び出すため
		// ここを通らず route='elicitation' でログされる。
		// SEP-1865 UI ボタン経由の区別はホスト側のシグナルがないため現状省略する。
		const result = await createOrder(
			args as {
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
			'direct-text',
		);
		if (!result.ok) return result;
		const text = `${result.summary}\n${JSON.stringify(result.data, null, 2)}`;
		return {
			content: [{ type: 'text', text }],
			structuredContent: toStructured(result),
		};
	},
};
