import { normalizeAssetCodes } from '../../lib/asset-code.js';
import { dayjs, nowIso } from '../../lib/datetime.js';
import { formatPair, formatPercent, formatPrice, formatYenAmount } from '../../lib/formatter.js';
import { fetchPairsSpec } from '../../lib/pairs.js';
import { ok } from '../../lib/result.js';
import { prependWarnings } from '../../lib/warning-propagation.js';
import { getDefaultClient } from '../private/client.js';
import {
	AnalyzeMyPortfolioOutputSchema,
	type PortfolioChangePctUnavailableReason,
	type PortfolioFlowUnavailableReason,
	type PortfolioFlowValuationBasis,
	type PortfolioQtyMismatchReason,
	type PortfolioUnresolvedDepositReason,
} from '../private/schemas.js';
import { failPrivateToolError } from '../private/tool-error.js';
import {
	buildAccountPnl,
	buildEquitySeries,
	buildPeriodAccountPnl,
	buildPeriodPerformance,
	calcDepositWithdrawalSummary,
	calcMarginPnl,
	calcPeriodDWSummary,
	calcPeriodMarginPnl,
	calcPeriodRealizedPnl,
	calcPnl,
	collectFlowValuationTargets,
	type DepositCostBasisInput,
	depositOnlyAssets,
	dominantUnresolvedDepositReason,
	flowUnavailableReasonFor,
	getJstPeriodBoundaries,
	MIN_START_VALUE_RATIO,
	type PeriodPerformanceKey,
	type PeriodSpec,
	type PortfolioPerformanceContext,
	resolveDepositWithdrawalStatus,
	summarizeFlowValuation,
	unresolvedDepositReasonsByAsset,
} from './portfolio/calc.js';
import { PORTFOLIO_CALENDAR_TZ } from './portfolio/calendar.js';
import {
	fetchCandlePriceData,
	fetchDepositWithdrawal,
	fetchFlowDatePrices,
	fetchMarginAccountInfo,
	fetchTechnical,
	fetchTickerPrices,
	MAX_DEPOSIT_FLOW_PRICE_YEAR_CHUNKS,
	MAX_WITHDRAWAL_FLOW_PRICE_YEAR_CHUNKS,
	paginateMarginTrades,
	paginateTrades,
} from './portfolio/fetch.js';
import {
	assetCountLabel,
	buildHoldingsPerformance,
	depositCountOrUndefined,
	summarizeUnrealized,
	tallyClosedAssets,
	tallyHeldAssets,
	type UnresolvedDeposits,
	withDepositOnlyAssets,
} from './portfolio/holdings.js';
import type {
	AccountPnl,
	CandlePriceData,
	DepositWithdrawalData,
	DepositWithdrawalSummary,
	EquityPoint,
	FlowPricing,
	FlowValuationBreakdown,
	MarginAccountInfo,
	PeriodAccountPnl,
	PeriodDWSummary,
	PeriodPerformance,
	PeriodRealizedPnl,
	RawAsset,
	RawMarginTrade,
	RawTrade,
	TechnicalSummary,
} from './portfolio/types.js';

/** get_margin_status の WARNING_STATUSES と同じ文言にそろえる。 */
const MARGIN_STATUS_WARNINGS: Record<string, string> = {
	CALL: '⚠ 追証発生中（CALL）。期日までに追加保証金を入金するか建玉を決済してください',
	LOSSCUT: '⚠ 強制決済中（LOSSCUT）。保証金率が閾値を下回り、建玉が自動決済されています',
	DEBT: '⚠ 不足金発生中（DEBT）。速やかに入金してください',
	SETTLED: '⚠ 信用口座は精算済み（SETTLED）',
};

function positionSideLabel(side: string): string {
	return side === 'long' ? 'ロング' : side === 'short' ? 'ショート' : side;
}

// 数値化できない値はゼロと断定できないので false（表示に倒す）。抑制の誤爆で実建玉を消さないため。
function isZeroMarginPosition(p: { open_amount: string; product: string }): boolean {
	return Number(p.open_amount) === 0 && Number(p.product) === 0;
}

// ゼロ建玉は明細に出さないが黙って消さず、省略件数を集計行に出す。全建玉がゼロでもセクションは出す（「建玉なし」と区別するため。#53）。
function buildMarginPositionsBlock(info: MarginAccountInfo): string[] {
	const positions = info.positions?.positions ?? [];
	if (positions.length === 0) return [];

	const openPositions = positions.filter((p) => !isZeroMarginPosition(p));
	const zeroPositionCount = positions.length - openPositions.length;

	const lines: string[] = [];
	lines.push('信用建玉:');
	for (const p of openPositions) {
		const sideLabel = positionSideLabel(p.position_side);
		lines.push(`  ${formatPair(p.pair)} ${sideLabel} ${p.open_amount} (評価額: ${formatPrice(Number(p.product))}円)`);
	}
	const longCount = openPositions.filter((p) => p.position_side === 'long').length;
	const shortCount = openPositions.filter((p) => p.position_side === 'short').length;
	const aggregateParts: string[] = [`ロング ${longCount}件 / ショート ${shortCount}件`];
	if (zeroPositionCount > 0) {
		aggregateParts.push(`ゼロ建玉 ${zeroPositionCount}件省略`);
	}

	// 個別建玉に unrealized_pnl が無いので、口座全体の margin_position_profit_loss を使う。
	const status = info.status;
	if (status) {
		const pl = Number(status.margin_position_profit_loss);
		if (Number.isFinite(pl)) {
			const sign = pl >= 0 ? '+' : '';
			aggregateParts.push(`建玉含み損益: ${sign}${formatYenAmount(pl)}`);
		}
	}
	lines.push(`  集計: ${aggregateParts.join(' / ')}`);
	return lines;
}

const FLOW_VALUATION_LABEL: Record<PortfolioFlowValuationBasis, string> = {
	deposit_date_price: '入出庫日の始値ベース',
	current_price_fallback: '現在価格での仮評価',
	mixed: '入出庫日の始値ベース + 一部は現在価格での仮評価',
};

const FLOW_UNAVAILABLE_CAUSE: Record<PortfolioFlowUnavailableReason, string> = {
	dw_fetch_failed: '入出金履歴の取得に失敗した',
	dw_history_incomplete: '入出金履歴を全件取得できなかった',
};

const FLOW_UNAVAILABLE_NOTE: Record<PortfolioFlowUnavailableReason, string> = {
	dw_fetch_failed:
		'入出金履歴の取得に失敗したため取得原価を確定できません（一部チャネルのみの失敗を含む）。時間をおいて再実行してください',
	dw_history_incomplete: '入出金履歴が多く全件取得できなかったため取得原価を確定できません（再実行しても解消しません）',
};

const CHANGE_PCT_UNAVAILABLE_NOTE: Record<PortfolioChangePctUnavailableReason, string> = {
	start_value_zero: '期初評価額が 0 で率を定義できないため',
	start_value_negligible: `期初評価額が現在評価額の ${MIN_START_VALUE_RATIO * 100}% 未満で、率が運用成績ではなく「期初がほぼ空だった」ことを表す数になるため`,
	start_boundary_unpriced:
		'期初の始値を解決できなかった暗号資産を評価に含められず期初評価額が過小になっているため。過小な分母では率が運用成績を表さない',
	current_value_unpriced:
		'現在価格を解決できなかった暗号資産の保有を現在評価額に含められず現在評価額が過小になっているため。分子が過小な率は運用成績ではなく価格取得の失敗を表す数になる',
};

// 価格の解決欠損 2 種では増減額へ誘導せず、代替（資産推移シリーズ）も示さない。シリーズも同じ始値に依存し、欠けた期間は現在価格で埋まっている（#105, #109）。
const CHANGE_JPY_GUIDANCE_LINE: Record<PortfolioChangePctUnavailableReason, string> = {
	start_value_zero: '増減額で読んでください',
	start_value_negligible: '増減額で読んでください',
	start_boundary_unpriced:
		'増減額（change_jpy / adjusted_change_jpy）も脱落した期初評価額の分だけ過大なので、成績として読まないでください。この期間の値動きはこの結果からは算出できません',
	current_value_unpriced:
		'増減額（change_jpy / adjusted_change_jpy）も脱落した現在評価額の分だけ過小なので、成績として読まないでください。この期間の値動きはこの結果からは算出できません',
};

// 両端から落ちる資産があるとずれは過大とも過小とも言えないので、「過大」と書かない。
const CHANGE_JPY_DIRECTION_UNKNOWN_LINE =
	'増減額（change_jpy / adjusted_change_jpy）も同じ欠損の影響を受けており、現在評価額でも価格を引けない保有があるためずれの向きも確定できません。成績として読まないでください。この期間の値動きはこの結果からは算出できません';

// warning は LLM が最初に読む行なので、代替として資産推移シリーズを持ち出さないことまで明示する。
const CHANGE_JPY_GUIDANCE_WARNING: Record<PortfolioChangePctUnavailableReason, string> = {
	start_value_zero: '増減額（change_jpy / adjusted_change_jpy）は出しているので成績はそちらで読むこと',
	start_value_negligible: '増減額（change_jpy / adjusted_change_jpy）は出しているので成績はそちらで読むこと',
	start_boundary_unpriced:
		'増減額（change_jpy / adjusted_change_jpy）も期初評価額から脱落した分だけ過大なので（change_jpy_overstated=true）、成績として読まないこと。該当期間の値動きはこの結果からは算出できません（資産推移シリーズも同じ日次価格に依存し、始値を引けなかった日付は現在価格で代替されるため代替になりません）',
	current_value_unpriced:
		'増減額（change_jpy / adjusted_change_jpy）も現在評価額から脱落した分だけ過小なので（change_jpy_understated=true）、成績として読まないこと。保有暗号資産が全て脱落している場合は現在評価額が JPY 残高だけに縮退しており、増減額は口座の損失ではなく価格取得の失敗を表す数です。該当期間の値動きはこの結果からは算出できません（資産推移シリーズも最終点に同じ現在評価額を使うため代替になりません）',
};

