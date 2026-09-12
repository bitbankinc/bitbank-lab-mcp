import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DetectPatternsInputSchema } from '../../src/schemas.js';
import {
	getConvergenceFactorForTf,
	getDefaultParamsForTf,
	getDefaultToleranceForTf,
	getHeadProminenceForTf,
	getMinFitForTf,
	getSizeThresholdsForTf,
	getTriangleCoeffForTf,
	getTriangleWindowSize,
	MIN_CONFIDENCE,
	resolveParams,
	SCHEMA_DEFAULTS,
} from '../../tools/patterns/config.js';
import { MIN_DEPTH_PCT, MIN_PATTERN_HEIGHT_PCT } from '../../tools/patterns/structural.js';

/**
 * `MIN_CONFIDENCE` の**エントリ集合そのもの**を固定する（issue #206）。
 *
 * #199 まで本表には double / H&S の 4 エントリも並んでいたが、**どの検出器も読んでいない
 * 死んだ定義**だった（旧テストは「主要パターン種別が定義されている」として、まさにその
 * 死んだエントリの存在を要求していた——表の見た目だけを固定していて、効くかどうかは
 * 一切見ていなかった）。#206 で実測のうえ削除した判断を、ここで機械的に固定する。
 *
 * 足したくなったら先に `tools/patterns/config.ts` の docstring を読むこと。
 * triple の 0.6 が非任意なのは**分布の空白帯（0.55〜0.59）に置いた線**だからで、
 * H&S / double にはその性質が無い（連続分布・棄却集合がクラスにならない・double は no-op）。
 */
describe('MIN_CONFIDENCE', () => {
	it('エントリは triple の 2 つだけ（double / H&S は #206 で削除。増やさない）', () => {
		expect(Object.keys(MIN_CONFIDENCE).sort()).toEqual(['triple_bottom', 'triple_top']);
		expect(MIN_CONFIDENCE.triple_top).toBe(0.6);
		expect(MIN_CONFIDENCE.triple_bottom).toBe(0.6);
	});

	it('値は 0-1 の範囲', () => {
		for (const v of Object.values(MIN_CONFIDENCE)) {
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
		}
	});

	/**
	 * 「表にエントリがある」と「検出器が読んでいる」は別（#206 が起きた原因そのもの）。
	 * 読み手を `detect_triples.ts` だけに固定して、**表を増やさずに配線だけ増える**逆向きの
	 * 事故も止める。tripwire であって証明ではない——再 export 経由の間接参照は拾えない。
	 */
	it('`MIN_CONFIDENCE` を読む検出器は detect_triples.ts だけ', () => {
		const patternsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'patterns');
		const readers = fs
			.readdirSync(patternsDir)
			.filter((f) => f.startsWith('detect_') && f.endsWith('.ts'))
			.filter((f) => /\bMIN_CONFIDENCE\b/.test(fs.readFileSync(path.join(patternsDir, f), 'utf8')));
		expect(readers).toEqual(['detect_triples.ts']);
	});
});

describe('SCHEMA_DEFAULTS', () => {
	it('既定値が正しい', () => {
		expect(SCHEMA_DEFAULTS.swingDepth).toBe(7);
		expect(SCHEMA_DEFAULTS.minBarsBetweenSwings).toBe(5);
		expect(SCHEMA_DEFAULTS.tolerancePct).toBe(0.04);
	});
});

describe('getDefaultParamsForTf', () => {
	it('1hour は swingDepth=3 を返す', () => {
		const p = getDefaultParamsForTf('1hour');
		expect(p.swingDepth).toBe(3);
		expect(p.minBarsBetweenSwings).toBe(2);
	});

	it('1day は swingDepth=6 を返す', () => {
		const p = getDefaultParamsForTf('1day');
		expect(p.swingDepth).toBe(6);
		expect(p.minBarsBetweenSwings).toBe(4);
	});

	it('1week は swingDepth=7 を返す', () => {
		const p = getDefaultParamsForTf('1week');
		expect(p.swingDepth).toBe(7);
	});

	it('不明な時間軸はフォールバックを返す', () => {
		const p = getDefaultParamsForTf('unknown');
		expect(p.swingDepth).toBe(6);
		expect(p.minBarsBetweenSwings).toBe(4);
	});

	it('分足は低い swingDepth を返す', () => {
		expect(getDefaultParamsForTf('5min').swingDepth).toBe(2);
		expect(getDefaultParamsForTf('15min').swingDepth).toBe(3);
		expect(getDefaultParamsForTf('30min').swingDepth).toBe(3);
	});
});

