// double の形成中パスは #262 / #268 案 C で削除されたので、このファイルが見ているのは完成済みパス（`near_completion` を含む）だけ。
// fixture がヒゲ無し（`extremePrice === close`）なのは、閾値の境界でどちらの検査が発火するかを素の割り算で読めるようにするため。
import { describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import { getSizeThresholdsForTf } from '../../tools/patterns/config.js';
import { asMockResult } from '../_assertResult.js';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';

type Candle = { isoTime: string; open: number; high: number; low: number; close: number; volume: number };

const DAY = getSizeThresholdsForTf('1day');
const HOUR = getSizeThresholdsForTf('1hour');

/** 固定の起点から i 本後。相対時刻にしないのは実行日でパターンが動かないようにするため。 */
function isoAt(i: number): string {
	return dayjs.utc('2026-01-01T00:00:00Z').add(i, 'day').toISOString();
}

function mkCandle(i: number, close: number): Candle {
	return { isoTime: isoAt(i), open: close, high: close, low: close, close, volume: 100 };
}

/** 谷1（idx=4, 安値 100）→ 山（idx=14, 高値 `peak`）→ 谷2（idx=24, 安値 100）→ 直近は上昇中。谷2 からの反発を速くしてあるのは、谷ゾーンを 1 本目で抜けないと `re_entered_trough_zone` でサイズ検査より前に落ちるため。`lastIdx = 42` は谷2 からの経過（18 本）を `FORMING_EXPIRY_BARS = 20` 以内に収める。 */
function buildFormingDoubleBottom(peak: number, lastIdx = 42): Candle[] {
	const closes: number[] = [106, 104, 102, 101, 100];
	for (let i = 1; i <= 10; i++) closes.push(100 + ((peak - 100) * i) / 10); // idx 5..14 → 山は idx=14
	for (let i = 1; i <= 10; i++) closes.push(peak - ((peak - 100) * i) / 10); // idx 15..24 → 谷2 は idx=24
	const n = lastIdx - 24;
	const tail = peak - 1;
	for (let i = 1; i <= n; i++) closes.push(100 + (tail - 100) * (0.6 + (0.4 * i) / n));
	return closes.map((c, i) => mkCandle(i, c));
}

/** 3 水準（山1 100 / 谷 `valley` / 山2 100）をすべて確定ピボットにした完成済み形状。 */
function buildCompletedShapeDoubleTop(valley: number): Candle[] {
	const closes: number[] = [94, 96, 98, 100];
	for (let i = 1; i <= 5; i++) closes.push(100 - ((100 - valley) * i) / 5); // idx 4..8 → 谷は idx=8
	for (let i = 1; i <= 5; i++) closes.push(valley + ((100 - valley) * i) / 5); // idx 9..13 → 山2 は idx=13
	for (let i = 1; i <= 12; i++) closes.push(100 - i); // idx 14..25 下落
	return closes.map((c, i) => mkCandle(i, c));
}

async function detect(candles: Candle[], tf: string, want: 'double_top' | 'double_bottom') {
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
	);
	const res = (await detectPatterns('btc_jpy', tf, candles.length, {
		patterns: [want],
		swingDepth: 2,
		includeForming: true,
		includeCompleted: true,
		view: 'debug',
	})) as {
		ok: boolean;
		data?: { patterns?: Array<{ type: string; status?: string }> };
		meta?: { debug?: { candidates?: Array<{ type: string; accepted: boolean; reason?: string; status?: string }> } };
	};
	expect(res.ok).toBe(true);
	const candidates = res.meta?.debug?.candidates ?? [];
	return {
		patterns: res.data?.patterns ?? [],
		reasons: candidates.filter((c) => !c.accepted).map((c) => c.reason),
		acceptedStatuses: candidates.filter((c) => c.accepted).map((c) => c.status),
	};
}

