/**
 * preview_order — 注文プレビューと確認トークン発行。
 *
 * 注文パラメータのバリデーションを行い、プレビューを表示し、
 * create_order に渡す確認トークンを発行する。実際の発注は行わない。
 */

import { toNum } from '../../lib/conversions.js';
import { formatPair, formatPrice } from '../../lib/formatter.js';
import { BITBANK_API_BASE, fetchJson } from '../../lib/http.js';
import { fail, ok, toStructured } from '../../lib/result.js';
import { generateToken } from '../../src/private/confirmation.js';
import { PreviewOrderInputSchema, PreviewOrderOutputSchema } from '../../src/private/schemas.js';
import type { ToolDefinition, ToolHandlerExtra } from '../../src/tool-definition.js';
import createOrder from './create_order.js';

/** 注文タイプごとの必須パラメータチェック */
function validateOrderParams(args: {
	type: string;
	price?: string;
	trigger_price?: string;
	post_only?: boolean;
}): string | null {
	const { type, price, trigger_price, post_only } = args;

	switch (type) {
		case 'limit':
			if (!price) return 'limit 注文には price（指値価格）が必須です';
			break;
		case 'market':
			if (price) return 'market 注文に price は指定できません（成行で約定します）';
			if (trigger_price) return 'market 注文に trigger_price は指定できません。逆指値は type="stop" を使用してください';
			break;
		case 'stop':
			if (!trigger_price) return 'stop 注文には trigger_price（トリガー価格）が必須です';
			if (price)
				return 'stop 注文に price は指定できません。トリガー到達後に指値で発注したい場合は type="stop_limit" を使用してください';
			break;
		case 'stop_limit':
			if (!trigger_price) return 'stop_limit 注文には trigger_price（トリガー価格）が必須です';
			if (!price) return 'stop_limit 注文には price（トリガー到達後の指値価格）が必須です';
			break;
	}

	if (post_only && type !== 'limit') {
		return 'post_only は limit 注文でのみ有効です';
	}

	return null;
}

function isPositiveNumericString(s: string): boolean {
	const n = Number(s);
	return Number.isFinite(n) && n > 0;
}

async function validateTriggerPrice(pair: string, side: 'buy' | 'sell', triggerPrice: number): Promise<string | null> {
	try {
		const url = `${BITBANK_API_BASE}/${pair}/ticker`;
		const json = (await fetchJson(url, { timeoutMs: 5000 })) as {
			success?: number;
			data?: { last?: string };
		};
		if (json?.success !== 1 || !json.data?.last) return null;
		const currentPrice = toNum(json.data.last);
		if (currentPrice == null) return null;

		if (side === 'sell' && triggerPrice >= currentPrice) {
			return [
				`stop sell のトリガー価格（${formatPrice(triggerPrice)}）が現在価格（${formatPrice(currentPrice)}）以上のため、即時発動してしまいます。`,
				'stop sell は「価格がトリガー以下に下落したとき」に発動します（損切り・ストップロス用）。',
				'R1 上抜けで利確したい場合は limit sell を使用してください。',
			].join('\n');
		}

		if (side === 'buy' && triggerPrice <= currentPrice) {
			return [
				`stop buy のトリガー価格（${formatPrice(triggerPrice)}）が現在価格（${formatPrice(currentPrice)}）以下のため、即時発動してしまいます。`,
				'stop buy は「価格がトリガー以上に上昇したとき」に発動します（ブレイクアウト買い用）。',
				'指定価格以下で買いたい場合は limit buy を使用してください。',
			].join('\n');
		}
	} catch {
		return null;
	}
	return null;
}

