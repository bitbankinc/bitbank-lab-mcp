// 計算層データ正確性診断（2026-11-18）で確認した問題の回帰テスト。probe B はタイ値仕様（修正しない判断）の記録。
import { describe, expect, it } from 'vitest';
import {
	ema,
	ichimokuSnapshot,
	lastCrossover,
	macd,
	obv,
	rsi,
	sma,
	stochastic,
	stochRSI,
	wilderAtr,
} from '../lib/indicators.js';

function rising(n: number, start = 100, step = 1): number[] {
	return Array.from({ length: n }, (_, i) => start + i * step);
}

function varied(n: number, start = 100): number[] {
	return Array.from({ length: n }, (_, i) => start + Math.sin(i * 1.3) * 5 + i * 0.3);
}

describe('probe A: rsi の NaN 取り扱い（ema/wilderAtr と同じリセット→再シード）', () => {
	it('A-1: シード窓の NaN で全系列が汚染されず、period 連続有限で再シードする（EMA と同挙動）', () => {
		const closes = [100, NaN, ...rising(60, 101)];
		const r = rsi(closes, 14);
		// 有限の変化は index 3 から始まり、14 本そろう index 16 で再シード完了
		expect(Number.isNaN(r[15])).toBe(true);
		expect(Number.isFinite(r[16])).toBe(true);
		expect(Number.isFinite(r.at(-1) as number)).toBe(true);

		const e = ema(closes, 14);
		expect(Number.isFinite(e.at(-1) as number)).toBe(true);
	});

	it('A-2: シード後の NaN は「変化なし」として通過せず、リセット→再シードまで NaN を返す', () => {
		const closes = [...rising(20), NaN, ...rising(20, 121)];
		const nanIdx = 20;
		const r = rsi(closes, 14);
		expect(Number.isNaN(r[nanIdx])).toBe(true);
		expect(Number.isNaN(r[nanIdx + 1])).toBe(true);
		// 有限の変化は index 22 から始まり、14 本そろう index 35 で再シード完了
		expect(Number.isNaN(r[34])).toBe(true);
		expect(Number.isFinite(r[35])).toBe(true);

		const s = sma(closes, 14);
		expect(Number.isNaN(s[nanIdx])).toBe(true);
	});
});

describe('probe B: lastCrossover のタイ値（=0）通過', () => {
	it('差がちょうど 0 の足を経由した符号反転（-5 → 0 → +3）はクロスとして検出されない', () => {
		const fast = [1, 2, 3];
		const slow = [6, 2, 0];
		expect(lastCrossover(fast, slow)).toBeNull();
	});

	it('0 を経由しない符号反転は検出される（コントロール）', () => {
		expect(lastCrossover([1, 3], [6, 0])).toEqual({ type: 'golden', barsAgo: 0 });
	});
});

describe('probe C: obv の NaN volume', () => {
	it('volume に NaN の足は「変化なし」として prev を引き継ぎ、累積を汚染しない', () => {
		const o = obv([1, 2, 3, 4], [10, 10, NaN, 10]);
		expect(o[2]).toBe(10);
		expect(o[3]).toBe(20);
	});
});

describe('probe D: macd signal は NaN ギャップでセグメントごとに再シードする', () => {
	it('line が NaN ギャップ後に復帰しても、signal は新セグメントで signal 期間そろうまで NaN', () => {
		const closes = [...varied(40), NaN, ...varied(40, 140)];
		const m = macd(closes, 12, 26, 9);
		const resume = 41 + 25;
		expect(Number.isFinite(m.line[resume - 1])).toBe(false);
		expect(Number.isFinite(m.line[resume])).toBe(true);
		expect(Number.isNaN(m.signal[resume])).toBe(true);
		// 新セグメントの line 9 本目で signal がシード完了する
		expect(Number.isNaN(m.signal[resume + 7])).toBe(true);
		expect(Number.isFinite(m.signal[resume + 8])).toBe(true);
	});
});

describe('probe E: buildWarnings 閾値と lib の実要求本数の一致（off-by-one なし）', () => {
	it('RSI_14: 14 本で全 NaN、15 本で最終値が有効', () => {
		expect(rsi(varied(14), 14).every((v) => Number.isNaN(v))).toBe(true);
		expect(Number.isFinite(rsi(varied(15), 14).at(-1) as number)).toBe(true);
	});

	it('SMA_200: 199 本で全 NaN、200 本で最終値が有効', () => {
		expect(sma(varied(199), 200).every((v) => Number.isNaN(v))).toBe(true);
		expect(Number.isFinite(sma(varied(200), 200).at(-1) as number)).toBe(true);
	});

	it('Stochastic(14,3,3): 17 本で全 NaN、18 本で %D 最終値が有効', () => {
		const h17 = varied(17, 110);
		const l17 = varied(17, 90);
		const c17 = varied(17);
		expect(stochastic(h17, l17, c17, 14, 3, 3).dSeries.every((v) => Number.isNaN(v))).toBe(true);
		const h18 = varied(18, 110);
		const l18 = varied(18, 90);
		const c18 = varied(18);
		expect(Number.isFinite(stochastic(h18, l18, c18, 14, 3, 3).dSeries.at(-1) as number)).toBe(true);
	});

	it('StochRSI(14,14,3,3): 33 本で全 NaN、34 本で %D 最終値が有効', () => {
		expect(stochRSI(varied(33), 14, 14, 3, 3).dSeries.every((v) => Number.isNaN(v))).toBe(true);
		expect(Number.isFinite(stochRSI(varied(34), 14, 14, 3, 3).dSeries.at(-1) as number)).toBe(true);
	});

	it('Ichimoku: 51 本で null、52 本で snapshot が返る', () => {
		expect(ichimokuSnapshot(varied(51, 110), varied(51, 90), varied(51))).toBeNull();
		expect(ichimokuSnapshot(varied(52, 110), varied(52, 90), varied(52))).not.toBeNull();
	});

	it('Wilder ATR(14): 14 本で全 NaN、15 本で最終値が有効', () => {
		expect(wilderAtr(varied(14, 110), varied(14, 90), varied(14), 14).every((v) => Number.isNaN(v))).toBe(true);
		expect(Number.isFinite(wilderAtr(varied(15, 110), varied(15, 90), varied(15), 14).at(-1) as number)).toBe(true);
	});
});
