/**
 * issue #138 欠陥 2-2 の回帰テスト — triple / H&S のサイズ検査。
 *
 * `detect_doubles.ts` だけが持っていた `MIN_PATTERN_HEIGHT_PCT` / `MIN_DEPTH_PCT` の
 * 検査を `structural.ts` に引き上げ、`detect_triples.ts` / `detect_hs.ts` へ横展開した。
 * 修正前は **double なら弾かれる小ささのレンジ往復が、その上端と下端を別々に拾われて
 * `triple_top` と `triple_bottom` の両方として同時に検出**されていた
 * （BTC/JPY 1時間足・パターン高さ 1.66%）。
 *
 * 合成データなので閾値そのものの妥当性は担保できない（閾値に合わせて作れてしまう）。
 * ここで固定するのは **「double と同じ値で弾かれること」と「弾く方向に振りすぎて
 * いないこと」** の 2 点。
 *
 * **issue #152 で閾値が時間足別になった。** サイズ検査そのものの回帰はアンカーの `1day`
 * （3% / 5% で据え置き）で見る。`1hour` は 0.62% / 1.04% まで下がるので同じ形が通るが、
 * #138 の芯である「1 本のレンジが top と bottom の両方に化ける」は #140 の構造ゲートが
 * 落とす。両方を別々の it で固定してある。
 */
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

/**
 * 単体テストのコメントの %（3% / 5%）は **1day の閾値**を指す。時間足別化（issue #152）後も
 * 1day はアンカーとして据え置きなので、ここは `getSizeThresholdsForTf('1day')` で引く。
 */
const DAY = getSizeThresholdsForTf('1day');

/** 固定の起点から h 時間後。相対時刻にしないのは実行日でパターンが動かないようにするため。 */
function isoAtHour(h: number): string {
	return dayjs.utc('2026-08-24T00:00:00Z').add(h, 'hour').toISOString();
}

function mkCandle(h: number, close: number): Candle {
	const wick = Math.round(close * 0.0004);
	return { isoTime: isoAtHour(h), open: close, high: close + wick, low: close - wick, close, volume: 100 };
}