describe('double のサイズ検査（issue #169 / #262 / #268）', () => {
	describe('ブレイク待ちダブルボトム: 深さ（depthPct）', () => {
		// 谷 100 / 100、山 104 → 両脚 (104-100)/104 = 3.85% ≥ 3% で高さは通り、深さ (104-100)/100 = 4% < 5% で落ちる。
		const legPct = (104 - 100) / 104;
		const depth = (104 - 100) / 100;

		it('前提: この形は 1day の heightPct を超え depthPct を割る（帯の内側）', () => {
			expect(legPct).toBeGreaterThanOrEqual(DAY.heightPct);
			expect(depth).toBeLessThan(DAY.depthPct);
		});

		it('1day: 高さは通るが深さで落ち、peak_too_shallow が記録される', async () => {
			const r = await detect(buildFormingDoubleBottom(104), '1day', 'double_bottom');
			expect(r.patterns).toHaveLength(0);
			expect(r.reasons).toContain('peak_too_shallow');
			expect(r.reasons).not.toContain('pattern_too_small');
			expect(r.reasons).not.toContain('forming_peak_too_shallow');
			expect(r.reasons).not.toContain('forming_pattern_height_below_min');
		});

		it('1hour: 同じ値動きは閾値が緩いので検出される（時間足別テーブル / #152）', async () => {
			expect(depth).toBeGreaterThanOrEqual(HOUR.depthPct);
			const r = await detect(buildFormingDoubleBottom(104), '1hour', 'double_bottom');
			expect(r.patterns.map((p) => p.type)).toContain('double_bottom');
			expect(r.patterns[0]?.status).toBe('near_completion');
			expect(r.reasons).not.toContain('peak_too_shallow');
		});

		it('1day: 深さを満たす形（山 105）はこれまでどおり検出される', async () => {
			expect((105 - 100) / 100).toBeGreaterThanOrEqual(DAY.depthPct);
			const r = await detect(buildFormingDoubleBottom(105), '1day', 'double_bottom');
			expect(r.patterns.map((p) => p.type)).toContain('double_bottom');
			expect(r.patterns[0]?.status).toBe('near_completion');
		});

		it('1day: 高さが足りない形（山 102）は pattern_too_small で落ちる（#166 の値動きを据え置き）', async () => {
			// 山 102 → 両脚 (102-100)/102 = 1.96% < 3%。深さの段より前に落ちる。
			expect((102 - 100) / 102).toBeLessThan(DAY.heightPct);
			const r = await detect(buildFormingDoubleBottom(102), '1day', 'double_bottom');
			expect(r.patterns).toHaveLength(0);
			expect(r.reasons).toContain('pattern_too_small');
			expect(r.reasons).not.toContain('peak_too_shallow');
		});
	});

	describe('完成済みダブルトップ: 高さ（heightPct）と深さ（depthPct）', () => {
		it('1day: 山 100 / 谷 96 / 山2 100 は深さ 4% < 5% で valley_too_shallow に落ちる', async () => {
			expect((100 - 96) / 100).toBeGreaterThanOrEqual(DAY.heightPct);
			expect((100 - 96) / 100).toBeLessThan(DAY.depthPct);
			const r = await detect(buildCompletedShapeDoubleTop(96), '1day', 'double_top');
			expect(r.patterns).toHaveLength(0);
			expect(r.reasons).toContain('valley_too_shallow');
			expect(r.reasons).not.toContain('forming_valley_too_shallow');
			expect(r.reasons).not.toContain('forming_pattern_too_small');
		});

		it('1day: 山 100 / 谷 98 / 山2 100 は高さ 2% < 3% で pattern_too_small に落ちる', async () => {
			expect((100 - 98) / 100).toBeLessThan(DAY.heightPct);
			const r = await detect(buildCompletedShapeDoubleTop(98), '1day', 'double_top');
			expect(r.patterns).toHaveLength(0);
			expect(r.reasons).toContain('pattern_too_small');
		});

		// この形状はブレイクのぶん最新足から離れるので `completed` でもライフサイクル絞り込みで出力から落ちることがあり、`data.patterns` の件数ではなくサイズ検査の理由コードが出ないことを見る。
		it('1hour: 同じ値動き（谷 96 / 谷 98）はどちらもサイズ検査を通る（時間足別テーブル / #152）', async () => {
			expect((100 - 98) / 100).toBeGreaterThanOrEqual(HOUR.depthPct);
			for (const valley of [96, 98]) {
				const r = await detect(buildCompletedShapeDoubleTop(valley), '1hour', 'double_top');
				expect(r.reasons, `谷 ${valley}`).not.toContain('valley_too_shallow');
				expect(r.reasons, `谷 ${valley}`).not.toContain('pattern_too_small');
			}
		});
	});
});
