// 合成データなので閾値そのものの妥当性は担保できない。固定するのは「double と同じ値で弾かれること」と「弾く方向に振りすぎていないこと」の 2 点（#138 欠陥 2-2）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import { getSizeThresholdsForTf } from '../../tools/patterns/config.js';
import { MIN_DEPTH_PCT, MIN_PATTERN_HEIGHT_PCT, validatePatternSize } from '../../tools/patterns/structural.js';
import { asMockResult } from '../_assertResult.js';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';

type Candle = { isoTime: string; open: number; high: number; low: number; close: number; volume: number };

const pv = (extremePrice: number) => ({ extremePrice });

/** 単体テストのコメントの %（3% / 5%）は 1day の閾値を指す。1day は時間足別化（issue #152）後もアンカーとして据え置き。 */
const DAY = getSizeThresholdsForTf('1day');

/** 固定の起点から h 時間後。相対時刻にしないのは実行日でパターンが動かないようにするため。 */
function isoAtHour(h: number): string {
	return dayjs.utc('2026-08-24T00:00:00Z').add(h, 'hour').toISOString();
}

function mkCandle(h: number, close: number): Candle {
	const wick = Math.round(close * 0.0004);
	return { isoTime: isoAtHour(h), open: close, high: close + wick, low: close - wick, close, volume: 100 };
}

/** 端をコサインでなだらかにして、折り返し 1 本だけが極値になるようにしている。 */
function buildRangeCandles(lo: number, hi: number): Candle[] {
	const closes: number[] = [lo];
	let up = true;
	for (let seg = 0; seg < 9; seg++) {
		const from = up ? lo : hi;
		const to = up ? hi : lo;
		for (let k = 1; k <= 10; k++) {
			const ease = 0.5 - 0.5 * Math.cos((Math.PI * k) / 10);
			closes.push(Math.round(from + (to - from) * ease));
		}
		up = !up;
	}
	return closes.map((close, i) => mkCandle(i, close));
}

async function detectOnRange(lo: number, hi: number, tf: string = '1hour') {
	const candles = buildRangeCandles(lo, hi);
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
	);
	const res = (await detectPatterns('btc_jpy', tf, candles.length, {
		includeForming: true,
		includeCompleted: true,
		view: 'debug',
	})) as {
		data?: { patterns?: Array<{ type: string }> };
		meta?: { debug?: { candidates?: Array<{ type: string; accepted: boolean; reason?: string }> } };
	};
	return {
		types: (res.data?.patterns ?? []).map((p) => p.type),
		candidates: res.meta?.debug?.candidates ?? [],
	};
}

describe('validatePatternSize', () => {
	it('パターン高さが MIN_PATTERN_HEIGHT_PCT 未満なら pattern_too_small', () => {
		// 全振幅 2%（< 3%）
		expect(validatePatternSize('top', [pv(100), pv(98), pv(100), pv(98), pv(100)], DAY)).toBe('pattern_too_small');
		expect(validatePatternSize('bottom', [pv(98), pv(100), pv(98), pv(100), pv(98)], DAY)).toBe('pattern_too_small');
	});

	it('高さは足りていても押しが浅ければ valley_too_shallow / peak_too_shallow', () => {
		// 高さは 1 つ目の谷で 10% 稼ぎ、2 つ目の谷の押しだけ 3%（< 5%）にする
		expect(validatePatternSize('top', [pv(100), pv(90), pv(100), pv(97), pv(100)], DAY)).toBe('valley_too_shallow');
		expect(validatePatternSize('bottom', [pv(90), pv(100), pv(90), pv(93), pv(90)], DAY)).toBe('peak_too_shallow');
	});

	it('高さも押しも足りていれば null', () => {
		expect(validatePatternSize('top', [pv(100), pv(90), pv(100), pv(90), pv(100)], DAY)).toBeNull();
		expect(validatePatternSize('bottom', [pv(90), pv(100), pv(90), pv(100), pv(90)], DAY)).toBeNull();
	});

	it('押しの深さは「両隣の平均」で測る（double の peakAvg = (a + c) / 2 の一般化）', () => {
		// 1 つ目の谷 105 の両隣は 100 / 120 → 平均 110 で押しは 4.5%。山の全体平均（120）で測ると 12.5% になり合格してしまう配置で、H&S の頭が平均を押し上げて肩-ネックライン間の浅さを隠すのと同じ形。
		expect(validatePatternSize('top', [pv(100), pv(105), pv(120), pv(100), pv(140)], DAY)).toBe('valley_too_shallow');
	});

	it('3 点なら double の検査と同じ形に縮退する', () => {
		// 高さ 4%（>= 3%）だが押しが 4%（< 5%）。double の validateDoubleSize と同じ判定。
		expect(validatePatternSize('top', [pv(100), pv(96), pv(100)], DAY)).toBe('valley_too_shallow');
		expect(validatePatternSize('top', [pv(100), pv(90), pv(100)], DAY)).toBeNull();
	});

	it('構成点が 3 点未満 / 非有限値なら判定しない（素通し）', () => {
		expect(validatePatternSize('top', [pv(100), pv(90)], DAY)).toBeNull();
		expect(validatePatternSize('top', [pv(100), pv(Number.NaN), pv(100)], DAY)).toBeNull();
	});

	it('閾値は double と同値', () => {
		expect(MIN_PATTERN_HEIGHT_PCT).toBe(0.03);
		expect(MIN_DEPTH_PCT).toBe(0.05);
	});
});