/** CHANGE_JPY_DIRECTION_UNKNOWN_LINE と対。 */
const CHANGE_JPY_DIRECTION_UNKNOWN_WARNING =
	'増減額（change_jpy / adjusted_change_jpy）も同じ欠損の影響を受けますが、現在評価額でも価格を解決できない保有があるためずれの向きは確定できません（change_jpy_overstated は付きません）。成績として読まないこと。該当期間の値動きはこの結果からは算出できません（資産推移シリーズも同じ日次価格に依存し、始値を引けなかった日付は現在価格で代替されるため代替になりません）';

// 2 フラグは排他なので 3 値に畳み、フラグが立っていないことを unknown として型で明示する。
type ChangeJpyDirection = 'overstated' | 'understated' | 'unknown';

/** `ChangeJpyDirection` の全値（warning のグルーピングで回す。型から漏れると typecheck が落ちる）。 */
const CHANGE_JPY_DIRECTIONS: readonly ChangeJpyDirection[] = ['overstated', 'understated', 'unknown'];

/** 期間の申告フラグから向きを求める（`change_jpy_overstated` / `change_jpy_understated` の単一ソース）。 */
function changeJpyDirectionOf(p: PeriodPerformance | undefined): ChangeJpyDirection {
	if (p?.change_jpy_overstated) return 'overstated';
	if (p?.change_jpy_understated) return 'understated';
	return 'unknown';
}

// start_boundary_unpriced だけが向きで分岐する。current_value_unpriced は向きが必ず過小で確定し、start_value_* は分子が正しい。
function changeJpyGuidanceLine(reason: PortfolioChangePctUnavailableReason, direction: ChangeJpyDirection): string {
	if (reason === 'start_boundary_unpriced' && direction !== 'overstated') return CHANGE_JPY_DIRECTION_UNKNOWN_LINE;
	return CHANGE_JPY_GUIDANCE_LINE[reason];
}

/** content 先頭の warning 用。分岐の条件は `changeJpyGuidanceLine` と同じ。 */
function changeJpyGuidanceWarning(reason: PortfolioChangePctUnavailableReason, direction: ChangeJpyDirection): string {
	if (reason === 'start_boundary_unpriced' && direction !== 'overstated') return CHANGE_JPY_DIRECTION_UNKNOWN_WARNING;
	return CHANGE_JPY_GUIDANCE_WARNING[reason];
}

const QTY_MISMATCH_CAUSE: Record<PortfolioQtyMismatchReason, string> = {
	has_crypto_deposits: '入庫日の価格を解決できない暗号資産の入庫あり',
	history_truncated: '約定履歴の打ち切り',
	reconstructed_qty_negative: '復元数量が負（API に現れない取得あり）',
	untracked_trade_suspected: '販売所取引など API に現れない取引の可能性',
};

// 原価だけでなく実現損益まで確定値を出さないのが抑止の眼目なので、対象フィールドを毎回列挙する（#80）。
const UNRESOLVED_DEPOSIT_NOTE: Record<PortfolioUnresolvedDepositReason, string> = {
	deposit_price_fetch_failed:
		'入庫日を含む年足の取得に失敗したため取得原価に算入していません（上限による切り落としではなく取得失敗なので、取得の成否が実行ごとに変わり、同じ口座を同じ日に叩いても取得原価と実現損益が変わります）',
	deposit_price_chunk_truncated: `入庫日を含む年足の追加取得が上限（${MAX_DEPOSIT_FLOW_PRICE_YEAR_CHUNKS}組）に達したため取りに行けず、取得原価に算入していません（上限は決定的なので同じ入力なら同じ結果になりますが、上限に収まる構成に変われば再実行で値が変わります）`,
};

// DEPRECATED_FIELD_REMOVAL_TARGET で alias を削除するときは、旧名 2 行とスキーマ・description をまとめて落とす（#85）。
function periodRealizedPnlForWire(
	period: PeriodRealizedPnl,
	unavailableReason: PortfolioUnresolvedDepositReason | undefined,
): {
	realized_pnl: number | undefined;
	sell_count: number;
	period_start: string;
	period_end: string;
	priced_deposit_count: number | undefined;
	unpriced_deposit_count: number | undefined;
	realized_pnl_unavailable_reason: PortfolioUnresolvedDepositReason | undefined;
	priced_deposit_count_all_time: number | undefined;
	unpriced_deposit_count_all_time: number | undefined;
} {
	const priced = depositCountOrUndefined(period.priced_deposit_count_all_time);
	const unpriced = depositCountOrUndefined(period.unpriced_deposit_count_all_time);
	return {
		realized_pnl: unavailableReason != null ? undefined : period.realized_pnl,
		sell_count: period.sell_count,
		period_start: period.period_start,
		period_end: period.period_end,
		priced_deposit_count: priced,
		unpriced_deposit_count: unpriced,
		realized_pnl_unavailable_reason: unavailableReason,
		priced_deposit_count_all_time: priced,
		unpriced_deposit_count_all_time: unpriced,
	};
}

// 未計測や率の抑止を黙って行ごと省かない。テキストしか読まない LLM には「調整不要」「ゼロ %」に見える。
function buildPerformanceLines(label: string, p: PeriodPerformance): string[] {
	const lines: string[] = [];
	const sign = p.change_jpy >= 0 ? '+' : '';
	lines.push(`${label}: ${formatYenAmount(p.start_value_jpy)} → ${formatYenAmount(p.current_value_jpy)}`);
	lines.push(
		`  増減: ${sign}${formatYenAmount(p.change_jpy)}${p.change_pct != null ? ` (${formatPercent(p.change_pct, { sign: true })})` : ''}`,
	);
	if (p.change_pct_unavailable_reason) {
		lines.push(
			`  ※ 増減率・入出金調整後増減率は非表示（${CHANGE_PCT_UNAVAILABLE_NOTE[p.change_pct_unavailable_reason]}）。${changeJpyGuidanceLine(p.change_pct_unavailable_reason, changeJpyDirectionOf(p))}`,
		);
	}
	if (p.unpriced_start_assets && p.unpriced_start_assets.length > 0) {
		// 向きが確定するとき（両端から落ちる資産が無いとき）だけ向きを書く。
		const overstatedNote = p.change_jpy_overstated ? '（脱落した分がそのまま上の増減額の過大分です）' : '';
		lines.push(
			`  ※ 上の期初評価額は過小: ${p.unpriced_start_assets.map((a) => a.toUpperCase()).join(', ')} の始値を解決できず含めていません${overstatedNote}`,
		);
	}
	if (p.unpriced_current_assets && p.unpriced_current_assets.length > 0) {
		const understatedNote = p.change_jpy_understated ? '（脱落した分がそのまま上の増減額の過小分です）' : '';
		lines.push(
			`  ※ 上の現在評価額は過小: ${p.unpriced_current_assets.map((a) => a.toUpperCase()).join(', ')} の現在価格を解決できず含めていません${understatedNote}`,
		);
	}

	// flow_measured=false のとき 3 フィールドはすべて null。型の絞り込みも兼ねて null で分岐する。
	if (p.net_flow_jpy == null || p.withdrawal_fee_jpy == null || p.adjusted_change_jpy == null) {
		const cause = p.flow_unavailable_reason ? FLOW_UNAVAILABLE_CAUSE[p.flow_unavailable_reason] : '入出金履歴が無い';
		lines.push(
			`  純入出金: 未計測（${cause}ため入出金調整後の増減を算出できません）。上の増減には入出金の出し入れが含まれたままです`,
		);
		return lines;
	}

	if (p.net_flow_jpy !== 0 || p.withdrawal_fee_jpy > 0) {
		const adjSign = p.adjusted_change_jpy >= 0 ? '+' : '';
		lines.push(
			`  入出金調整後: ${adjSign}${formatYenAmount(p.adjusted_change_jpy)}${p.adjusted_change_pct != null ? ` (期初評価額比 ${formatPercent(p.adjusted_change_pct, { sign: true })})` : ''}`,
		);
		const flowSign = p.net_flow_jpy >= 0 ? '+' : '';
		lines.push(`  純入出金（元本）: ${flowSign}${formatYenAmount(p.net_flow_jpy)}`);
		if (p.withdrawal_fee_jpy > 0) {
			lines.push(`  出金手数料: -${formatYenAmount(p.withdrawal_fee_jpy)}`);
		}
	}
	if (p.staking_reward_jpy != null) {
		lines.push(
			`  ステーキング報酬: +${formatYenAmount(p.staking_reward_jpy)}（入庫日の価格で換算。元本ではなく成果として増減に含む）`,
		);
	} else if (p.staking_reward_unpriced_assets) {
		lines.push(
			`  ステーキング報酬: ${p.staking_reward_unpriced_assets.map((a) => a.toUpperCase()).join(', ')} の価格を解決できず額を出せません（成果として増減には含まれています）`,
		);
	}
	return lines;
}

// グラフ化されない経路では「線が跳ねた = 運用成績」と誤読されるので、フロー発生点があるときだけ読み方を添える。
const EQUITY_FLOW_MARKER_NOTE =
	'「← 純入出金」が付いた点は外部からの入出金が発生した点で、その点から次の点への増減に金額が含まれる。運用成績ではないのでグラフではマーカーとして扱い、線の変動として説明しない';

// headingBase は末尾のコロンを含めない（注記を挟んでからコロンを付ける）。
function buildEquitySeriesLines(headingBase: string, series: EquityPoint[]): string[] {
	const hasFlow = series.some((p) => p.flow_jpy != null);
	const lines = [hasFlow ? `${headingBase}。${EQUITY_FLOW_MARKER_NOTE}:` : `${headingBase}:`];
	for (let i = 0; i < series.length; i++) {
		const p = series[i];
		// 符号の出し方は buildPerformanceLines の純入出金行と揃える（負値は formatYenAmount が符号を持つ）。
		const marker = p.flow_jpy != null ? ` ← 純入出金 ${p.flow_jpy >= 0 ? '+' : ''}${formatYenAmount(p.flow_jpy)}` : '';
		const label = i === series.length - 1 ? '（現在）' : '';
		lines.push(`  ${p.timestamp}: ${formatYenAmount(p.value_jpy)}${marker}${label}`);
	}
	return lines;
}

