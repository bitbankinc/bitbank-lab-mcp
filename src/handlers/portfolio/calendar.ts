/**
 * ポートフォリオの暦日境界。
 *
 * `analyze_my_portfolio` は「JST 暦日の 0:00」を 3 箇所で別々に実装していた
 * （当日損益の起点 = `getJstPeriodBoundaries`、日次価格マップのキー正規化 =
 * `fetchCandlePriceData`、資産推移の日次点の打ち止め = `analyzeMyPortfolioHandler`）。
 * この 3 つは **同じ暦日境界でなければ壊れる**: 日次価格は JST 0:00 の ms をキーに
 * 持ち、資産推移側はその ms で lookup するため、片方だけ暦がずれると全点が
 * 現在価格フォールバックに落ちて `equitySeriesQuality` が実態と乖離する。
 * 暦日そのものの計算は `lib/calendar.ts` に委譲し、基準の共有を本モジュールが担う。
 *
 * ## tz を引数にせず定数のままにした理由
 *
 * 当日損益の計算基準（どの暦の 0:00 を「今日の始まり」とするか）は仕様であって
 * 呼び出し側の自由度ではない。設定可能にすると、
 *
 * - 上流の `fetchCandlePriceData` は同じ定数を `getCandles` の tz 引数に渡して
 *   **JST 日足**を取得している。境界だけ別 tz にすると足の区切りと起点がずれるため、
 *   通すなら取得側の tz まで一貫して通す必要がある。
 * - 出力の ISO 文字列（`period_start` 等）も JST オフセット前提で組まれている。
 *
 * つまり tz の外出しは「当日損益の計算基準日の変更」という仕様変更とセットになる。
 * 本モジュールは現行挙動を変えずに実装の重複だけを解消する範囲に留め、定数を
 * 1 箇所に集約する。仕様として変えるときはここを起点に上流の tz まで辿ること。
 */

import { startOfDayMs } from '../../../lib/calendar.js';

/**
 * ポートフォリオの暦日基準。当日損益の起点・日次価格マップのキーはすべてこの暦の 0:00。
 * 変更は当日損益の仕様変更にあたる（上の「tz を引数にせず定数のままにした理由」を参照）。
 */
export const PORTFOLIO_CALENDAR_TZ = 'Asia/Tokyo';

/**
 * `ms` が属する JST 暦日の開始ミリ秒。
 *
 * 「今日の始まり」が欲しい場合は `portfolioDayStartMs(Date.now())` を呼ぶ。
 * 非有限な `ms` は `lib/calendar.ts` が `TypeError` を投げるので、呼び出し前に弾くこと。
 */
export function portfolioDayStartMs(ms: number): number {
	return startOfDayMs(ms, PORTFOLIO_CALENDAR_TZ);
}