describe('getDefaultToleranceForTf', () => {
	it('1hour は 0.05 を返す', () => {
		expect(getDefaultToleranceForTf('1hour')).toBe(0.05);
	});

	it('1day はフォールバックの 0.04 を返す', () => {
		expect(getDefaultToleranceForTf('1day')).toBe(0.04);
	});

	it('1week は 0.035 を返す', () => {
		expect(getDefaultToleranceForTf('1week')).toBe(0.035);
	});

	it('短期足はより広い許容誤差を返す', () => {
		expect(getDefaultToleranceForTf('15min')).toBe(0.06);
	});
});

describe('getConvergenceFactorForTf', () => {
	it('短期足は 0.6 を返す', () => {
		expect(getConvergenceFactorForTf('1hour')).toBe(0.6);
		expect(getConvergenceFactorForTf('4hour')).toBe(0.6);
	});

	it('デフォルトは 0.8', () => {
		expect(getConvergenceFactorForTf('1day')).toBe(0.8);
		expect(getConvergenceFactorForTf('1week')).toBe(0.8);
	});
});

describe('getTriangleCoeffForTf', () => {
	it('短期足のcoeffを返す', () => {
		const c = getTriangleCoeffForTf('1hour');
		expect(c.flat).toBe(1.2);
		expect(c.move).toBe(0.8);
	});

	it('デフォルトのcoeffを返す', () => {
		const c = getTriangleCoeffForTf('1day');
		expect(c.flat).toBe(0.8);
		expect(c.move).toBe(1.2);
	});
});

describe('getMinFitForTf', () => {
	it('1hour は 0.6', () => {
		expect(getMinFitForTf('1hour')).toBe(0.6);
	});

	it('1day は 0.7', () => {
		expect(getMinFitForTf('1day')).toBe(0.7);
	});

	it('デフォルトは 0.75', () => {
		expect(getMinFitForTf('1week')).toBe(0.75);
	});
});

describe('getTriangleWindowSize', () => {
	it('時間軸ごとに異なるウィンドウサイズ', () => {
		expect(getTriangleWindowSize('1month')).toBe(30);
		expect(getTriangleWindowSize('1week')).toBe(40);
		expect(getTriangleWindowSize('1day')).toBe(50);
		expect(getTriangleWindowSize('1hour')).toBe(40);
	});

	it('デフォルトは 20', () => {
		expect(getTriangleWindowSize('unknown')).toBe(20);
	});
});

