import { startOfDayMs } from '../../../lib/calendar.js';

// 日足を取る getCandles の tz と日次価格マップのキーの 0:00 をそろえている。片方だけ変えると価格の lookup が全点外れ、現在価格フォールバックに落ちる。
export const PORTFOLIO_CALENDAR_TZ = 'Asia/Tokyo';

export function portfolioDayStartMs(ms: number): number {
	return startOfDayMs(ms, PORTFOLIO_CALENDAR_TZ);
}