function buildFetchStatusLines(input: {
	marginFetchFailed: boolean;
	marginStatusFetchFailed: boolean;
	marginPositionsFetchFailed: boolean;
	marginStatus: MarginAccountInfo['status'];
	tradesTruncated: boolean;
	marginTradesTruncated: boolean;
}): string[] {
	const {
		marginFetchFailed,
		marginStatusFetchFailed,
		marginPositionsFetchFailed,
		marginStatus,
		tradesTruncated,
		marginTradesTruncated,
	} = input;
	const lines: string[] = [];
	// 信用 fetch 失敗時は truncated と内容が重複するので、信用側の truncated 警告は抑止する。
	if (marginFetchFailed) {
		lines.push('⚠️ 信用約定の取得に失敗。信用 PnL は実態を反映しない可能性');
	}
	if (marginStatusFetchFailed) {
		lines.push('⚠️ 信用口座状態の取得に失敗。建玉・追証状態は反映されていません');
	}
	if (marginPositionsFetchFailed) {
		lines.push('⚠️ 信用建玉の取得に失敗。建玉情報は反映されていません');
	}
	if (marginStatus && marginStatus.status !== 'NORMAL') {
		const warningLine = MARGIN_STATUS_WARNINGS[marginStatus.status];
		if (warningLine) lines.push(warningLine);
	}
	const showMarginTruncated = marginTradesTruncated && !marginFetchFailed;
	if (tradesTruncated || showMarginTruncated) {
		const subjects = [tradesTruncated && '現物', showMarginTruncated && '信用'].filter(Boolean).join(' / ');
		lines.push(`※ 約定履歴（${subjects}）が上限に達したため一部のみ取得。損益計算が不正確な可能性があります`);
	}
	return lines;
}

function buildPerformanceSectionLines(input: {
	dailyPerformance: PeriodPerformance | undefined;
	yearlyPerformance: PeriodPerformance | undefined;
	monthlyPerformance: PeriodPerformance | undefined;
	flowUnavailableReason: PortfolioFlowUnavailableReason | undefined;
	monthlyEquitySeries: EquityPoint[] | undefined;
	yearlyEquitySeries: EquityPoint[] | undefined;
	equitySeriesQuality: 'complete' | 'partial_fallback' | 'fallback_only' | 'jpy_only' | undefined;
	equitySeriesFallbackAssets: readonly string[];
}): string[] {
	const {
		dailyPerformance,
		yearlyPerformance,
		monthlyPerformance,
		flowUnavailableReason,
		monthlyEquitySeries,
		yearlyEquitySeries,
		equitySeriesQuality,
		equitySeriesFallbackAssets,
	} = input;
	const lines: string[] = [];
	if (dailyPerformance) lines.push(...buildPerformanceLines('前日比', dailyPerformance));
	if (yearlyPerformance) lines.push(...buildPerformanceLines('年初比', yearlyPerformance));
	if (monthlyPerformance) lines.push(...buildPerformanceLines('月初比', monthlyPerformance));
	if (yearlyPerformance || monthlyPerformance) {
		lines.push(`期間基準: JST`);
		lines.push(
			'※ 期初評価額は約定・入出金を逆算して復元、期初始値で評価。暗号資産入出庫は入出庫日（入庫: confirmed_at / 出庫: requested_at）の始値で JPY 換算',
		);
		lines.push('※ 出金元本は外部フローとして除外、出金手数料はコストとして performance に含む');
		// 上の 2 行が復元前提を語っているので、前提が満たせていないことをその直後に置く。
		if (flowUnavailableReason != null) {
			lines.push(
				`※ ただし今回は${FLOW_UNAVAILABLE_CAUSE[flowUnavailableReason]}ため入出金を巻き戻せていません。期初評価額・資産推移シリーズは入出金があった期間で実態と乖離します`,
			);
		}
	}
	if (monthlyEquitySeries && monthlyEquitySeries.length > 0) {
		if (equitySeriesQuality === 'jpy_only') {
			lines.push('※ 資産推移シリーズ: JPY のみ保有のため、価格変動は反映されません（入出金・約定の影響のみ）');
		} else if (equitySeriesQuality === 'fallback_only') {
			lines.push(
				'※ 資産推移シリーズ: 暗号資産の歴史的価格データが取得できなかったため、現在価格で全期間を代替（progression は holdings 変動のみ反映）',
			);
		} else if (equitySeriesQuality === 'partial_fallback') {
			const missing = equitySeriesFallbackAssets.map((a) => a.toUpperCase()).join(', ');
			lines.push(`※ 資産推移シリーズ: ${missing} の歴史的価格データが取得できなかったため、現在価格で代替`);
		}
		lines.push(
			...buildEquitySeriesLines(
				`月次資産推移（日次, ${monthlyEquitySeries.length}点）— グラフ「月次推移」タブ専用。年次タブでは使わない`,
				monthlyEquitySeries,
			),
		);
	}
	if (yearlyEquitySeries && yearlyEquitySeries.length > 0) {
		lines.push(
			...buildEquitySeriesLines(
				`年次資産推移（月次, ${yearlyEquitySeries.length}点）— グラフ「年次推移」タブ専用。月次タブでは使わない`,
				yearlyEquitySeries,
			),
		);
	}
	return lines;
}

function periodDWLine(label: '年初来' | '月初来', d: PeriodDWSummary): string {
	const parts = [
		`${label}入出金: JPY入金 ${formatYenAmount(d.jpy_deposited)} / JPY出金 ${formatYenAmount(d.jpy_withdrawn)} / 純入出金 ${formatYenAmount(d.net_jpy)}`,
	];
	if (d.crypto_deposit_count > 0)
		parts.push(
			`暗号資産入庫 ${d.crypto_deposit_count}件${d.crypto_deposit_estimated_jpy ? `（概算 ${formatYenAmount(d.crypto_deposit_estimated_jpy)}）` : ''}`,
		);
	if (d.crypto_withdrawal_count > 0)
		parts.push(
			`暗号資産出庫 ${d.crypto_withdrawal_count}件${d.crypto_withdrawal_estimated_jpy ? `（概算 ${formatYenAmount(d.crypto_withdrawal_estimated_jpy)}）` : ''}`,
		);
	return parts.join(' / ');
}

function buildDWStatusLines(input: {
	depositWithdrawalStatus: ReturnType<typeof resolveDepositWithdrawalStatus>;
	dwAllFailed: boolean | undefined;
	dwFetchedForPnl: boolean;
	flowUnavailableReason: PortfolioFlowUnavailableReason | undefined;
}): string[] {
	const { depositWithdrawalStatus, dwAllFailed, dwFetchedForPnl, flowUnavailableReason } = input;
	const lines: string[] = [];
	if (depositWithdrawalStatus === 'available') {
		lines.push(`入出金分析状態: available`);
		lines.push(`分析基準: deposit_withdrawal`);
	} else if (depositWithdrawalStatus === 'fallback') {
		lines.push(`入出金分析状態: fallback`);
		lines.push(`分析基準: trade_only`);
		if (dwAllFailed) {
			lines.push('※ 入出金APIの取得に全て失敗したため、約定ベースの分析のみです');
		} else {
			lines.push('※ API取得失敗またはpartial failureのため、約定ベースの分析にフォールバックしています');
		}
	} else if (depositWithdrawalStatus === 'no_history') {
		lines.push(`入出金分析状態: no_history`);
		lines.push(`分析基準: trade_only`);
		lines.push('※ 入出金履歴が0件のため、入出金ベース分析なし。約定ベースの分析のみです');
	} else {
		lines.push(`入出金分析状態: not_requested`);
		lines.push(`分析基準: trade_only`);
		// 「反映した値です」と断言するのは原価を出しているときだけ。原価を抑止しているときは「算出不能」行と矛盾するので中立の文言に落とす。
		lines.push(
			dwFetchedForPnl && flowUnavailableReason == null
				? '※ 入出金分析セクションは未リクエスト（include_deposit_withdrawal=false）。ただし損益計算には入出金履歴を取得して使用しているため、取得原価・評価損益・純入出金は入出金を反映した値です'
				: '※ 入出金分析は未リクエスト。約定ベースの分析のみです',
		);
	}
	return lines;
}