describe('resolveParams', () => {
	it('オプションなしで時間軸のデフォルト値を使用', () => {
		const result = resolveParams('1day', {});
		expect(result.swingDepth).toBe(6);
		expect(result.tolerancePct).toBe(0.04);
		expect(result.minBarsBetweenSwings).toBe(4);
		expect(result.headProminencePct).toBe(0.04);
		expect(result.sources).toEqual({
			swingDepth: 'auto',
			tolerancePct: 'auto',
			minBarsBetweenSwings: 'auto',
			headProminencePct: 'auto',
		});
	});

	it('スキーマデフォルト値(7)は時間軸オートに置換', () => {
		const result = resolveParams('1hour', { swingDepth: 7 });
		expect(result.swingDepth).toBe(3); // 1hour のデフォルト
	});

	it('スキーマデフォルトでないカスタム値はそのまま使用', () => {
		const result = resolveParams('1day', { swingDepth: 10 });
		expect(result.swingDepth).toBe(10);
		// 由来はパラメータごとに割れる（旧 autoScaled は集約フラグだったので表現できなかった）
		expect(result.sources.swingDepth).toBe('explicit');
		expect(result.sources.minBarsBetweenSwings).toBe('auto');
	});

	it('tolerancePct のスキーマデフォルト(0.04)は時間軸オートに置換', () => {
		const result = resolveParams('1hour', { tolerancePct: 0.04 });
		expect(result.tolerancePct).toBe(0.05); // 1hour のデフォルト
	});

	it('カスタム tolerancePct はそのまま使用', () => {
		const result = resolveParams('1day', { tolerancePct: 0.1 });
		expect(result.tolerancePct).toBe(0.1);
	});

	// ── headProminencePct（issue #149） ──

	it('headProminencePct 未指定時は getHeadProminenceForTf の時間軸オート値を使う（tolerancePct とは別表。issue #198）', () => {
		const result = resolveParams('1hour', {});
		expect(result.headProminencePct).toBe(0.0083); // 1hour 専用テーブル（getHeadProminenceForTf）
		expect(result.tolerancePct).toBe(0.05); // tolerancePct は別表のまま
		expect(result.headProminencePct).not.toBe(result.tolerancePct); // #198 以前は誤って同値だった
	});

	it('カスタム headProminencePct はそのまま使用', () => {
		const result = resolveParams('1day', { headProminencePct: 0.02 });
		expect(result.headProminencePct).toBe(0.02);
	});

	// ── 述語のエッジケース（#184 のリファクタで実効値が動いていないことの固定） ──
	// `resolveParams` は入れ子三項から `xxxExplicit` の平坦な述語に書き換えたが、
	// **パラメータごとの述語は元のまま**（`swingDepth` / `minBarsBetweenSwings` は
	// `Number.isFinite`、`tolerancePct` / `headProminencePct` は `typeof number && !NaN`）。
	// 揃えると `Infinity` の扱いが変わって実効値が動くため。スキーマは値域を縛るので
	// MCP 経路では届かないが、直接呼びの経路では届く。

	it('Infinity: swingDepth は時間軸オートに落ち、tolerancePct はそのまま通る（旧実装と同じ）', () => {
		const result = resolveParams('1day', { swingDepth: Number.POSITIVE_INFINITY });
		expect(result.swingDepth).toBe(6); // Number.isFinite(Infinity) === false → auto
		expect(result.sources.swingDepth).toBe('auto');

		const tol = resolveParams('1day', { tolerancePct: Number.POSITIVE_INFINITY });
		expect(tol.tolerancePct).toBe(Number.POSITIVE_INFINITY); // typeof number && !NaN → explicit
		expect(tol.sources.tolerancePct).toBe('explicit');
	});

	it('NaN: 4 パラメータとも時間軸オートに落ちる', () => {
		const result = resolveParams('1day', {
			swingDepth: Number.NaN,
			minBarsBetweenSwings: Number.NaN,
			tolerancePct: Number.NaN,
			headProminencePct: Number.NaN,
		});
		expect(result.swingDepth).toBe(6);
		expect(result.minBarsBetweenSwings).toBe(4);
		expect(result.tolerancePct).toBe(0.04);
		expect(result.headProminencePct).toBe(0.04);
		expect(Object.values(result.sources)).toEqual(['auto', 'auto', 'auto', 'auto']);
	});

	it('tolerancePct を明示的に変えても headProminencePct には影響しない', () => {
		// issue #149: 旧実装は同じ値を共有していたため、tolerancePct を下げると
		// 意図とは逆に頭の判定が厳しくなった。分離後は tolerancePct を動かしても
		// headProminencePct（未指定なら getHeadProminenceForTf の時間軸オート値のまま。issue #198）
		// は変わらない。
		const result = resolveParams('1hour', { tolerancePct: 0.01 });
		expect(result.tolerancePct).toBe(0.01);
		expect(result.headProminencePct).toBe(0.0083); // 1hour のオート値のまま（getHeadProminenceForTf）
	});
});

