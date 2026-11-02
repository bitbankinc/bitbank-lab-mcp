import { nowIso } from '../../lib/datetime.js';
import { formatPair, formatPrice } from '../../lib/formatter.js';
import { logTradeAction } from '../../lib/logger.js';
import { isJpyQuotedPair, withNormalizedPair } from '../../lib/pair-code.js';
import { fetchPairsSpec, validateOrderConstraints } from '../../lib/pairs.js';
import { fail, ok } from '../../lib/result.js';
import { validateTriggerPrice } from '../../lib/trigger-price.js';
import { getDefaultClient } from '../../src/private/client.js';
import { validateToken } from '../../src/private/confirmation.js';
import { runAppUiExecute } from '../../src/private/execute-gate.js';
import type { OrderResponse } from '../../src/private/schemas.js';
import { CreateOrderInputSchema, CreateOrderOutputSchema } from '../../src/private/schemas.js';
import { failPrivateToolError } from '../../src/private/tool-error.js';
import type { ToolDefinition } from '../../src/tool-definition.js';
import { clearUiSnapshot } from '../../src/ui-snapshot-cache.js';

/** 二重発注事故時に、LLM がテキストからトークンを抜き出して直接呼んだのか UI 経由なのかを区別する監査用ラベル。 */
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

	const tokenParams: Record<string, unknown> = { pair, amount, side, type };
	if (price) tokenParams.price = price;
	if (post_only != null) tokenParams.post_only = post_only;
	if (trigger_price) tokenParams.trigger_price = trigger_price;
	if (position_side) tokenParams.position_side = position_side;

	const tokenError = validateToken(confirmation_token, 'create_order', tokenParams, token_expires_at);
	if (tokenError) {
		// 二重発注を errorType=token_already_used で検出できるよう、検証エラーのコードをそのまま errorType に伝播する。
		return CreateOrderOutputSchema.parse(fail(tokenError.message, tokenError.code));
	}

	// preview から create までの間に状態が変化し得る項目だけを再検証する。pairs 取得失敗時は preview と同じく warning に留めて発注を継続する。
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

	// preview からの時間差で市場が動いている可能性があるので、トリガー価格が即時発動レベルになっていないか再チェックする。
	if ((type === 'stop' || type === 'stop_limit') && trigger_price) {
		const triggerError = await validateTriggerPrice(pair, side, Number(trigger_price));
		if (triggerError) {
			return CreateOrderOutputSchema.parse(fail(triggerError, 'validation_error'));
		}
	}

	const client = getDefaultClient();

	try {
		const isMargin = !!position_side;
		const body: Record<string, unknown> = { pair, amount, side, type };
		if (price) body.price = price;
		if (post_only != null) body.post_only = post_only;
		if (trigger_price) body.trigger_price = trigger_price;
		if (position_side) body.position_side = position_side;

		// `data.order.pair` は小文字契約で返すが、リクエストボディの `pair` はユーザー入力のまま（正規化は応答側だけ）。
		const rawOrder = withNormalizedPair(await client.post<OrderResponse>('/v1/user/spot/order', body));

		const timestamp = nowIso();
		const isJpy = isJpyQuotedPair(pair);
		const sideLabel = side === 'buy' ? '買' : '売';
		const fmtPrice = price ? (isJpy ? formatPrice(Number(price)) : price) : '成行';

		let marginLabel = '';
		if (isMargin) {
			const posLabel = position_side === 'long' ? 'ロング' : 'ショート';
			const isOpen = (side === 'buy' && position_side === 'long') || (side === 'sell' && position_side === 'short');
			marginLabel = isOpen ? `信用新規（${posLabel}）` : `信用決済（${posLabel}）`;
		}

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

		// 発注済み内容の確認カードが復元されて二重発注を誘発しないよう、実行済み preview のスナップショットを無効化する（同一セッションのエントリのみ）。
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
	// iframe 起源の tools/call をサーバー側で識別できないので visibility に app を含めない。MCP Apps 実行経路の解錠は handler 側のゲートとトークン検証で行う。
	_meta: {
		ui: {
			visibility: ['model'],
		},
	},
	handler: async (args, extra) => runAppUiExecute(args, extra, CreateOrderOutputSchema, createOrder),
};