function buildAccountReturnLines(dwSummary: DepositWithdrawalSummary): string[] {
	const lines: string[] = [];
	// crypto_*_count は総件数で、estimated_jpy に載っているのは価格を解決できた件数だけなので、内訳の件数の和から逆算する。
	const valuedCounts = (breakdown: FlowValuationBreakdown | undefined) =>
		(breakdown?.deposit_date_price_count ?? 0) + (breakdown?.current_price_fallback_count ?? 0);
	const valuedDepositCount = valuedCounts(dwSummary.crypto_deposit_valuation);
	const valuedWithdrawalCount = valuedCounts(dwSummary.crypto_withdrawal_valuation);
	const unvaluedDepositCount = (dwSummary.crypto_deposit_count ?? 0) - valuedDepositCount;
	const unvaluedWithdrawalCount = (dwSummary.crypto_withdrawal_count ?? 0) - valuedWithdrawalCount;

	if (dwSummary.account_return_jpy != null) {
		const sign = dwSummary.account_return_jpy >= 0 ? '+' : '';
		const approxLabel = dwSummary.is_complete ? '' : '（概算）';
		lines.push(
			`口座全体リターン${approxLabel}: ${sign}${formatYenAmount(dwSummary.account_return_jpy)} (${formatPercent(dwSummary.account_return_pct, { sign: true })})`,
		);
		lines.push(`  JPY入金合計: ${formatYenAmount(dwSummary.total_jpy_deposited)}`);
		if (dwSummary.total_jpy_withdrawn > 0) {
			lines.push(`  JPY出金合計: ${formatYenAmount(dwSummary.total_jpy_withdrawn)}`);
		}
		const netJpyDeposit = dwSummary.total_jpy_deposited - dwSummary.total_jpy_withdrawn;
		lines.push(`  JPY純入金: ${formatYenAmount(Math.round(netJpyDeposit))}`);
		if (dwSummary.crypto_deposit_estimated_jpy) {
			lines.push(
				`  暗号資産入庫の評価: ${formatYenAmount(dwSummary.crypto_deposit_estimated_jpy)}（${valuedDepositCount}件、${FLOW_VALUATION_LABEL[dwSummary.crypto_deposit_valuation?.basis ?? 'current_price_fallback']}）`,
			);
		}
		if (dwSummary.crypto_withdrawal_estimated_jpy) {
			lines.push(
				`  暗号資産出庫の評価: -${formatYenAmount(dwSummary.crypto_withdrawal_estimated_jpy)}（${valuedWithdrawalCount}件、${FLOW_VALUATION_LABEL[dwSummary.crypto_withdrawal_valuation?.basis ?? 'current_price_fallback']}）`,
			);
		}
		if (dwSummary.staking_reward_estimated_jpy) {
			lines.push(
				`  うちステーキング報酬: ${formatYenAmount(dwSummary.staking_reward_estimated_jpy)}（${dwSummary.staking_reward_count ?? 0}件。元本ではないので純投入額から除き、リターンに含めています）`,
			);
		}
		// 内訳の式は実際に載っている項だけを並べる（0 円の項を書くと読み手が総額を追えない）。
		const netInvestedTerms = [
			dwSummary.crypto_deposit_estimated_jpy ? '+ 暗号資産入庫の評価額' : '',
			dwSummary.staking_reward_estimated_jpy ? '- ステーキング報酬の評価額' : '',
			dwSummary.crypto_withdrawal_estimated_jpy ? '- 暗号資産出庫の評価額' : '',
		].filter(Boolean);
		lines.push(
			`  純投入額: ${formatYenAmount(dwSummary.net_jpy_invested)}${netInvestedTerms.length > 0 ? `（JPY純入金 ${netInvestedTerms.join(' ')}）` : ''}`,
		);
		if (!dwSummary.is_complete) {
			lines.push('  ※ 入出金履歴が多く全件取得できなかったため、概算値です');
		}
		if (unvaluedDepositCount > 0) {
			lines.push(`  ※ 暗号資産入庫 ${unvaluedDepositCount}件の価格が取得できず評価額に含まれていません`);
		}
		const depositFallbackCount = dwSummary.crypto_deposit_valuation?.current_price_fallback_count ?? 0;
		if (depositFallbackCount > 0) {
			lines.push(
				`  ※ うち ${depositFallbackCount}件は入庫日の価格を取得できず現在価格で仮評価（この分だけ相場変動で評価額が動きます）`,
			);
		}
		if (unvaluedWithdrawalCount > 0) {
			lines.push(`  ※ 暗号資産出庫 ${unvaluedWithdrawalCount}件は評価額を算出できず純投入額に反映されていません`);
		}
		const withdrawalFallbackCount = dwSummary.crypto_withdrawal_valuation?.current_price_fallback_count ?? 0;
		if (withdrawalFallbackCount > 0) {
			lines.push(
				`  ※ うち ${withdrawalFallbackCount}件は出庫日の価格を取得できず現在価格で仮評価（この分だけ相場変動で評価額が動きます）`,
			);
		}
		if (valuedWithdrawalCount > 0) {
			lines.push(
				`  ※ 暗号資産出庫 ${valuedWithdrawalCount}件は JPY 出金と同じ「元本の回収」として純投入額から差し引いています（外部ウォレットへ移して保有を続けている場合でも、口座外の値動きは測定対象外です）`,
			);
		}
	} else if (dwSummary.net_jpy_invested <= 0) {
		// 黙ってブロックごと消すと「計算されたのに表示されていない」と読まれるので、出せない理由を 1 行で出す。
		const withdrawalCause =
			valuedWithdrawalCount > 0 ? `暗号資産出庫 ${valuedWithdrawalCount}件を元本の回収として差し引いた結果、` : '';
		lines.push(
			`口座全体リターン: 算出不可（${withdrawalCause}純投入額が ${formatYenAmount(dwSummary.net_jpy_invested)} と 0 以下になりました。引き出しが投入を上回る口座ではリターン率を定義できません）`,
		);
	}
	return lines;
}

function buildAccountPnlLines(input: {
	accountPnl: AccountPnl;
	totalRealizedPnlUnavailableReason: PortfolioUnresolvedDepositReason | undefined;
	heldRealizedPnl: number;
	closedPositionRealizedPnl: number | undefined;
	closedPositionAssetCount: number | undefined;
	hasPeriodAccountPnl: boolean;
}): string[] {
	const {
		accountPnl,
		totalRealizedPnlUnavailableReason,
		heldRealizedPnl,
		closedPositionRealizedPnl,
		closedPositionAssetCount,
		hasPeriodAccountPnl,
	} = input;
	const lines: string[] = [];
	// 全履歴と年初来 / 月初来が併存するので、ラベルにスコープを書く（text だけでは判別できない。#53）。
	const spotRealized = accountPnl.spot_realized_pnl;
	const hasMargin =
		accountPnl.margin_realized_pnl !== 0 || accountPnl.margin_interest_cost !== 0 || accountPnl.margin_fee_cost !== 0;
	// data 側はコスト = 正値なので、表示は total への寄与として - を前置する（#72）。
	const marginPart = `Margin: ${accountPnl.margin_realized_pnl >= 0 ? '+' : ''}${formatYenAmount(accountPnl.margin_realized_pnl)} / Interest cost: -${formatYenAmount(accountPnl.margin_interest_cost)} / Fee cost: -${formatYenAmount(accountPnl.margin_fee_cost)}`;
	if (spotRealized == null && totalRealizedPnlUnavailableReason != null) {
		// 抑止した銘柄を除いた部分和を見出しに載せない。数字を出した時点で口座の実現損益として読まれる（#80）。
		lines.push(
			`Realized PnL (Spot, 全履歴・売り切り銘柄含む): 算出不能（${UNRESOLVED_DEPOSIT_NOTE[totalRealizedPnlUnavailableReason]}）`,
		);
		lines.push(
			hasMargin
				? `Account PnL (全履歴): 算出不能（現物の実現損益が確定しないため。信用のみの内訳: ${marginPart}）`
				: 'Account PnL (全履歴): 算出不能（現物の実現損益が確定しないため）',
		);
	} else {
		const spotSign = (spotRealized ?? 0) >= 0 ? '+' : '';
		lines.push(`Realized PnL (Spot, 全履歴・売り切り銘柄含む): ${spotSign}${formatYenAmount(spotRealized ?? 0)}`);
		if (closedPositionRealizedPnl != null) {
			const heldSign = heldRealizedPnl >= 0 ? '+' : '';
			const closedPart =
				closedPositionAssetCount != null && closedPositionAssetCount > 0
					? `売り切り銘柄 ${closedPositionAssetCount}銘柄 ${closedPositionRealizedPnl >= 0 ? '+' : ''}${formatYenAmount(closedPositionRealizedPnl)}`
					: '売り切り銘柄なし（0円）';
			lines.push(
				`  内訳: 現在保有銘柄（holdings[].realized_pnl の合計）${heldSign}${formatYenAmount(heldRealizedPnl)} / ${closedPart}`,
			);
		}
		const total = accountPnl.total ?? 0;
		const totalSign = total >= 0 ? '+' : '';
		if (hasMargin) {
			lines.push(
				`Account PnL (全履歴): ${totalSign}${formatYenAmount(total)} (Spot: ${spotSign}${formatYenAmount(spotRealized ?? 0)} / ${marginPart})`,
			);
		} else {
			lines.push(`Account PnL (全履歴): ${totalSign}${formatYenAmount(total)}`);
		}
	}
	// 年初来 / 月初来は data 側にしか出ないので、全履歴の値と取り違えられないよう所在を示す。
	if (hasPeriodAccountPnl) {
		lines.push(
			'※ 上の Realized PnL / Account PnL は全履歴（口座開設来）の集計です。年初来 / 月初来は yearly_account_pnl / monthly_account_pnl（現物単独は yearly_realized_pnl / monthly_realized_pnl）を参照してください',
		);
	}
	return lines;
}

function buildCostNoteLines(input: {
	flowUnavailableReason: PortfolioFlowUnavailableReason | undefined;
	totalUnrealizedPnl: number | undefined;
	totalUnrealizedPnlPct: number | undefined;
	qtyMismatchAssets: ReadonlyArray<{ asset: string; reason: PortfolioQtyMismatchReason }>;
	depositOnlyDetected: readonly string[];
	unpricedDepositLabel: string;
	suppressedRealizedLabel: string;
	qtyClampLabel: string;
}): string[] {
	const {
		flowUnavailableReason,
		totalUnrealizedPnl,
		totalUnrealizedPnlPct,
		qtyMismatchAssets,
		depositOnlyDetected,
		unpricedDepositLabel,
		suppressedRealizedLabel,
		qtyClampLabel,
	} = input;
	const lines: string[] = [];
	if (flowUnavailableReason != null) {
		// 壊れた原価から出した率が見出しに載ると、LLM がそれを口座の成績として読む。
		lines.push(`評価損益: 算出不能（${FLOW_UNAVAILABLE_NOTE[flowUnavailableReason]}）`);
	} else {
		if (totalUnrealizedPnl != null) {
			const sign = totalUnrealizedPnl >= 0 ? '+' : '';
			lines.push(
				`合計評価損益（全履歴の約定ベース）: ${sign}${formatYenAmount(totalUnrealizedPnl)} (${formatPercent(totalUnrealizedPnlPct, { sign: true })})`,
			);
		}
		lines.push(
			'※ 評価損益は全履歴の約定・暗号資産入出庫から移動平均法で算出した取得原価ベース。暗号資産入庫は入庫日（confirmed_at）の始値で取得したとみなして原価に算入（真の取得原価ではなく入庫時点の相場という仮定）。入庫日の価格を取得できなかった入庫は原価に算入しないため、その分だけ取得原価は過小になります（復元数量が実残高と乖離した銘柄は取得原価を出しません）',
		);
	}
	if (qtyMismatchAssets.length > 0) {
		lines.push(
			`※ ${qtyMismatchAssets.map((m) => m.asset.toUpperCase()).join(', ')} は復元数量が実残高と乖離しているため合計評価損益に含めていません`,
		);
	}
	if (depositOnlyDetected.length > 0) {
		lines.push(
			`※ ${depositOnlyDetected.map((a) => a.toUpperCase()).join(', ')} は入庫記録はあるものの約定履歴にも現在残高にも現れません（closed_positions を参照）`,
		);
	}
	if (unpricedDepositLabel !== '') {
		lines.push(
			`※ ${unpricedDepositLabel} は入庫日の始値を解決できなかった入庫（カッコ内は件数）を取得原価に算入していないため、取得原価・評価損益・実現損益がその分だけ不完全です。合計からは除外せず含めています`,
		);
	}
	if (suppressedRealizedLabel !== '') {
		lines.push(
			`※ ${suppressedRealizedLabel} は入庫日を含む年足を取得できなかった入庫（カッコ内は件数）があるため、取得原価・評価損益・実現損益を出していません（合計評価損益からは除外しています）。合計実現損益・口座全体 PnL も、抑止した銘柄を除いた部分和は出さず算出不能にしています`,
		);
	}
	if (qtyClampLabel !== '') {
		lines.push(
			`※ ${qtyClampLabel} は履歴から復元した保有を超える売却（カッコ内は発火件数）があり、超過分を原価ゼロで按分しています。その分だけ実現損益は過大側、取得原価は過小側です`,
		);
	}
	return lines;
}

