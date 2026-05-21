import { describe, expect, it } from 'vitest';
import renderCandlePatternDiagram, { toolDef } from '../tools/render_candle_pattern_diagram.js';
import { assertOk } from './_assertResult.js';

type Candle = {
	date: string;
	open: number;
	high: number;
	low: number;
	close: number;
	type: 'bullish' | 'bearish';
	isPartial?: boolean;
};

function makeCandle(
	date: string,
	open: number,
	high: number,
	low: number,
	close: number,
	type: 'bullish' | 'bearish',
	isPartial = false,
): Candle {
	return {
		date,
		open,
		high,
		low,
		close,
		type,
		isPartial,
	};
}

function buildSampleCandles(): Candle[] {
	return [
		makeCandle('01/01', 100, 110, 95, 98, 'bearish'),
		makeCandle('01/02', 97, 112, 96, 109, 'bullish'),
		makeCandle('01/03', 109, 115, 105, 111, 'bullish', true),
	];
}

describe('render_candle_pattern_diagram', () => {
	it('title と日付ラベルの XML 特殊文字をエスケープできる', async () => {
		const res = await renderCandlePatternDiagram({
			candles: [makeCandle('01/01<&>', 100, 110, 95, 98, 'bearish'), makeCandle('01/02"', 97, 112, 96, 109, 'bullish')],
			title: '包み線 <demo> & "test"',
			pattern: {
				name: '陽線包み線',
				confirmedDate: '01/02',
				involvedIndices: [0, 1],
			},
		});

		assertOk(res);
		expect(res.data.svg).toContain('包み線 &lt;demo&gt; &amp; &quot;test&quot;');
		expect(res.data.svg).toContain('01/01&lt;&amp;&gt;');
		expect(res.data.svg).toContain('01/02&quot;');
	});

	it('inputSchema: pattern.involvedIndices の負数は拒否するべき', () => {
		const parse = () =>
			toolDef.inputSchema.parse({
				candles: buildSampleCandles(),
				pattern: {
					name: '陽線包み線',
					confirmedDate: '01/02',
					involvedIndices: [-1, 1],
				},
			});

		expect(parse).toThrow();
	});

	it('svg ルート要素に viewBox を持つ（コンテナで縦に切れないように）', async () => {
		const res = await renderCandlePatternDiagram({
			candles: buildSampleCandles(),
			pattern: {
				name: '陽線包み線',
				confirmedDate: '01/02',
				involvedIndices: [0, 1],
			},
		});

		assertOk(res);
		expect(res.data.svg).toMatch(/<svg[^>]*\sviewBox="0 0 \d+ \d+"/);
	});

	it('価格レンジが 0 のときも SVG に NaN や Infinity を含めるべきではない', async () => {
		const res = await renderCandlePatternDiagram({
			candles: [makeCandle('01/01', 100, 100, 100, 100, 'bullish'), makeCandle('01/02', 100, 100, 100, 100, 'bearish')],
			pattern: {
				name: '毛抜き底',
				confirmedDate: '01/02',
				involvedIndices: [0, 1],
			},
		});

		assertOk(res);
		expect(res.data.svg).not.toMatch(/NaN|Infinity/);
	});

	it('ローソク足は plot area 内に水平方向で中央寄せされる（右側余白が膨らまない）', async () => {
		// N=4 candles, plot area = 100..750 (中心 425)
		const res = await renderCandlePatternDiagram({
			candles: [
				makeCandle('05/17', 100, 110, 95, 98, 'bearish'),
				makeCandle('05/18', 97, 112, 96, 109, 'bearish'),
				makeCandle('05/19', 109, 115, 105, 111, 'bearish'),
				makeCandle('05/20', 111, 120, 108, 118, 'bullish'),
			],
			pattern: { name: '明けの明星', confirmedDate: '05/20', involvedIndices: [1, 3] },
		});

		assertOk(res);
		// 日付ラベルの x 座標を抽出。<text x="N" ... > の date が見える形式から拾う
		const xs = [...(res.data.svg ?? '').matchAll(/<text x="([\d.]+)"[^>]*>05\/\d{2}<\/text>/g)].map((m) =>
			Number(m[1]),
		);
		expect(xs).toHaveLength(4);
		// 4 本の中央値が plot area の中央 (425) になっていること（±1px 許容）
		const mid = (xs[0] + xs[xs.length - 1]) / 2;
		expect(Math.abs(mid - 425)).toBeLessThan(1);
	});

	it('N=10 でも候補がプロット領域の右端を超えない（候補数に応じて spacing を縮める）', async () => {
		const candles = Array.from({ length: 10 }, (_, i) =>
			makeCandle(`01/${String(i + 1).padStart(2, '0')}`, 100, 110, 95, 105, 'bullish'),
		);
		const res = await renderCandlePatternDiagram({ candles });

		assertOk(res);
		const xs = [...(res.data.svg ?? '').matchAll(/<text x="([\d.]+)"[^>]*>01\/\d{2}<\/text>/g)].map((m) =>
			Number(m[1]),
		);
		expect(xs).toHaveLength(10);
		// 最右の候補が plotRight (750) を超えない
		expect(xs[xs.length - 1]).toBeLessThan(750);
		// 最左が plotLeft (100) を下回らない
		expect(xs[0]).toBeGreaterThan(100);
	});
});