export default async function previewOrder(args: {
	pair: string;
	amount: string;
	price?: string;
	side: 'buy' | 'sell';
	type: 'limit' | 'market' | 'stop' | 'stop_limit';
	post_only?: boolean;
	trigger_price?: string;
	position_side?: 'long' | 'short';
}) {
	const { pair, amount, price, side, type, post_only, trigger_price, position_side } = args;

	// バリデーション
	const paramError = validateOrderParams({ type, price, trigger_price, post_only });
	if (paramError) {
		return PreviewOrderOutputSchema.parse(fail(paramError, 'validation_error'));
	}

	if (!isPositiveNumericString(amount)) {
		return PreviewOrderOutputSchema.parse(fail('amount は正の数値を指定してください', 'validation_error'));
	}
	if (price && !isPositiveNumericString(price)) {
		return PreviewOrderOutputSchema.parse(fail('price は正の数値を指定してください', 'validation_error'));
	}
	if (trigger_price && !isPositiveNumericString(trigger_price)) {
		return PreviewOrderOutputSchema.parse(fail('trigger_price は正の数値を指定してください', 'validation_error'));
	}

	// stop / stop_limit: トリガー価格の妥当性チェック
	if ((type === 'stop' || type === 'stop_limit') && trigger_price) {
		const triggerError = await validateTriggerPrice(pair, side, Number(trigger_price));
		if (triggerError) {
			return PreviewOrderOutputSchema.parse(fail(triggerError, 'validation_error'));
		}
	}

	// 確認トークン生成
	const tokenParams: Record<string, unknown> = { pair, amount, side, type };
	if (price) tokenParams.price = price;
	if (post_only != null) tokenParams.post_only = post_only;
	if (trigger_price) tokenParams.trigger_price = trigger_price;
	if (position_side) tokenParams.position_side = position_side;

	const { token, expiresAt } = generateToken('create_order', tokenParams);

	// プレビュー表示
	const isJpy = pair.includes('jpy');
	const sideLabel = side === 'buy' ? '買' : '売';
	const fmtPrice = price ? (isJpy ? formatPrice(Number(price)) : price) : '成行';
	const isMargin = !!position_side;

	// 信用取引の操作ラベル
	let marginLabel = '';
	if (isMargin) {
		const posLabel = position_side === 'long' ? 'ロング' : 'ショート';
		const isOpen = (side === 'buy' && position_side === 'long') || (side === 'sell' && position_side === 'short');
		marginLabel = isOpen ? `信用新規（${posLabel}）` : `信用決済（${posLabel}）`;
	}

	const lines: string[] = [];
	if (isMargin) {
		lines.push(`📋 ${marginLabel} 注文プレビュー: ${formatPair(pair)}`);
	} else {
		lines.push(`📋 注文プレビュー: ${formatPair(pair)}`);
	}
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
	if (isMargin) {
		lines.push('');
		lines.push('⚠️ 信用取引です。損失が保証金を超える可能性があります。');
	}
	lines.push('');
	lines.push('⚠️ この注文はユーザーの最終確認（ホスト UI または elicitation）を経るまで発注されません。');

	const summary = lines.join('\n');

	const preview: Record<string, unknown> = { pair, amount, side, type };
	if (price) preview.price = price;
	if (trigger_price) preview.trigger_price = trigger_price;
	if (post_only) preview.post_only = post_only;
	if (position_side) preview.position_side = position_side;

	return PreviewOrderOutputSchema.parse(
		ok(summary, { confirmation_token: token, expires_at: expiresAt, preview }, { action: 'create_order' as const }),
	);
}

/**
 * クライアントが elicitation/create に対応しているかを判定する。
 * 非対応ホストでは従来挙動（structuredContent でトークンを返す）にフォールバックする。
 */
function clientSupportsElicitation(extra: ToolHandlerExtra | undefined): boolean {
	const server = (extra as { server?: { getClientCapabilities?: () => unknown } } | undefined)?.server;
	const caps = typeof server?.getClientCapabilities === 'function' ? server.getClientCapabilities() : undefined;
	const elicitation = (caps as { elicitation?: unknown } | undefined)?.elicitation;
	return Boolean(elicitation);
}

