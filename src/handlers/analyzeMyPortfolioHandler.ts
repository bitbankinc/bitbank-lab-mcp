/**
 * analyzeMyPortfolioHandler — ポートフォリオ分析のメインハンドラ。
 *
 * データ取得・計算ロジックは以下のモジュールに分離:
 *   - portfolio/types.ts  — 型定義
 *   - portfolio/fetch.ts  — API データ取得レイヤー
 *   - portfolio/calc.ts   — 純粋計算ロジック
 */

import { normalizeAssetCodes } from '../../lib/asset-code.js';
import { dayjs, nowIso } from '../../lib/datetime.js';
import { formatPair, formatPercent, formatPrice, formatPriceJPY } from '../../lib/formatter.js';
import { fetchPairsSpec, type PairSpec, roundToPriceDigits } from '../../lib/pairs.js';
import { ok } from '../../lib/result.js';
import { prependWarnings } from '../../lib/warning-propagation.js';
import { getDefaultClient } from '../private/client.js';
import {
	AnalyzeMyPortfolioOutputSchema,
	type PortfolioChangePctUnavailableReason,
	type PortfolioCostBasisUnavailableReason,
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
	type PeriodSpec,
	type PortfolioPerformanceContext,
	qtyInvariantHolds,
	qtyInvariantTolerance,
	qtyMismatchReasonFor,
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
import type {
	AccountPnl,
	CandlePriceData,
	DepositWithdrawalSummary,
	EquityPoint,
	FlowPricing,
	FlowValuationBreakdown,
	MarginAccountInfo,
	PeriodAccountPnl,
	PeriodDWSummary,
	PeriodPerformance,
	PeriodRealizedPnl,
	PnlResult,
	RawAsset,
	RawMarginTrade,
	RawTrade,
	TechnicalSummary,
} from './portfolio/types.js';

/** status !== 'NORMAL' のときの警告文言（get_margin_status の WARNING_STATUSES 文言を踏襲） */
const MARGIN_STATUS_WARNINGS: Record<string, string> = {
	CALL: '⚠ 追証発生中（CALL）。期日までに追加保証金を入金するか建玉を決済してください',
	LOSSCUT: '⚠ 強制決済中（LOSSCUT）。保証金率が閾値を下回り、建玉が自動決済されています',
	DEBT: '⚠ 不足金発生中（DEBT）。速やかに入金してください',
	SETTLED: '⚠ 信用口座は精算済み（SETTLED）',
};

/** position_side -> 表示ラベル */
function positionSideLabel(side: string): string {
	return side === 'long' ? 'ロング' : side === 'short' ? 'ショート' : side;
}

/**
 * 建玉数量・評価額がともにゼロの行か（表示スキップの判定）。
 *
 * 実口座では過去に建てて決済し終えたペアがゼロ建玉として残り続ける。数値化できない値
 * （`Number()` が NaN になる想定外の応答）は「ゼロと断定できない」ので false を返し、
 * 表示に倒す（抑制の誤爆で実建玉を消さないため）。
 */
function isZeroMarginPosition(p: { open_amount: string; product: string }): boolean {
	return Number(p.open_amount) === 0 && Number(p.product) === 0;
}

/**
 * 信用建玉サマリを生成する。建玉なし時は空配列を返してハンドラ側で表示スキップ。
 *
 * ゼロ建玉（`open_amount == 0` かつ `product == 0`）は明細行に出さない。実口座では
 * 決済済みペアのゼロ建玉が 10 行前後居座り、実建玉が埋もれる（#53 症状 7）。
 * ただし**黙って消さず**、省略件数を集計行に併記する。
 *
 * 全建玉がゼロだった場合もセクション自体は出す（明細 0 行 + 集計行のみ）。ここで
 * セクションごと消すと省略件数の申告先が無くなり、「建玉なし」と区別できなくなるため。
 * `positions` が空（建玉そのものが無い）ときだけ空配列を返す。
 *
 * ロング / ショートの件数はゼロ建玉を除いた実建玉のみを数える（建玉が無いのに
 * 「ロング 10件」と出ると実エクスポージャの誤読になる）。
 */
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

	// 信用口座状態が取得できている場合、建玉含み損益（マージン口座全体集計）も併記する。
	// 個別建玉に unrealized_pnl フィールドが無いため API 値（margin_position_profit_loss）を採用。
	const status = info.status;
	if (status) {
		const pl = Number(status.margin_position_profit_loss);
		if (Number.isFinite(pl)) {
			const sign = pl >= 0 ? '+' : '';
			aggregateParts.push(`建玉含み損益: ${sign}${formatPriceJPY(pl)}`);
		}
	}
	lines.push(`  集計: ${aggregateParts.join(' / ')}`);
	return lines;
}

/**
 * 価格フィールド（`avg_buy_price` / `current_price`）の丸め方針。
 *
 * かつては両方を無条件に `Math.round` で整数化していたが、これは低価格ペアを壊す
 * （XLM: 実勢 26.686 → 27、29.59 → 30 で誤差 1.4%。建値ストップ判断で損益の符号が変わる）。
 * ペアごとの `price_digits`（最小値刻み = 10^-price_digits）を基準に丸める。
 *
 * - **`current_price`**: `price_digits` ちょうど。板に載る価格そのものなので刻みと一致させる。
 * - **`avg_buy_price`**: `price_digits + AVG_BUY_PRICE_EXTRA_DIGITS`。移動平均法の加重平均
 *   （cost_basis / 復元保有数量）であって板に発注できる価格ではないため、刻みに縛る理由が無い。
 *   刻みちょうどで丸めると `amount × avg_buy_price` と `cost_basis` の再構成誤差が刻み幅ぶん
 *   乗ってしまう（#53 の症状 1 が見ていた乖離を、丸めのほうから再導入することになる）。
 *   一方で素通しにすると 26.686000000000003 のような浮動小数ノイズが LLM に渡るため、
 *   桁の余裕を持たせたうえで丸める形にしている。
 * - **`/spot/pairs` を取得できない / 未知ペアのときは丸めない**（生値素通し）。
 *   整数丸めへのフォールバックは禁止 — それがこのバグそのものだから。
 * - 円建て金額（`jpy_value` / `cost_basis` / `unrealized_pnl` 等）の整数丸めは対象外。
 *   これらは JPY の最小単位が 1 円なので整数化が正しい。
 */
const AVG_BUY_PRICE_EXTRA_DIGITS = 2;

/** 暗号資産入出庫の JPY 換算方式の表示ラベル（summary 用）。 */
const FLOW_VALUATION_LABEL: Record<PortfolioFlowValuationBasis, string> = {
	deposit_date_price: '入出庫日の始値ベース',
	current_price_fallback: '現在価格での仮評価',
	mixed: '入出庫日の始値ベース + 一部は現在価格での仮評価',
};

/** 理由コードごとの「入出金履歴が使えない原因」を表す句（各文言の共通パーツ）。 */
const FLOW_UNAVAILABLE_CAUSE: Record<PortfolioFlowUnavailableReason, string> = {
	dw_fetch_failed: '入出金履歴の取得に失敗した',
	dw_history_incomplete: '入出金履歴を全件取得できなかった',
};

/** 理由コードごとの「なぜ取得原価を確定できないか」の説明文（summary / warning 共通）。 */
const FLOW_UNAVAILABLE_NOTE: Record<PortfolioFlowUnavailableReason, string> = {
	dw_fetch_failed:
		'入出金履歴の取得に失敗したため取得原価を確定できません（一部チャネルのみの失敗を含む）。時間をおいて再実行してください',
	dw_history_incomplete: '入出金履歴が多く全件取得できなかったため取得原価を確定できません（再実行しても解消しません）',
};

/**
 * 増減率を出さなかった理由コードごとの説明句（summary の注記行 / meta.warnings 共通）。
 *
 * 率が消えた理由を書かないと「率を取れなかった」のか「ゼロ %」なのか読み手に区別できない。
 * 閾値（現在評価額の 1%）は `MIN_START_VALUE_RATIO` が単一ソース。
 */
const CHANGE_PCT_UNAVAILABLE_NOTE: Record<PortfolioChangePctUnavailableReason, string> = {
	start_value_zero: '期初評価額が 0 で率を定義できないため',
	start_value_negligible: `期初評価額が現在評価額の ${MIN_START_VALUE_RATIO * 100}% 未満で、率が運用成績ではなく「期初がほぼ空だった」ことを表す数になるため`,
	start_boundary_unpriced:
		'期初の始値を解決できなかった暗号資産を評価に含められず期初評価額が過小になっているため。過小な分母では率が運用成績を表さない',
	current_value_unpriced:
		'現在価格を解決できなかった暗号資産の保有を現在評価額に含められず現在評価額が過小になっているため。分子が過小な率は運用成績ではなく価格取得の失敗を表す数になる',
};

/**
 * 理由コードごとの「増減額をどう読むか」（summary の注記行に足す短句）。
 *
 * 率を抑止した理由は 2 系統ある（#105）:
 *
 * - `start_value_zero` / `start_value_negligible` — 期初評価額が**本当に**小さい。分子
 *   （`change_jpy`）は正しいので、従来どおり増減額で読ませる。
 * - `start_boundary_unpriced` — 期初の始値が引けず暗号資産が期初評価から**脱落**している。
 *   分母を壊した欠損がそのまま分子の欠損なので、増減額も信用できない。ここで増減額へ
 *   誘導すると、率より壊れた数字を確定値として読ませることになる（#54 と同じ構造）。
 *   文言は `changeJpyGuidanceLine` / `changeJpyGuidanceWarning` がずれの向きで振り分ける。
 * - `current_value_unpriced` — 現在 ticker 価格が引けず保有が現在評価額から**脱落**している
 *   （#109。上の対称形で、こちらは分子が過小＝増減額が過小になる）。ticker は 1 回の取得で
 *   全銘柄ぶんを取るため、失敗すると現在評価額が JPY 残高だけに縮退し、増減額が
 *   「口座が消し飛んだ」ように見える巨額の偽損失になる。ここでも増減額へ誘導しない。
 *
 * 代替の読み方は**示さない**。資産推移シリーズ（`*_equity_series`）は同じ 1day candle の
 * 始値に依存し、引けなかった日付は現在価格にフォールバックするため、始値が欠けている
 * まさにその期間では値動きを表さない（`buildEquitySeries` の `fallbackPrices`）。
 * 壊れた代替へ誘導するくらいなら「算出できません」と言い切る。
 */
const CHANGE_JPY_GUIDANCE_LINE: Record<PortfolioChangePctUnavailableReason, string> = {
	start_value_zero: '増減額で読んでください',
	start_value_negligible: '増減額で読んでください',
	start_boundary_unpriced:
		'増減額（change_jpy / adjusted_change_jpy）も脱落した期初評価額の分だけ過大なので、成績として読まないでください。この期間の値動きはこの結果からは算出できません',
	current_value_unpriced:
		'増減額（change_jpy / adjusted_change_jpy）も脱落した現在評価額の分だけ過小なので、成績として読まないでください。この期間の値動きはこの結果からは算出できません',
};

/**
 * `start_boundary_unpriced` で**ずれの向きが確定しない**ときの短句（summary の注記行）。
 *
 * 現在評価額も価格を引けない保有を落としているため、期初・現在の両端から落ちる資産では
 * ずれが過大とも過小とも言えない（`unpriced_current_assets` が同時に立つ構成）。ここで「過大」と書くと、
 * 抑止したはずの確定値を文言のほうから出すことになる（CodeRabbit 指摘）。
 */
