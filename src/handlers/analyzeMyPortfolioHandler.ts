/**
 * analyzeMyPortfolioHandler — ポートフォリオ分析のメインハンドラ。
 *
 * データ取得・計算ロジックは以下のモジュールに分離:
 *   - portfolio/types.ts  — 型定義
 *   - portfolio/fetch.ts  — API データ取得レイヤー
 *   - portfolio/calc.ts   — 純粋計算ロジック
 */

import { dayjs, nowIso } from '../../lib/datetime.js';
import { formatPair, formatPercent, formatPrice, formatPriceJPY } from '../../lib/formatter.js';
import { fail, ok } from '../../lib/result.js';
import { getDefaultClient, PrivateApiError } from '../private/client.js';
import { AnalyzeMyPortfolioOutputSchema } from '../private/schemas.js';
import {
	buildAccountPnl,
	buildEquitySeries,
	buildPeriodAccountPnl,
	calcDepositWithdrawalSummary,
	calcMarginPnl,
	calcPeriodDWSummary,
	calcPeriodMarginPnl,
	calcPeriodNetFlow,
	calcPeriodRealizedPnl,
	calcPnl,
	calcPortfolioValue,
	getJstPeriodBoundaries,
	reconstructHoldingsAtDate,
} from './portfolio/calc.js';
import {
	fetchCandlePriceData,
	fetchDepositWithdrawal,
	fetchTechnical,
	fetchTickerPrices,
	paginateMarginTrades,
	paginateTrades,
} from './portfolio/fetch.js';
import type {
	AccountPnl,
	CandlePriceData,
	DepositWithdrawalSummary,
	EquityPoint,
	PeriodAccountPnl,
	PeriodDWSummary,
	PeriodPerformance,
	PeriodRealizedPnl,
	RawAsset,
	RawMarginTrade,
	RawTrade,
	TechnicalSummary,
} from './portfolio/types.js';

