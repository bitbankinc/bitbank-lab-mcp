/**
 * `triple_*` の `pivots` にネックライン定義点（v1 / v2）が入ることを**実データのパイプライン全体**で
 * 固定する（issue #224 症状 3）。
 *
 * 症状: `triple_top` / `triple_bottom` の `pivots` は主構成点 3 点（形成中は 2 点）しか持たず、
 * content に `ネックライン: 12,285,548円（水平）` と書いてあっても、消費者は報告された点から
 * その値を検算できなかった（`neckline[].y` は v1 / v2 の `price` の平均で決まるのに、v1 / v2 が
 * どこにも出ていない）。H&S（p1 / p3）と double（b）は入っていて、**triple だけが例外**だった。
 *
 * ここで固定するのは実データ B（`btc_jpy` の 1 時間足 365 本）を**ネイティブのまま**見た値（#219）。
 * `tf` ラベルだけが `1hour` / `4hour` の 2 通りで、系列は同じ 1 本:
 *
 * | パターン | 時間足 | `pivots`（idx / kind） | `neckline.y` | 検算 |
 * |---|---|---|---:|---|
 * | `triple_bottom` near_completion | `1hour` | 305 L / **308 H** / 313 L / **318 H** / 331 L | 12,601,128 | (12,617,817 + 12,584,439) / 2 |
 * | `triple_top` forming | `4hour` | 294 H / **305 L** / 308 H / **331 L** | 12,490,844.5 | (12,531,708 + 12,449,981) / 2 |
 *
 * 形成中の 3 山目（3 谷目）は現在価格の暫定値なので `pivots` に**入らない**（従来どおり）。
 *
 * > **形成中の行は issue #261 で差し替えた。** 以前は同じ fixture の `1hour` に出ていた
 * > `triple_bottom` forming（313 L / 318 H / 331 L / 355 H、`neckline.y` 12,691,733.5）を使っていたが、
 * > **暫定の 3 谷目（最新足 364 の終値 12,854,642）がネックラインより 162,908.5 円（1.28%）上**にあり、
 * > `validateMainPointsNecklineSide` を形成中に配線した #261 が
 * > `forming_valleys_above_neckline` で落とすようになった。ネックラインの上に抜けている点は
 * > 「支持帯への 3 回目のタッチ」ではないので、落ちるのが正しい。**その棄却も下で固定してある。**
 * > `pivots` の 4 点契約（L-H-L-H / H-L-H-L）は同じ fixture の `4hour` に残った
 * > `triple_top` forming で引き続き実データで押さえる。
 *
 * 判定フィールド（`confidence` / `status` / `neckline` / `breakoutTarget` / `aftermath` /
 * `meta.reduction.tripleHsExcluded`）が動いていないことは 940 ケースの実測で確認済み
 * （CHANGELOG の読む順 50）。既定オプションの回帰ベースライン
 * （`tests/detect_patterns_data_patterns_regression.test.ts`）には #216 / #218 以降 triple が
 * 1 件も残っていないため、本ファイルが triple の実データ回帰を持つ。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import { toolDef as detectPatternsTool } from '../src/handlers/detectPatternsHandler.js';
import analyzeIndicators from '../tools/analyze_indicators.js';
import detectPatterns from '../tools/detect_patterns.js';
import { asMockResult, assertOk } from './_assertResult.js';
import { buildBtcJpy1hour202608Candles } from './fixtures/btc_jpy_1hour_2026_08.js';

type PivotLike = { idx: number; price: number; kind: 'H' | 'L' };

/** 実データ B（`btc_jpy` 1hour）を `analyze_indicators` の応答として 1 回分差し込む。 */
function mockCandles() {
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles: buildBtcJpy1hour202608Candles() } } }),
	);
}

/** `includeForming: true` で `detect_patterns` を走らせ、ok を確認して返す。 */
async function runForming(tf = '1hour') {
	mockCandles();
	const res = await detectPatterns('btc_jpy', tf, 365, { includeForming: true });
	assertOk(res);
	return res;
}

/** 水平ネックラインの y を、報告された `pivots` の中間側 `kind` 2 点の平均から再現する。 */
function necklineFromPivots(pivots: PivotLike[], mainKind: 'H' | 'L'): number {
	const mids = pivots.filter((p) => p.kind !== mainKind);
	expect(mids).toHaveLength(2);
	return (mids[0].price + mids[1].price) / 2;
}

