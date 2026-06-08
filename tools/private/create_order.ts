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
import { fetchPairsSpec, validateOrderConstraints } from '../../lib/pairs.js';
import { fail, ok, toStructured } from '../../lib/result.js';
import { validateTriggerPrice } from '../../lib/trigger-price.js';
import { getDefaultClient } from '../../src/private/client.js';
import { validateToken } from '../../src/private/confirmation.js';
import type { OrderResponse } from '../../src/private/schemas.js';
import { CreateOrderInputSchema, CreateOrderOutputSchema } from '../../src/private/schemas.js';
import { failPrivateToolError } from '../../src/private/tool-error.js';
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

		if (warnings.length > 0) {
			lines.push('');
			for (const w of warnings) {
				lines.push(`⚠️ ${w}`);
			}
		}

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
		'⚠️ LLM はこのツールを直接呼び出してはならない。常に preview_order 経由（elicitation 対応ホストではネイティブダイアログ、SEP-1865 対応ホストでは iframe の「注文を確定する」ボタン）でのみ呼び出すこと。',
		'デフォルト設定では confirmation_token はクライアントに返らないため、LLM が直接呼び出してもトークン検証で拒否される（HITL の第二防衛線）。',
		'`BITBANK_TRUST_HOST_APPROVAL=1` の妥協モードでは structuredContent 経由で token が見える場合があるが、その場合もユーザーの明示的な確認操作（iframe ボタン押下またはホストの承認 UI）が前提となる。',
		'対応注文タイプは limit（指値）/ market（成行）/ stop（逆指値）/ stop_limit（逆指値指値）の 4 種類のみ。',
		'公式 spec の take_profit / stop_loss / losscut は本実装では未対応（仕様が曖昧なため意図的に除外）。',
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
