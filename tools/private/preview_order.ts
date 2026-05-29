/**
 * preview_order — 注文プレビュー。
 *
 * 注文パラメータのバリデーションを行い、プレビューを表示する。実際の発注は行わない。
 *
 * 内部的に confirmation_token も生成するが、これはサーバープロセス内に閉じる:
 *   - elicitation 対応ホスト: ハンドラ内の accept 経路で create_order へ非公開のまま引き渡す
 *   - elicitation 非対応ホスト: 取引実行は行わずプレビューのみ返し、token はクライアントに渡さない
 *
 * 詳細は docs/private-api.md「`confirmation_token` の受け渡し」節を参照。
 */

import { formatPair, formatPrice } from '../../lib/formatter.js';
import { fetchPairsSpec, validateOrderConstraints } from '../../lib/pairs.js';
import { fail, ok, toStructured } from '../../lib/result.js';
import { validateTriggerPrice } from '../../lib/trigger-price.js';
import { generateToken } from '../../src/private/confirmation.js';
import { withElicitedConfirmation } from '../../src/private/elicitation.js';
import { PreviewOrderInputSchema, PreviewOrderOutputSchema } from '../../src/private/schemas.js';
import type { ToolDefinition } from '../../src/tool-definition.js';
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

	// /spot/pairs に照らした事前バリデーション（最小数量・桁数・取引停止フラグ）
	// API 取得失敗時は warning に留めて発注を継続する（後段の bitbank 側で必ず検証されるため）。
	// 失敗時の挙動は docs/private-api.md「ペア仕様の事前バリデーション」節を参照。
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
			return PreviewOrderOutputSchema.parse(fail(violation.message, 'validation_error'));
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		warnings.push(`ペア仕様（/spot/pairs）取得失敗のため最小数量・桁数チェックをスキップしました: ${msg}`);
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
	if (warnings.length > 0) {
		lines.push('');
		for (const w of warnings) {
			lines.push(`⚠️ ${w}`);
		}
	}
	lines.push('');
	lines.push('⚠️ この注文はユーザーの最終確認（ホスト UI または elicitation）を経るまで発注されません。');

	const summary = lines.join('\n');

	const preview: Record<string, unknown> = { pair, amount, side, type };
	if (price) preview.price = price;
	if (trigger_price) preview.trigger_price = trigger_price;
	if (post_only) preview.post_only = post_only;
	if (position_side) preview.position_side = position_side;

	const meta: { action: 'create_order'; warnings?: string[] } = { action: 'create_order' as const };
	if (warnings.length > 0) meta.warnings = warnings;

	return PreviewOrderOutputSchema.parse(
		ok(summary, { confirmation_token: token, expires_at: expiresAt, preview }, meta),
	);
}

export const toolDef: ToolDefinition = {
	name: 'preview_order',
	description: [
		'[Preview Order] 注文内容をプレビューする。実際の発注は行わない。Private API。',
		'バリデーション（パラメータチェック、トリガー価格チェック）もここで実施する。',
		'対応注文タイプは limit / market / stop / stop_limit の 4 種類のみ（take_profit / stop_loss / losscut は未対応）。',
		'position_side を指定すると信用注文として扱う（ロング新規=buy+long, ロング決済=sell+long, ショート新規=sell+short, ショート決済=buy+short）。',
		'⚠️ confirmation_token はクライアント側には返さない（content / structuredContent / _meta のいずれにも含めない）。',
		'実際の発注は elicitation 対応ホストでのみ可能で、その場合はこのハンドラ内で preview → ユーザー確認 → create_order までを完結させる。',
		'elicitation 非対応ホストではプレビュー内容のみ返し、取引実行は受け付けない。',
	].join(' '),
	inputSchema: PreviewOrderInputSchema,
	// MCP Apps (SEP-1865): 対応ホストでは iframe 内に注文確認 UI を表示する。
	// 非対応ホストでは無視される（Progressive Enhancement）。
	// 注: 本 PR 時点では UI 側からの create_order 経路は未実装（pending action store と
	// UI origin 検証の安全設計を別 PR で整備するまで token を UI に渡さない）。
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

		// elicitation 非対応ホスト向けのフォールバックレスポンス。
		// 取引実行はこのホストでは行えない旨を明示し、トークンの存在は仄めかさない。
		const fallbackText = [
			result.summary,
			'',
			'※ このホストでは取引実行に対応していません。',
			'  実際に発注するには、elicitation 対応クライアント（Claude Desktop など）で同じ操作を実行してください。',
		].join('\n');

		// BITBANK_TRUST_HOST_APPROVAL=1 のときに使う妥協経路用のレスポンス。
		// structuredContent に confirmation_token / expires_at を含めたまま返し、
		// SEP-1865 iframe ボタン → create_order の経路を成立させる。
		// 詳細は docs/adr/0002-hitl-confirmation-token-delivery.md。
		const trustHostFallbackText = [
			result.summary,
			'',
			'iframe の「注文を確定する」ボタンを押して発注を確定してください。',
			'ボタンを押さない限り発注は行われません。',
		].join('\n');

		// elicitation 対応ホストでは preview → ユーザー確認 → create_order までを
		// このハンドラ内で完結させる（LLM から見ると preview_order 1 回呼び出しで発注完了）。
		// confirmation_token / expires_at は withElicitedConfirmation が
		// structuredContent / declinedStructured / fallback から必ず剥がすため
		// caller 側で sanitize する必要はない（多層防御の最終ガードは helper 側）。
		return withElicitedConfirmation({
			extra,
			summary: result.summary,
			confirmTitle: 'この注文を発注する',
			// 内部的に create_order を実行。監査ログには route='elicitation' で記録される。
			// confirmation_token / expires_at は previewOrder() が必ず生成するため non-null 断定して渡す
			// （スキーマ上は optional だが内部生成のみで undefined にはならない）。
			onConfirmed: () =>
				createOrder(
					{
						...typedArgs,
						confirmation_token: result.data.confirmation_token!,
						token_expires_at: result.data.expires_at!,
					},
					'elicitation',
				),
			onDeclinedText: 'ユーザーが発注をキャンセルしました（elicitation）',
			declinedStructured: toStructured(result),
			fallback: {
				content: [{ type: 'text', text: fallbackText }],
				structuredContent: toStructured(result),
			},
			trustHostFallback: {
				content: [{ type: 'text', text: trustHostFallbackText }],
				structuredContent: toStructured(result),
			},
		});
	},
};