/**
 * **MCP 経路（`DetectPatternsInputSchema.parse()` を通した値）での由来判定**（issue #184 欠陥 B）。
 *
 * 上の `describe('resolveParams')` は `resolveParams` を**直接**呼んでおり、
 * `.default()` が埋まらないので `opts.swingDepth === undefined` の経路を通る。
 * ところが MCP 経路では `.default()` が必ず値を埋めるため、**その経路は実在しない**。
 * 旧 `autoScaled` は「`swingDepth` / `minBarsBetweenSwings` がどちらも未指定」で判定していたので、
 * MCP 経路では**常に `false`** を返していた——`{"pair":"btc_jpy","type":"1hour"}` のように
 * 何も指定していない（＝解決値が完全に時間軸オートの 3 / 2 / 0.05 になる）呼び出しでもだ。
 *
 * 直接呼びのテストしか無かったことがこの欠陥を見逃した原因なので、
 * **入力スキーマを通した値で**固定する。
 */
describe('resolveParams: MCP 入力経路（DetectPatternsInputSchema.parse を通す）', () => {
	/** MCP サーバと同じ順序で解決する: 入力スキーマ parse → resolveParams。 */
	function resolveViaSchema(input: Record<string, unknown>) {
		const parsed = DetectPatternsInputSchema.parse(input);
		return { parsed, resolved: resolveParams(parsed.type, parsed) };
	}

	it('.default() が sentinel 値を埋める（未指定が resolveParams に届かない）', () => {
		const { parsed } = resolveViaSchema({ pair: 'btc_jpy', type: '1hour' });
		// ここが崩れたら #182 案 B（`.default()` 除去）が入ったということ。
		// そのときは「未指定」と「既定値の明示指定」が区別できるようになるので、
		// 下の auto 判定の意味づけも見直すこと。
		expect(parsed.swingDepth).toBe(SCHEMA_DEFAULTS.swingDepth);
		expect(parsed.minBarsBetweenSwings).toBe(SCHEMA_DEFAULTS.minBarsBetweenSwings);
		expect(parsed.tolerancePct).toBe(SCHEMA_DEFAULTS.tolerancePct);
		// headProminencePct だけは `.default()` が無いので undefined のまま届く（#149 / PR #153）
		expect(parsed.headProminencePct).toBeUndefined();
	});

	it('パラメータ未指定 → 実効値は時間軸オートで、4 つとも source=auto', () => {
		// **旧 autoScaled が false を返していたケース。** 実効値は完全にオート（3 / 2 / 0.05）。
		const { resolved } = resolveViaSchema({ pair: 'btc_jpy', type: '1hour' });
		expect(resolved.swingDepth).toBe(3);
		expect(resolved.minBarsBetweenSwings).toBe(2);
		expect(resolved.tolerancePct).toBe(0.05);
		expect(resolved.headProminencePct).toBe(0.0083); // getHeadProminenceForTf('1hour')。tolerancePct とは別表（issue #198）
		expect(resolved.sources).toEqual({
			swingDepth: 'auto',
			minBarsBetweenSwings: 'auto',
			tolerancePct: 'auto',
			headProminencePct: 'auto',
		});
	});

	it('swingDepth だけ明示 → そのパラメータだけ explicit（集約フラグでは表現できなかった）', () => {
		const { resolved } = resolveViaSchema({ pair: 'btc_jpy', type: '1hour', swingDepth: 4 });
		expect(resolved.swingDepth).toBe(4);
		expect(resolved.sources.swingDepth).toBe('explicit');
		expect(resolved.sources.minBarsBetweenSwings).toBe('auto');
		expect(resolved.sources.tolerancePct).toBe('auto');
	});

	it('sentinel 値を明示指定 → 実効値もオートで source も auto（未指定と区別できない）', () => {
		// `.default()` がある限りこの 2 者は resolveParams に同じ値で届く。
		// **本 PR では区別しない**（どちらでも実効値は同じで、見せたいのは実効値のほう）。
		const { resolved } = resolveViaSchema({
			pair: 'btc_jpy',
			type: '1hour',
			swingDepth: SCHEMA_DEFAULTS.swingDepth,
			minBarsBetweenSwings: SCHEMA_DEFAULTS.minBarsBetweenSwings,
			tolerancePct: SCHEMA_DEFAULTS.tolerancePct,
		});
		expect(resolved.swingDepth).toBe(3);
		expect(resolved.minBarsBetweenSwings).toBe(2);
		expect(resolved.tolerancePct).toBe(0.05);
		expect(resolved.sources.swingDepth).toBe('auto');
		expect(resolved.sources.minBarsBetweenSwings).toBe('auto');
		expect(resolved.sources.tolerancePct).toBe('auto');
	});

	it('1hour で tolerancePct=0.05 を明示 → 実効値はオートと同じだが source は explicit', () => {
		// #182 の no-op ケース（0.04 → 0.05 に「緩めた」つもりが前後とも 0.05）。
		// 実効値が動いていないことは値そのもので分かるが、由来が割れることも固定しておく。
		const { resolved } = resolveViaSchema({ pair: 'btc_jpy', type: '1hour', tolerancePct: 0.05 });
		expect(resolved.tolerancePct).toBe(0.05);
		expect(resolved.sources.tolerancePct).toBe('explicit');
	});

	it('headProminencePct は明示すれば必ず explicit（sentinel が無い）', () => {
		const auto = resolveViaSchema({ pair: 'btc_jpy', type: '1hour' });
		expect(auto.resolved.sources.headProminencePct).toBe('auto');
		// tolerancePct のオート値と同値（0.05）を渡しても、こちらは sentinel 扱いにならない
		const explicit = resolveViaSchema({ pair: 'btc_jpy', type: '1hour', headProminencePct: 0.05 });
		expect(explicit.resolved.headProminencePct).toBe(0.05);
		expect(explicit.resolved.sources.headProminencePct).toBe('explicit');
	});
});