const CHANGE_JPY_DIRECTION_UNKNOWN_LINE =
	'増減額（change_jpy / adjusted_change_jpy）も同じ欠損の影響を受けており、現在評価額でも価格を引けない保有があるためずれの向きも確定できません。成績として読まないでください。この期間の値動きはこの結果からは算出できません';

/**
 * 理由コードごとの「増減額をどう読むか」（content 先頭の warning に足す文）。
 *
 * 分岐の理由は `CHANGE_JPY_GUIDANCE_LINE` と同じ。warning は LLM が最初に読む行なので、
 * `start_boundary_unpriced` では代替として資産推移シリーズを持ち出さないことまで明示する
 * （テキストだけ読む LLM は「じゃあ series を見よう」と動き、そこも現在価格代替で埋まっている）。
 */
const CHANGE_JPY_GUIDANCE_WARNING: Record<PortfolioChangePctUnavailableReason, string> = {
	start_value_zero: '増減額（change_jpy / adjusted_change_jpy）は出しているので成績はそちらで読むこと',
	start_value_negligible: '増減額（change_jpy / adjusted_change_jpy）は出しているので成績はそちらで読むこと',
	start_boundary_unpriced:
		'増減額（change_jpy / adjusted_change_jpy）も期初評価額から脱落した分だけ過大なので（change_jpy_overstated=true）、成績として読まないこと。該当期間の値動きはこの結果からは算出できません（資産推移シリーズも同じ日次価格に依存し、始値を引けなかった日付は現在価格で代替されるため代替になりません）',
	current_value_unpriced:
		'増減額（change_jpy / adjusted_change_jpy）も現在評価額から脱落した分だけ過小なので（change_jpy_understated=true）、成績として読まないこと。保有暗号資産が全て脱落している場合は現在評価額が JPY 残高だけに縮退しており、増減額は口座の損失ではなく価格取得の失敗を表す数です。該当期間の値動きはこの結果からは算出できません（資産推移シリーズも最終点に同じ現在評価額を使うため代替になりません）',
};

/** `start_boundary_unpriced` で向きが確定しないときの warning 文（`CHANGE_JPY_DIRECTION_UNKNOWN_LINE` と対） */
const CHANGE_JPY_DIRECTION_UNKNOWN_WARNING =
	'増減額（change_jpy / adjusted_change_jpy）も同じ欠損の影響を受けますが、現在評価額でも価格を解決できない保有があるためずれの向きは確定できません（change_jpy_overstated は付きません）。成績として読まないこと。該当期間の値動きはこの結果からは算出できません（資産推移シリーズも同じ日次価格に依存し、始値を引けなかった日付は現在価格で代替されるため代替になりません）';

/**
 * 増減額のずれの向き（`change_jpy_overstated` / `change_jpy_understated` の 3 状態を 1 値にしたもの）。
 *
 * 2 フラグは排他なので 3 値に畳める。誘導文の選択と warning のグルーピングで共有し、
 * 「フラグが立っていない ＝ 向きが確定しない」を型のうえで明示する。
 */
type ChangeJpyDirection = 'overstated' | 'understated' | 'unknown';

/** `ChangeJpyDirection` の全値（warning のグルーピングで回す。型から漏れると typecheck が落ちる）。 */
const CHANGE_JPY_DIRECTIONS: readonly ChangeJpyDirection[] = ['overstated', 'understated', 'unknown'];

/** 期間の申告フラグから向きを求める（`change_jpy_overstated` / `change_jpy_understated` の単一ソース）。 */
function changeJpyDirectionOf(p: PeriodPerformance | undefined): ChangeJpyDirection {
	if (p?.change_jpy_overstated) return 'overstated';
	if (p?.change_jpy_understated) return 'understated';
	return 'unknown';
}

/**
 * summary の注記行に足す「増減額をどう読むか」を選ぶ。
 *
 * `start_boundary_unpriced` だけ、ずれの向きが確定するか（`change_jpy_overstated`）で
 * 文言が変わる。`current_value_unpriced` は理由コードが選ばれている時点で期初側が欠けて
 * いない（＝向きは必ず「過小」で確定する）ので分岐しない。`start_value_*` は分子が正しいので
 * こちらも分岐しない。
 */
function changeJpyGuidanceLine(reason: PortfolioChangePctUnavailableReason, direction: ChangeJpyDirection): string {
	if (reason === 'start_boundary_unpriced' && direction !== 'overstated') return CHANGE_JPY_DIRECTION_UNKNOWN_LINE;
	return CHANGE_JPY_GUIDANCE_LINE[reason];
}

/** content 先頭の warning 用。分岐の条件は `changeJpyGuidanceLine` と同じ。 */
function changeJpyGuidanceWarning(reason: PortfolioChangePctUnavailableReason, direction: ChangeJpyDirection): string {
	if (reason === 'start_boundary_unpriced' && direction !== 'overstated') return CHANGE_JPY_DIRECTION_UNKNOWN_WARNING;
	return CHANGE_JPY_GUIDANCE_WARNING[reason];
}

/** 数量乖離の理由コードごとの原因表示（銘柄名に添える短句）。 */
const QTY_MISMATCH_CAUSE: Record<PortfolioQtyMismatchReason, string> = {
	has_crypto_deposits: '入庫日の価格を解決できない暗号資産の入庫あり',
	history_truncated: '約定履歴の打ち切り',
	unknown: '原因不明',
	reconstructed_qty_negative: '復元数量が負（API に現れない取得あり）',
	// #93: qtyMismatchReasonFor は現在この値しか返さないが、Record は enum 全体の網羅を
	// 要求するため unknown も残す（他の判定経路のために enum 自体には残っているため）。
	untracked_trade_suspected: '販売所取引など API に現れない取引の可能性',
};

/**
 * 入庫日価格を解決できなかった理由コードごとの警告文（#80）。
 *
 * 「なぜ取れなかったか」と「だから何を出していないか」を 1 文に閉じる。原価だけでなく
 * **実現損益まで確定値を出さない**のがこの抑止の眼目なので、対象フィールドを毎回列挙する。
 */
const UNRESOLVED_DEPOSIT_NOTE: Record<PortfolioUnresolvedDepositReason, string> = {
	deposit_price_fetch_failed:
		'入庫日を含む年足の取得に失敗したため取得原価に算入していません（上限による切り落としではなく取得失敗なので、取得の成否が実行ごとに変わり、同じ口座を同じ日に叩いても取得原価と実現損益が変わります）',
	deposit_price_chunk_truncated: `入庫日を含む年足の追加取得が上限（${MAX_DEPOSIT_FLOW_PRICE_YEAR_CHUNKS}組）に達したため取りに行けず、取得原価に算入していません（上限は決定的なので同じ入力なら同じ結果になりますが、上限に収まる構成に変われば再実行で値が変わります）`,
};

/**
 * 入庫の算入件数は 0 のときキーごと落とす（#77）。
 *
 * 入庫が 1 件も無い銘柄の出力を従来と JSON 一致させるため。`0` を出すと「数えたが 0」と
 * 「そもそも入庫が無い」が同じ表示になるうえ、入庫を持たない大多数の銘柄に無意味なキーが増える。
 */
function depositCountOrUndefined(count: number | undefined): number | undefined {
	return count != null && count > 0 ? count : undefined;
}

/**
 * 期間実現損益を wire 形に写す（#85）。
 *
 * 件数は全履歴・全銘柄なので canonical 名は `*_all_time`。旧名
 * `priced_deposit_count` / `unpriced_deposit_count` は同じ値を返す alias。
 * 両方とも 0 のときはキーごと落とす（`depositCountOrUndefined`）。
 *
 * `DEPRECATED_FIELD_REMOVAL_TARGET`（`src/schema/base.ts`）で alias を削除する際は、
 * ここの旧名 2 行とスキーマ・description をまとめて落とすこと。
 */
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

/**
 * 数量不変条件（`cost_basis_reliable`）の判定に入った 2 値を holdings 用に組み立てる（#87）。
 *
 * 判定結果だけを出していると、消費者は境界付近の妥当性を評価できず、API に現れない取引
 * （販売所での売買など）の存在も推定できない。**入力そのもの**を出して検算可能にする。
 *
 * - `reconstructed_qty` は**丸めない**。`amount_precision` で丸めると差が最大 0.5 quanta 動き、
 *   絶対項が 5 quanta しかない境界付近で消費者の再計算が判定と食い違う。
 * - 許容誤差は `amount_precision` から決まるが、その桁数は出力に無い。**値を出さないと
 *   消費者側で許容誤差を再現できない**ので `qty_invariant_tolerance` として同梱する。
 * - `reconstructed_qty` は 0 でもキーを落とさない（「復元したら 0 だった」は判定の入力そのもので、
 *   落とすと未計算と区別できない）。件数フィールドの 0 省略（`depositCountOrUndefined`）とは別方針。
 *
 * 原価計算をしていない銘柄（JPY / `include_pnl=false` ＝ `pnl == null`）では両方 undefined。
 * **原価を抑止した銘柄では出す**——抑止の妥当性こそ検算対象なので。
 */
function qtyInvariantInputsOf(
	pnl: PnlResult | undefined,
	onhandAmount: string,
	amountPrecision: number,
): {
	reconstructed_qty: number | undefined;
	qty_invariant_tolerance: number | undefined;
	qty_clamp_count: number | undefined;
	qty_clamp_absorbed_qty: number | undefined;
} {
	if (pnl == null) {
		return {
			reconstructed_qty: undefined,
			qty_invariant_tolerance: undefined,
			qty_clamp_count: undefined,
			qty_clamp_absorbed_qty: undefined,
		};
	}
	const onhand = Number(onhandAmount);
	const clamped = pnl.qty_clamp_count > 0;
	return {
		reconstructed_qty: Number.isFinite(pnl.reconstructed_qty) ? pnl.reconstructed_qty : undefined,
		// 実残高が数値にならない構成では許容誤差も NaN になる。出力スキーマ（z.number()）は
		// NaN を通さずレスポンス全体が parse error で落ちるため、値にならないものは出さない。
		qty_invariant_tolerance: Number.isFinite(onhand) ? qtyInvariantTolerance(onhand, amountPrecision) : undefined,
		// クランプ発火の申告（#89）。0 件は件数フィールドの慣例どおりキーごと落とす
		// （発火していない銘柄の出力を従来と JSON 一致させる）。吸収量は件数と対で意味を持つので
		// 同じ条件で出し入れする——件数 0 で吸収量 0 だけ出しても読み手には何の情報も無い。
		qty_clamp_count: clamped ? pnl.qty_clamp_count : undefined,
		qty_clamp_absorbed_qty: clamped ? pnl.qty_clamp_absorbed_qty : undefined,
	};
}

/**
 * 期間パフォーマンス 1 期間ぶんの summary 行を組み立てる。
 *
 * 純入出金が未計測（`flow_measured: false`）のときは調整後増減の行を出す代わりに
 * 「未計測」であることを明示する。ここで黙って行を省くと、テキストしか読まない LLM には
 * 「入出金調整が不要な口座」に見えてしまう。
 *
 * 増減率を抑止した期間（`change_pct_unavailable_reason` あり）でも同じ理由で、率を黙って
 * 落とさず**金額 + なぜ率が出ないか**を 1 行足す。率が消えた理由が分からないと
 * 「率を取れなかった」のか「ゼロ %」なのかを読み手が区別できない。注記は増減額の直後に置く
 * （`change_pct` と `adjusted_change_pct` は分母が同じで必ず同時に落ちるため 1 行で両方を説明する）。
 *
 * その注記に足す「増減額をどう読むか」は**理由コードで分岐する**（`CHANGE_JPY_GUIDANCE_LINE`）。
 * `start_boundary_unpriced` では分子（`change_jpy`）も同じ欠損で過大なので、増減額へ誘導しない。
 */