describe('detect_patterns: triple の pivots がネックライン定義点を含む（issue #224 症状 3。実データ B）', () => {
	it('near_completion の triple_bottom は 5 点（L-H-L-H-L）で、2 山の平均が neckline の y に一致する', async () => {
		const res = await runForming();
		const tb = res.data.patterns.find((p) => p.type === 'triple_bottom' && p.status === 'near_completion');
		expect(tb).toBeDefined();
		const pivots = tb?.pivots as PivotLike[];
		expect(pivots.map((p) => [p.idx, p.kind])).toEqual([
			[305, 'L'],
			[308, 'H'],
			[313, 'L'],
			[318, 'H'],
			[331, 'L'],
		]);
		// 検算: (12,617,817 + 12,584,439) / 2 = 12,601,128
		expect(necklineFromPivots(pivots, 'L')).toBe(12_601_128);
		expect(tb?.neckline?.map((n) => n.y)).toEqual([12_601_128, 12_601_128]);
		// 主構成点は kind で取る（位置ではない）。3 谷は据え置き。
		expect(pivots.filter((p) => p.kind === 'L').map((p) => p.idx)).toEqual([305, 313, 331]);
	});

	it('forming の triple_top は 4 点（H-L-H-L）で、暫定 3 山目（現在価格）は含まない', async () => {
		const res = await runForming('4hour');
		const tt = res.data.patterns.find((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(tt).toBeDefined();
		const pivots = tt?.pivots as PivotLike[];
		expect(pivots.map((p) => [p.idx, p.kind])).toEqual([
			[294, 'H'],
			[305, 'L'],
			[308, 'H'],
			[331, 'L'],
		]);
		// 検算: (12,531,708 + 12,449,981) / 2 = 12,490,844.5
		expect(necklineFromPivots(pivots, 'H')).toBe(12_490_844.5);
		expect(tt?.neckline?.map((n) => n.y)).toEqual([12_490_844.5, 12_490_844.5]);
		expect(pivots.filter((p) => p.kind === 'H')).toHaveLength(2);
	});

	/**
	 * 上の表の注記の裏取り（issue #261）。`1hour` に出ていた forming `triple_bottom`
	 * 313-331-364 が**消えたこと**だけでは、理由が #261 のゲートなのか別の変更なのかが読めない。
	 */
	it('1hour の forming triple_bottom は #261 のネックライン側ゲートで落ちる（消えた理由の固定）', async () => {
		mockCandles();
		const res = await detectPatterns('btc_jpy', '1hour', 365, {
			includeForming: true,
			view: 'debug',
			patterns: ['triple_bottom'],
		});
		assertOk(res);
		expect(res.data.patterns.filter((p) => p.type === 'triple_bottom' && p.status === 'forming')).toHaveLength(0);

		const meta = res.meta as { debug?: { candidates?: Array<Record<string, unknown>> } } | undefined;
		const hit = (meta?.debug?.candidates ?? []).find(
			(c) =>
				c.reason === 'forming_valleys_above_neckline' && String((c.indices as number[])?.join('-')) === '313-331-364',
		);
		expect(hit).toBeDefined();
		expect(hit?.details).toMatchObject({
			necklinePrice: 12_691_733.5,
			offenders: [{ idx: 364, price: 12_854_642, deviation: 162_908.5 }],
		});
	});

	it('triple 以外の反転系の pivots 点数は従来どおり（完成済み H&S は 5 点、double は 3 点）', async () => {
		const res = await runForming();
		const lengths = res.data.patterns
			.filter((p) => p.status !== 'forming')
			.filter((p) => /head_and_shoulders|double_/.test(String(p.type)))
			.map((p) => `${p.type}:${(p.pivots ?? []).length}`);
		expect(lengths.length).toBeGreaterThan(0);
		expect(lengths.filter((l) => l.includes('head_and_shoulders')).every((l) => l.endsWith(':5'))).toBe(true);
		expect(lengths.filter((l) => l.startsWith('double_')).every((l) => l.endsWith(':3'))).toBe(true);
	});

	/** `view=full` の content を 1 回分取る。 */
	async function fullContent(tf: string): Promise<string> {
		mockCandles();
		const out = (await detectPatternsTool.handler({
			pair: 'btc_jpy',
			type: tf,
			limit: 365,
			includeForming: true,
			view: 'full',
		})) as { content: Array<{ text: string }> };
		return out.content[0].text;
	}

	it('content: near_completion の価格範囲がネックライン定義点を含んだ幅になる（1hour）', async () => {
		// before は 3 谷だけの 12,449,981 - 12,531,708 円だった。山 308（12,617,817）が上限に入る。
		expect(await fullContent('1hour')).toContain('価格範囲: 12,449,981円 - 12,617,817円');
	});

	it('content: forming も同じで、暫定注記は引き続き出る（4hour）', async () => {
		const text = await fullContent('4hour');
		// before は 2 山だけの 12,617,817 - 12,851,000 円だった。谷 331（12,449,981）が下限に入る。
		expect(text).toContain('価格範囲: 12,449,981円 - 12,851,000円');
		// 形成中 triple の注記は `status === 'forming'` で判定する（`pivots.length === 2` に依存しない）。
		expect(text).toContain('3 山目は現在価格を暫定');
	});
});