/**
 * 山 `hi` / 谷 `lo` を 10 本ずつで往復するレンジ相場を 91 本作る。
 * 端をコサインでなだらかにして、折り返し 1 本だけが極値になるようにしている。
 */
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
		// 1 つ目の谷 105 の両隣は 100 / 120 → 平均 110。押しは 4.5% で不合格。
		// 山の全体平均（(100 + 120 + 140) / 3 = 120）で測ると 12.5% になり合格してしまう配置で、
		// H&S の頭が平均を押し上げて肩-ネックライン間の浅さを隠すのと同じ形。
		expect(validatePatternSize('top', [pv(100), pv(105), pv(120), pv(100), pv(140)], DAY)).toBe('valley_too_shallow');
	});

	it('3 点なら double の検査と同じ形に縮退する', () => {
		// 高さ 4%（>= 3%）だが押しが 4%（< 5%）。double の validateTopSize と同じ判定。
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
		// issue #138 の実例（BTC/JPY 1hour, 谷 12,521,114 〜 山 12,726,672 の約 1.6%）に相当。
		// 修正前はこの 1 本の系列から triple_top と triple_bottom が両方返っていた。
		//
		// **時間足別化（issue #152）後、サイズ検査そのものを見るのは 1day で行う。** 1day は
		// アンカーで閾値が据え置き（3% / 5%）なので、#138 が固定した「double なら弾かれる
		// 小ささが triple / H&S でも弾かれる」がそのまま成立する。1hour での挙動は次の it が
		// 別途固定する（閾値が 0.62% / 1.04% に下がるので、この形はサイズでは落ちない）。
		const { types, candidates } = await detectOnRange(12_525_000, 12_720_000, '1day');

		expect(types.filter((t) => t === 'triple_top')).toHaveLength(0);
		expect(types.filter((t) => t === 'triple_bottom')).toHaveLength(0);

		// 別経路の silent reject で落ちていないことを担保するため理由コードを明示的に見る。
		// double と同じ命名で view=debug に出ること（issue #138 の受け入れ条件）。
		for (const type of ['triple_top', 'triple_bottom']) {
			expect(candidates.some((c) => c.type === type && !c.accepted && c.reason === 'pattern_too_small')).toBe(true);
		}
		// 同じ系列で double も同じ理由で落ちている＝「double なら弾かれる小ささ」の裏取り。
		expect(candidates.some((c) => c.type === 'double_top' && c.reason === 'pattern_too_small')).toBe(true);
	});

	it('同じ形が 1hour ではサイズ検査を通り、それでも triple_top / triple_bottom の同時検出にはならない', async () => {
		// **issue #152 で 1hour の閾値が 0.62% / 1.04% に下がったので、この形は通る。**
		// 高さ 1.533% は 1hour の下限の 2.5 倍、押しの深さ 1.533% は 1.47 倍。BTC/JPY 1hour の
		// 実測 ATR 0.57% で読むと 2.69 ATR で、1day が要求する 1.09 ATR より大きい
		// （この合成系列自身の ATR は 0.187% なので、系列の自前のボラで測れば 8.2 ATR）。
		//
		// **#138 欠陥 2-2 の芯は「1 本のレンジが triple_top と triple_bottom の両方に化ける」**
		// という構造的矛盾のほうで、そこは #140 の構造ゲートが落とす——レンジの往復は
		// 戻り率がちょうど 1.0 になり `retracement_out_of_band` に当たる。サイズ検査を
		// 緩めても矛盾は戻ってこないことをここで固定する。
		const { types, candidates } = await detectOnRange(12_525_000, 12_720_000, '1hour');

		// 同時検出にならない: bottom 側は 1 件も残らない。
		expect(types.filter((t) => t === 'triple_bottom')).toHaveLength(0);
		expect(
			candidates.filter((c) => c.type === 'triple_bottom' && c.reason === 'retracement_out_of_band').length,
		).toBeGreaterThan(0);

		// top 側で残る 1 件は**スキャン窓の左端の窓**。構造ゲートは先行極値が取れないと
		// スキップする仕様（`no_prior_extreme`）で、左端の窓には先行スイングが存在しない。
		// 先行極値が取れる窓（2 つ目以降）は top 側も同じ理由で落ちている。
		expect(types.filter((t) => t === 'triple_top')).toHaveLength(1);
		expect(
			candidates.filter((c) => c.type === 'triple_top' && c.reason === 'retracement_out_of_band').length,
		).toBeGreaterThan(0);

		// サイズ検査では落ちていないこと（理由が構造ゲートに移っただけであることの裏取り）。
		expect(candidates.filter((c) => c.type === 'triple_top' && c.reason === 'pattern_too_small')).toHaveLength(0);
	});

	it('同じ形でも値幅が十分ならサイズ検査では落ちない（過剰棄却の回帰）', async () => {
		// 上と同一の形状で振幅だけを 15.4% に広げたもの。**サイズ検査の理由コードが出ないこと**で
		// 過剰棄却を見る。
		//
		// 旧版はここで `types` に triple_top / triple_bottom が入ることを見ていたが、
		// #138 欠陥 2-1（構造ゲートの横展開）以降、**先行トレンドの無い純粋なレンジの往復は
		// 構造ゲート側で落ちる**（戻り率 = 1.0 → `retracement_out_of_band`）。落ちる理由が
		// サイズ検査から構造ゲートに移っただけで、サイズ検査が過剰に弾いていないことは
		// 理由コードで直接確認できる。先行トレンドを伴う形が残ることは
		// `tests/patterns/structural-gates-triple-hs.test.ts` が固定する。
		const { candidates } = await detectOnRange(11_000_000, 12_700_000);
		const sizeReasons = ['pattern_too_small', 'valley_too_shallow', 'peak_too_shallow'];
		for (const type of ['triple_top', 'triple_bottom']) {
			expect(candidates.filter((c) => c.type === type && sizeReasons.includes(String(c.reason)))).toHaveLength(0);
			// **両種別について**構成点まで到達していること（別経路の silent reject で消えている
			// わけではないこと）の裏取り。片方だけ見ると、もう片方がサイズ検査より手前で
			// 落ちていても上の「サイズ系の理由が 0 件」が空振りで通ってしまう。
			expect(candidates.some((c) => c.type === type && c.reason === 'retracement_out_of_band')).toBe(true);
		}
	});
});
