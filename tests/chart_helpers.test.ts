import { describe, expect, it } from 'vitest';
import { buildDepthPaths } from '../tools/chart/depth-paths.js';
import { createCloudPaths } from '../tools/chart/ichimoku-cloud.js';
import { renderSubPanels, type SubPanelContext } from '../tools/chart/render-sub-panels.js';
import { formatYLabel, niceTicks, sanitizeSvg, simplifyPts } from '../tools/chart/svg-utils.js';

describe('niceTicks', () => {
	it('range=0 は単一値を返す', () => {
		expect(niceTicks(10, 10)).toEqual([10]);
	});
	it('min > max は入れ替えて計算する（step×2 の分岐）', () => {
		expect(niceTicks(100, 0)).toEqual([0, 20, 40, 60, 80, 100]);
	});
	it('誤差が小さいとき step×10 に粗くする', () => {
		expect(niceTicks(0, 4999)).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
	});
	it('中間の誤差は step×5', () => {
		expect(niceTicks(0, 2000)).toEqual([0, 500, 1000, 1500, 2000]);
	});
	it('1 未満の range は precision を上げて小数の目盛りを返す', () => {
		expect(niceTicks(0, 1)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
	});
});

describe('formatYLabel', () => {
	it('桁ごとの単位と JPY プレフィックス', () => {
		expect(formatYLabel(1_500_000_000, true)).toBe('¥1.5B');
		expect(formatYLabel(2_500_000, true)).toBe('¥2.50M');
		expect(formatYLabel(25_000_000, false)).toBe('25.0M');
		expect(formatYLabel(50_000, true)).toBe('¥50.0K');
		expect(formatYLabel(150_000, true)).toBe('¥150K');
		expect(formatYLabel(1_500, false)).toBe('1,500');
		expect(formatYLabel(999, true)).toBe('¥999');
	});
	it('負値も絶対値で桁を決める', () => {
		expect(formatYLabel(-2_500_000, true)).toBe('¥-2.50M');
	});
});

describe('simplifyPts', () => {
	it('tolerance<=0 と 2 点以下はそのまま返す', () => {
		const pts = [
			{ x: 0, y: 0 },
			{ x: 1, y: 1 },
		];
		expect(simplifyPts(pts, 0)).toBe(pts);
		expect(simplifyPts(pts, 1)).toBe(pts);
	});
	it('直線上の中間点を落とし、意味のある角は残す', () => {
		const line = [
			{ x: 0, y: 0 },
			{ x: 1, y: 0 },
			{ x: 2, y: 0 },
		];
		expect(simplifyPts(line, 0.5)).toHaveLength(2);
		const corner = [
			{ x: 0, y: 0 },
			{ x: 1, y: 5 },
			{ x: 2, y: 0 },
		];
		expect(simplifyPts(corner, 0.5)).toHaveLength(3);
	});
});

describe('sanitizeSvg', () => {
	it('script タグと on* 属性を除去する', () => {
		const dirty = `<svg><script>alert(1)</script><rect onload="x()" onclick='y'/></svg>`;
		const clean = sanitizeSvg(dirty);
		expect(clean).not.toContain('<script');
		expect(clean).not.toContain('onload');
		expect(clean).not.toContain('onclick');
		expect(clean).toContain('<rect');
	});
});

describe('buildDepthPaths', () => {
	const id = (v: number) => v;
	it('空配列はすべて空文字', () => {
		const r = buildDepthPaths([], [], id, id);
		expect(r).toEqual({ bidPath: '', askPath: '', bidFill: '', askFill: '' });
	});
	it('階段 path と塗り（bid=緑 / ask=橙）を生成する', () => {
		const r = buildDepthPaths(
			[
				[100, 1],
				[99, 2],
			],
			[[101, 1.5]],
			id,
			id,
		);
		expect(r.bidPath).toBe('M 100,1 L 99,2');
		expect(r.askPath).toBe('M 101,1.5');
		expect(r.bidFill).toContain('rgba(16,185,129');
		expect(r.bidFill).toContain('Z');
		expect(r.askFill).toContain('rgba(249,115,22');
	});
});

describe('createCloudPaths', () => {
	const ctx = {
		x: (i: number) => i * 10,
		y: (v: number) => 100 - v * 10,
		pastBuffer: 0,
		displayLength: 5,
		forwardShift: 0,
	};

	it('spanA >= spanB が続く区間は緑の雲だけになる', () => {
		const r = createCloudPaths([2, 2, 2], [1, 1, 1], 0, ctx);
		expect(r.greenCloudPath).toContain('Z');
		expect(r.redCloudPath).toBe('');
	});

	it('span が交差すると交点（t=0.5 → x=5, y=80）で分割して緑と赤の両方を生成する', () => {
		const r = createCloudPaths([1, 3], [3, 1], 0, ctx);
		expect(r.redCloudPath).toBe('M 0,70 L 5,80 L 5,80 L 0,90 Z');
		expect(r.greenCloudPath).toBe('M 5,80 L 10,70 L 10,90 L 5,80 Z');
	});

	it('null ギャップで雲を区切る（ギャップ後の区間だけ描く）', () => {
		const r = createCloudPaths([2, null, 2, 2], [1, null, 1, 1], 0, ctx);
		expect((r.greenCloudPath.match(/Z/g) ?? []).length).toBe(1);
	});

	it('表示範囲外の区間はスキップする（maxPosIndex=displayLength+forwardShift+1 まで描く）', () => {
		const narrow = { ...ctx, displayLength: 1 };
		const r = createCloudPaths([2, 2, 2, 2, 2, 2], [1, 1, 1, 1, 1, 1], 0, narrow);
		expect(r.greenCloudPath).toContain('30,80');
		expect(r.greenCloudPath).not.toContain('40,80');
		expect(r.greenCloudPath).not.toContain('50,80');
	});
});

describe('renderSubPanels', () => {
	const baseCtx: SubPanelContext = {
		x: (i: number) => 50 + i * 20,
		padding: { top: 10, right: 20, bottom: 30, left: 40 },
		plotW: 500,
		w: 560,
		barW: 6,
		effectivePrecision: 1,
		pastBuffer: 1,
		displayItems: [
			{ open: 1, close: 2, volume: 10 },
			{ open: 2, close: 1, volume: 5 },
			{ open: 1, close: 1, volume: 0 },
			{ open: 1, close: 3, volume: 7 },
		],
		indicators: {
			macd_series: {
				line: [null, 1, -1, 2, 1.5],
				signal: [null, 0.5, -0.5, 1, 0.8],
				hist: [null, 0.5, -0.5, 1, 0.7],
			},
			RSI_14_series: [null, 30, 75, 50, 40],
		},
	};

	it('panelTypes が空なら何も描かない', () => {
		expect(renderSubPanels([], baseCtx)).toEqual({ svg: '', totalHeight: 0 });
	});

	it('MACD / RSI / Volume の 3 パネルと凡例を描き、高さはパネル数に比例する', () => {
		const r = renderSubPanels(['macd', 'rsi', 'volume'], baseCtx);
		expect(r.totalHeight).toBe(3 * 120 + 3 * 24);
		expect(r.svg).toContain('MACD');
		expect(r.svg).toContain('Signal');
		expect(r.svg).toContain('RSI (14)');
		expect(r.svg).toContain('Volume');
		expect(r.svg).toContain('>Up</text>');
		expect(r.svg).toContain('>Down</text>');
	});

	it('MACD 単独パネル: hist 正負で 0 ラインの破線が出て、hist バー（width=4.2）が null 以外の本数だけ描かれる', () => {
		const r = renderSubPanels(['macd'], baseCtx);
		// RSI パネルの midline も "4 4" を出すので、MACD 単独で検証する
		expect(r.svg).toContain('stroke-dasharray="4 4"');
		expect(r.svg.match(/width="4.2"/g)).toHaveLength(4);
	});

	it('Volume 単独パネル: データバー（width=6）は出来高ゼロを除く本数だけ描かれる', () => {
		const r = renderSubPanels(['volume'], baseCtx);
		// volumes [10, 5, 0, 7] → ゼロの 1 本を除く 3 本
		expect(r.svg.match(/width="6"/g)).toHaveLength(3);
	});

	it('indicators が無い MACD パネルは凡例だけ描く（値ブロックをスキップ）', () => {
		const r = renderSubPanels(['macd'], { ...baseCtx, indicators: undefined });
		expect(r.svg).toContain('MACD');
		expect(r.svg).not.toContain('<path');
	});

	it('全出来高ゼロの Volume パネルはデータバーを描かない（凡例 8px スウォッチのみ）', () => {
		const items = baseCtx.displayItems.map((d) => ({ ...d, volume: 0 }));
		const r = renderSubPanels(['volume'], { ...baseCtx, displayItems: items });
		expect(r.svg).toContain('Volume');
		// データバーは barW=6（width="6"）、凡例は width="8" なので幅で区別できる
		expect(r.svg.match(/width="6"/g)).toBeNull();
	});
});