function buildPerformanceLines(label: string, p: PeriodPerformance): string[] {
	const lines: string[] = [];
	const sign = p.change_jpy >= 0 ? '+' : '';
	lines.push(`${label}: ${formatPriceJPY(p.start_value_jpy)} → ${formatPriceJPY(p.current_value_jpy)}`);
	lines.push(
		`  増減: ${sign}${formatPriceJPY(p.change_jpy)}${p.change_pct != null ? ` (${formatPercent(p.change_pct, { sign: true })})` : ''}`,
	);
	if (p.change_pct_unavailable_reason) {
		lines.push(
			`  ※ 増減率・入出金調整後増減率は非表示（${CHANGE_PCT_UNAVAILABLE_NOTE[p.change_pct_unavailable_reason]}）。${changeJpyGuidanceLine(p.change_pct_unavailable_reason, changeJpyDirectionOf(p))}`,
		);
	}
	if (p.unpriced_start_assets && p.unpriced_start_assets.length > 0) {
		// 「脱落分 = 増減額の過大分」と言えるのは、その資産が現在評価額には載っている場合だけ
		// （両端から落ちる資産があると向きが決まらない）。確定するときだけ向きを書く。
		const overstatedNote = p.change_jpy_overstated ? '（脱落した分がそのまま上の増減額の過大分です）' : '';
		lines.push(
			`  ※ 上の期初評価額は過小: ${p.unpriced_start_assets.map((a) => a.toUpperCase()).join(', ')} の始値を解決できず含めていません${overstatedNote}`,
		);
	}
	if (p.unpriced_current_assets && p.unpriced_current_assets.length > 0) {
		// 期初側（上）の対称形（#109）。向きが確定するのは期初評価額から何も落ちていないときだけ。
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
			`  入出金調整後: ${adjSign}${formatPriceJPY(p.adjusted_change_jpy)}${p.adjusted_change_pct != null ? ` (${formatPercent(p.adjusted_change_pct, { sign: true })})` : ''}`,
		);
		const flowSign = p.net_flow_jpy >= 0 ? '+' : '';
		lines.push(`  純入出金（元本）: ${flowSign}${formatPriceJPY(p.net_flow_jpy)}`);
		if (p.withdrawal_fee_jpy > 0) {
			lines.push(`  出金手数料: -${formatPriceJPY(p.withdrawal_fee_jpy)}`);
		}
	}
	return lines;
}

/**
 * 資産推移シリーズの見出しに足すマーカーの読み方。
 *
 * グラフ化されると注記行は消える前提で `flow_jpy` をデータとして返しているが、
 * summary を読むだけの経路（LLM が本文から所感を書く）では「線が跳ねた ＝ 運用成績」の
 * 誤読が残る。フロー発生点があるときだけ読み方を添える（#53 の症状 7 後半）。
 */
const EQUITY_FLOW_MARKER_NOTE =
	'「← 純入出金」が付いた点は外部からの入出金が発生した点で、その点から次の点への増減に金額が含まれる。運用成績ではないのでグラフではマーカーとして扱い、線の変動として説明しない';

/**
 * 資産推移シリーズの見出し行 + 各点の行を組み立てる。
 *
 * `headingBase` は末尾のコロンを含めない（フロー発生点があるときだけ
 * `EQUITY_FLOW_MARKER_NOTE` を挟んでからコロンを付けるため）。フロー発生点が 1 つも
 * 無いシリーズでは注記もマーカーも出さず、従来と同じ行になる。
 */
function buildEquitySeriesLines(headingBase: string, series: EquityPoint[]): string[] {
	const hasFlow = series.some((p) => p.flow_jpy != null);
	const lines = [hasFlow ? `${headingBase}。${EQUITY_FLOW_MARKER_NOTE}:` : `${headingBase}:`];
	for (let i = 0; i < series.length; i++) {
		const p = series[i];
		// 符号の出し方は buildPerformanceLines の純入出金行と揃える（負値は formatPriceJPY が符号を持つ）。
		const marker = p.flow_jpy != null ? ` ← 純入出金 ${p.flow_jpy >= 0 ? '+' : ''}${formatPriceJPY(p.flow_jpy)}` : '';
		const label = i === series.length - 1 ? '（現在）' : '';
		lines.push(`  ${p.timestamp}: ${formatPriceJPY(p.value_jpy)}${marker}${label}`);
	}
	return lines;
}