function buildHoldingsPerformanceLines(
	holdingsPerformance: ReadonlyArray<{
		asset: string;
		jpy_value?: number | null;
		monthly_change_pct?: number | null;
		yearly_change_pct?: number | null;
	}>,
): string[] {
	const lines: string[] = [];
	lines.push('保有銘柄のパフォーマンス:');
	for (const hp of holdingsPerformance) {
		const assetUpper = hp.asset.toUpperCase();
		const parts = [`${assetUpper}`];
		if (hp.jpy_value != null) parts.push(formatYenAmount(hp.jpy_value));
		if (hp.monthly_change_pct != null)
			parts.push(`月次騰落率: ${formatPercent(hp.monthly_change_pct, { sign: true })}`);
		if (hp.yearly_change_pct != null) parts.push(`年次騰落率: ${formatPercent(hp.yearly_change_pct, { sign: true })}`);
		lines.push(`  ${parts.join(' / ')}`);
	}
	return lines;
}

function buildTechnicalLines(technical: readonly TechnicalSummary[]): string[] {
	const lines: string[] = [];
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
	return lines;
}

type EquitySeriesQuality = 'complete' | 'partial_fallback' | 'fallback_only' | 'jpy_only';

function calendarPoints(startMs: number, endMs: number, unit: 'day' | 'month'): ReturnType<typeof dayjs>[] {
	const points: ReturnType<typeof dayjs>[] = [];
	for (let d = dayjs(startMs).tz(PORTFOLIO_CALENDAR_TZ); d.valueOf() <= endMs; d = d.add(1, unit)) {
		points.push(d);
	}
	return points;
}

// 判定は buildEquitySeries が実際に lookup する日付キーがすべて揃っているか。任意の 1 件で OK とすると sparse coverage でも complete になる。
function equitySeriesFallbackAssetsOf(
	cryptoAssets: readonly string[],
	requiredDateKeys: ReadonlySet<number>,
	dailyPrices: CandlePriceData['dailyPrices'],
): string[] {
	return cryptoAssets.filter((asset) => {
		const dp = dailyPrices.get(asset);
		if (!dp) return true;
		for (const ts of requiredDateKeys) {
			if (!dp.has(ts)) return true;
		}
		return false;
	});
}

function equitySeriesQualityOf(cryptoAssetCount: number, fallbackAssetCount: number): EquitySeriesQuality {
	if (cryptoAssetCount === 0) return 'jpy_only';
	if (fallbackAssetCount === 0) return 'complete';
	return fallbackAssetCount === cryptoAssetCount ? 'fallback_only' : 'partial_fallback';
}

interface DWSection {
	dwSummary: DepositWithdrawalSummary | undefined;
	yearlyDWSummary: PeriodDWSummary | undefined;
	monthlyDWSummary: PeriodDWSummary | undefined;
	dwWarnings: string[];
}

function buildDWSection(
	dwData: DepositWithdrawalData | null,
	totalJpyValue: number,
	flowPricing: FlowPricing,
	boundaries: ReturnType<typeof getJstPeriodBoundaries>,
): DWSection {
	const section: DWSection = {
		dwSummary: undefined,
		yearlyDWSummary: undefined,
		monthlyDWSummary: undefined,
		dwWarnings: [],
	};
	if (dwData == null) return section;
	if (dwData.allFailed) {
		section.dwWarnings.push('入出金履歴の取得に全て失敗したため、約定ベースの分析のみです');
		return section;
	}
	section.dwWarnings.push(...dwData.warnings.map((w) => `注意: ${w}（部分的なデータで概算）`));
	if (dwData.deposits.length > 0 || dwData.withdrawals.length > 0) {
		section.dwSummary = calcDepositWithdrawalSummary(dwData, totalJpyValue, flowPricing);
		section.yearlyDWSummary = calcPeriodDWSummary(
			dwData,
			boundaries.yearStartMs,
			boundaries.yearStartIso,
			boundaries.nowIso,
			flowPricing,
		);
		section.monthlyDWSummary = calcPeriodDWSummary(
			dwData,
			boundaries.monthStartMs,
			boundaries.monthStartIso,
			boundaries.nowIso,
			flowPricing,
		);
	}
	return section;
}

interface SuppressedChangePct {
	key: PeriodPerformanceKey;
	label: string;
	reason: PortfolioChangePctUnavailableReason;
	direction: ChangeJpyDirection;
}

// 並びは summary の期間ブロックと同じ（前日比 → 年初比 → 月初比）。
function suppressedChangePcts(
	periods: Record<PeriodPerformanceKey, PeriodPerformance | undefined>,
): SuppressedChangePct[] {
	const labels: Array<[PeriodPerformanceKey, string]> = [
		['daily', '前日比'],
		['yearly', '年初比'],
		['monthly', '月初比'],
	];
	const suppressed: SuppressedChangePct[] = [];
	for (const [key, label] of labels) {
		const p = periods[key];
		const reason = p?.change_pct_unavailable_reason;
		if (reason != null) suppressed.push({ key, label, reason, direction: changeJpyDirectionOf(p) });
	}
	return suppressed;
}

interface CalcWarningsInput {
	dailyPerformance: PeriodPerformance | undefined;
	monthlyPerformance: PeriodPerformance | undefined;
	yearlyPerformance: PeriodPerformance | undefined;
	flowUnavailableReason: PortfolioFlowUnavailableReason | undefined;
	qtyMismatchAssets: ReadonlyArray<{ asset: string; reason: PortfolioQtyMismatchReason }>;
	depositOnlyDetected: readonly string[];
	tradesTruncated: boolean;
	unpricedDepositLabel: string;
	qtyClampLabel: string;
	cryptoHoldingCount: number;
	changePctSuppressed: ReadonlyArray<{
		label: string;
		reason: PortfolioChangePctUnavailableReason;
		direction: ChangeJpyDirection;
	}>;
	flowValuationFallbackCount: number;
	chunkTruncated: { deposits: number; withdrawals: number };
	chunkFailed: { deposits: number; withdrawals: number };
	suppressedLabelOf: (reason?: PortfolioUnresolvedDepositReason) => string;
}