export default async function analyzeMyPortfolioHandler(args: {
	include_technical?: boolean;
	include_pnl?: boolean;
	include_deposit_withdrawal?: boolean;
}) {
	const { include_technical = true, include_pnl = true, include_deposit_withdrawal = true } = args;
	const client = getDefaultClient();

	try {
		// 1. 保有資産 + ticker を並列取得
		const [rawAssets, prices] = await Promise.all([
			client.get<{ assets: RawAsset[] }>('/v1/user/assets'),
			fetchTickerPrices(),
		]);

		// ゼロでない資産（JPY 含む）
		const nonZeroAssets = rawAssets.assets.filter((a) => {
			const amount = Number(a.onhand_amount);
			return Number.isFinite(amount) && amount > 0;
		});

		// JST 基準の年初来・月初来の境界（API フェッチの since パラメータにも使用）
		const boundaries = getJstPeriodBoundaries();

		// 2. 約定履歴 + 信用約定履歴 + 入出金履歴を並列取得（全期間）
		// 損益計算（calcPnl / calcPeriodRealizedPnl / calcDepositWithdrawalSummary）は
		// 全履歴を入力として移動平均法を回す前提のため、年初前の買い・入金も含めて取得する。
		// 期間集計（yearly_/monthly_）は calcPeriodRealizedPnl / calcPeriodMarginPnl /
		// calcPeriodDWSummary 内で executed_at / confirmed_at の sinceMs 比較で絞り込む。
		const tradePromise = include_pnl
			? paginateTrades(client)
			: Promise.resolve({ trades: [] as RawTrade[], truncated: false });

		const marginTradePromise = include_pnl
			? paginateMarginTrades(client)
			: Promise.resolve({ trades: [] as RawMarginTrade[], truncated: false, fetchFailed: false });

		const dwPromise = include_deposit_withdrawal ? fetchDepositWithdrawal(client) : Promise.resolve(null);

		const [tradeResult, marginTradeResult, dwData] = await Promise.all([tradePromise, marginTradePromise, dwPromise]);
		const allTrades = tradeResult.trades;
		const tradesTruncated = tradeResult.truncated;
		const allMarginTrades = marginTradeResult.trades;
		const marginTradesTruncated = marginTradeResult.truncated;
		const marginFetchFailed = marginTradeResult.fetchFailed;

		// 期間パフォーマンス用: 全関連ペアのキャンドルデータを早期フェッチ開始
		const allRelevantPairs = new Set<string>();
		for (const a of nonZeroAssets) {
			if (a.asset !== 'jpy') allRelevantPairs.add(`${a.asset}_jpy`);
		}
		for (const t of allTrades) {
			if (t.pair.endsWith('_jpy') && !t.pair.startsWith('jpy_')) {
				allRelevantPairs.add(t.pair);
			}
		}
		const candlePricePromise = include_pnl
			? fetchCandlePriceData(
					[...allRelevantPairs],
					boundaries.yearStartMs,
					boundaries.monthStartMs,
					boundaries.dayStartMs,
				)
			: Promise.resolve({ boundaryPrices: new Map(), dailyPrices: new Map() } as CandlePriceData);

		const timestamp = nowIso();

		// 3. 各保有通貨の損益算出
		let totalJpyValue = 0;
		let _totalCostBasis = 0;
		let totalRealizedPnl = 0;
		let _hasCostData = false;

		const holdings = nonZeroAssets.map((a) => {
			const amount = a.onhand_amount;
			const isJpy = a.asset === 'jpy';

			// JPY はそのまま評価額 = 保有量
			const currentPrice = isJpy ? 1 : prices.get(a.asset);
			const jpyValue = isJpy ? Number(amount) : currentPrice ? Number(amount) * currentPrice : undefined;

			if (jpyValue != null && Number.isFinite(jpyValue)) {
				totalJpyValue += jpyValue;
			}

			// JPY は損益計算不要
			if (isJpy) {
				return {
					asset: a.asset,
					pair: 'jpy',
					amount,
					avg_buy_price: undefined,
					current_price: undefined,
					jpy_value: jpyValue != null ? Math.round(jpyValue) : undefined,
					cost_basis: undefined,
					unrealized_pnl: undefined,
					unrealized_pnl_pct: undefined,
					realized_pnl: undefined,
					trade_count: undefined,
				};
			}

			const pair = `${a.asset}_jpy`;
			const pnl = include_pnl ? calcPnl(allTrades, a.asset, dwData?.withdrawals) : undefined;

			if (pnl?.cost_basis != null) {
				_totalCostBasis += pnl.cost_basis;
				_hasCostData = true;
			}
			if (pnl) {
				totalRealizedPnl += pnl.realized_pnl;
			}

			const unrealizedPnl =
				jpyValue != null && pnl?.cost_basis != null ? Math.round(jpyValue - pnl.cost_basis) : undefined;
			const unrealizedPnlPct =
				unrealizedPnl != null && pnl?.cost_basis != null && pnl.cost_basis > 0
					? Math.round((unrealizedPnl / pnl.cost_basis) * 10000) / 100
					: undefined;

			return {
				asset: a.asset,
				pair,
				amount,
				avg_buy_price: pnl?.avg_buy_price != null ? Math.round(pnl.avg_buy_price) : undefined,
				current_price: currentPrice != null ? Math.round(currentPrice) : undefined,
				jpy_value: jpyValue != null ? Math.round(jpyValue) : undefined,
				cost_basis: pnl?.cost_basis != null ? Math.round(pnl.cost_basis) : undefined,
				unrealized_pnl: unrealizedPnl,
				unrealized_pnl_pct: unrealizedPnlPct,
				realized_pnl: pnl?.realized_pnl,
				trade_count: pnl?.trade_count,
			};
		});

		// 売り切り銘柄の実現損益を集計（現在保有ゼロだが約定履歴がある通貨）
		if (include_pnl && allTrades.length > 0) {
			const heldAssets = new Set(nonZeroAssets.map((a) => a.asset));
			const tradedAssets = new Set(allTrades.map((t) => t.pair.replace('_jpy', '')).filter((a) => a !== 'jpy'));
			for (const asset of tradedAssets) {
				if (!heldAssets.has(asset)) {
					const pnl = calcPnl(allTrades, asset, dwData?.withdrawals);
					if (pnl.realized_pnl !== 0) {
						totalRealizedPnl += pnl.realized_pnl;
					}
				}
			}
		}

		// 6.5. 年初来・月初来の実現損益を算出（JST 基準、現物単独）
		let yearlyRealizedPnl: PeriodRealizedPnl | undefined;
		let monthlyRealizedPnl: PeriodRealizedPnl | undefined;
		if (include_pnl && allTrades.length > 0) {
			yearlyRealizedPnl = calcPeriodRealizedPnl(
				allTrades,
				boundaries.yearStartMs,
				boundaries.yearStartIso,
				boundaries.nowIso,
				dwData?.withdrawals,
			);
			monthlyRealizedPnl = calcPeriodRealizedPnl(
				allTrades,
				boundaries.monthStartMs,
				boundaries.monthStartIso,
				boundaries.nowIso,
				dwData?.withdrawals,
			);
		}

		// 6.5b. 信用 PnL の集計 + 口座全体 PnL の構築
		// 現物の totalRealizedPnl と yearly/monthlyRealizedPnl は現物単独の値として維持し、
		// account_pnl 系として「現物 + 信用決済損益 - 信用支払利息」をまとめて公開する。
		let accountPnl: AccountPnl | undefined;
		let yearlyAccountPnl: PeriodAccountPnl | undefined;
		let monthlyAccountPnl: PeriodAccountPnl | undefined;
		if (include_pnl) {
			const marginPnlAll = calcMarginPnl(allMarginTrades);
			accountPnl = buildAccountPnl(totalRealizedPnl, marginPnlAll);

			const marginPnlYearly = calcPeriodMarginPnl(
				allMarginTrades,
				boundaries.yearStartMs,
				boundaries.yearStartIso,
				boundaries.nowIso,
			);
			yearlyAccountPnl = buildPeriodAccountPnl(
				yearlyRealizedPnl?.realized_pnl ?? 0,
				marginPnlYearly,
				boundaries.yearStartIso,
				boundaries.nowIso,
			);

			const marginPnlMonthly = calcPeriodMarginPnl(
				allMarginTrades,
				boundaries.monthStartMs,
				boundaries.monthStartIso,
				boundaries.nowIso,
			);
			monthlyAccountPnl = buildPeriodAccountPnl(
				monthlyRealizedPnl?.realized_pnl ?? 0,
				marginPnlMonthly,
				boundaries.monthStartIso,
				boundaries.nowIso,
			);
		}

		// 6.6. 期間別パフォーマンス（評価額比較）— 主指標
		let yearlyPerformance: PeriodPerformance | undefined;
		let monthlyPerformance: PeriodPerformance | undefined;
		let dailyPerformance: PeriodPerformance | undefined;
		let monthlyEquitySeries: EquityPoint[] | undefined;
		let yearlyEquitySeries: EquityPoint[] | undefined;
		if (include_pnl) {
			const candlePriceData = await candlePricePromise;
			const periodPrices = candlePriceData.boundaryPrices;
			const currentJpyValueRounded = Math.round(totalJpyValue);
			const performanceNote =
				'期初評価額は現在の保有状態から約定・入出金を逆算して復元し、期初時点の始値（1day candle open）で評価。暗号資産の入出庫は現在価格で仮評価。純入出金は元本移動のみ（出金手数料を含まない）。調整後増減 = 単純増減 - 純入出金（市場変動 + 出金手数料コスト）。';

			// 年初比パフォーマンス
			const yearStartHoldings = reconstructHoldingsAtDate(
				nonZeroAssets.map((a) => ({ asset: a.asset, amount: a.onhand_amount })),
				allTrades,
				boundaries.yearStartMs,
				dwData,
			);
			const yearStartPriceMap = new Map<string, number>();
			for (const [asset, pp] of periodPrices) {
				if (pp.yearStart != null) yearStartPriceMap.set(asset, pp.yearStart);
			}
			const yearStartValue = Math.round(calcPortfolioValue(yearStartHoldings, yearStartPriceMap));
			const yearFlow = calcPeriodNetFlow(dwData, boundaries.yearStartMs, prices);
			const yearChange = currentJpyValueRounded - yearStartValue;
			const yearAdjusted = yearChange - yearFlow.net_flow_jpy;
			yearlyPerformance = {
				start_value_jpy: yearStartValue,
				current_value_jpy: currentJpyValueRounded,
				change_jpy: yearChange,
				change_pct: yearStartValue > 0 ? Math.round((yearChange / yearStartValue) * 10000) / 100 : undefined,
				net_flow_jpy: yearFlow.net_flow_jpy,
				withdrawal_fee_jpy: yearFlow.withdrawal_fee_jpy,
				adjusted_change_jpy: yearAdjusted,
				adjusted_change_pct: yearStartValue > 0 ? Math.round((yearAdjusted / yearStartValue) * 10000) / 100 : undefined,
				period_start: boundaries.yearStartIso,
				period_end: boundaries.nowIso,
				note: performanceNote,
			};

			// 月初比パフォーマンス
			const monthStartHoldings = reconstructHoldingsAtDate(
				nonZeroAssets.map((a) => ({ asset: a.asset, amount: a.onhand_amount })),
				allTrades,
				boundaries.monthStartMs,
				dwData,
			);
			const monthStartPriceMap = new Map<string, number>();
			for (const [asset, pp] of periodPrices) {
				if (pp.monthStart != null) monthStartPriceMap.set(asset, pp.monthStart);
			}
			const monthStartValue = Math.round(calcPortfolioValue(monthStartHoldings, monthStartPriceMap));
			const monthFlow = calcPeriodNetFlow(dwData, boundaries.monthStartMs, prices);
			const monthChange = currentJpyValueRounded - monthStartValue;
			const monthAdjusted = monthChange - monthFlow.net_flow_jpy;
			monthlyPerformance = {
				start_value_jpy: monthStartValue,
				current_value_jpy: currentJpyValueRounded,
				change_jpy: monthChange,
				change_pct: monthStartValue > 0 ? Math.round((monthChange / monthStartValue) * 10000) / 100 : undefined,
				net_flow_jpy: monthFlow.net_flow_jpy,
				withdrawal_fee_jpy: monthFlow.withdrawal_fee_jpy,
				adjusted_change_jpy: monthAdjusted,
				adjusted_change_pct:
					monthStartValue > 0 ? Math.round((monthAdjusted / monthStartValue) * 10000) / 100 : undefined,
				period_start: boundaries.monthStartIso,
				period_end: boundaries.nowIso,
				note: performanceNote,
			};

			// 前日比（当日 00:00 JST）パフォーマンス
			const dayStartHoldings = reconstructHoldingsAtDate(
				nonZeroAssets.map((a) => ({ asset: a.asset, amount: a.onhand_amount })),
				allTrades,
				boundaries.dayStartMs,
				dwData,
			);
			const dayStartPriceMap = new Map<string, number>();
			for (const [asset, pp] of periodPrices) {
				if (pp.dayStart != null) dayStartPriceMap.set(asset, pp.dayStart);
			}
			const dayStartValue = Math.round(calcPortfolioValue(dayStartHoldings, dayStartPriceMap));
			const dayFlow = calcPeriodNetFlow(dwData, boundaries.dayStartMs, prices);
			const dayChange = currentJpyValueRounded - dayStartValue;
			const dayAdjusted = dayChange - dayFlow.net_flow_jpy;
			dailyPerformance = {
				start_value_jpy: dayStartValue,
				current_value_jpy: currentJpyValueRounded,
				change_jpy: dayChange,
				change_pct: dayStartValue > 0 ? Math.round((dayChange / dayStartValue) * 10000) / 100 : undefined,
				net_flow_jpy: dayFlow.net_flow_jpy,
				withdrawal_fee_jpy: dayFlow.withdrawal_fee_jpy,
				adjusted_change_jpy: dayAdjusted,
				adjusted_change_pct: dayStartValue > 0 ? Math.round((dayAdjusted / dayStartValue) * 10000) / 100 : undefined,
				period_start: boundaries.dayStartIso,
				period_end: boundaries.nowIso,
				note: performanceNote,
			};

			// 6.7. 資産推移時系列データの構築（月次: 日次点、年次: 月次点）
			if (candlePriceData.dailyPrices.size > 0) {
				const holdingsForReconstruction = nonZeroAssets.map((a) => ({ asset: a.asset, amount: a.onhand_amount }));
				const nowJst = dayjs().tz('Asia/Tokyo');

				// Monthly: daily points from month start through today 00:00 JST, + current
				const monthDates: ReturnType<typeof dayjs>[] = [];
				let d = dayjs(boundaries.monthStartMs).tz('Asia/Tokyo');
				const todayStart = nowJst.startOf('day');
				while (!d.isAfter(todayStart)) {
					monthDates.push(d);
					d = d.add(1, 'day');
				}
				monthlyEquitySeries = buildEquitySeries(
					monthDates,
					holdingsForReconstruction,
					allTrades,
					dwData,
					candlePriceData.dailyPrices,
					currentJpyValueRounded,
					boundaries.nowIso,
				);

				// Yearly: monthly points from year start through current month start, + current
				const yearDates: ReturnType<typeof dayjs>[] = [];
				let m = dayjs(boundaries.yearStartMs).tz('Asia/Tokyo');
				const currentMonthStart = nowJst.startOf('month');
				while (!m.isAfter(currentMonthStart)) {
					yearDates.push(m);
					m = m.add(1, 'month');
				}
				yearlyEquitySeries = buildEquitySeries(
					yearDates,
					holdingsForReconstruction,
					allTrades,
					dwData,
					candlePriceData.dailyPrices,
					currentJpyValueRounded,
					boundaries.nowIso,
				);
			}
		}

		// JPY 評価額降順ソート
		holdings.sort((a, b) => (b.jpy_value ?? 0) - (a.jpy_value ?? 0));

		// 暗号資産 / JPY を分離（テクニカル分析・サマリー・評価損益で使い分ける）
		const cryptoHoldings = holdings.filter((h) => h.asset !== 'jpy');
		const jpyHolding = holdings.find((h) => h.asset === 'jpy');

		// 合計評価損益（暗号資産部分のみ。JPY 残高は cost_basis に含めない）
		// ticker 未取得の銘柄がある場合は totalCostBasis に原価だけ積まれて過大なマイナスになるため、
		// 現在値が取れた銘柄の原価だけを集計し直す
		let validCostBasis = 0;
		let validJpyValue = 0;
		for (const h of cryptoHoldings) {
			if (h.jpy_value != null && h.cost_basis != null) {
				validCostBasis += h.cost_basis;
				validJpyValue += h.jpy_value;
			}
		}
		const hasValidCostData = validCostBasis > 0;
		const totalUnrealizedPnl = hasValidCostData ? Math.round(validJpyValue - validCostBasis) : undefined;
		const totalUnrealizedPnlPct =
			totalUnrealizedPnl != null && validCostBasis > 0
				? Math.round((totalUnrealizedPnl / validCostBasis) * 10000) / 100
				: undefined;

		// ticker 未取得の銘柄がある場合は警告
		const missingPriceAssets = cryptoHoldings
			.filter((h) => h.jpy_value == null && h.cost_basis != null)
			.map((h) => h.asset.toUpperCase());
		const hasMissingPrices = missingPriceAssets.length > 0;

		// 保有銘柄のパフォーマンス（月次・年次の価格騰落率）
		let holdingsPerformance:
			| Array<{
					asset: string;
					pair: string;
					current_price: number | undefined;
					monthly_change_pct: number | undefined;
					yearly_change_pct: number | undefined;
					jpy_value: number | undefined;
					amount: string;
			  }>
			| undefined;
		if (include_pnl) {
			const candlePriceData = await candlePricePromise;
			const periodPrices = candlePriceData.boundaryPrices;
			holdingsPerformance = cryptoHoldings.map((h) => {
				const currentPrice = prices.get(h.asset);
				const bp = periodPrices.get(h.asset);
				const monthlyChangePct =
					currentPrice != null && bp?.monthStart != null && bp.monthStart > 0
						? Math.round(((currentPrice - bp.monthStart) / bp.monthStart) * 10000) / 100
						: undefined;
				const yearlyChangePct =
					currentPrice != null && bp?.yearStart != null && bp.yearStart > 0
						? Math.round(((currentPrice - bp.yearStart) / bp.yearStart) * 10000) / 100
						: undefined;
				return {
					asset: h.asset,
					pair: h.pair,
					current_price: h.current_price,
					monthly_change_pct: monthlyChangePct,
					yearly_change_pct: yearlyChangePct,
					jpy_value: h.jpy_value,
					amount: h.amount,
				};
			});
		}

		// 4. 入出金ベースのリターン計算（Phase 4）
		let dwSummary: DepositWithdrawalSummary | undefined;
		let yearlyDWSummary: PeriodDWSummary | undefined;
		let monthlyDWSummary: PeriodDWSummary | undefined;
		const dwWarnings: string[] = [];
		if (dwData) {
			if (dwData.allFailed) {
				// 全リクエスト失敗: trade_only フォールバック + 警告
				dwWarnings.push('入出金履歴の取得に全て失敗したため、約定ベースの分析のみです');
			} else {
				if (dwData.warnings.length > 0) {
					dwWarnings.push(...dwData.warnings.map((w) => `注意: ${w}（部分的なデータで概算）`));
				}
				if (dwData.deposits.length > 0 || dwData.withdrawals.length > 0) {
					dwSummary = calcDepositWithdrawalSummary(dwData, totalJpyValue, prices);
					// 年次・月次の入出金サマリー
					yearlyDWSummary = calcPeriodDWSummary(
						dwData,
						boundaries.yearStartMs,
						boundaries.yearStartIso,
						boundaries.nowIso,
						prices,
					);
					monthlyDWSummary = calcPeriodDWSummary(
						dwData,
						boundaries.monthStartMs,
						boundaries.monthStartIso,
						boundaries.nowIso,
						prices,
					);
				}
			}
		}

		// 5. テクニカル分析（オプション、暗号資産のみ）
		let technical: TechnicalSummary[] | undefined;
		if (include_technical && cryptoHoldings.length > 0) {
			const jpyPairs = cryptoHoldings.filter((h) => h.jpy_value != null).map((h) => h.pair);
			technical = await fetchTechnical(jpyPairs);
		}

		// 5.5. depositWithdrawalStatus の判定（summary 生成より先に確定する）:
		// - not_requested: include_deposit_withdrawal=false
		// - available: 入出金データ取得成功＋分析実行
		// - no_history: API取得成功・警告なし・本当に履歴0件
		// - fallback: API取得失敗・partial failure 等で約定ベースにフォールバック
		let depositWithdrawalStatus: 'available' | 'fallback' | 'no_history' | 'not_requested';
		if (!include_deposit_withdrawal) {
			depositWithdrawalStatus = 'not_requested';
		} else if (dwSummary != null) {
			depositWithdrawalStatus = 'available';
		} else if (
			dwData &&
			!dwData.allFailed &&
			dwData.warnings.length === 0 &&
			dwData.deposits.length === 0 &&
			dwData.withdrawals.length === 0
		) {
			depositWithdrawalStatus = 'no_history';
		} else {
			depositWithdrawalStatus = 'fallback';
		}

		// 6. サマリー文字列の生成
		const lines: string[] = [];

		// 取得層の不完全性（fetch 失敗 / 上限到達）を先頭に出して LLM が見落とさないようにする。
		// 信用 fetch 失敗時は truncated と内容が重複するため、信用側の truncated 警告は抑止する。
		if (marginFetchFailed) {
			lines.push('⚠️ 信用約定の取得に失敗。信用 PnL は実態を反映しない可能性');
		}
		const showMarginTruncated = marginTradesTruncated && !marginFetchFailed;
		if (tradesTruncated || showMarginTruncated) {
			const subjects = [tradesTruncated && '現物', showMarginTruncated && '信用'].filter(Boolean).join(' / ');
			lines.push(`※ 約定履歴（${subjects}）が上限に達したため一部のみ取得。損益計算が不正確な可能性があります`);
		}

		lines.push(`ポートフォリオ分析: 暗号資産 ${cryptoHoldings.length}銘柄${jpyHolding ? ' + JPY' : ''}`);
		lines.push(`取得時刻: ${timestamp}`);
		if (totalJpyValue > 0) {
			lines.push(
				`口座合計: ${formatPrice(Math.round(totalJpyValue))}${jpyHolding ? ` (うち JPY: ${formatPriceJPY(jpyHolding.jpy_value ?? 0)})` : ''}`,
			);
		}

		// 主指標: 前日比・年初比・月初比の口座評価額増減
		if (dailyPerformance) {
			const dSign = dailyPerformance.change_jpy >= 0 ? '+' : '';
			lines.push(
				`前日比: ${formatPriceJPY(dailyPerformance.start_value_jpy)} → ${formatPriceJPY(dailyPerformance.current_value_jpy)}`,
			);
			lines.push(
				`  増減: ${dSign}${formatPriceJPY(dailyPerformance.change_jpy)}${dailyPerformance.change_pct != null ? ` (${formatPercent(dailyPerformance.change_pct, { sign: true })})` : ''}`,
			);
			if (dailyPerformance.net_flow_jpy !== 0 || dailyPerformance.withdrawal_fee_jpy > 0) {
				const adjSign = dailyPerformance.adjusted_change_jpy >= 0 ? '+' : '';
				lines.push(
					`  入出金調整後: ${adjSign}${formatPriceJPY(dailyPerformance.adjusted_change_jpy)}${dailyPerformance.adjusted_change_pct != null ? ` (${formatPercent(dailyPerformance.adjusted_change_pct, { sign: true })})` : ''}`,
				);
				const flowSign = dailyPerformance.net_flow_jpy >= 0 ? '+' : '';
				lines.push(`  純入出金（元本）: ${flowSign}${formatPriceJPY(dailyPerformance.net_flow_jpy)}`);
				if (dailyPerformance.withdrawal_fee_jpy > 0) {
					lines.push(`  出金手数料: -${formatPriceJPY(dailyPerformance.withdrawal_fee_jpy)}`);
				}
			}
		}
		if (yearlyPerformance) {
			const ySign = yearlyPerformance.change_jpy >= 0 ? '+' : '';
			lines.push(
				`年初比: ${formatPriceJPY(yearlyPerformance.start_value_jpy)} → ${formatPriceJPY(yearlyPerformance.current_value_jpy)}`,
			);
			lines.push(
				`  増減: ${ySign}${formatPriceJPY(yearlyPerformance.change_jpy)}${yearlyPerformance.change_pct != null ? ` (${formatPercent(yearlyPerformance.change_pct, { sign: true })})` : ''}`,
			);
			if (yearlyPerformance.net_flow_jpy !== 0 || yearlyPerformance.withdrawal_fee_jpy > 0) {
				const adjSign = yearlyPerformance.adjusted_change_jpy >= 0 ? '+' : '';
				lines.push(
					`  入出金調整後: ${adjSign}${formatPriceJPY(yearlyPerformance.adjusted_change_jpy)}${yearlyPerformance.adjusted_change_pct != null ? ` (${formatPercent(yearlyPerformance.adjusted_change_pct, { sign: true })})` : ''}`,
				);
				const flowSign = yearlyPerformance.net_flow_jpy >= 0 ? '+' : '';
				lines.push(`  純入出金（元本）: ${flowSign}${formatPriceJPY(yearlyPerformance.net_flow_jpy)}`);
				if (yearlyPerformance.withdrawal_fee_jpy > 0) {
					lines.push(`  出金手数料: -${formatPriceJPY(yearlyPerformance.withdrawal_fee_jpy)}`);
				}
			}
		}
		if (monthlyPerformance) {
			const mSign = monthlyPerformance.change_jpy >= 0 ? '+' : '';
			lines.push(
				`月初比: ${formatPriceJPY(monthlyPerformance.start_value_jpy)} → ${formatPriceJPY(monthlyPerformance.current_value_jpy)}`,
			);
			lines.push(
				`  増減: ${mSign}${formatPriceJPY(monthlyPerformance.change_jpy)}${monthlyPerformance.change_pct != null ? ` (${formatPercent(monthlyPerformance.change_pct, { sign: true })})` : ''}`,
			);
			if (monthlyPerformance.net_flow_jpy !== 0 || monthlyPerformance.withdrawal_fee_jpy > 0) {
				const adjSign = monthlyPerformance.adjusted_change_jpy >= 0 ? '+' : '';
				lines.push(
					`  入出金調整後: ${adjSign}${formatPriceJPY(monthlyPerformance.adjusted_change_jpy)}${monthlyPerformance.adjusted_change_pct != null ? ` (${formatPercent(monthlyPerformance.adjusted_change_pct, { sign: true })})` : ''}`,
				);
				const flowSign = monthlyPerformance.net_flow_jpy >= 0 ? '+' : '';
				lines.push(`  純入出金（元本）: ${flowSign}${formatPriceJPY(monthlyPerformance.net_flow_jpy)}`);
				if (monthlyPerformance.withdrawal_fee_jpy > 0) {
					lines.push(`  出金手数料: -${formatPriceJPY(monthlyPerformance.withdrawal_fee_jpy)}`);
				}
			}
		}
		if (yearlyPerformance || monthlyPerformance) {
			lines.push(`期間基準: JST`);
			lines.push('※ 期初評価額は約定・入出金を逆算して復元、期初始値で評価。暗号資産入出庫は現在価格で仮評価');
			lines.push('※ 出金元本は外部フローとして除外、出金手数料はコストとして performance に含む');
		}
		if (monthlyEquitySeries && monthlyEquitySeries.length > 0) {
			lines.push(`月次資産推移（日次, ${monthlyEquitySeries.length}点）:`);
			for (let i = 0; i < monthlyEquitySeries.length; i++) {
				const p = monthlyEquitySeries[i];
				const label = i === monthlyEquitySeries.length - 1 ? '（現在）' : '';
				lines.push(`  ${p.timestamp}: ${formatPriceJPY(p.value_jpy)}${label}`);
			}
		}
		if (yearlyEquitySeries && yearlyEquitySeries.length > 0) {
			lines.push(`年次資産推移（月次, ${yearlyEquitySeries.length}点）:`);
			for (let i = 0; i < yearlyEquitySeries.length; i++) {
				const p = yearlyEquitySeries[i];
				const label = i === yearlyEquitySeries.length - 1 ? '（現在）' : '';
				lines.push(`  ${p.timestamp}: ${formatPriceJPY(p.value_jpy)}${label}`);
			}
		}

		// 年次・月次の入出金サマリー
		if (yearlyDWSummary) {
			const y = yearlyDWSummary;
			const parts = [
				`年初来入出金: JPY入金 ${formatPriceJPY(y.jpy_deposited)} / JPY出金 ${formatPriceJPY(y.jpy_withdrawn)} / 純入出金 ${formatPriceJPY(y.net_jpy)}`,
			];
			if (y.crypto_deposit_count > 0)
				parts.push(
					`暗号資産入庫 ${y.crypto_deposit_count}件${y.crypto_deposit_estimated_jpy ? `（概算 ${formatPriceJPY(y.crypto_deposit_estimated_jpy)}）` : ''}`,
				);
			if (y.crypto_withdrawal_count > 0)
				parts.push(
					`暗号資産出庫 ${y.crypto_withdrawal_count}件${y.crypto_withdrawal_estimated_jpy ? `（概算 ${formatPriceJPY(y.crypto_withdrawal_estimated_jpy)}）` : ''}`,
				);
			lines.push(parts.join(' / '));
		}
		if (monthlyDWSummary) {
			const m = monthlyDWSummary;
			const parts = [
				`月初来入出金: JPY入金 ${formatPriceJPY(m.jpy_deposited)} / JPY出金 ${formatPriceJPY(m.jpy_withdrawn)} / 純入出金 ${formatPriceJPY(m.net_jpy)}`,
			];
			if (m.crypto_deposit_count > 0)
				parts.push(
					`暗号資産入庫 ${m.crypto_deposit_count}件${m.crypto_deposit_estimated_jpy ? `（概算 ${formatPriceJPY(m.crypto_deposit_estimated_jpy)}）` : ''}`,
				);
			if (m.crypto_withdrawal_count > 0)
				parts.push(
					`暗号資産出庫 ${m.crypto_withdrawal_count}件${m.crypto_withdrawal_estimated_jpy ? `（概算 ${formatPriceJPY(m.crypto_withdrawal_estimated_jpy)}）` : ''}`,
				);
			lines.push(parts.join(' / '));
		}

		// 入出金分析状態と分析基準をsummaryに明示（structuredContentを見ないLLM向け）
		if (depositWithdrawalStatus === 'available') {
			lines.push(`入出金分析状態: available`);
			lines.push(`分析基準: deposit_withdrawal`);
		} else if (depositWithdrawalStatus === 'fallback') {
			lines.push(`入出金分析状態: fallback`);
			lines.push(`分析基準: trade_only`);
			if (dwData?.allFailed) {
				lines.push('※ 入出金APIの取得に全て失敗したため、約定ベースの分析のみです');
			} else {
				lines.push('※ API取得失敗またはpartial failureのため、約定ベースの分析にフォールバックしています');
			}
		} else if (depositWithdrawalStatus === 'no_history') {
			lines.push(`入出金分析状態: no_history`);
			lines.push(`分析基準: trade_only`);
			lines.push('※ 入出金履歴が0件のため、入出金ベース分析なし。約定ベースの分析のみです');
		} else {
			// not_requested
			lines.push(`入出金分析状態: not_requested`);
			lines.push(`分析基準: trade_only`);
			lines.push('※ 入出金分析は未リクエスト。約定ベースの分析のみです');
		}

		// 入出金ベースの口座全体リターン（Phase 4）
		if (dwSummary && dwSummary.account_return_jpy != null) {
			const sign = dwSummary.account_return_jpy >= 0 ? '+' : '';
			const approxLabel = dwSummary.is_complete ? '' : '（概算）';
			lines.push(
				`口座全体リターン${approxLabel}: ${sign}${formatPriceJPY(dwSummary.account_return_jpy)} (${formatPercent(dwSummary.account_return_pct, { sign: true })})`,
			);
			// 内訳を式追跡しやすい形で表示
			lines.push(`  JPY入金合計: ${formatPriceJPY(dwSummary.total_jpy_deposited)}`);
			if (dwSummary.total_jpy_withdrawn > 0) {
				lines.push(`  JPY出金合計: ${formatPriceJPY(dwSummary.total_jpy_withdrawn)}`);
			}
			const netJpyDeposit = dwSummary.total_jpy_deposited - dwSummary.total_jpy_withdrawn;
			lines.push(`  JPY純入金: ${formatPriceJPY(Math.round(netJpyDeposit))}`);
			if (dwSummary.crypto_deposit_estimated_jpy) {
				lines.push(
					`  暗号資産入庫の仮評価: ${formatPriceJPY(dwSummary.crypto_deposit_estimated_jpy)}（${dwSummary.crypto_deposit_count}件、現在価格ベース）`,
				);
			}
			lines.push(
				`  純投入額: ${formatPriceJPY(dwSummary.net_jpy_invested)}${dwSummary.crypto_deposit_estimated_jpy ? '（JPY純入金 + 暗号資産入庫の仮評価）' : ''}`,
			);
			if (!dwSummary.is_complete) {
				lines.push('  ※ 入出金履歴が多く全件取得できなかったため、概算値です');
			}
			if (dwSummary.crypto_deposit_count > 0 && !dwSummary.crypto_deposit_estimated_jpy) {
				lines.push(`  ※ 暗号資産入庫 ${dwSummary.crypto_deposit_count}件の価格が取得できず仮評価に含まれていません`);
			}
			if (dwSummary.crypto_withdrawal_count > 0) {
				lines.push(`  ※ 暗号資産出庫 ${dwSummary.crypto_withdrawal_count}件は送金として損益計算から除外しています`);
			}
		}

		// 入出金取得の警告
		if (dwWarnings.length > 0) {
			for (const w of dwWarnings) {
				lines.push(`  ${w}`);
			}
		}

		// 実現損益（現物単独）と口座全体 PnL（現物 + 信用決済損益 - 利息 - 手数料）
		if (accountPnl != null) {
			const spotSign = accountPnl.spot_realized_pnl >= 0 ? '+' : '';
			lines.push(`Realized PnL (Spot): ${spotSign}${formatPriceJPY(accountPnl.spot_realized_pnl)}`);
			const totalSign = accountPnl.total >= 0 ? '+' : '';
			const hasMargin =
				accountPnl.margin_realized_pnl !== 0 || accountPnl.margin_interest !== 0 || accountPnl.margin_fee !== 0;
			if (hasMargin) {
				const mSign = accountPnl.margin_realized_pnl >= 0 ? '+' : '';
				lines.push(
					`Account PnL: ${totalSign}${formatPriceJPY(accountPnl.total)} (Spot: ${spotSign}${formatPriceJPY(accountPnl.spot_realized_pnl)} / Margin: ${mSign}${formatPriceJPY(accountPnl.margin_realized_pnl)} / Interest: -${formatPriceJPY(accountPnl.margin_interest)} / Fee: -${formatPriceJPY(accountPnl.margin_fee)})`,
				);
			} else {
				lines.push(`Account PnL: ${totalSign}${formatPriceJPY(accountPnl.total)}`);
			}
		}

		if (totalUnrealizedPnl != null) {
			const sign = totalUnrealizedPnl >= 0 ? '+' : '';
			lines.push(
				`合計評価損益（全履歴の約定ベース）: ${sign}${formatPriceJPY(totalUnrealizedPnl)} (${formatPercent(totalUnrealizedPnlPct, { sign: true })})`,
			);
		}
		lines.push('※ 評価損益は全履歴の約定・暗号資産出庫から移動平均法で算出した取得原価ベース');
		lines.push('');

		// 保有銘柄のパフォーマンス（月次・年次の価格騰落率）
		if (holdingsPerformance && holdingsPerformance.length > 0) {
			lines.push('保有銘柄のパフォーマンス:');
			for (const hp of holdingsPerformance) {
				const assetUpper = hp.asset.toUpperCase();
				const parts = [`${assetUpper}`];
				if (hp.jpy_value != null) parts.push(formatPriceJPY(hp.jpy_value));
				if (hp.monthly_change_pct != null)
					parts.push(`月次騰落率: ${formatPercent(hp.monthly_change_pct, { sign: true })}`);
				if (hp.yearly_change_pct != null)
					parts.push(`年次騰落率: ${formatPercent(hp.yearly_change_pct, { sign: true })}`);
				lines.push(`  ${parts.join(' / ')}`);
			}
		}

		// ticker 未取得警告
		if (hasMissingPrices) {
			lines.push('');
			lines.push(`注意: ${missingPriceAssets.join(', ')} の現在価格が取得できなかったため、評価損益から除外しています`);
		}

		// テクニカルサマリー
		if (technical && technical.length > 0) {
			lines.push('');
			lines.push('テクニカル分析:');
			for (const t of technical) {
				const parts = [formatPair(t.pair)];
				if (t.trend) parts.push(`トレンド: ${t.trend}`);
				if (t.rsi_14 != null) parts.push(`RSI: ${t.rsi_14}`);
				if (t.sma_deviation_pct != null) parts.push(`SMA乖離: ${formatPercent(t.sma_deviation_pct, { sign: true })}`);
				if (t.signal) parts.push(`総合判定: ${t.signal}`);
				lines.push(`  ${parts.join(' / ')}`);
			}
		}

		const summary = lines.join('\n');

		// deposit_withdrawal_summary の出し分け（status に基づく一貫した契約）:
		// - available: dwSummary（実データ、analysis_basis='deposit_withdrawal'）
		// - fallback: placeholder（analysis_basis='trade_only'）— 常に返す
		// - no_history: undefined（API成功だが履歴なし）
		// - not_requested: undefined（未リクエスト）
		const fallbackPlaceholder = {
			total_jpy_deposited: 0,
			total_jpy_withdrawn: 0,
			net_jpy_invested: 0,
			crypto_deposit_count: 0,
			crypto_deposit_estimated_jpy: undefined,
			crypto_withdrawal_count: 0,
			account_return_pct: undefined,
			account_return_jpy: undefined,
			is_complete: false,
			analysis_basis: 'trade_only' as const,
		};

		const depositWithdrawalSummary =
			depositWithdrawalStatus === 'available'
				? dwSummary
				: depositWithdrawalStatus === 'fallback'
					? fallbackPlaceholder
					: undefined;

		const data = {
			holdings,
			total_jpy_value: totalJpyValue > 0 ? Math.round(totalJpyValue) : undefined,
			total_cost_basis: hasValidCostData ? Math.round(validCostBasis) : undefined,
			total_unrealized_pnl: totalUnrealizedPnl,
			total_unrealized_pnl_pct: totalUnrealizedPnlPct,
			total_realized_pnl: totalRealizedPnl !== 0 ? totalRealizedPnl : undefined,
			daily_performance: dailyPerformance,
			yearly_performance: yearlyPerformance,
			monthly_performance: monthlyPerformance,
			monthly_equity_series: monthlyEquitySeries,
			yearly_equity_series: yearlyEquitySeries,
			yearly_realized_pnl: yearlyRealizedPnl
				? {
						realized_pnl: yearlyRealizedPnl.realized_pnl,
						sell_count: yearlyRealizedPnl.sell_count,
						period_start: yearlyRealizedPnl.period_start,
						period_end: yearlyRealizedPnl.period_end,
					}
				: undefined,
			monthly_realized_pnl: monthlyRealizedPnl
				? {
						realized_pnl: monthlyRealizedPnl.realized_pnl,
						sell_count: monthlyRealizedPnl.sell_count,
						period_start: monthlyRealizedPnl.period_start,
						period_end: monthlyRealizedPnl.period_end,
					}
				: undefined,
			account_pnl: accountPnl,
			yearly_account_pnl: yearlyAccountPnl,
			monthly_account_pnl: monthlyAccountPnl,
			deposit_withdrawal_summary: depositWithdrawalSummary,
			yearly_dw_summary: yearlyDWSummary,
			monthly_dw_summary: monthlyDWSummary,
			holdings_performance: holdingsPerformance && holdingsPerformance.length > 0 ? holdingsPerformance : undefined,
			technical: technical && technical.length > 0 ? technical : undefined,
			timestamp,
		};

		const meta = {
			fetchedAt: timestamp,
			holdingCount: holdings.length,
			hasPnl: include_pnl && allTrades.length > 0,
			hasTechnical: include_technical && (technical?.length ?? 0) > 0,
			depositWithdrawalStatus,
			periodBasis: 'jst' as const,
			tradesTruncated,
			marginTradesTruncated,
			marginFetchFailed,
		};

		return AnalyzeMyPortfolioOutputSchema.parse(ok(summary, data, meta));
	} catch (err) {
		if (err instanceof PrivateApiError) {
			return AnalyzeMyPortfolioOutputSchema.parse(fail(err.message, err.errorType));
		}
		return AnalyzeMyPortfolioOutputSchema.parse(
			fail(
				err instanceof Error ? err.message : 'ポートフォリオ分析中に予期しないエラーが発生しました',
				'upstream_error',
			),
		);
	}
}
