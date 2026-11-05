import { toNum } from '../../lib/conversions.js';
import { nowIso, toIsoMs } from '../../lib/datetime.js';
import { formatPair, formatPrice } from '../../lib/formatter.js';
import { normalizePairCodes } from '../../lib/pair-code.js';
import { ok } from '../../lib/result.js';
import { normalizePair } from '../../lib/validate.js';
import { getDefaultClient } from '../../src/private/client.js';
import { GetMarginPositionsInputSchema, GetMarginPositionsOutputSchema } from '../../src/private/schemas.js';
import { failPrivateToolError } from '../../src/private/tool-error.js';
import type { ToolDefinition } from '../../src/tool-definition.js';

interface RawMarginPositionsResponse {
	notice: {
		what: string | null;
		occurred_at: number | null;
		amount: string | null;
		due_date_at: number | null;
	} | null;
	payables: {
		amount: string;
	};
	positions: Array<{
		pair: string;
		position_side: 'long' | 'short';
		open_amount: string;
		product: string;
		average_price: string;
		unrealized_fee_amount: string;
		unrealized_interest_amount: string;
	}>;
	losscut_threshold: {
		individual: string;
		company: string;
	};
}

export default async function getMarginPositions(args: { pair?: string }) {
	// 下のクライアント側フィルタは API 応答の pair と `===` で突き合わせるので、入力も小文字の空間に乗せる（大文字入力で建玉が全件消える）。
	// `ensurePair` は使わない。ALLOWED_PAIRS に無い pair（上場廃止ペア等）の建玉を照会できなくなる。
	const pair = args.pair != null ? (normalizePair(args.pair) ?? args.pair) : undefined;
	const client = getDefaultClient();

	try {
		const params: Record<string, string> = {};
		if (pair) params.pair = pair;

		const raw = await client.get<RawMarginPositionsResponse>(
			'/v1/user/margin/positions',
			Object.keys(params).length > 0 ? params : undefined,
		);

		const timestamp = nowIso();

		// 下のフィルタの `===` 比較と JPY 判定（`p.pair.includes('jpy')`）が小文字前提なので、取得境界で揃える。
		const allPositions = normalizePairCodes(raw.positions);

		// API がペアのフィルタに対応していない場合に備えたクライアント側フィルタ。
		const positions = pair ? allPositions.filter((p) => p.pair === pair) : allPositions;

		const hasNotice = raw.notice != null && raw.notice.what != null;
		const hasPayables = (toNum(raw.payables.amount) ?? 0) > 0;

		// 危険情報（追証・不足金）は LLM が見落とさないよう summary の先頭に出す（get_margin_status.ts と揃える）。
		const lines: string[] = [];

		if (hasNotice && raw.notice) {
			const n = raw.notice;
			const dueDate = n.due_date_at != null ? (toIsoMs(n.due_date_at) ?? String(n.due_date_at)) : '—';
			const amountText = n.amount != null ? `${formatPrice(Number(n.amount))} 円` : '—';
			lines.push(`⚠ ${n.what}: ${amountText}（期日: ${dueDate}）`);
		}
		if (hasPayables) {
			lines.push(`⚠ 不足金: ${formatPrice(toNum(raw.payables.amount))} 円`);
		}
		if (lines.length > 0) {
			lines.push('');
		}

		const pairLabel = pair ? formatPair(pair) : '全ペア';
		lines.push(`信用建玉一覧: ${pairLabel} ${positions.length}件`);

		if (positions.length > 0) {
			lines.push('');
			for (const p of positions) {
				const sideLabel = p.position_side === 'long' ? 'ロング' : 'ショート';
				const isJpy = p.pair.includes('jpy');
				const avgPrice = isJpy ? formatPrice(Number(p.average_price)) : p.average_price;
				lines.push(
					`${formatPair(p.pair)} ${sideLabel} ${p.open_amount} @ ${avgPrice} (評価額: ${formatPrice(Number(p.product))} 円)`,
				);
			}

			const longCount = positions.filter((p) => p.position_side === 'long').length;
			const shortCount = positions.filter((p) => p.position_side === 'short').length;
			lines.push('');
			lines.push(`集計: ロング ${longCount}件 / ショート ${shortCount}件`);
		} else {
			lines.push('建玉はありません');
		}

		const summary = lines.join('\n');

		const data = {
			positions,
			notice: raw.notice,
			payables: raw.payables,
			losscut_threshold: raw.losscut_threshold,
			timestamp,
		};

		const meta = {
			fetchedAt: timestamp,
			positionCount: positions.length,
			pair: pair || undefined,
			hasNotice,
			...(client.lastRateLimit ? { rateLimit: client.lastRateLimit } : {}),
		};

		return GetMarginPositionsOutputSchema.parse(ok(summary, data, meta));
	} catch (err) {
		return GetMarginPositionsOutputSchema.parse(
			failPrivateToolError(err, '信用建玉取得中に予期しないエラーが発生しました'),
		);
	}
}

export const toolDef: ToolDefinition = {
	name: 'get_margin_positions',
	description:
		'[Margin Positions / 信用建玉一覧] 信用取引の保有建玉一覧（通貨ペア・方向・数量・評価額・平均取得価格）を取得。追証・不足金がある場合はアラート表示。通貨ペアでフィルタ可能。Private API。',
	inputSchema: GetMarginPositionsInputSchema,
	handler: async (args: { pair?: string }) => getMarginPositions(args),
};