function buildCalcWarnings(input: CalcWarningsInput): string[] {
	const {
		dailyPerformance,
		monthlyPerformance,
		yearlyPerformance,
		flowUnavailableReason,
		qtyMismatchAssets,
		depositOnlyDetected,
		tradesTruncated,
		unpricedDepositLabel,
		qtyClampLabel,
		cryptoHoldingCount,
		changePctSuppressed,
		flowValuationFallbackCount,
		chunkTruncated,
		chunkFailed,
		suppressedLabelOf,
	} = input;
	const netFlowUnpricedAssets = [
		...new Set([
			...(dailyPerformance?.unpriced_flow_assets ?? []),
			...(monthlyPerformance?.unpriced_flow_assets ?? []),
			...(yearlyPerformance?.unpriced_flow_assets ?? []),
		]),
	].sort();
	const startBoundaryUnpricedAssets = [
		...new Set([
			...(dailyPerformance?.unpriced_start_assets ?? []),
			...(monthlyPerformance?.unpriced_start_assets ?? []),
			...(yearlyPerformance?.unpriced_start_assets ?? []),
		]),
	].sort();
	const currentUnpricedAssets = [
		...new Set([
			...(dailyPerformance?.unpriced_current_assets ?? []),
			...(monthlyPerformance?.unpriced_current_assets ?? []),
			...(yearlyPerformance?.unpriced_current_assets ?? []),
		]),
	].sort();
	const calcWarnings: string[] = [];
	// summary 本文の「算出不能」行は JSON より後ろに埋もれることがあるので、content 先頭にも出す。
	if (flowUnavailableReason != null) {
		calcWarnings.push(
			`評価損益・取得原価は算出していません（${FLOW_UNAVAILABLE_NOTE[flowUnavailableReason]}）。期間パフォーマンスの純入出金も未計測です`,
		);
	}
	if (qtyMismatchAssets.length > 0) {
		calcWarnings.push(
			`${qtyMismatchAssets.map((m) => `${m.asset.toUpperCase()}（${QTY_MISMATCH_CAUSE[m.reason]}）`).join(', ')} は約定・出庫から復元した保有数量が実残高と一致しないため、取得原価・評価損益を算出せず合計評価損益からも除外しています`,
		);
	}
	// 約定履歴が打ち切られている実行で「販売所取引の可能性」と言い切らないよう、文言を tradesTruncated で分ける。
	if (depositOnlyDetected.length > 0) {
		calcWarnings.push(
			tradesTruncated
				? `${depositOnlyDetected.map((a) => a.toUpperCase()).join(', ')} は入出金履歴に暗号資産の入庫記録があるものの、約定履歴にも現在残高にも現れません。約定履歴の取得が件数上限で打ち切られているため取引所約定を見落としている可能性があり、該当銘柄の実現損益はこの結果に含まれていません（closed_positions に realized_pnl_unavailable_reason=history_truncated 付きで申告しています）`
				: `${depositOnlyDetected.map((a) => a.toUpperCase()).join(', ')} は入出金履歴に暗号資産の入庫記録があるものの、約定履歴にも現在残高にも現れません。販売所取引など bitbank API に現れない取引で全量を処分した可能性があり（断定はできません）、該当銘柄の実現損益はこの結果に含まれていません（closed_positions に realized_pnl_unavailable_reason=untracked_trade_suspected 付きで申告しています）`,
		);
	}
	if (unpricedDepositLabel !== '') {
		calcWarnings.push(
			`${unpricedDepositLabel} は入庫日の始値を解決できなかった暗号資産入庫（カッコ内は件数）を取得原価にも復元数量にも算入せずに cost_basis / avg_buy_price / unrealized_pnl / realized_pnl を算出しています。未算入ぶんを売却済みなら原価ゼロで売ったことになり実現損益は過大、保有継続なら取得原価が過小です。数量乖離が許容誤差に収まっているため cost_basis_reliable=true のまま確定値が出ますが、原価は不完全です（件数は holdings[].unpriced_deposit_count。該当銘柄は total_cost_basis / total_unrealized_pnl / total_realized_pnl から除外せず含めています）`,
		);
	}
	// 原価をゼロ扱いにするのは実現損益として妥当なので抑止せず、算出条件として申告だけする（#89）。
	if (qtyClampLabel !== '') {
		calcWarnings.push(
			`${qtyClampLabel} は約定・入出庫から復元した保有を超える売却があり（カッコ内は発火件数）、超過分を原価ゼロで按分して realized_pnl を算出しています（その分だけ過大側、取得原価は過小側）。**これ自体が取得漏れの症状**——API に現れない取得（販売所での買いなど）があると復元保有が不足し、その状態の売却がここに出ます。吸収された数量は holdings[].qty_clamp_absorbed_qty、乖離そのものは reconstructed_qty と amount の差で読むこと（数量側はクランプしていないので、乖離は吸収されずに残ります）`,
		);
	}
	if (netFlowUnpricedAssets.length > 0) {
		calcWarnings.push(
			`${netFlowUnpricedAssets.map((a) => a.toUpperCase()).join(', ')} は入出庫日価格・現在価格のいずれも取得できず、期間中の入出庫を純入出金に計上できませんでした（未計上が入庫なら純入出金は過小・入出金調整後増減は過大、出庫なら逆向きにずれます）`,
		);
	}
	if (startBoundaryUnpricedAssets.length > 0) {
		calcWarnings.push(
			`${startBoundaryUnpricedAssets.map((a) => a.toUpperCase()).join(', ')} は期初の始値を解決できず期初評価額に含めていません（当日足が未取得の時間帯では数十分後に解消しうる）。期初評価額は過小で、該当期間の増減額（change_jpy / adjusted_change_jpy）も同じ欠損の影響を受けます（ずれの向きが確定する期間には change_jpy_overstated=true が付きます）`,
		);
	}
	// 全銘柄が並ぶのは ticker 取得そのものの失敗なので、全滅かどうかを文言で切り分ける（#109）。
	if (currentUnpricedAssets.length > 0) {
		const allCryptoUnpriced = cryptoHoldingCount > 0 && currentUnpricedAssets.length === cryptoHoldingCount;
		calcWarnings.push(
			`${currentUnpricedAssets.map((a) => a.toUpperCase()).join(', ')} は現在価格を解決できず現在評価額（current_value_jpy）に含めていません。現在評価額は過小で、増減額（change_jpy / adjusted_change_jpy）も同じ額だけ過小です（ずれの向きが確定する期間には change_jpy_understated=true が付きます）。同じ銘柄は合計評価損益（total_unrealized_pnl）・合計取得原価（total_cost_basis）からも除外しています${allCryptoUnpriced ? '。**保有する暗号資産が全て脱落しています ＝ ticker 取得そのものが失敗しており、現在評価額は JPY 残高だけに縮退しています。**増減額は口座の損失ではなく価格取得の失敗を表す数なので、損失として読まないでください（時間をおいて再実行してください）' : ''}`,
		);
	}
	// 同じ理由でも向きが確定する期間としない期間が混ざりうるので、向きでも分けて行を出す。
	for (const reason of Object.keys(CHANGE_PCT_UNAVAILABLE_NOTE) as PortfolioChangePctUnavailableReason[]) {
		for (const direction of CHANGE_JPY_DIRECTIONS) {
			const labels = changePctSuppressed
				.filter((e) => e.reason === reason && e.direction === direction)
				.map((e) => e.label);
			if (labels.length === 0) continue;
			calcWarnings.push(
				`${labels.join(' / ')}の増減率（change_pct / adjusted_change_pct）は出していません（${CHANGE_PCT_UNAVAILABLE_NOTE[reason]}）。${changeJpyGuidanceWarning(reason, direction)}。率が無いのは「ゼロ %」の意味ではありません`,
			);
		}
	}
	if (flowValuationFallbackCount > 0) {
		calcWarnings.push(
			`暗号資産入出庫 ${flowValuationFallbackCount}件は入出庫日（入庫: confirmed_at / 出庫: requested_at）の価格を取得できず現在価格で仮評価しています。この分の評価額は相場変動で動きます（取得原価には算入しないため、該当する入庫で復元数量が実残高と乖離した銘柄は cost_basis_unavailable_reason=has_crypto_deposits になり、乖離が許容誤差以内に収まった銘柄は取得原価がその分だけ過小のまま出ます）`,
		);
	}
	// フォールバック件数からは再実行で直るかが読めないので、上限・取得失敗の分は別枠で出す（#76）。
	// 件数だけでは値が出ているのか抑止されたのか読めないので、抑止した銘柄名を同じ行に載せる（#80）。
	const depositShortfallWarning = (count: number, reason: PortfolioUnresolvedDepositReason): string => {
		const label = suppressedLabelOf(reason);
		const head = `暗号資産入庫 ${count}件は${UNRESOLVED_DEPOSIT_NOTE[reason]}`;
		if (label === '') {
			return `${head}。該当銘柄は保有・約定のいずれにも現れないため、抑止した出力はありません`;
		}
		return `${head}。${label}（カッコ内は件数）は取得原価・平均取得単価・評価損益・実現損益を確定値として出さず cost_basis_unavailable_reason=${reason} で抑止しています。合計実現損益（total_realized_pnl / account_pnl.spot_realized_pnl）と、抑止した銘柄が売却している期間の期間実現損益も、残りを足した部分和は出さず undefined です`;
	};
	if (chunkTruncated.deposits > 0) {
		calcWarnings.push(depositShortfallWarning(chunkTruncated.deposits, 'deposit_price_chunk_truncated'));
	}
	if (chunkFailed.deposits > 0) {
		calcWarnings.push(depositShortfallWarning(chunkFailed.deposits, 'deposit_price_fetch_failed'));
	}
	if (chunkTruncated.withdrawals > 0) {
		calcWarnings.push(
			`暗号資産出庫 ${chunkTruncated.withdrawals}件は出庫日を含む年足の追加取得が上限（${MAX_WITHDRAWAL_FLOW_PRICE_YEAR_CHUNKS}組）に達したため取りに行けず、現在価格で仮評価しています（純投入額の減算に使う表示専用の値で、取得原価には影響しません）`,
		);
	}
	if (chunkFailed.withdrawals > 0) {
		calcWarnings.push(
			`暗号資産出庫 ${chunkFailed.withdrawals}件は出庫日を含む年足の取得に失敗したため現在価格で仮評価しています（純投入額の減算に使う表示専用の値で、取得原価には影響しません）`,
		);
	}

	return calcWarnings;
}