describe('getSizeThresholdsForTf', () => {
	it('1day はアンカーで structural.ts の定数と一致する（issue #152 で据え置き）', () => {
		const t = getSizeThresholdsForTf('1day');
		expect(t.heightPct).toBe(MIN_PATTERN_HEIGHT_PCT);
		expect(t.depthPct).toBe(MIN_DEPTH_PCT);
	});

	it('1week / 1month / 未知の時間足も 1day と同値（緩める方向のみという前提）', () => {
		for (const tf of ['1week', '1month', 'unknown']) {
			expect(getSizeThresholdsForTf(tf)).toEqual({ heightPct: MIN_PATTERN_HEIGHT_PCT, depthPct: MIN_DEPTH_PCT });
		}
	});

	it('1hour は実測 ATR 比（0.57% / 2.75%）から導いた値', () => {
		expect(getSizeThresholdsForTf('1hour')).toEqual({ heightPct: 0.0062, depthPct: 0.0104 });
	});

	it('4hour は √t 推定値（4hour の ATR は未実測）', () => {
		expect(getSizeThresholdsForTf('4hour')).toEqual({ heightPct: 0.0122, depthPct: 0.0204 });
	});

	/**
	 * **これが本テーブルの不変条件。** 両方とも下限なので、時間足が短いほど値が小さく
	 * （＝緩く）なっていないと「下位時間足だけ緩める」という設計が成立しない。
	 * 1day を上回る値が 1 つでも入ると検出が減る方向に動き、issue #152 の受け入れ条件
	 * （減る方向の変化 0 件）が壊れる。
	 */
	it('短い時間足ほど緩く、1day を上回る値は無い（単調性）', () => {
		const order = ['1min', '5min', '15min', '30min', '1hour', '4hour', '8hour', '12hour', '1day'];
		const rows = order.map((tf) => getSizeThresholdsForTf(tf));
		for (let i = 1; i < rows.length; i++) {
			expect(rows[i].heightPct).toBeGreaterThan(rows[i - 1].heightPct);
			expect(rows[i].depthPct).toBeGreaterThan(rows[i - 1].depthPct);
		}
		for (const tf of [...order, '1week', '1month']) {
			expect(getSizeThresholdsForTf(tf).heightPct).toBeLessThanOrEqual(MIN_PATTERN_HEIGHT_PCT);
			expect(getSizeThresholdsForTf(tf).depthPct).toBeLessThanOrEqual(MIN_DEPTH_PCT);
		}
	});

	/**
	 * 導出は「1day を 1.0 とした ATR 比を 3% / 5% に掛ける」の 1 本だけ。
	 * 比が height と depth で割れていたら、片方だけ緩めて棄却理由が
	 * `valley_too_shallow` から `pattern_too_small` に移るだけ、という #152 の落とし穴に戻る。
	 */
	it('height と depth は同じ ATR 比から導出されている（片方だけ緩めていない）', () => {
		for (const tf of ['1min', '5min', '15min', '30min', '1hour', '4hour', '8hour', '12hour', '1day']) {
			const t = getSizeThresholdsForTf(tf);
			const heightRatio = t.heightPct / MIN_PATTERN_HEIGHT_PCT;
			const depthRatio = t.depthPct / MIN_DEPTH_PCT;
			// 0.0001 刻みに丸めた表なので、比の一致は丸め誤差の範囲で見る
			expect(Math.abs(heightRatio - depthRatio)).toBeLessThan(0.02);
		}
	});
});