export default async function analyzeMyPortfolioHandler(args: {
	include_technical?: boolean;
	include_pnl?: boolean;
	include_deposit_withdrawal?: boolean;
}) {
	const { include_technical = true, include_pnl = true, include_deposit_withdrawal = true } = args;
	const client = getDefaultClient();

	try {
		// 1. 保有資産 + ticker + ペア仕様を並列取得
		// ペア仕様は価格フィールドの丸め桁（price_digits）にだけ使う。1 時間キャッシュ済みの
		// 単発 GET なので、ここに載せればレイテンシは実質増えない。
		// 取得失敗は握り潰して null にする（丸め桁が分からないだけで分析自体は成立する。
		// null のときは丸めずに生値を出す — AVG_BUY_PRICE_EXTRA_DIGITS の doc 参照）。
		const [rawAssets, prices, pairsSpec] = await Promise.all([
			client.get<{ assets: RawAsset[] }>('/v1/user/assets'),
			fetchTickerPrices(),
			fetchPairsSpec().catch(() => null),
		]);

		// 取得境界での asset 正規化。以降は holdings の Map キー・`${asset}_jpy` の組み立て・
		// `prices.get(asset)` がすべて小文字前提で走る（`lib/asset-code.ts` 参照）。
		// 大文字が混ざると BTC / btc で保有キーが割れて二重計上になるため、ここで揃える。
		const assets = normalizeAssetCodes(rawAssets.assets);

		// ゼロでない資産（JPY 含む）
		const nonZeroAssets = assets.filter((a) => {
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

		// 入出金履歴は「入出金分析セクションを出すか」ではなく「損益計算に要るか」で取得する。
		// 取得原価（移動平均法）は暗号資産出庫を原価の按分減少として処理し、期初評価額と
		// 資産推移シリーズは入出金の巻き戻しを前提にしているため、include_pnl=true の時点で
		// 入出金履歴は必須の入力になる。include_deposit_withdrawal は表示セクションのみ制御する。
		// 追加の API 呼び出し（最大 4 チャネル × ページネーション）は下の Promise.all に載せて
		// 約定履歴・信用約定・信用口座情報と並列に走らせ、レイテンシ増を最小化する。
		const dwPromise =
			include_pnl || include_deposit_withdrawal ? fetchDepositWithdrawal(client) : Promise.resolve(null);

		// 信用口座状態・建玉サマリも並列取得（取得失敗時は warning として summary に反映）。
		// 信用約定 fetch とは独立してフェイルする可能性があるため別フラグで管理する。
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

		// 入出金分析セクションの状態（表示側の契約）。include_deposit_withdrawal=false なら
		// 履歴を取得済みでも not_requested になる——セクションを出さないという意味だから。
		const depositWithdrawalStatus = resolveDepositWithdrawalStatus(include_deposit_withdrawal, dwData);
		// 入出金履歴を損益計算に供給できたか（計算側の状態）。表示フラグとは独立で、
		// 「取得を試みて成功したか」だけを見る。部分失敗・打ち切りでも true になるので、
		// 取得原価を信頼してよいかは flowUnavailableReason 側で判定する。
		const dwFetchedForPnl = include_pnl && dwData != null && !dwData.allFailed;
		// 取得原価（移動平均法）は暗号資産出庫を原価の按分減少として扱うため、出庫履歴が
		// 欠けると出庫済み数量の原価が残留して cost_basis が過大化し、評価損益が壊れる。
		// そこで holdings のマッピングより前に理由コードを確定し、信頼できない値は出さない。
		// include_pnl=false なら損益・期間パフォーマンス自体を出さないので抑止対象が無い。
		const flowUnavailableReason: PortfolioFlowUnavailableReason | undefined = include_pnl
			? flowUnavailableReasonFor(dwData)
			: undefined;

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

		// 2.5. 暗号資産入出庫の JPY 換算に使う価格を確定する。
		// 入出庫日（入庫: confirmed_at / 出庫: requested_at）の 1day open を第一候補にし、
		// 直近 400 日窓（fetchCandlePriceData）で解けない分だけ年単位 chunk を追加取得する。
		// 現在価格で仮評価すると誤差が相場と連動して動く系統的バイアスになるため（#53 の機序 6）。
		//
		// 消費者は 3 つ:
		//   (1) 入出金分析セクション（純投入額・口座全体リターン）
		//   (2) 期間ネットフロー（*_performance.net_flow_jpy）
		//   (3) 取得原価（calcPnl / calcPeriodRealizedPnl の入庫算入）
		// (3) が入ったため、この確定はセクション 3 の損益算出**より前**に済ませる必要がある。
		// candlePricePromise の await をここまで引き上げても、間に挟まる処理は同期計算だけなので
		// 待ち時間は増えない（in-flight の promise を待つ位置が早まるだけ）。
		//
		// 追加取得の母集合は「換算結果を実際に出力するセクションがある入出庫」だけに絞る。
		// 入庫と出庫で消費者が非対称なので、下限時刻も別々に決める:
		//   - 入庫: 純投入額・口座全体リターンに加えて取得原価が**全履歴**を換算する
		//     （移動平均法は期間開始前の入庫も積み上げる）
		//   - 出庫: 入出金分析セクションがある構成では calcDepositWithdrawalSummary が
		//     **全履歴**を換算して純投入額から減算する（元本回収として扱う。#70）。
		//     セクションを閉じた構成では消費者が期間集計（期間ネットフロー）だけになるので
		//     年初来（yearly が最広の期間）で足りる
		// どの消費者もいない構成では価格解決そのものを行わない。走らせてしまうと、
		// (1) 出力に現れない換算のために candle 取得のレイテンシを払い、
		// (2) meta / summary が「どの出力にも載っていない評価額」を申告して読み手を迷わせる。
		// 具体例: include_deposit_withdrawal=false（セクションを閉じる）＋ 入出金履歴の部分失敗で
		// buildPeriodPerformance が未計測に短絡し、取得原価も抑止されるケース。
		const candlePriceData = await candlePricePromise;
		// 部分失敗・打ち切りでも dwSummary は出るので、セクション側の消費判定に
		// flowUnavailableReason は使わない（原価が信頼できないことと、入出金サマリーを
		// 出せることは別問題 — flowUnavailableReasonFor の doc 参照）。
		const dwSectionUsesFlow = include_deposit_withdrawal && dwData != null && !dwData.allFailed;
		// 純入出金・取得原価は flowUnavailableReason があるとどちらも抑止される
		// （buildPeriodPerformance は unmeasuredNetFlow() に短絡し、holdings は原価由来 4
		// フィールドを落とす）。その時点で消費者ではなくなる。
		const pnlUsesFlow = include_pnl && flowUnavailableReason == null;
		const flowValuationTargets =
			dwSectionUsesFlow || pnlUsesFlow
				? collectFlowValuationTargets(dwData, {
						// 入庫は全履歴。dwSectionUsesFlow / pnlUsesFlow のどちらの経路でも
						// 全履歴を要求するので、ここで年初来に絞れる構成は無い。
						depositsSinceMs: undefined,
						// 出庫は入出金分析セクションがあるときだけ全履歴（純投入額の減算に使う）。
						// 無ければ消費者は期間ネットフローだけなので年初来に絞る。
						withdrawalsSinceMs: dwSectionUsesFlow ? undefined : boundaries.yearStartMs,
					})
				: [];
		// 年 chunk の予算は入庫用・出庫用に分かれている（#76）。出庫が何件増えても入庫の
		// 取得結果は変わらないので、取得原価と実現損益は実行タイミングに依存しない。
		// 取り切れなかった分は種類別に返るので、下の警告で「上限で切った」と「本当に取れない」を
		// 区別して申告する。
		const flowDatePrices = await fetchFlowDatePrices(candlePriceData.dailyPrices, flowValuationTargets);
		const flowPricing: FlowPricing = {
			dailyPrices: flowDatePrices.dailyPrices,
			currentPrices: prices,
		};
		// 換算方式の申告は母集合を 1 度だけ数える。各セクションの内訳（全履歴 ⊃ 年初来 ⊃ 月初来）を
		// 足すと二重計上になるため、meta / summary の件数はここで確定した値を使う。
		const flowValuation = summarizeFlowValuation(flowValuationTargets, flowPricing);
		// 取得原価への入庫算入に渡す入力。入庫日の始値を解決できた入庫だけが原価になり、
		// 現在価格フォールバックしかない入庫は算入されない（calcPnl の doc 参照）。
		// pnlUsesFlow が false の構成では原価由来フィールド自体を出さないので渡さない。
		const depositCost: DepositCostBasisInput | undefined =
			pnlUsesFlow && dwData != null ? { deposits: dwData.deposits, pricing: flowPricing } : undefined;

		const timestamp = nowIso();

		// 3. 各保有通貨の損益算出
		let totalJpyValue = 0;
		let _totalCostBasis = 0;
		let totalRealizedPnl = 0;

		// 数量不変条件で乖離を検出した銘柄（summary の警告行と合計からの除外に使う）
		const qtyMismatchAssets: Array<{ asset: string; reason: PortfolioQtyMismatchReason }> = [];

		// 原価に算入できなかった入庫があるのに、確定値を出している銘柄（#77）。
		// 数量乖離で抑止した銘柄はここに入れない——あちらは値そのものを出しておらず
		// `has_crypto_deposits` の警告行で申告済みなので、二重に警告すると読み手が
		// 「抑止されたのか出ているのか」を取り違える。売り切り銘柄も後段の集計ループで足す
		// （holdings に載らないが realized_pnl は total に入るため、算出条件の申告が要る）。
		const unpricedDepositAssets: Array<{ asset: string; count: number }> = [];

		// 売りの原価按分がゼロ床でクランプされた銘柄（#89）。リプレイ上の保有を超える売りが
		// あったということで、その銘柄の realized_pnl は原価ゼロで按分した売却を含む。
		// 保有銘柄は holdings[].qty_clamp_count にも出るが、**売り切り銘柄は holdings に載らない**ので
		// 警告行が唯一の申告経路になる（#77 の unpricedDepositAssets と同じ事情）。
		const qtyClampAssets: Array<{ asset: string; count: number }> = [];

		// 入庫はあるが約定履歴にも現在残高にも現れない銘柄（#93）。closed_positions への
		// 反映とは別に、警告行でも申告するため銘柄名だけ別途保持する。
		let depositOnlyDetected: string[] = [];

		// 入庫日価格を「取りに行けば解決できたはず」なのに解決できなかった銘柄（#80）。
		// pnlUsesFlow が false の構成では入庫を原価に算入しておらず（depositCost を渡さない）、
		// 原価由来フィールドは flowUnavailableReason で既に抑止されているので判定しない。
		const unresolvedDepositReasons = pnlUsesFlow
			? unresolvedDepositReasonsByAsset(
					flowDatePrices.truncatedByChunkLimit.depositsByAsset,
					flowDatePrices.chunkFetchFailed.depositsByAsset,
				)
			: new Map<string, PortfolioUnresolvedDepositReason>();
		// 上のうち、実際に出力を抑止した銘柄（保有銘柄と売り切り銘柄の両方が入る）。入庫があっても
		// 保有も約定も無い銘柄は損益のどこにも現れないので抑止対象にならない。
		const suppressedRealizedAssets: Array<{
			asset: string;
			count: number;
			reason: PortfolioUnresolvedDepositReason;
		}> = [];
		/** 当該銘柄の未算入入庫のうち「取りに行けば解決できたはず」の件数（警告に出す件数の単一ソース） */
		const unresolvedDepositCountOf = (asset: string): number =>
			(flowDatePrices.chunkFetchFailed.depositsByAsset.get(asset) ?? 0) +
			(flowDatePrices.truncatedByChunkLimit.depositsByAsset.get(asset) ?? 0);

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
					cost_basis_unavailable_reason: undefined,
					cost_basis_reliable: undefined,
					priced_deposit_count: undefined,
					unpriced_deposit_count: undefined,
					// JPY は calcPnl を呼んでいない（復元数量という概念が無い）のでまとめて省く。
					reconstructed_qty: undefined,
					qty_invariant_tolerance: undefined,
					qty_clamp_count: undefined,
					qty_clamp_absorbed_qty: undefined,
				};
			}

			const pair = `${a.asset}_jpy`;
			// 価格フィールドの丸め桁。/spot/pairs を取得できなかった / 未知ペアなら undefined で、
			// roundToPriceDigits はその場合に生値を素通しする（AVG_BUY_PRICE_EXTRA_DIGITS の doc 参照）。
			const pairSpec: PairSpec | undefined = pairsSpec?.get(pair);
			// 現在価格は板の刻み（price_digits）ちょうどで丸める。以降の 3 経路（原価抑止 /
			// 数量乖離 / 通常）で同じ値を使う。
			const roundedCurrentPrice = roundToPriceDigits(currentPrice, pairSpec);
			const pnl = include_pnl ? calcPnl(allTrades, a.asset, dwData?.withdrawals, depositCost) : undefined;

			if (pnl?.cost_basis != null) {
				_totalCostBasis += pnl.cost_basis;
			}
			// 入庫日価格の取得失敗・打ち切りで抑止する銘柄は、その realized_pnl 自体が
			// 実行ごとに変わりうる値なので合計にも積まない（下の分岐で undefined を返す）。
			const unresolvedDepositReason = unresolvedDepositReasons.get(a.asset);
			if (pnl && unresolvedDepositReason == null) {
				totalRealizedPnl += pnl.realized_pnl;
			}
			// クランプ発火の申告（#89）。**`unresolvedDepositReason` が付く銘柄では集めない**——
			// その経路は realized_pnl 自体を undefined で返す（下の分岐）ので、「realized_pnl が
			// 過大側にずれている」という警告文が、出してもいない値を指すことになり誤導する。
			// 銘柄別の件数は他の 3 経路すべてで `qtyInvariantInputsOf` が載せるが、警告行にも
			// 出さないとテキストしか読まない LLM が realized_pnl の過大寄りに気づけない。
			if (pnl != null && unresolvedDepositReason == null && pnl.qty_clamp_count > 0) {
				qtyClampAssets.push({ asset: a.asset, count: pnl.qty_clamp_count });
			}

			// 入出金履歴が無いときの取得原価は過大な値になる。avg_buy_price 単体は出庫に対して
			// 不変だが、amount × avg_buy_price で原価を再構成されると同じ誤りに戻るため、
			// 原価から派生する 4 フィールドをまとめて出さず理由コードだけを返す。
			if (flowUnavailableReason != null) {
				return {
					asset: a.asset,
					pair,
					amount,
					avg_buy_price: undefined,
					current_price: roundedCurrentPrice,
					jpy_value: jpyValue != null ? Math.round(jpyValue) : undefined,
					cost_basis: undefined,
					unrealized_pnl: undefined,
					unrealized_pnl_pct: undefined,
					realized_pnl: pnl?.realized_pnl,
					trade_count: pnl?.trade_count,
					cost_basis_unavailable_reason: flowUnavailableReason,
					cost_basis_reliable: false,
					// この経路では depositCost を渡していない（pnlUsesFlow=false）ので両件数とも 0 になる。
					// 「入庫を数えたうえで 0 件だった」ではなく「入庫の原価算入を行っていない」なので、
					// 0 を出さずキーごと落とす（理由は cost_basis_unavailable_reason が表す）。
					priced_deposit_count: depositCountOrUndefined(pnl?.priced_deposit_count),
					unpriced_deposit_count: depositCountOrUndefined(pnl?.unpriced_deposit_count),
					// 数量不変条件を評価する**前**に抑止した経路。それでも復元数量は出す——
					// 入出金履歴が欠けたリプレイの結果であることは cost_basis_unavailable_reason で
					// 読めるので、「どれだけ乖離しているか」を消費者から隠す理由が無い（#87）。
					...qtyInvariantInputsOf(pnl, amount, a.amount_precision),
				};
			}

			// 入庫日価格を取りに行けなかった / 取得に失敗した銘柄（#80）。原価由来 4 フィールドに
			// 加えて **realized_pnl も確定値として出さない**——移動平均法では入庫 1 件の欠落が
			// 過去の売却の按分原価を丸ごと変えるので、実現損益まで実行ごとに動く。
			// 数量不変条件より先に判定する: 両方成立する構成では抑止が広いこちらを載せないと
			// realized_pnl が漏れる（has_crypto_deposits は realized_pnl を出す経路）。
			if (pnl != null && unresolvedDepositReason != null) {
				suppressedRealizedAssets.push({
					asset: a.asset,
					count: unresolvedDepositCountOf(a.asset),
					reason: unresolvedDepositReason,
				});
				return {
					asset: a.asset,
					pair,
					amount,
					avg_buy_price: undefined,
					current_price: roundedCurrentPrice,
					jpy_value: jpyValue != null ? Math.round(jpyValue) : undefined,
					cost_basis: undefined,
					unrealized_pnl: undefined,
					unrealized_pnl_pct: undefined,
					realized_pnl: undefined,
					// 約定件数は原価に依存しないのでそのまま出す（何件の約定を見た結果かが読める）。
					trade_count: pnl.trade_count,
					cost_basis_unavailable_reason: unresolvedDepositReason,
					cost_basis_reliable: false,
					// 件数は抑止の根拠そのものなので落とさない。
					priced_deposit_count: depositCountOrUndefined(pnl.priced_deposit_count),
					unpriced_deposit_count: depositCountOrUndefined(pnl.unpriced_deposit_count),
					// 復元数量も同じ理由で出す。こちらも数量不変条件より先に抑止しているので、
					// 検算すると許容誤差内なのに cost_basis_reliable=false という組み合わせが出る（#87）。
					...qtyInvariantInputsOf(pnl, amount, a.amount_precision),
				};
			}

			// 数量不変条件: 復元数量が実残高と許容誤差を超えて乖離していたら、原価から派生する
			// 4 フィールドは確定値を出さず（上と同じ null 化経路）、理由コードだけ返す。
			if (pnl != null && !qtyInvariantHolds(Number(amount), pnl.reconstructed_qty, a.amount_precision)) {
				const reason = qtyMismatchReasonFor(dwData, tradesTruncated, pnl.unpriced_deposit_count, pnl.reconstructed_qty);
				qtyMismatchAssets.push({ asset: a.asset, reason });
				return {
					asset: a.asset,
					pair,
					amount,
					avg_buy_price: undefined,
					current_price: roundedCurrentPrice,
					jpy_value: jpyValue != null ? Math.round(jpyValue) : undefined,
					cost_basis: undefined,
					unrealized_pnl: undefined,
					unrealized_pnl_pct: undefined,
					realized_pnl: pnl.realized_pnl,
					trade_count: pnl.trade_count,
					cost_basis_unavailable_reason: reason,
					cost_basis_reliable: false,
					priced_deposit_count: depositCountOrUndefined(pnl.priced_deposit_count),
					unpriced_deposit_count: depositCountOrUndefined(pnl.unpriced_deposit_count),
					// この経路こそ復元数量が要る。理由コードだけでは「どれだけ乖離したのか」が
					// 読めず、抑止が妥当だったかを消費者が判断できない（#87）。
					...qtyInvariantInputsOf(pnl, amount, a.amount_precision),
				};
			}

			const unrealizedPnl =
				jpyValue != null && pnl?.cost_basis != null ? Math.round(jpyValue - pnl.cost_basis) : undefined;
			const unrealizedPnlPct =
				unrealizedPnl != null && pnl?.cost_basis != null && pnl.cost_basis > 0
					? Math.round((unrealizedPnl / pnl.cost_basis) * 10000) / 100
					: undefined;

			// 確定値を出す経路。未算入の入庫があってもここを通る（数量乖離が許容誤差に収まった
			// ケース）ので、cost_basis_reliable=true と unpriced_deposit_count>0 は同時に立つ。
			if (pnl != null && pnl.unpriced_deposit_count > 0) {
				unpricedDepositAssets.push({ asset: a.asset, count: pnl.unpriced_deposit_count });
			}

			return {
				asset: a.asset,
				pair,
				amount,
				// 平均取得単価は板の刻みに縛られないので桁の余裕を足して丸める
				avg_buy_price: roundToPriceDigits(pnl?.avg_buy_price, pairSpec, {
					extraDigits: AVG_BUY_PRICE_EXTRA_DIGITS,
				}),
				current_price: roundedCurrentPrice,
				jpy_value: jpyValue != null ? Math.round(jpyValue) : undefined,
				cost_basis: pnl?.cost_basis != null ? Math.round(pnl.cost_basis) : undefined,
				unrealized_pnl: unrealizedPnl,
				unrealized_pnl_pct: unrealizedPnlPct,
				realized_pnl: pnl?.realized_pnl,
				trade_count: pnl?.trade_count,
				cost_basis_unavailable_reason: undefined,
				cost_basis_reliable: pnl != null ? true : undefined,
				priced_deposit_count: depositCountOrUndefined(pnl?.priced_deposit_count),
				unpriced_deposit_count: depositCountOrUndefined(pnl?.unpriced_deposit_count),
				// cost_basis_reliable=true の根拠。差がゼロでない（＝原価が入庫や販売所の売買を
				// 取り込めていない）ことは、この値と amount の引き算でしか読めない（#87）。
				...qtyInvariantInputsOf(pnl, amount, a.amount_precision),
			};
		});

		// ここまでの totalRealizedPnl は holdings[] に載る銘柄ぶんだけ。下の売り切り集計を足す前に
		// 退避しておき、summary の内訳行はこの値を使う（spot_realized_pnl - closed の引き算で
		// 出すと浮動小数の残差が表示に乗るため）。
		const heldRealizedPnl = totalRealizedPnl;

		// 売り切り銘柄の実現損益を集計（現在保有ゼロだが約定履歴がある通貨）。
		// undefined = 集計自体を行っていない（include_pnl=false / 約定履歴なし）で、0 =「売り切りは
		// あったが実現損益ゼロ / 売り切り銘柄なし」と区別する。
		let closedPositionRealizedPnl: number | undefined;
		let closedPositionAssetCount: number | undefined;
		// 銘柄別の内訳（#92）+ 入庫はあるが約定履歴にも現在残高にも現れない銘柄の検出結果（#93）。
		// 前者はループ内で元々銘柄ごとに算出済みだったが、closedSum に畳む時点で捨てられていたため、
		// 合計値の変化がどの銘柄由来か出力から特定できなかった。undefined の条件は
		// closedPositionRealizedPnl と同一（集計していない / 抑止）——本配列は既存 2 フィールドが
		// 従う「部分和を出さない」方針をそのまま引き継ぐ、値の分解にすぎない。
		// 後者（realized_pnl_unavailable_reason 付き要素）はこの抑止と独立に動く（下のブロック参照）。
		let closedPositions:
			| Array<{
					asset: string;
					realized_pnl: number | undefined;
					priced_deposit_count: number | undefined;
					unpriced_deposit_count: number | undefined;
					realized_pnl_unavailable_reason: PortfolioCostBasisUnavailableReason | undefined;
			  }>
			| undefined;
		// held / traded は #93 の検出（closedSuppressed や約定 0 件と無関係に動く）でも使うため、
		// include_pnl の外側で一度だけ計算する。
		const heldAssets = new Set(nonZeroAssets.map((a) => a.asset));
		const tradedAssets = new Set(allTrades.map((t) => t.pair.replace('_jpy', '')).filter((a) => a !== 'jpy'));
		if (include_pnl && allTrades.length > 0) {
			let closedSum = 0;
			let closedCount = 0;
			// 売り切り銘柄側で抑止が起きたか。1 銘柄でも抑止したら closed 系は部分和になるので
			// 確定値を出さない（下で undefined に畳む）。
			let closedSuppressed = false;
			const closedBreakdown: NonNullable<typeof closedPositions> = [];
			for (const asset of tradedAssets) {
				if (!heldAssets.has(asset)) {
					const pnl = calcPnl(allTrades, asset, dwData?.withdrawals, depositCost);
					// 入庫日価格を解決できなかった銘柄（#80）は holdings に載らないので抑止する
					// フィールドが無いが、closed / total には確実に効く。ここで合計に積むのをやめ、
					// 下で closed 系・total 系を undefined にする。
					const unresolvedDepositReason = unresolvedDepositReasons.get(asset);
					if (unresolvedDepositReason != null) {
						suppressedRealizedAssets.push({
							asset,
							count: unresolvedDepositCountOf(asset),
							reason: unresolvedDepositReason,
						});
						closedSuppressed = true;
						continue;
					}
					// 売り切り銘柄は holdings に載らず件数フィールドの置き場が無いので、警告行が
					// 算出条件を伝える唯一の経路になる（#77）。**金額の集計条件とは切り離す**——
					// realized_pnl は Math.round 済みで、未算入入庫があるからこそ 0 円に丸まる
					// ケース（本来の原価を引けていれば非ゼロ）まで申告が消えるため。
					if (pnl.unpriced_deposit_count > 0) {
						unpricedDepositAssets.push({ asset, count: pnl.unpriced_deposit_count });
					}
					// 売り切り銘柄は holdings に載らないので、クランプ発火も警告行でしか申告できない（#89）
					if (pnl.qty_clamp_count > 0) {
						qtyClampAssets.push({ asset, count: pnl.qty_clamp_count });
					}
					// realized_pnl が 0 の銘柄も内訳には含める（#92）。closedCount は寄与のあった
					// 銘柄しか数えないため、ある銘柄が非ゼロ→ゼロに、別の銘柄がゼロ→非ゼロに同時に
					// 入れ替わると件数の変化が相殺されて見えなくなる（本 issue の発端そのもの）。
					// 0 を足しても合計は変わらないので、Σ closed_positions[].realized_pnl = closedSum
					// は 0 円銘柄の有無に関わらず成立する。
					closedBreakdown.push({
						asset,
						realized_pnl: pnl.realized_pnl,
						priced_deposit_count: depositCountOrUndefined(pnl.priced_deposit_count),
						unpriced_deposit_count: depositCountOrUndefined(pnl.unpriced_deposit_count),
						realized_pnl_unavailable_reason: undefined,
					});
					if (pnl.realized_pnl !== 0) {
						totalRealizedPnl += pnl.realized_pnl;
						closedSum += pnl.realized_pnl;
						closedCount++;
					}
				}
			}
			closedPositionRealizedPnl = closedSuppressed ? undefined : closedSum;
			closedPositionAssetCount = closedSuppressed ? undefined : closedCount;
			// 抑止時は内訳も undefined にする（部分和を出さない既存方針と揃える）。抑止されなかった
			// 銘柄だけの部分配列を出すと、合計は undefined なのに内訳の合計だけは計算できてしまい、
			// 部分和を「本当の合計」と誤認させる。並び順は realized_pnl 降順・同値は asset 昇順で決定的。
			closedPositions = closedSuppressed
				? undefined
				: closedBreakdown.sort(
						(x, y) => (y.realized_pnl ?? 0) - (x.realized_pnl ?? 0) || x.asset.localeCompare(y.asset),
					);
		}

		// 入庫はあるが約定履歴にも現在残高にも現れない銘柄の検出（#93 仕様 1）。上のループは
		// tradedAssets を起点にするため、可視の約定が 1 件も無い銘柄はそもそも対象にならない。
		// closedSuppressed（他の売り切り銘柄の入庫日価格解決失敗）とは無関係に動く——検出結果は
		// realized_pnl を持たず合計に寄与しないため、他銘柄の抑止に道連れにする理由が無い。
		if (include_pnl) {
			// depositOnlyAssets の除外判定は dw.withdrawals の完全性に依存する（DONE 出庫が
			// 1 件でもあれば除外する設計のため、出庫を 1 件でも見落とすと除外できず誤検出になる）。
			// flowUnavailableReason（dw 取得の全体的な失敗・打ち切り）が立っている実行では
			// 除外判定そのものが信頼できないため、検出自体を行わない（CodeRabbit review, PR #95）。
			depositOnlyDetected = flowUnavailableReason == null ? depositOnlyAssets(dwData, heldAssets, tradedAssets) : [];
			if (depositOnlyDetected.length > 0) {
				// 約定履歴が打ち切られていると tradedAssets は部分集合になり、取引所で売買した
				// 銘柄まで「約定に現れない」と誤検出しうる。qtyMismatchReasonFor が
				// has_crypto_deposits / history_truncated を untracked 系より優先する非対称と
				// 揃え、確度が落ちる場合は history_truncated（本当に取得漏れかは断定しない）に倒す。
				const detectionReason: PortfolioCostBasisUnavailableReason = tradesTruncated
					? 'history_truncated'
					: 'untracked_trade_suspected';
				const detectedEntries: NonNullable<typeof closedPositions> = depositOnlyDetected.map((asset) => ({
					asset,
					realized_pnl: undefined,
					priced_deposit_count: undefined,
					unpriced_deposit_count: undefined,
					realized_pnl_unavailable_reason: detectionReason,
				}));
				// realized_pnl_unavailable_reason 付き（realized_pnl 無し）の要素は順位付けできないため
				// 常に末尾に asset 昇順でまとめる。`?? 0` で欠損値扱いすると負の realized_pnl を持つ
				// 計算済み要素より前に出てしまう（0 より大きい値と誤認される）ので、まず defined/undefined
				// で分けてから、計算済み同士は従来どおり降順 + asset 昇順で比較する。
				closedPositions = [...(closedPositions ?? []), ...detectedEntries].sort((x, y) => {
					if (x.realized_pnl == null || y.realized_pnl == null) {
						if ((x.realized_pnl == null) !== (y.realized_pnl == null)) {
							return x.realized_pnl == null ? 1 : -1;
						}
						return x.asset.localeCompare(y.asset);
					}
					return y.realized_pnl - x.realized_pnl || x.asset.localeCompare(y.asset);
				});
			}
		}

		// 全履歴の実現損益を確定値として出せるか（#80）。保有・売り切りのどちらで抑止しても、
		// 残りを足した部分和は「口座の実現損益」ではないので合計そのものを出さない。
		// 抑止した銘柄を除外しても含めても正しい合計にならない以上、黙って混ぜる方が有害。
		const totalRealizedPnlUnavailableReason = dominantUnresolvedDepositReason(
			suppressedRealizedAssets.map((e) => e.reason),
		);

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
				depositCost,
			);
			monthlyRealizedPnl = calcPeriodRealizedPnl(
				allTrades,
				boundaries.monthStartMs,
				boundaries.monthStartIso,
				boundaries.nowIso,
				dwData?.withdrawals,
				depositCost,
			);
		}

		// 期間実現損益は全銘柄を単一タイムラインで合算した値なので、抑止した銘柄が
		// **その期間に売却している**ときだけ壊れる。期間内に売却が無ければ抑止した銘柄の
		// 原価が欠けていても値は動かないので、抑止範囲を広げない（#80 仕様 2）。
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

		// 6.5b. 信用 PnL の集計 + 口座全体 PnL の構築
		// 現物の totalRealizedPnl と yearly/monthlyRealizedPnl は現物単独の値として維持し、
		// account_pnl 系として「現物 + 信用決済損益 - 信用支払利息」をまとめて公開する。
		let accountPnl: AccountPnl | undefined;
		let yearlyAccountPnl: PeriodAccountPnl | undefined;
		let monthlyAccountPnl: PeriodAccountPnl | undefined;
		if (include_pnl) {
			const marginPnlAll = calcMarginPnl(allMarginTrades);
			accountPnl = buildAccountPnl(
				totalRealizedPnlUnavailableReason != null ? undefined : totalRealizedPnl,
				marginPnlAll,
				totalRealizedPnlUnavailableReason,
			);

			const marginPnlYearly = calcPeriodMarginPnl(
				allMarginTrades,
				boundaries.yearStartMs,
				boundaries.yearStartIso,
				boundaries.nowIso,
			);
			yearlyAccountPnl = buildPeriodAccountPnl(
				yearlyRealizedPnlUnavailableReason != null ? undefined : (yearlyRealizedPnl?.realized_pnl ?? 0),
				marginPnlYearly,
				boundaries.yearStartIso,
				boundaries.nowIso,
				yearlyRealizedPnlUnavailableReason,
			);

			const marginPnlMonthly = calcPeriodMarginPnl(
				allMarginTrades,
				boundaries.monthStartMs,
				boundaries.monthStartIso,
				boundaries.nowIso,
			);
			monthlyAccountPnl = buildPeriodAccountPnl(
				monthlyRealizedPnlUnavailableReason != null ? undefined : (monthlyRealizedPnl?.realized_pnl ?? 0),
				marginPnlMonthly,
				boundaries.monthStartIso,
				boundaries.nowIso,
				monthlyRealizedPnlUnavailableReason,
			);
		}

		// 6.6. 期間別パフォーマンス（評価額比較）— 主指標
		let yearlyPerformance: PeriodPerformance | undefined;
		let monthlyPerformance: PeriodPerformance | undefined;
		let dailyPerformance: PeriodPerformance | undefined;
		let monthlyEquitySeries: EquityPoint[] | undefined;
		let yearlyEquitySeries: EquityPoint[] | undefined;
		// equitySeriesQuality: equity series が現在価格フォールバックに依存している度合い。
		//   complete         — 全保有暗号資産で daily candle 取得済（履歴正確）
		//   partial_fallback — 一部資産で candle 欠落 → 現在価格代替
		//   fallback_only    — 全保有暗号資産で candle 欠落 → 全期間現在価格代替
		//   jpy_only         — JPY のみ保有（価格情報は不要、入出金/約定のみ反映）
		let equitySeriesQuality: 'complete' | 'partial_fallback' | 'fallback_only' | 'jpy_only' | undefined;
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

			// 6.7. 資産推移時系列データの構築（月次: 日次点、年次: 月次点）
			// candle 取得状況に関わらず必ず構築する。JPY のみ保有 / 全 candle 失敗時も
			// content に series を含めないと LLM が 2 点だけで折れ線を描いてしまい
			// プロンプト仕様（"2 点だけで折れ線を描かない"）に反するため。
			// fallbackPrices=prices を渡すと、daily candle が無い資産は現在 ticker 価格で
			// 代替され、historical 点と最終点 currentValueJpy のスケールが揃う。
			const holdingsForReconstruction = nonZeroAssets.map((a) => ({ asset: a.asset, amount: a.onhand_amount }));

			// Monthly: daily points from month start through today 00:00 JST, + current
			// 打ち止めの「今日 00:00 JST」は fetchCandlePriceData に渡した boundaries と
			// **同じ瞬間から導く**（portfolio/calendar.ts 参照）。ここで時計を読み直すと、
			// リクエスト処理中に JST 00:00 を跨いだ場合に取得済みの日次価格に無い翌日の点が
			// 1 つ増え、その点だけ現在価格フォールバックに落ちる。
			const monthDates: ReturnType<typeof dayjs>[] = [];
			let d = dayjs(boundaries.monthStartMs).tz(PORTFOLIO_CALENDAR_TZ);
			while (d.valueOf() <= boundaries.dayStartMs) {
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
				prices,
				flowPricing,
			);

			// Yearly: monthly points from year start through current month start, + current
			// 月次点の終端も同じ理由で boundaries 由来（月跨ぎのレースを避ける）。
			const yearDates: ReturnType<typeof dayjs>[] = [];
			let m = dayjs(boundaries.yearStartMs).tz(PORTFOLIO_CALENDAR_TZ);
			while (m.valueOf() <= boundaries.monthStartMs) {
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
				prices,
				flowPricing,
			);

			// equity series のデータ品質を判定。LLM が現在価格代替に気づけるよう summary / meta に明示する。
			// 判定基準: buildEquitySeries が実際に lookup する日付キー（monthDates + yearDates）が
			// すべて dailyPrices に揃っているか。1件でも欠ければその資産は fallback 対象とする。
			// 「年初以降の任意の1件でも OK」とすると sparse coverage でも complete 判定になり、
			// progression が fallback で埋まっている実態と乖離する。
			const cryptoAssetsInPortfolio = nonZeroAssets.filter((a) => a.asset !== 'jpy').map((a) => a.asset);
			if (cryptoAssetsInPortfolio.length === 0) {
				equitySeriesQuality = 'jpy_only';
			} else {
				const requiredDateKeys = new Set<number>([
					...monthDates.map((d) => d.valueOf()),
					...yearDates.map((d) => d.valueOf()),
				]);
				equitySeriesFallbackAssets = cryptoAssetsInPortfolio.filter((asset) => {
					const dp = candlePriceData.dailyPrices.get(asset);
					if (!dp) return true;
					for (const ts of requiredDateKeys) {
						if (!dp.has(ts)) return true;
					}
					return false;
				});
				if (equitySeriesFallbackAssets.length === 0) {
					equitySeriesQuality = 'complete';
				} else if (equitySeriesFallbackAssets.length === cryptoAssetsInPortfolio.length) {
					equitySeriesQuality = 'fallback_only';
				} else {
					equitySeriesQuality = 'partial_fallback';
				}
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
		// 入出金履歴が使えない場合は銘柄別で原価を出していないので合計も立たない
		// （validCostBasis は 0 のまま）が、意図を明示するため理由コードでも明示的に閉じる。
		const hasValidCostData = flowUnavailableReason == null && validCostBasis > 0;
		const totalUnrealizedPnl = hasValidCostData ? Math.round(validJpyValue - validCostBasis) : undefined;
		const totalUnrealizedPnlPct =
			totalUnrealizedPnl != null && validCostBasis > 0
				? Math.round((totalUnrealizedPnl / validCostBasis) * 10000) / 100
				: undefined;

		// 原価不完全な銘柄の表示ラベル（#77）。銘柄名と件数のみで金額は出さない
		// （`.claude/rules/sensitive-data.md` の HIGH 分類）。保有銘柄（評価額降順）と
		// 売り切り銘柄（Set 由来で順序不定）が混ざるので、銘柄名でソートして出力を決定的にする。
		const unpricedDepositLabel = [...unpricedDepositAssets]
			.sort((x, y) => x.asset.localeCompare(y.asset))
			.map((e) => `${e.asset.toUpperCase()}（${e.count}件）`)
			.join(', ');

		// 原価側クランプが発火した銘柄の表示ラベル（#89）。銘柄名と件数のみで金額・数量は出さない
		// （`.claude/rules/sensitive-data.md` の HIGH 分類。吸収量は holdings[].qty_clamp_absorbed_qty で読む）。
		// 保有銘柄と売り切り銘柄が混ざるので、上の #77 と同じく銘柄名でソートして出力を決定的にする。
		const qtyClampLabel = [...qtyClampAssets]
			.sort((x, y) => x.asset.localeCompare(y.asset))
			.map((e) => `${e.asset.toUpperCase()}（${e.count}件）`)
			.join(', ');

		// 入庫日価格を取得できず確定値を抑止した銘柄の表示ラベル（#80）。上の #77 と同じく
		// 銘柄名と件数のみで金額は出さない。保有銘柄と売り切り銘柄が混ざるので銘柄名でソートする。
		const suppressedLabelOf = (reason?: PortfolioUnresolvedDepositReason): string =>
			[...suppressedRealizedAssets]
				.filter((e) => reason == null || e.reason === reason)
				.sort((x, y) => x.asset.localeCompare(y.asset))
				.map((e) => `${e.asset.toUpperCase()}（${e.count}件）`)
				.join(', ');
		const suppressedRealizedLabel = suppressedLabelOf();

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
		// ここから下は入出金**分析セクション**なので include_deposit_withdrawal で閉じる。
		// 損益計算側は上で dwData を直接使っており、このフラグの影響を受けない。
		// 取得失敗を伝える dwWarnings もセクション側の文言なのでここに含める。損益側で
		// 取得が欠けたことは flowUnavailableReason 由来の警告が別途 content 先頭に出る。
		let dwSummary: DepositWithdrawalSummary | undefined;
		let yearlyDWSummary: PeriodDWSummary | undefined;
		let monthlyDWSummary: PeriodDWSummary | undefined;
		const dwWarnings: string[] = [];
		if (include_deposit_withdrawal && dwData) {
			if (dwData.allFailed) {
				// 全リクエスト失敗: trade_only フォールバック + 警告
				dwWarnings.push('入出金履歴の取得に全て失敗したため、約定ベースの分析のみです');
			} else {
				if (dwData.warnings.length > 0) {
					dwWarnings.push(...dwData.warnings.map((w) => `注意: ${w}（部分的なデータで概算）`));
				}
				if (dwData.deposits.length > 0 || dwData.withdrawals.length > 0) {
					dwSummary = calcDepositWithdrawalSummary(dwData, totalJpyValue, flowPricing);
					// 年次・月次の入出金サマリー
					yearlyDWSummary = calcPeriodDWSummary(
						dwData,
						boundaries.yearStartMs,
						boundaries.yearStartIso,
						boundaries.nowIso,
						flowPricing,
					);
					monthlyDWSummary = calcPeriodDWSummary(
						dwData,
						boundaries.monthStartMs,
						boundaries.monthStartIso,
						boundaries.nowIso,
						flowPricing,
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

		// 6. サマリー文字列の生成
		const lines: string[] = [];

		// 取得層の不完全性（fetch 失敗 / 上限到達）を先頭に出して LLM が見落とさないようにする。
		// 信用 fetch 失敗時は truncated と内容が重複するため、信用側の truncated 警告は抑止する。
		// 信用約定 / 信用口座状態 / 信用建玉の 3 系統は原因切り分けのため警告行を別々に出す。
		if (marginFetchFailed) {
			lines.push('⚠️ 信用約定の取得に失敗。信用 PnL は実態を反映しない可能性');
		}
		if (marginStatusFetchFailed) {
			lines.push('⚠️ 信用口座状態の取得に失敗。建玉・追証状態は反映されていません');
		}
		if (marginPositionsFetchFailed) {
			lines.push('⚠️ 信用建玉の取得に失敗。建玉情報は反映されていません');
		}
		// 信用口座状態 (status) が取得できかつ NORMAL でない場合、追証・ロスカット等の警告を出す。
		const marginStatus = marginAccountInfo.status;
		if (marginStatus && marginStatus.status !== 'NORMAL') {
			const warningLine = MARGIN_STATUS_WARNINGS[marginStatus.status];
			if (warningLine) lines.push(warningLine);
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
		if (dailyPerformance) lines.push(...buildPerformanceLines('前日比', dailyPerformance));
		if (yearlyPerformance) lines.push(...buildPerformanceLines('年初比', yearlyPerformance));
		if (monthlyPerformance) lines.push(...buildPerformanceLines('月初比', monthlyPerformance));
		if (yearlyPerformance || monthlyPerformance) {
			lines.push(`期間基準: JST`);
			lines.push(
				'※ 期初評価額は約定・入出金を逆算して復元、期初始値で評価。暗号資産入出庫は入出庫日（入庫: confirmed_at / 出庫: requested_at）の始値で JPY 換算',
			);
			lines.push('※ 出金元本は外部フローとして除外、出金手数料はコストとして performance に含む');
			// 入出金を巻き戻せていない場合、期初評価額と資産推移シリーズは「ずっと同額保有」寄りに歪む。
			// 上の 2 行が復元前提を語っているので、前提が満たせていないことをその直後に置く。
			if (flowUnavailableReason != null) {
				lines.push(
					`※ ただし今回は${FLOW_UNAVAILABLE_CAUSE[flowUnavailableReason]}ため入出金を巻き戻せていません。期初評価額・資産推移シリーズは入出金があった期間で実態と乖離します`,
				);
			}
		}
		if (monthlyEquitySeries && monthlyEquitySeries.length > 0) {
			// 品質警告: series が現在価格フォールバック・JPY のみ等の場合は LLM がデータの不完全性を把握できるよう明示
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
			// 「入出金分析セクションが無い」と「損益が入出金を見ていない」は別。後者と読まれると
			// LLM が取得原価を疑って再取得を促してしまうため、供給済みならその旨を明示する。
			//
			// ただし「反映した値です」と断言してよいのは原価を出しているときだけ。部分失敗・
			// 打ち切り（dwFetchedForPnl=true かつ flowUnavailableReason あり）では原価を抑止して
			// おり、同じ content 内の「評価損益: 算出不能」と真っ向から矛盾する。text しか
			// 読まない LLM にはこの矛盾を解けないので、その場合は中立の文言に落とす
			// （取得が欠けたことは算出不能行と content 先頭の warning が別途伝える）。
			lines.push(
				dwFetchedForPnl && flowUnavailableReason == null
					? '※ 入出金分析セクションは未リクエスト（include_deposit_withdrawal=false）。ただし損益計算には入出金履歴を取得して使用しているため、取得原価・評価損益・純入出金は入出金を反映した値です'
					: '※ 入出金分析は未リクエスト。約定ベースの分析のみです',
			);
		}

		// 入出金ベースの口座全体リターン（Phase 4）
		//
		// `crypto_*_count` は「入出庫の総件数」で、`crypto_*_estimated_jpy` に実際に載っているのは
		// **価格を解決できた件数**だけ（解決できなかった分は黙って 0 円計上せず集計から落としている）。
		// 一部だけ解決できた口座で総件数を使うと、金額と件数が食い違う説明になる。
		// `FlowValuationBreakdown` の 2 つの件数の和が「評価できた件数」なので、そこから逆算する。
		const valuedCounts = (breakdown: FlowValuationBreakdown | undefined) =>
			(breakdown?.deposit_date_price_count ?? 0) + (breakdown?.current_price_fallback_count ?? 0);
		const valuedDepositCount = valuedCounts(dwSummary?.crypto_deposit_valuation);
		const valuedWithdrawalCount = valuedCounts(dwSummary?.crypto_withdrawal_valuation);
		const unvaluedDepositCount = (dwSummary?.crypto_deposit_count ?? 0) - valuedDepositCount;
		const unvaluedWithdrawalCount = (dwSummary?.crypto_withdrawal_count ?? 0) - valuedWithdrawalCount;

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
					`  暗号資産入庫の評価: ${formatPriceJPY(dwSummary.crypto_deposit_estimated_jpy)}（${valuedDepositCount}件、${FLOW_VALUATION_LABEL[dwSummary.crypto_deposit_valuation?.basis ?? 'current_price_fallback']}）`,
				);
			}
			if (dwSummary.crypto_withdrawal_estimated_jpy) {
				lines.push(
					`  暗号資産出庫の評価: -${formatPriceJPY(dwSummary.crypto_withdrawal_estimated_jpy)}（${valuedWithdrawalCount}件、${FLOW_VALUATION_LABEL[dwSummary.crypto_withdrawal_valuation?.basis ?? 'current_price_fallback']}）`,
				);
			}
			// 内訳の式は実際に載っている項だけを並べる（0 円の項を書くと読み手が総額を追えない）。
			const netInvestedTerms = [
				dwSummary.crypto_deposit_estimated_jpy ? '+ 暗号資産入庫の評価額' : '',
				dwSummary.crypto_withdrawal_estimated_jpy ? '- 暗号資産出庫の評価額' : '',
			].filter(Boolean);
			lines.push(
				`  純投入額: ${formatPriceJPY(dwSummary.net_jpy_invested)}${netInvestedTerms.length > 0 ? `（JPY純入金 ${netInvestedTerms.join(' ')}）` : ''}`,
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
			// 差し引いたと言えるのは評価できた件数だけ。総件数で書くと、価格を解決できず
			// 純投入額に載っていない出庫まで「差し引いた」と説明することになる。
			if (valuedWithdrawalCount > 0) {
				lines.push(
					`  ※ 暗号資産出庫 ${valuedWithdrawalCount}件は JPY 出金と同じ「元本の回収」として純投入額から差し引いています（外部ウォレットへ移して保有を続けている場合でも、口座外の値動きは測定対象外です）`,
				);
			}
		} else if (dwSummary && dwSummary.net_jpy_invested <= 0) {
			// 純投入額が 0 以下でリターン率を定義できないケース（`account_return_*` が undefined に
			// なる既存分岐）。黙ってブロックごと消すと「リターンが計算されたのに表示されていない」と
			// 読まれるため、出せない理由を 1 行で明示する。原因は暗号資産出庫の減算とは限らない
			// （JPY 出金だけで入金と相殺されている口座も同じ状態になる）ので、出庫が効いている
			// ときだけその内訳を添える。
			const withdrawalCause =
				valuedWithdrawalCount > 0 ? `暗号資産出庫 ${valuedWithdrawalCount}件を元本の回収として差し引いた結果、` : '';
			lines.push(
				`口座全体リターン: 算出不可（${withdrawalCause}純投入額が ${formatPriceJPY(dwSummary.net_jpy_invested)} と 0 以下になりました。引き出しが投入を上回る口座ではリターン率を定義できません）`,
			);
		}

		// 入出金取得の警告
		if (dwWarnings.length > 0) {
			for (const w of dwWarnings) {
				lines.push(`  ${w}`);
			}
		}

		// 信用建玉サマリ（建玉あり時のみ）— 現物サマリ後 / Account PnL 前に挿入
		const marginPositionsBlock = buildMarginPositionsBlock(marginAccountInfo);
		if (marginPositionsBlock.length > 0) {
			lines.push(...marginPositionsBlock);
			lines.push('');
		}

		// 実現損益（現物単独）と口座全体 PnL（現物 + 信用決済損益 - 利息 - 手数料）。
		// ラベルにスコープ（期間 / 対象銘柄）を書く: 同じ出力に全履歴（account_pnl）と
		// 年初来 / 月初来（yearly_account_pnl / monthly_account_pnl）が併存し、text しか読まない
		// LLM には「Realized PnL (Spot)」だけでどれなのか判別できないため（#53 症状 5）。
		if (accountPnl != null) {
			const spotRealized = accountPnl.spot_realized_pnl;
			const hasMargin =
				accountPnl.margin_realized_pnl !== 0 ||
				accountPnl.margin_interest_cost !== 0 ||
				accountPnl.margin_fee_cost !== 0;
			// Interest / Fee は data 側では**コスト = 正値**（margin_interest_cost /
			// margin_fee_cost）。表示は total への寄与を表すので `-` を前置する（#72）。
			const marginPart = `Margin: ${accountPnl.margin_realized_pnl >= 0 ? '+' : ''}${formatPriceJPY(accountPnl.margin_realized_pnl)} / Interest cost: -${formatPriceJPY(accountPnl.margin_interest_cost)} / Fee cost: -${formatPriceJPY(accountPnl.margin_fee_cost)}`;
			if (spotRealized == null && totalRealizedPnlUnavailableReason != null) {
				// 抑止した銘柄を除いた部分和を「実現損益」として見出しに載せない（#80）。
				// テキストしか読まない LLM には金額が唯一の手掛かりなので、数字を出した時点で
				// 口座の実現損益として読まれる。信用側は現物と独立に確定するので内訳だけ残す。
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
				lines.push(`Realized PnL (Spot, 全履歴・売り切り銘柄含む): ${spotSign}${formatPriceJPY(spotRealized ?? 0)}`);
				// 内訳を出して holdings[].realized_pnl の合計との差分（= 売り切り銘柄ぶん）を追えるようにする。
				// 集計を行っていない構成（約定履歴なし）では差分そのものが定義されないので出さない。
				if (closedPositionRealizedPnl != null) {
					const heldSign = heldRealizedPnl >= 0 ? '+' : '';
					const closedPart =
						closedPositionAssetCount != null && closedPositionAssetCount > 0
							? `売り切り銘柄 ${closedPositionAssetCount}銘柄 ${closedPositionRealizedPnl >= 0 ? '+' : ''}${formatPriceJPY(closedPositionRealizedPnl)}`
							: '売り切り銘柄なし（0円）';
					lines.push(
						`  内訳: 現在保有銘柄（holdings[].realized_pnl の合計）${heldSign}${formatPriceJPY(heldRealizedPnl)} / ${closedPart}`,
					);
				}
				const total = accountPnl.total ?? 0;
				const totalSign = total >= 0 ? '+' : '';
				if (hasMargin) {
					lines.push(
						`Account PnL (全履歴): ${totalSign}${formatPriceJPY(total)} (Spot: ${spotSign}${formatPriceJPY(spotRealized ?? 0)} / ${marginPart})`,
					);
				} else {
					lines.push(`Account PnL (全履歴): ${totalSign}${formatPriceJPY(total)}`);
				}
			}
			// 年初来 / 月初来は data 側にしか出ないので、全履歴の値と取り違えられないよう所在を示す。
			if (yearlyAccountPnl != null || monthlyAccountPnl != null) {
				lines.push(
					'※ 上の Realized PnL / Account PnL は全履歴（口座開設来）の集計です。年初来 / 月初来は yearly_account_pnl / monthly_account_pnl（現物単独は yearly_realized_pnl / monthly_realized_pnl）を参照してください',
				);
			}
		}

		if (flowUnavailableReason != null) {
			// 「合計評価損益」の確定値を出さない。壊れた原価から出した率（例: -60.9%）が
			// 見出しに載ると、テキストしか読まない LLM がそれを口座の成績として読んでしまう。
			lines.push(`評価損益: 算出不能（${FLOW_UNAVAILABLE_NOTE[flowUnavailableReason]}）`);
		} else {
			if (totalUnrealizedPnl != null) {
				const sign = totalUnrealizedPnl >= 0 ? '+' : '';
				lines.push(
					`合計評価損益（全履歴の約定ベース）: ${sign}${formatPriceJPY(totalUnrealizedPnl)} (${formatPercent(totalUnrealizedPnlPct, { sign: true })})`,
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

		// 計算層の warning（`.claude/rules/tools.md` の meta.warnings 系統）。
		// 期間ネットフローで価格を解決できなかった暗号資産は net_flow_jpy に計上されず
		// （＝ 0 円計上と等価）、adjusted_change_jpy = change_jpy - net_flow_jpy も逆向きにずれるため明示する。
		// 3 期間で同じ資産が落ちるので集合で重複排除する。金額・件数は出さず資産名のみ
		// （`.claude/rules/sensitive-data.md` の HIGH 分類）。
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
		// 現在 ticker 価格を解決できず現在評価額から落ちた暗号資産（#109）。現在価格は期間に
		// 依存しないので 3 期間で同じ集合になるが、期初側と同じ形で畳んで由来を 1 か所に揃える。
		const currentUnpricedAssets = [
			...new Set([
				...(dailyPerformance?.unpriced_current_assets ?? []),
				...(monthlyPerformance?.unpriced_current_assets ?? []),
				...(yearlyPerformance?.unpriced_current_assets ?? []),
			]),
		].sort();
		// 増減率（change_pct / adjusted_change_pct）を抑止した期間（#71）。
		// 理由は各期間の summary 注記行にも出るが、content 先頭の warning にも出す
		// （`.claude/rules/tools.md`。率が undefined な理由を LLM が説明できないと「ゼロ %」と読まれる）。
		// 並びは summary の期間ブロックと同じ（前日比 → 年初比 → 月初比）。
		const changePctSuppressed = [
			{
				key: 'daily' as const,
				label: '前日比',
				reason: dailyPerformance?.change_pct_unavailable_reason,
				direction: changeJpyDirectionOf(dailyPerformance),
			},
			{
				key: 'yearly' as const,
				label: '年初比',
				reason: yearlyPerformance?.change_pct_unavailable_reason,
				direction: changeJpyDirectionOf(yearlyPerformance),
			},
			{
				key: 'monthly' as const,
				label: '月初比',
				reason: monthlyPerformance?.change_pct_unavailable_reason,
				direction: changeJpyDirectionOf(monthlyPerformance),
			},
		].filter((e): e is typeof e & { reason: PortfolioChangePctUnavailableReason } => e.reason != null);
		const calcWarnings: string[] = [];
		// 取得原価が確定できない件は content 先頭に出す。summary 本文の「算出不能」行だけだと
		// JSON より後ろに埋もれる位置に来ることがあり、LLM が数値の欠落理由に辿り着けない。
		if (flowUnavailableReason != null) {
			calcWarnings.push(
				`評価損益・取得原価は算出していません（${FLOW_UNAVAILABLE_NOTE[flowUnavailableReason]}）。期間パフォーマンスの純入出金も未計測です`,
			);
		}
		// 数量不変条件の乖離（金額・件数は出さず銘柄名のみ: `.claude/rules/sensitive-data.md` の HIGH 分類）。
		if (qtyMismatchAssets.length > 0) {
			calcWarnings.push(
				`${qtyMismatchAssets.map((m) => `${m.asset.toUpperCase()}（${QTY_MISMATCH_CAUSE[m.reason]}）`).join(', ')} は約定・出庫から復元した保有数量が実残高と一致しないため、取得原価・評価損益を算出せず合計評価損益からも除外しています`,
			);
		}
		// 入庫はあるが約定履歴にも現在残高にも現れない銘柄（#93）。ゼロ残高なので qtyMismatchAssets
		// とは別経路の検出——入出金履歴（DONE の暗号資産入庫）を起点に、そこから約定・残高の
		// どちらにも辿れない銘柄を拾う。realized_pnl は算出しておらず closed_positions（要素の
		// realized_pnl_unavailable_reason）に検出結果だけを申告する。文言は tradesTruncated で
		// 分岐する——約定履歴が打ち切られている実行では「販売所取引の可能性」と断定的に言うと、
		// 単に取得できなかっただけの取引所約定を誤って販売所のせいと言い切ることになる。
		if (depositOnlyDetected.length > 0) {
			calcWarnings.push(
				tradesTruncated
					? `${depositOnlyDetected.map((a) => a.toUpperCase()).join(', ')} は入出金履歴に暗号資産の入庫記録があるものの、約定履歴にも現在残高にも現れません。約定履歴の取得が件数上限で打ち切られているため取引所約定を見落としている可能性があり、該当銘柄の実現損益はこの結果に含まれていません（closed_positions に realized_pnl_unavailable_reason=history_truncated 付きで申告しています）`
					: `${depositOnlyDetected.map((a) => a.toUpperCase()).join(', ')} は入出金履歴に暗号資産の入庫記録があるものの、約定履歴にも現在残高にも現れません。販売所取引など bitbank API に現れない取引で全量を処分した可能性があり（断定はできません）、該当銘柄の実現損益はこの結果に含まれていません（closed_positions に realized_pnl_unavailable_reason=untracked_trade_suspected 付きで申告しています）`,
			);
		}
		// 原価は出したが不完全な銘柄（#77）。上の数量乖離とは別軸で、こちらは**確定値が出ている**。
		// 申告しないと realized_pnl の算出条件（何件の入庫を除外したか）が出力から復元できない。
		if (unpricedDepositLabel !== '') {
			calcWarnings.push(
				`${unpricedDepositLabel} は入庫日の始値を解決できなかった暗号資産入庫（カッコ内は件数）を取得原価にも復元数量にも算入せずに cost_basis / avg_buy_price / unrealized_pnl / realized_pnl を算出しています。未算入ぶんを売却済みなら原価ゼロで売ったことになり実現損益は過大、保有継続なら取得原価が過小です。数量乖離が許容誤差に収まっているため cost_basis_reliable=true のまま確定値が出ますが、原価は不完全です（件数は holdings[].unpriced_deposit_count。該当銘柄は total_cost_basis / total_unrealized_pnl / total_realized_pnl から除外せず含めています）`,
			);
		}
		// 原価側クランプの発火（#89）。数量乖離の抑止とは別軸で、こちらは**確定値が出ている**
		// （原価をゼロ扱いにするのは実現損益として妥当なので抑止しない）。申告しないと
		// 「リプレイの保有で賄えない売りがあった」という realized_pnl の算出条件が出力から復元できない。
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
		// 現在 ticker 価格の解決欠損（#109）。期初側と違い 1 回の取得で全銘柄ぶんを取るため、
		// 保有暗号資産が全て並ぶ ＝ ticker 取得そのものの失敗で、現在評価額が JPY 残高だけに
		// 縮退している。その状態の増減額は「口座が消し飛んだ」ように見える偽の巨額損失になるので、
		// 全滅かどうかを文言で切り分けて先頭 warning に出す。
		if (currentUnpricedAssets.length > 0) {
			const allCryptoUnpriced = cryptoHoldings.length > 0 && currentUnpricedAssets.length === cryptoHoldings.length;
			calcWarnings.push(
				`${currentUnpricedAssets.map((a) => a.toUpperCase()).join(', ')} は現在価格を解決できず現在評価額（current_value_jpy）に含めていません。現在評価額は過小で、増減額（change_jpy / adjusted_change_jpy）も同じ額だけ過小です（ずれの向きが確定する期間には change_jpy_understated=true が付きます）。同じ銘柄は合計評価損益（total_unrealized_pnl）・合計取得原価（total_cost_basis）からも除外しています${allCryptoUnpriced ? '。**保有する暗号資産が全て脱落しています ＝ ticker 取得そのものが失敗しており、現在評価額は JPY 残高だけに縮退しています。**増減額は口座の損失ではなく価格取得の失敗を表す数なので、損失として読まないでください（時間をおいて再実行してください）' : ''}`,
			);
		}
		// 期間ごとに理由が割れうる（前日比は期初 0、年初比は期初が極小、など）ので理由コード単位でまとめる。
		// キーの網羅は CHANGE_PCT_UNAVAILABLE_NOTE（Record<理由コード, string>）が型で保証する。
		// 同じ理由でも増減額のずれの向きが確定する期間としない期間は混ざりうる（例: 当日足だけ
		// 欠けた資産と、現在価格ごと引けない資産が同居する構成）ので、向きでも分けて行を出す。
		// 混ぜると片方の期間に誤った向きを付けることになる。
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
		// 入出庫日の日次価格を解決できず現在価格に落ちた分は、評価額が相場と連動して動く
		// （本来これを止めるのが入出庫日評価の目的）。黙って混ぜず件数で申告する。
		const flowValuationFallbackCount = flowValuation?.current_price_fallback_count ?? 0;
		if (flowValuationFallbackCount > 0) {
			calcWarnings.push(
				`暗号資産入出庫 ${flowValuationFallbackCount}件は入出庫日（入庫: confirmed_at / 出庫: requested_at）の価格を取得できず現在価格で仮評価しています。この分の評価額は相場変動で動きます（取得原価には算入しないため、該当する入庫で復元数量が実残高と乖離した銘柄は cost_basis_unavailable_reason=has_crypto_deposits になり、乖離が許容誤差以内に収まった銘柄は取得原価がその分だけ過小のまま出ます）`,
			);
		}
		// 上のフォールバック件数は「上限で取りに行かなかった」「取得に失敗した」「上場前で本当に無い」を
		// 全部まとめた数字なので、そこからは再実行で直るのかどうかが読めない。前 2 つは件数を別枠で出す
		// （#76 仕様 2）。前 2 つは「取りに行けば解決できたはず」の分でもあり、入庫側は該当銘柄の
		// 確定値そのものを抑止する（#80）ので、件数と一緒に抑止した銘柄も申告する。
		const chunkTruncated = flowDatePrices.truncatedByChunkLimit;
		const chunkFailed = flowDatePrices.chunkFetchFailed;
		/**
		 * 入庫側の取りこぼしを 1 行で申告する（#80）。
		 *
		 * 件数だけでは「値が出ているのか抑止されたのか」が読めないので、抑止した銘柄名と
		 * その件数を同じ行に載せる。抑止が起きていない構成（`pnlUsesFlow=false` で原価を
		 * そもそも出していない / 該当銘柄に保有も約定も無い）は取りこぼしが損益のどこにも
		 * 効かないので、そう明記して確定値の心配をさせない。
		 */
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

		// 取得層の warning（上の ⚠️ 行）とは別行・別フィールドで先頭に出す。
		const summary = prependWarnings(lines.join('\n'), { warnings: calcWarnings }, { separator: '\n' });

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
			hasPnl: include_pnl && allTrades.length > 0,
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