describe('detect_patterns: triple / H&S のサイズ検査（issue #138 欠陥 2-2）', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('高さ 1.55% のレンジ往復が 1day では pattern_too_small で弾かれる', async () => {
		// issue #138 の実例（BTC/JPY 1hour, 谷 12,521,114 〜 山 12,726,672 の約 1.6%）に相当。サイズ検査そのものはアンカー（3% / 5% で据え置き）の 1day で見る。
		const { types, candidates } = await detectOnRange(12_525_000, 12_720_000, '1day');

		expect(types.filter((t) => t === 'triple_top')).toHaveLength(0);
		expect(types.filter((t) => t === 'triple_bottom')).toHaveLength(0);

		// 別経路の silent reject で落ちていないことを担保するため、理由コードを明示的に見る。
		for (const type of ['triple_top', 'triple_bottom']) {
			expect(candidates.some((c) => c.type === type && !c.accepted && c.reason === 'pattern_too_small')).toBe(true);
		}
		// 同じ系列で double も同じ理由で落ちている＝「double なら弾かれる小ささ」の裏取り。
		expect(candidates.some((c) => c.type === 'double_top' && c.reason === 'pattern_too_small')).toBe(true);
	});

	it('同じ形が 1hour でも横ばい先行ゲートで triple_top / triple_bottom の同時検出にならない', async () => {
		// issue #152 で 1hour の閾値が 0.62% / 1.04% に下がったので、この形はサイズ検査を通る。#138 の芯は「1 本のレンジが triple_top と triple_bottom の両方に化ける」構造的矛盾のほうで、先行トレンド不一致で除外されて矛盾が戻らないことを固定する。
		const { types, candidates } = await detectOnRange(12_525_000, 12_720_000, '1hour');

		expect(types.filter((t) => t === 'triple_bottom')).toHaveLength(0);
		expect(
			candidates.filter((c) => c.type === 'triple_bottom' && c.reason === 'prior_trend_mismatch:sideways').length,
		).toBeGreaterThan(0);

		// 履歴ウォームアップにより、窓先頭の triple_top も出力前に除外される。
		expect(types.filter((t) => t === 'triple_top')).toHaveLength(0);
		expect(
			candidates.filter((c) => c.type === 'triple_top' && c.reason === 'prior_trend_mismatch:sideways').length,
		).toBeGreaterThan(0);

		// サイズ検査では落ちていないこと（理由が構造ゲートに移っただけであることの裏取り）。
		expect(candidates.filter((c) => c.type === 'triple_top' && c.reason === 'pattern_too_small')).toHaveLength(0);
	});

	it('同じ形でも値幅が十分ならサイズ検査では落ちない（過剰棄却の回帰）', async () => {
		// 上と同一の形状で振幅だけを 15.4% に広げたもの。先行トレンドの無い純粋なレンジの往復は方向ゲートで落ちるので、サイズ検査の理由コードが出ないことで過剰棄却を見る。
		const { candidates } = await detectOnRange(11_000_000, 12_700_000);
		const sizeReasons = ['pattern_too_small', 'valley_too_shallow', 'peak_too_shallow'];
		for (const type of ['triple_top', 'triple_bottom']) {
			expect(candidates.filter((c) => c.type === type && sizeReasons.includes(String(c.reason)))).toHaveLength(0);
			expect(candidates.some((c) => c.type === type && c.reason === 'prior_trend_mismatch:sideways')).toBe(true);
		}
	});
});
