/**
 * get_my_assets — 自分の資産残高を取得する Private API ツール。
 *
 * bitbank Private API `/v1/user/assets` を呼び出し、
 * ticker 連携で円評価額・構成比を自動算出する。
 */

import { toNum } from '../../lib/conversions.js';
import { nowIso } from '../../lib/datetime.js';
import { formatPrice } from '../../lib/formatter.js';
import { ok } from '../../lib/result.js';
import type { RawAsset } from '../../src/handlers/portfolio/types.js';
import { getDefaultClient } from '../../src/private/client.js';
import { GetMyAssetsInputSchema, GetMyAssetsOutputSchema } from '../../src/private/schemas.js';
import { failPrivateToolError } from '../../src/private/tool-error.js';
import type { ToolDefinition } from '../../src/tool-definition.js';

/**
 * public API の tickers_jpy から各通貨の最新価格を取得する。
 * 失敗しても get_my_assets 自体は動作する（partial_data_warning）。
 */
async function fetchTickerPrices(): Promise<{ prices: Map<string, number>; error?: string }> {
	try {
		const res = await fetch('https://public.bitbank.cc/tickers_jpy', {
			signal: AbortSignal.timeout(3000),
		});
		if (!res.ok) {
			return { prices: new Map(), error: `ticker HTTP ${res.status}` };
		}
		const json = (await res.json()) as { success?: number; data?: Array<{ pair: string; last: string }> };
		if (json.success !== 1 || !Array.isArray(json.data)) {
			return { prices: new Map(), error: 'ticker レスポンス不正' };
		}

		const prices = new Map<string, number>();
		for (const item of json.data) {
			const asset = item.pair.replace('_jpy', '');
			const last = toNum(item.last);
			if (last != null && last > 0) {
				prices.set(asset, last);
			}
		}
		return { prices };
	} catch (e) {
		return { prices: new Map(), error: e instanceof Error ? e.message : 'ticker 取得失敗' };
	}
}

export default async function getMyAssets(args: { include_jpy_valuation?: boolean }) {
	const { include_jpy_valuation = true } = args;
	const client = getDefaultClient();

	try {
		const rawAssets = await client.get<{ assets: RawAsset[] }>('/v1/user/assets');
		const timestamp = nowIso();

		// ゼロでない資産のみ抽出
		const nonZeroAssets = rawAssets.assets.filter((a) => {
			const amount = toNum(a.onhand_amount);
			return amount != null && amount > 0;
		});

		// ticker 連携（オプション）
		let tickerError: string | undefined;
		let prices = new Map<string, number>();

		if (include_jpy_valuation) {
			const tickerResult = await fetchTickerPrices();
			prices = tickerResult.prices;
			tickerError = tickerResult.error;
		}

		// 資産データの組み立て
		let totalJpyValue = 0;
		const assets = nonZeroAssets.map((a) => {
			const amount = a.onhand_amount;
			const available = a.free_amount;
			const locked = a.locked_amount;

			let jpyValue: number | undefined;
			if (include_jpy_valuation) {
				if (a.asset === 'jpy') {
					jpyValue = toNum(amount) ?? undefined;
				} else {
					const price = prices.get(a.asset);
					const amountN = toNum(amount);
					if (price && amountN != null) {
						jpyValue = amountN * price;
					}
				}
			}

			if (jpyValue != null && Number.isFinite(jpyValue)) {
				totalJpyValue += jpyValue;
			}

			return {
				asset: a.asset,
				amount,
				available_amount: available,
				locked_amount: locked,
				jpy_value: jpyValue != null && Number.isFinite(jpyValue) ? Math.round(jpyValue) : undefined,
			};
		});

		// 構成比の算出
		if (include_jpy_valuation && totalJpyValue > 0) {
			for (const asset of assets) {
				if (asset.jpy_value != null) {
					(asset as { allocation_pct?: number }).allocation_pct =
						Math.round((asset.jpy_value / totalJpyValue) * 10000) / 100;
				}
			}
		}

		// JPY 評価額降順でソート
		assets.sort((a, b) => (b.jpy_value ?? 0) - (a.jpy_value ?? 0));

		// サマリー文字列の生成
		const lines: string[] = [];
		lines.push(`保有資産: ${assets.length}通貨`);
		if (include_jpy_valuation && totalJpyValue > 0) {
			lines.push(`合計評価額: ${formatPrice(totalJpyValue, 'btc_jpy')}`);
		}
		lines.push('');

		for (const a of assets) {
			const assetUpper = a.asset.toUpperCase();
			let line = `${assetUpper}: ${a.amount}`;
			if (a.jpy_value != null) {
				line += ` (${formatPrice(a.jpy_value, 'btc_jpy')}`;
				const pct = (a as { allocation_pct?: number }).allocation_pct;
				if (pct != null) {
					line += `, ${pct}%`;
				}
				line += ')';
			}
			if ((toNum(a.locked_amount) ?? 0) > 0) {
				line += ` [ロック: ${a.locked_amount}]`;
			}
			lines.push(line);
		}

		if (tickerError) {
			lines.push('');
			lines.push(`⚠ ticker 連携一部失敗: ${tickerError}（一部通貨の円評価額が欠損している可能性があります）`);
		}

		const summary = lines.join('\n');
		const hasJpyValuation = include_jpy_valuation && totalJpyValue > 0;

		const data = {
			assets,
			total_jpy_value: hasJpyValuation ? Math.round(totalJpyValue) : undefined,
			timestamp,
		};

		const meta = {
			fetchedAt: timestamp,
			assetCount: assets.length,
			hasJpyValuation,
			...(client.lastRateLimit ? { rateLimit: client.lastRateLimit } : {}),
		};

		const result = ok(summary, data, meta);

		// ticker 一部失敗の場合は partial_data_warning を付与
		if (tickerError) {
			(result.meta as Record<string, unknown>).warning = 'partial_data_warning';
			(result.meta as Record<string, unknown>).warningDetail = tickerError;
		}

		return GetMyAssetsOutputSchema.parse(result);
	} catch (err) {
		// PrivateApiError は分類済み文言を素通し、未知エラーは err.message を伏せて汎用文に置換する。
		return GetMyAssetsOutputSchema.parse(failPrivateToolError(err, 'asset 取得中に予期しないエラーが発生しました'));
	}
}

// ── MCP ツール定義（tool-registry から自動収集） ──
export const toolDef: ToolDefinition = {
	name: 'get_my_assets',
	description:
		'[My Assets / Balance / Wallet] 自分の保有資産・残高一覧（my assets / balance / wallet / holdings）を取得。全通貨の数量・円評価額・構成比を返す。Private API。',
	inputSchema: GetMyAssetsInputSchema,
	handler: async (args: Record<string, unknown>) => getMyAssets(args as { include_jpy_valuation?: boolean }),
};