/** SDK の elicitInput を呼び出すための最小限の interface */
interface ElicitCapableServer {
	elicitInput: (params: {
		message: string;
		requestedSchema: Record<string, unknown>;
	}) => Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }>;
}

export const toolDef: ToolDefinition = {
	name: 'preview_order',
	description: [
		'[Preview Order] 注文内容をプレビューし確認トークンを発行する。実際の発注は行わない。Private API。',
		'create_order を実行するには、まずこのツールで確認トークンを取得する必要がある。',
		'バリデーション（パラメータチェック、トリガー価格チェック）もここで実施する。',
		'position_side を指定すると信用注文として扱う（ロング新規=buy+long, ロング決済=sell+long, ショート新規=sell+short, ショート決済=buy+short）。',
		'⚠️ confirmation_token は LLM 可視テキストには含めない。ホスト UI または elicitation のユーザー確認を経て create_order が呼ばれる前提。LLM が独断でトークンを引用して create_order を呼ぶと二重発注になり得る。',
	].join(' '),
	inputSchema: PreviewOrderInputSchema,
	// MCP Apps (SEP-1865): 対応ホストでは iframe 内に注文確認 UI を表示する。
	// 非対応ホストでは無視され、従来のテキスト確認フローがそのまま動作する（Progressive Enhancement）。
	_meta: {
		ui: {
			resourceUri: 'ui://order/confirm.html',
		},
	},
	handler: async (args, extra) => {
		const typedArgs = args as {
			pair: string;
			amount: string;
			price?: string;
			side: 'buy' | 'sell';
			type: 'limit' | 'market' | 'stop' | 'stop_limit';
			post_only?: boolean;
			trigger_price?: string;
			position_side?: 'long' | 'short';
		};
		const result = await previewOrder(typedArgs);
		if (!result.ok) return result;

		// elicitation 対応ホストでは preview → ユーザー確認 → create_order までを
		// このハンドラ内で完結させる（LLM から見ると preview_order 1 回呼び出しで発注完了）。
		// 非対応ホストでは従来通り structuredContent 経由でトークンを渡しフォールバックする。
		if (clientSupportsElicitation(extra)) {
			const server = (extra as { server?: ElicitCapableServer } | undefined)?.server;
			if (server && typeof server.elicitInput === 'function') {
				try {
					const elicit = await server.elicitInput({
						message: result.summary,
						requestedSchema: {
							type: 'object',
							properties: {
								confirmed: { type: 'boolean', title: 'この注文を発注する' },
							},
							required: ['confirmed'],
						},
					});
					if (elicit.action !== 'accept' || !elicit.content?.confirmed) {
						return {
							content: [{ type: 'text', text: 'ユーザーが発注をキャンセルしました（elicitation）' }],
							structuredContent: toStructured(result),
						};
					}
					// 内部的に create_order を実行。監査ログには route='elicitation' で記録される。
					const orderResult = await createOrder(
						{
							...typedArgs,
							confirmation_token: result.data.confirmation_token,
							token_expires_at: result.data.expires_at,
						},
						'elicitation',
					);
					const orderText = orderResult.ok ? orderResult.summary : `Error: ${orderResult.summary}`;
					return {
						content: [{ type: 'text', text: orderText }],
						structuredContent: toStructured(orderResult),
					};
				} catch {
					// elicitInput が想定外に失敗した場合はフォールバックに進む。
				}
			}
		}

		// フォールバック: confirmation_token は LLM 可視テキストには含めず、
		// structuredContent 側にだけ残す。SEP-1865 UI ボタンや Inspector はこちらを参照する。
		const text = [
			result.summary,
			'',
			'※ confirmation_token はホスト UI / structuredContent 経由でのみ受け渡されます。',
			'  LLM はトークンを引用したり、ユーザー確認なしに create_order を呼ばないでください。',
		].join('\n');
		return {
			content: [{ type: 'text', text }],
			structuredContent: toStructured(result),
		};
	},
};
