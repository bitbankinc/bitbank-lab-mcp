import { z } from 'zod';
import { toNum } from '../../lib/conversions.js';
import { formatPercent, formatPrice, formatVolumeJPY } from '../../lib/formatter.js';
import getTickersJpy from '../../tools/get_tickers_jpy.js';
import { GetTickersJpyHandlerOutputSchema } from '../schemas.js';
import type { ToolDefinition } from '../tool-definition.js';

export interface NormalizedTicker {
	pair: string;
	lastN: number | null;
	openN: number | null;
	highN: number | null;
	lowN: number | null;
	buyN: number | null;
	sellN: number | null;
	changeN: number | null;
	volN: number | null;
	volumeInJPY: number | null;
}

/** ranked ビューのテキスト組み立て — テスト可能な純粋関数 */
export function buildTickersJpyRankedText(
	totalItems: number,
	ranked: NormalizedTicker[],
	sortBy: string,
	order: string,
	limit: number,
): string {
	const lines = ranked.map((r, i) => {
		const chg = formatPercent(r.changeN, { sign: true, digits: 2 });
		const px = formatPrice(r.lastN);
		const volTxt = formatVolumeJPY(r.volumeInJPY);
		return `${i + 1}. ${String(r.pair).toUpperCase().replace('_', '/')} ${chg}（${px}、出来高${volTxt}）`;
	});
	return [`全${totalItems}ペア取得（sortBy=${sortBy}, ${order}, top${limit}）`, '', lines.join('\n')].join('\n');
}

/** items ビューのテキスト組み立て — テスト可能な純粋関数 */
export function buildTickersJpyItemsText(items: NormalizedTicker[]): string {
	const lines: string[] = [];
	lines.push(`全${items.length}ペア取得`);
	lines.push('');
	const top5 = items.slice(0, 5);
	for (const it of top5) {
		const pairDisplay = String(it.pair).toUpperCase().replace('_', '/');
		const priceStr = formatPrice(it.lastN);
		const changeStr = formatPercent(it.changeN, { sign: true, digits: 2 });
		const volStr = formatVolumeJPY(it.volumeInJPY);
		lines.push(`${pairDisplay}: ${priceStr} (${changeStr}) 出来高${volStr}`);
	}
	if (items.length > 5) {
		lines.push(`... 他${items.length - 5}ペア`);
	}
	return lines.join('\n');
}

const InputSchema = z.object({
	view: z.enum(['items', 'ranked']).optional().default('ranked'),
	sortBy: z.enum(['change24h', 'volume', 'name']).optional().default('change24h'),
	order: z.enum(['asc', 'desc']).optional().default('desc'),
	limit: z.number().int().min(1).max(50).optional().default(5),
});

export const toolDef: ToolDefinition = {
	name: 'get_tickers_jpy',
	description:
		'[All Tickers / Market Overview] 全JPYペアのティッカー一覧（tickers / ranking / market overview）を取得。変化率・出来高でランキング表示可能。',
	inputSchema: InputSchema,
	handler: async (args: Record<string, unknown>) => {
		const parsed = InputSchema.parse(args);
		const { view, sortBy, order, limit } = parsed;
		const res = await getTickersJpy();
		if (!res?.ok) return res;
		const items = (Array.isArray(res?.data) ? res.data : []) as Array<{
			pair: string;
			last?: unknown;
			open?: unknown;
			high?: unknown;
			low?: unknown;
			buy?: unknown;
			sell?: unknown;
			change24h?: unknown;
			change24hPct?: unknown;
			vol?: unknown;
			[key: string]: unknown;
		}>;

		// normalize numeric fields（open/high/low 追加）
		const norm = items.map((it) => {
			const lastN = toNum(it?.last);
			const openN = toNum(it?.open);
			const highN = toNum(it?.high);
			const lowN = toNum(it?.low);
			const buyN = toNum(it?.buy);
			const sellN = toNum(it?.sell);
			const change = it?.change24h ?? it?.change24hPct;
			const changeN =
				change != null
					? toNum(change)
					: openN != null && openN > 0 && lastN != null
						? Number((((lastN - openN) / openN) * 100).toFixed(2))
						: null;
			const volN = toNum(it?.vol);
			// 有限数同士の積でも 1e308 * 1e308 のように Infinity へオーバーフローし得るため、結果側も明示的に弾く。
			const product = volN != null && lastN != null ? volN * lastN : null;
			const volumeInJPY = product != null && Number.isFinite(product) ? product : null;
			return { ...it, lastN, openN, highN, lowN, buyN, sellN, changeN, volN, volumeInJPY };
		});

		// ranking logic
		const cmpNum = (a?: number | null, b?: number | null) => {
			const aa = a == null ? -Infinity : a;
			const bb = b == null ? -Infinity : b;
			return aa - bb;
		};
		const sorted = [...norm].sort((a, b) => {
			if (sortBy === 'name') {
				return String(a.pair).localeCompare(String(b.pair));
			}
			if (sortBy === 'volume') {
				return cmpNum(a.volumeInJPY, b.volumeInJPY);
			}
			return cmpNum(a.changeN, b.changeN);
		});
		if ((order || 'desc') === 'desc') sorted.reverse();
		const ranked = sorted.slice(0, Number(limit || 5));

		if (view === 'ranked') {
			const text = buildTickersJpyRankedText(items.length, ranked, sortBy, order, limit);
			const structured = GetTickersJpyHandlerOutputSchema.parse({
				ok: true,
				summary: `ranked ${ranked.length}/${items.length}`,
				data: { items: norm, ranked },
				meta: res?.meta ?? {},
			});
			return {
				content: [{ type: 'text', text }],
				structuredContent: structured as unknown as Record<string, unknown>,
			};
		}

		// view=items: 全データ一覧（上位5件をサマリ表示）
		const text = buildTickersJpyItemsText(norm);
		const structured = GetTickersJpyHandlerOutputSchema.parse({
			ok: true,
			summary: res?.summary ?? `items ${norm.length}`,
			data: { items: norm },
			meta: res?.meta ?? {},
		});
		return {
			content: [{ type: 'text', text }],
			structuredContent: structured as unknown as Record<string, unknown>,
		};
	},
};