export default async function analyzeMyPortfolioHandler(args: {
	include_technical?: boolean;
	include_pnl?: boolean;
	include_deposit_withdrawal?: boolean;
}) {
	const { include_technical = true, include_pnl = true, include_deposit_withdrawal = true } = args;
	const client = getDefaultClient();

	try {
		// pairs は丸め桁にだけ使うので、取得失敗は null に握り潰して丸めずに出す。
		const [rawAssets, prices, pairsSpec] = await Promise.all([
			client.get<{ assets: RawAsset[] }>('/v1/user/assets'),
			fetchTickerPrices(),
			fetchPairsSpec().catch(() => null),
		]);

		// 大文字が混ざると BTC / btc で保有キーが割れて二重計上になるので、取得境界で小文字に揃える。
		const assets = normalizeAssetCodes(rawAssets.assets);

		const nonZeroAssets = assets.filter((a) => {
			const amount = Number(a.onhand_amount);
			return Number.isFinite(amount) && amount > 0;
		});

		const boundaries = getJstPeriodBoundaries();

		// 損益計算は全履歴で移動平均を回すので全期間を取得する。期間集計は各関数の sinceMs で絞る。
		const tradePromise = include_pnl
			? paginateTrades(client)
			: Promise.resolve({ trades: [] as RawTrade[], truncated: false });

		const marginTradePromise = include_pnl
			? paginateMarginTrades(client)
			: Promise.resolve({ trades: [] as RawMarginTrade[], truncated: false, fetchFailed: false });

		// 入出金履歴は表示セクションの有無ではなく損益計算に要るかで取得する（include_pnl=true なら必須の入力）。
		const dwPromise =
			include_pnl || include_deposit_withdrawal ? fetchDepositWithdrawal(client) : Promise.resolve(null);

		// 信用約定の取得とは独立して失敗しうるので別フラグで持つ。
		const marginAccountInfoPromise = fetchMarginAccountInfo();

		const [tradeResult, marginTradeResult, dwData, marginAccountInfo] = await Promise.all([
			tradePromise,
			marginTradePromise,
			dwPromise,
			marginAccountInfoPromise,
		]);
		const allTrades = tradeResult.trades;
		const tradesTruncated = tradeResult.truncated;
		const allMarginTrades = marginTradeResult.trades;
		const marginTradesTruncated = marginTradeResult.truncated;
		const marginFetchFailed = marginTradeResult.fetchFailed;
		const marginStatusFetchFailed = marginAccountInfo.statusFetchFailed;
		const marginPositionsFetchFailed = marginAccountInfo.positionsFetchFailed;

		// include_deposit_withdrawal=false なら履歴を取得済みでも not_requested（セクションを出さないという意味）。
		const depositWithdrawalStatus = resolveDepositWithdrawalStatus(include_deposit_withdrawal, dwData);
		// 部分失敗・打ち切りでも true になるので、取得原価を信頼してよいかは flowUnavailableReason で判定する。
		const dwFetchedForPnl = include_pnl && dwData != null && !dwData.allFailed;
		// 出庫履歴が欠けると cost_basis が過大化するので、holdings のマッピングより前に理由コードを確定する。
		const flowUnavailableReason: PortfolioFlowUnavailableReason | undefined = include_pnl
			? flowUnavailableReasonFor(dwData)
			: undefined;

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

		// 取得原価が入庫日価格を使うので、この確定は損益算出より前に済ませる。どの消費者もいない構成では価格解決そのものを行わない（出力に現れない換算で警告を出さない）。
		const candlePriceData = await candlePricePromise;
		// 部分失敗・打ち切りでも dwSummary は出るので、セクション側の消費判定に flowUnavailableReason は使わない。
		const dwSectionUsesFlow = include_deposit_withdrawal && dwData != null && !dwData.allFailed;
		const pnlUsesFlow = include_pnl && flowUnavailableReason == null;
		const flowValuationTargets =
			dwSectionUsesFlow || pnlUsesFlow
				? collectFlowValuationTargets(dwData, {
						// 入庫はどの経路でも全履歴を要求するので、年初来に絞れる構成は無い。
						depositsSinceMs: undefined,
						// 出庫は入出金分析セクションがあるときだけ全履歴（純投入額の減算に使う）。
						withdrawalsSinceMs: dwSectionUsesFlow ? undefined : boundaries.yearStartMs,
					})
				: [];
		const flowDatePrices = await fetchFlowDatePrices(candlePriceData.dailyPrices, flowValuationTargets);
		const flowPricing: FlowPricing = {
			dailyPrices: flowDatePrices.dailyPrices,
			currentPrices: prices,
		};
		const flowValuation = summarizeFlowValuation(flowValuationTargets, flowPricing);
		// pnlUsesFlow が false の構成では原価由来フィールド自体を出さないので渡さない。
		const depositCost: DepositCostBasisInput | undefined =
			pnlUsesFlow && dwData != null ? { deposits: dwData.deposits, pricing: flowPricing } : undefined;

		const timestamp = nowIso();

		// pnlUsesFlow が false の構成では入庫を原価に算入しておらず、原価由来フィールドも既に抑止されているので判定しない。
		const unresolvedDeposits: UnresolvedDeposits = {
			reasons: pnlUsesFlow
				? unresolvedDepositReasonsByAsset(
						flowDatePrices.truncatedByChunkLimit.depositsByAsset,
						flowDatePrices.chunkFetchFailed.depositsByAsset,
					)
				: new Map<string, PortfolioUnresolvedDepositReason>(),
			countOf: (asset) =>
				(flowDatePrices.chunkFetchFailed.depositsByAsset.get(asset) ?? 0) +
				(flowDatePrices.truncatedByChunkLimit.depositsByAsset.get(asset) ?? 0),
		};
		const pnlOf = (asset: string) => calcPnl(allTrades, asset, dwData?.withdrawals, depositCost);

		const held = tallyHeldAssets(nonZeroAssets, {
			prices,
			pairsSpec,
			pnlOf: include_pnl ? pnlOf : undefined,
			flowUnavailableReason,
			unresolvedDeposits,
			dwData,
			tradesTruncated,
		});
		const { holdings, totalJpyValue, qtyMismatchAssets } = held;
		// summary の内訳行はこの退避値を使う（spot_realized_pnl - closed の引き算だと浮動小数の残差が表示に乗る）。
		const heldRealizedPnl = held.realizedPnl;

		// #93 の検出でも使うので include_pnl の外側で一度だけ計算する。
		const heldAssets = new Set(nonZeroAssets.map((a) => a.asset));
		const tradedAssets = new Set(allTrades.map((t) => t.pair.replace('_jpy', '')).filter((a) => a !== 'jpy'));
		// undefined なら closed 系はすべて undefined（集計していない）。
		const closed =
			include_pnl && allTrades.length > 0
				? tallyClosedAssets({ tradedAssets, heldAssets, pnlOf, unresolvedDeposits, heldRealizedPnl })
				: undefined;
		const totalRealizedPnl = closed?.totalRealizedPnl ?? heldRealizedPnl;
		const closedPositionRealizedPnl = closed?.closedPositionRealizedPnl;
		const closedPositionAssetCount = closed?.closedPositionAssetCount;
		const unpricedDepositAssets = [...held.unpricedDepositAssets, ...(closed?.unpricedDepositAssets ?? [])];
		// 売り切り銘柄は holdings に載らないので警告行が唯一の申告経路になる（#89）。
		const qtyClampAssets = [...held.qtyClampAssets, ...(closed?.qtyClampAssets ?? [])];
		const suppressedRealizedAssets = [...held.suppressedRealizedAssets, ...(closed?.suppressedRealizedAssets ?? [])];

		// 除外判定は出庫履歴の完全性に依存するので、flowUnavailableReason が立つ実行では検出自体を行わない。
		const depositOnlyDetected =
			include_pnl && flowUnavailableReason == null ? depositOnlyAssets(dwData, heldAssets, tradedAssets) : [];
		const closedPositions = withDepositOnlyAssets(closed?.closedPositions, depositOnlyDetected, tradesTruncated);

		// 抑止した銘柄を除いても含めても正しい合計にならないので、合計そのものを出さない（#80）。
		const totalRealizedPnlUnavailableReason = dominantUnresolvedDepositReason(
			suppressedRealizedAssets.map((e) => e.reason),
		);

		const periodRealizedPnl = (startMs: number, startIso: string) =>
			calcPeriodRealizedPnl(allTrades, startMs, startIso, boundaries.nowIso, dwData?.withdrawals, depositCost);
		const hasPnl = include_pnl && allTrades.length > 0;
		const yearlyRealizedPnl = hasPnl ? periodRealizedPnl(boundaries.yearStartMs, boundaries.yearStartIso) : undefined;
		const monthlyRealizedPnl = hasPnl
			? periodRealizedPnl(boundaries.monthStartMs, boundaries.monthStartIso)
			: undefined;

		// 抑止した銘柄がその期間に売却しているときだけ壊れるので、抑止範囲を広げない（#80）。
		const periodRealizedPnlUnavailableReasonFor = (
			period: PeriodRealizedPnl | undefined,
		): PortfolioUnresolvedDepositReason | undefined => {
			if (period == null) return undefined;
			const sold = new Set(period.sold_assets);
			return dominantUnresolvedDepositReason(
				suppressedRealizedAssets.filter((e) => sold.has(e.asset)).map((e) => e.reason),
			);
		};
		const yearlyRealizedPnlUnavailableReason = periodRealizedPnlUnavailableReasonFor(yearlyRealizedPnl);
		const monthlyRealizedPnlUnavailableReason = periodRealizedPnlUnavailableReasonFor(monthlyRealizedPnl);

		// totalRealizedPnl と yearly / monthly は現物単独の値のまま維持し、信用込みは account_pnl 系にまとめる。
		const periodAccountPnl = (
			startMs: number,
			startIso: string,
			spot: PeriodRealizedPnl | undefined,
			spotUnavailableReason: PortfolioUnresolvedDepositReason | undefined,
		): PeriodAccountPnl =>
			buildPeriodAccountPnl(
				spotUnavailableReason != null ? undefined : (spot?.realized_pnl ?? 0),
				calcPeriodMarginPnl(allMarginTrades, startMs, startIso, boundaries.nowIso),
				startIso,
				boundaries.nowIso,
				spotUnavailableReason,
			);
		const accountPnl: AccountPnl | undefined = include_pnl
			? buildAccountPnl(
					totalRealizedPnlUnavailableReason != null ? undefined : totalRealizedPnl,
					calcMarginPnl(allMarginTrades),
					totalRealizedPnlUnavailableReason,
				)
			: undefined;
		const yearlyAccountPnl = include_pnl
			? periodAccountPnl(
					boundaries.yearStartMs,
					boundaries.yearStartIso,
					yearlyRealizedPnl,
					yearlyRealizedPnlUnavailableReason,
				)
			: undefined;
		const monthlyAccountPnl = include_pnl
			? periodAccountPnl(
					boundaries.monthStartMs,
					boundaries.monthStartIso,
					monthlyRealizedPnl,
					monthlyRealizedPnlUnavailableReason,
				)
			: undefined;

		let yearlyPerformance: PeriodPerformance | undefined;
		let monthlyPerformance: PeriodPerformance | undefined;
		let dailyPerformance: PeriodPerformance | undefined;
		let monthlyEquitySeries: EquityPoint[] | undefined;
		let yearlyEquitySeries: EquityPoint[] | undefined;
		let equitySeriesQuality: EquitySeriesQuality | undefined;
		let equitySeriesFallbackAssets: string[] = [];
		if (include_pnl) {
			const currentJpyValueRounded = Math.round(totalJpyValue);

			const performanceCtx: PortfolioPerformanceContext = {
				currentHoldings: nonZeroAssets.map((a) => ({ asset: a.asset, amount: a.onhand_amount })),
				trades: allTrades,
				dwData,
				candlePriceData,
				flowPricing,
				currentValue: currentJpyValueRounded,
				nowIso: boundaries.nowIso,
				flowUnavailableReason,
			};
			const performanceSpecs: PeriodSpec[] = [
				{ key: 'yearly', startMs: boundaries.yearStartMs, startIso: boundaries.yearStartIso },
				{ key: 'monthly', startMs: boundaries.monthStartMs, startIso: boundaries.monthStartIso },
				{ key: 'daily', startMs: boundaries.dayStartMs, startIso: boundaries.dayStartIso },
			];
			[yearlyPerformance, monthlyPerformance, dailyPerformance] = performanceSpecs.map((s) =>
				buildPeriodPerformance(s, performanceCtx),
			);

			// candle 取得状況に関わらず必ず構築する。series を含めないと LLM が 2 点だけで折れ線を描いてしまう。
			const holdingsForReconstruction = nonZeroAssets.map((a) => ({ asset: a.asset, amount: a.onhand_amount }));

			// 今日 00:00 JST は fetchCandlePriceData に渡した boundaries と同じ瞬間から導く。時計を読み直すと JST 00:00 を跨いだときに日次価格に無い点が 1 つ増える。
			const monthDates = calendarPoints(boundaries.monthStartMs, boundaries.dayStartMs, 'day');
			// 月次点の終端も同じ理由で boundaries 由来（月跨ぎのレースを避ける）。
			const yearDates = calendarPoints(boundaries.yearStartMs, boundaries.monthStartMs, 'month');
			const equitySeriesOver = (dates: ReturnType<typeof dayjs>[]) =>
				buildEquitySeries(
					dates,
					holdingsForReconstruction,
					allTrades,
					dwData,
					candlePriceData.dailyPrices,
					currentJpyValueRounded,
					boundaries.nowIso,
					prices,
					flowPricing,
				);
			monthlyEquitySeries = equitySeriesOver(monthDates);
			yearlyEquitySeries = equitySeriesOver(yearDates);

			const cryptoAssetsInPortfolio = nonZeroAssets.filter((a) => a.asset !== 'jpy').map((a) => a.asset);
			equitySeriesFallbackAssets = equitySeriesFallbackAssetsOf(
				cryptoAssetsInPortfolio,
				new Set<number>([...monthDates.map((d) => d.valueOf()), ...yearDates.map((d) => d.valueOf())]),
				candlePriceData.dailyPrices,
			);
			equitySeriesQuality = equitySeriesQualityOf(cryptoAssetsInPortfolio.length, equitySeriesFallbackAssets.length);
		}

		const cryptoHoldings = holdings.filter((h) => h.asset !== 'jpy');
		const jpyHolding = holdings.find((h) => h.asset === 'jpy');

		const { validCostBasis, hasValidCostData, totalUnrealizedPnl, totalUnrealizedPnlPct } = summarizeUnrealized(
			cryptoHoldings,
			flowUnavailableReason,
		);

		const unpricedDepositLabel = assetCountLabel(unpricedDepositAssets);
		const qtyClampLabel = assetCountLabel(qtyClampAssets);
		const suppressedLabelOf = (reason?: PortfolioUnresolvedDepositReason): string =>
			assetCountLabel(suppressedRealizedAssets.filter((e) => reason == null || e.reason === reason));
		const suppressedRealizedLabel = suppressedLabelOf();

		const missingPriceAssets = cryptoHoldings
			.filter((h) => h.jpy_value == null && h.cost_basis != null)
			.map((h) => h.asset.toUpperCase());
		const hasMissingPrices = missingPriceAssets.length > 0;

		const holdingsPerformance = include_pnl
			? buildHoldingsPerformance(cryptoHoldings, prices, candlePriceData.boundaryPrices)
			: undefined;

		// ここから下は入出金分析セクションなので include_deposit_withdrawal で閉じる。損益計算側はこのフラグの影響を受けない。
		const { dwSummary, yearlyDWSummary, monthlyDWSummary, dwWarnings } = buildDWSection(
			include_deposit_withdrawal ? dwData : null,
			totalJpyValue,
			flowPricing,
			boundaries,
		);

		let technical: TechnicalSummary[] | undefined;
		if (include_technical && cryptoHoldings.length > 0) {
			const jpyPairs = cryptoHoldings.filter((h) => h.jpy_value != null).map((h) => h.pair);
			technical = await fetchTechnical(jpyPairs);
		}

		const lines: string[] = [];

		lines.push(
			...buildFetchStatusLines({
				marginFetchFailed,
				marginStatusFetchFailed,
				marginPositionsFetchFailed,
				marginStatus: marginAccountInfo.status,
				tradesTruncated,
				marginTradesTruncated,
			}),
		);

		lines.push(`ポートフォリオ分析: 暗号資産 ${cryptoHoldings.length}銘柄${jpyHolding ? ' + JPY' : ''}`);
		lines.push(`取得時刻: ${timestamp}`);
		if (totalJpyValue > 0) {
			lines.push(
				`口座合計: ${formatPrice(Math.round(totalJpyValue))}${jpyHolding ? ` (うち JPY: ${formatYenAmount(jpyHolding.jpy_value ?? 0)})` : ''}`,
			);
		}

		lines.push(
			...buildPerformanceSectionLines({
				dailyPerformance,
				yearlyPerformance,
				monthlyPerformance,
				flowUnavailableReason,
				monthlyEquitySeries,
				yearlyEquitySeries,
				equitySeriesQuality,
				equitySeriesFallbackAssets,
			}),
		);

		if (yearlyDWSummary) lines.push(periodDWLine('年初来', yearlyDWSummary));
		if (monthlyDWSummary) lines.push(periodDWLine('月初来', monthlyDWSummary));

		lines.push(
			...buildDWStatusLines({
				depositWithdrawalStatus,
				dwAllFailed: dwData?.allFailed,
				dwFetchedForPnl,
				flowUnavailableReason,
			}),
		);

		if (dwSummary) lines.push(...buildAccountReturnLines(dwSummary));

		if (dwWarnings.length > 0) {
			for (const w of dwWarnings) {
				lines.push(`  ${w}`);
			}
		}

		const marginPositionsBlock = buildMarginPositionsBlock(marginAccountInfo);
		if (marginPositionsBlock.length > 0) {
			lines.push(...marginPositionsBlock);
			lines.push('');
		}

		if (accountPnl != null) {
			lines.push(
				...buildAccountPnlLines({
					accountPnl,
					totalRealizedPnlUnavailableReason,
					heldRealizedPnl,
					closedPositionRealizedPnl,
					closedPositionAssetCount,
					hasPeriodAccountPnl: yearlyAccountPnl != null || monthlyAccountPnl != null,
				}),
			);
		}

		lines.push(
			...buildCostNoteLines({
				flowUnavailableReason,
				totalUnrealizedPnl,
				totalUnrealizedPnlPct,
				qtyMismatchAssets,
				depositOnlyDetected,
				unpricedDepositLabel,
				suppressedRealizedLabel,
				qtyClampLabel,
			}),
		);
		lines.push('');

		if (holdingsPerformance && holdingsPerformance.length > 0) {
			lines.push(...buildHoldingsPerformanceLines(holdingsPerformance));
		}

		if (hasMissingPrices) {
			lines.push('');
			lines.push(`注意: ${missingPriceAssets.join(', ')} の現在価格が取得できなかったため、評価損益から除外しています`);
		}

		if (technical && technical.length > 0) lines.push(...buildTechnicalLines(technical));

		const changePctSuppressed = suppressedChangePcts({
			daily: dailyPerformance,
			yearly: yearlyPerformance,
			monthly: monthlyPerformance,
		});
		const flowValuationFallbackCount = flowValuation?.current_price_fallback_count ?? 0;
		// フォールバック件数からは再実行で直るかが読めないので、上限・取得失敗の分は別枠で出す（#76）。
		const chunkTruncated = flowDatePrices.truncatedByChunkLimit;
		const chunkFailed = flowDatePrices.chunkFetchFailed;
		const calcWarnings = buildCalcWarnings({
			dailyPerformance,
			monthlyPerformance,
			yearlyPerformance,
			flowUnavailableReason,
			qtyMismatchAssets,
			depositOnlyDetected,
			tradesTruncated,
			unpricedDepositLabel,
			qtyClampLabel,
			cryptoHoldingCount: cryptoHoldings.length,
			changePctSuppressed,
			flowValuationFallbackCount,
			chunkTruncated,
			chunkFailed,
			suppressedLabelOf,
		});

		// 取得層の warning（上の ⚠️ 行）とは別行・別フィールドで先頭に出す。
		const summary = prependWarnings(lines.join('\n'), { warnings: calcWarnings }, { separator: '\n' });

		const fallbackPlaceholder = {
			total_jpy_deposited: 0,
			total_jpy_withdrawn: 0,
			net_jpy_invested: 0,
			crypto_deposit_count: 0,
			crypto_deposit_estimated_jpy: undefined,
			crypto_withdrawal_count: 0,
			crypto_withdrawal_estimated_jpy: undefined,
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
			total_cost_basis_unavailable_reason: flowUnavailableReason,
			total_realized_pnl:
				totalRealizedPnlUnavailableReason == null && totalRealizedPnl !== 0 ? totalRealizedPnl : undefined,
			closed_position_realized_pnl: closedPositionRealizedPnl,
			closed_position_asset_count: closedPositionAssetCount,
			closed_positions: closedPositions,
			daily_performance: dailyPerformance,
			yearly_performance: yearlyPerformance,
			monthly_performance: monthlyPerformance,
			monthly_equity_series: monthlyEquitySeries,
			yearly_equity_series: yearlyEquitySeries,
			yearly_realized_pnl: yearlyRealizedPnl
				? periodRealizedPnlForWire(yearlyRealizedPnl, yearlyRealizedPnlUnavailableReason)
				: undefined,
			monthly_realized_pnl: monthlyRealizedPnl
				? periodRealizedPnlForWire(monthlyRealizedPnl, monthlyRealizedPnlUnavailableReason)
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
			total_realized_pnl_unavailable_reason: totalRealizedPnlUnavailableReason,
		};

		const meta = {
			fetchedAt: timestamp,
			holdingCount: holdings.length,
			hasPnl,
			hasTechnical: include_technical && (technical?.length ?? 0) > 0,
			depositWithdrawalStatus,
			dwFetchedForPnl,
			periodBasis: 'jst' as const,
			tradesTruncated,
			marginTradesTruncated,
			marginFetchFailed,
			marginStatusFetchFailed,
			marginPositionsFetchFailed,
			equitySeriesQuality,
			equitySeriesFallbackAssets: equitySeriesFallbackAssets.length > 0 ? equitySeriesFallbackAssets : undefined,
			flowDataUnavailableReason: flowUnavailableReason,
			flowValuationBasis: flowValuation?.basis,
			flowValuationFallbackCount: flowValuationFallbackCount > 0 ? flowValuationFallbackCount : undefined,
			flowPriceChunkTruncatedDepositCount: chunkTruncated.deposits > 0 ? chunkTruncated.deposits : undefined,
			flowPriceChunkTruncatedWithdrawalCount: chunkTruncated.withdrawals > 0 ? chunkTruncated.withdrawals : undefined,
			flowPriceChunkFailedDepositCount: chunkFailed.deposits > 0 ? chunkFailed.deposits : undefined,
			flowPriceChunkFailedWithdrawalCount: chunkFailed.withdrawals > 0 ? chunkFailed.withdrawals : undefined,
			changePctUnavailablePeriods: changePctSuppressed.length > 0 ? changePctSuppressed.map((e) => e.key) : undefined,
			warnings: calcWarnings.length > 0 ? calcWarnings : undefined,
		};

		return AnalyzeMyPortfolioOutputSchema.parse(ok(summary, data, meta));
	} catch (err) {
		// PrivateApiError は分類済み文言を素通し、未知エラーは err.message を伏せて汎用文に置換する。
		return AnalyzeMyPortfolioOutputSchema.parse(
			failPrivateToolError(err, 'ポートフォリオ分析中に予期しないエラーが発生しました'),
		);
	}
}