describe('getHeadProminenceForTf', () => {
	const ANCHOR = 0.04; // tolerancePct の 1day 既定値と同値（旧実装が事実上使っていた値）

	it('1day はアンカーで 0.04（tolerancePct の旧既定値と同値）', () => {
		expect(getHeadProminenceForTf('1day')).toBe(ANCHOR);
	});

	it('1week / 1month / 未知の時間足も 1day と同値（緩める方向のみという前提。#152 と同じ扱い）', () => {
		for (const tf of ['1week', '1month', 'unknown']) {
			expect(getHeadProminenceForTf(tf)).toBe(ANCHOR);
		}
	});

	it('1hour は実測 ATR 比（0.57% / 2.75% = 0.2073）から導いた値（issue #198 Phase 1 実測の起点）', () => {
		expect(getHeadProminenceForTf('1hour')).toBe(0.0083);
	});

	it('4hour は √t 推定値（4hour の ATR は未実測。getSizeThresholdsForTf と同じ限界）', () => {
		expect(getHeadProminenceForTf('4hour')).toBe(0.0163);
	});

	/**
	 * **これが本テーブルの不変条件。** `headProminencePct` は大きいほど厳しい（`tolerancePct` とは
	 * 向きが逆）ので、「下位時間足だけ緩める」は値を**小さく**することを意味する
	 * （{@link getSizeThresholdsForTf} と数値の向きは同じだが、下限 vs 最小要求率で「緩い」の
	 * 意味が違う点に注意）。1day を上回る値が 1 つでもあると #198 が直そうとした逆転
	 * （1hour が 1day より厳しい）が形を変えて残る。
	 */
	it('短い時間足ほど緩く（値が小さく）、1day を上回る値は無い（単調性）', () => {
		const order = ['1min', '5min', '15min', '30min', '1hour', '4hour', '8hour', '12hour', '1day'];
		const values = order.map((tf) => getHeadProminenceForTf(tf));
		for (let i = 1; i < values.length; i++) {
			expect(values[i]).toBeGreaterThan(values[i - 1]);
		}
		for (const tf of [...order, '1week', '1month']) {
			expect(getHeadProminenceForTf(tf)).toBeLessThanOrEqual(ANCHOR);
		}
	});

	/**
	 * 導出は {@link getSizeThresholdsForTf} と同じ ATR 比テーブルをアンカー 0.04 に掛けただけ
	 * （新たに ATR を測り直していない）。比が一致していなければ、どちらかの表が個別に
	 * 手直しされて #152 の ATR 比テーブルから乖離したということ。
	 */
	it('getSizeThresholdsForTf と同じ ATR 比から導出されている', () => {
		for (const tf of ['1min', '5min', '15min', '30min', '1hour', '4hour', '8hour', '12hour']) {
			const headRatio = getHeadProminenceForTf(tf) / ANCHOR;
			const sizeRatio = getSizeThresholdsForTf(tf).heightPct / MIN_PATTERN_HEIGHT_PCT;
			// 0.0001 刻みに丸めた表なので、比の一致は丸め誤差の範囲で見る
			expect(Math.abs(headRatio - sizeRatio)).toBeLessThan(0.02);
		}
	});

	it('tolerancePct の時間軸オート表とは独立している（1hour で値が異なる。issue #198）', () => {
		expect(getHeadProminenceForTf('1hour')).not.toBe(getDefaultToleranceForTf('1hour'));
	});
});
