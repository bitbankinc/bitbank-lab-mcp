import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
}));
vi.mock('sharp', () => ({
	default: vi.fn(),
}));

import { existsSync, mkdirSync } from 'node:fs';
import sharp from 'sharp';
import { generateBacktestChartFilename, svgToPng } from '../../../tools/trading_process/lib/svg_to_png.js';

afterEach(() => {
	vi.resetAllMocks();
});

function makeSharpPipeline(toFile = vi.fn().mockResolvedValue(undefined)) {
	const png = vi.fn().mockReturnValue({ toFile });
	const resize = vi.fn();
	const pipeline = { png, resize } as unknown as ReturnType<typeof sharp>;
	vi.mocked(resize).mockReturnValue(pipeline);
	vi.mocked(sharp).mockReturnValue(pipeline);
	return { pipeline, png, resize, toFile };
}

describe('generateBacktestChartFilename', () => {
	it('正しいフォーマットのファイル名を生成する', () => {
		const filename = generateBacktestChartFilename('btc_jpy', '1D', 'sma_cross');
		expect(filename).toMatch(/^backtest_btcjpy_1D_sma_cross_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.png$/);
	});

	it('SVG フォーマットを指定できる', () => {
		const filename = generateBacktestChartFilename('eth_jpy', '4H', 'macd', 'svg');
		expect(filename).toMatch(/\.svg$/);
		expect(filename).toContain('ethjpy');
		expect(filename).toContain('4H');
		expect(filename).toContain('macd');
	});

	it('デフォルトは PNG', () => {
		const filename = generateBacktestChartFilename('btc_jpy', '1D', 'test');
		expect(filename).toMatch(/\.png$/);
	});

	it('ペア名のアンダースコアを除去する', () => {
		const filename = generateBacktestChartFilename('xrp_jpy', '1H', 'rsi');
		expect(filename).toContain('xrpjpy');
		expect(filename).not.toContain('xrp_jpy');
	});

	// パス区切りやドットを含む値が渡ってもファイル名がディレクトリを抜け出さないこと
	// （防御的サニタイズ。pair は上流の ensurePair で弾かれる前提だが、局所でも保証する）
	it('パストラバーサルを含むペア名からパス区切りとドットを除去する', () => {
		const filename = generateBacktestChartFilename('../../etc/passwd', '1D', 'sma_cross');
		expect(filename).not.toContain('/');
		expect(filename).not.toContain('..');
		expect(filename).toMatch(/^backtest_etcpasswd_1D_sma_cross_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.png$/);
	});

	it('バックスラッシュ・null バイト等の危険文字も除去する', () => {
		const filename = generateBacktestChartFilename('..\\evil\0name', '1D/../x', 'rsi');
		expect(filename).not.toContain('\\');
		expect(filename).not.toContain('\0');
		expect(filename).not.toContain('/');
		expect(filename).not.toContain('..');
	});

	it('正常なペア名のファイル名フォーマットはサニタイズ後も変わらない（回帰）', () => {
		const filename = generateBacktestChartFilename('btc_jpy', '1D', 'sma_cross');
		expect(filename).toMatch(/^backtest_btcjpy_1D_sma_cross_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.png$/);
	});
});

describe('svgToPng', () => {
	it('ディレクトリが存在する場合は mkdirSync を呼ばない', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		makeSharpPipeline();
		await svgToPng('<svg/>', '/output/chart.png');
		expect(mkdirSync).not.toHaveBeenCalled();
	});

	it('ディレクトリが存在しない場合は mkdirSync を呼ぶ', async () => {
		vi.mocked(existsSync).mockReturnValue(false);
		makeSharpPipeline();
		await svgToPng('<svg/>', '/output/chart.png');
		expect(mkdirSync).toHaveBeenCalledWith('/output', { recursive: true });
	});

	it('width/height 未指定時は resize を呼ばない', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		const { resize } = makeSharpPipeline();
		await svgToPng('<svg/>', '/output/chart.png');
		expect(resize).not.toHaveBeenCalled();
	});

	it('width と height 両方指定時は resize を呼ぶ', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		const { resize } = makeSharpPipeline();
		await svgToPng('<svg/>', '/output/chart.png', { width: 800, height: 600 });
		expect(resize).toHaveBeenCalledWith(800, 600, { fit: 'inside', withoutEnlargement: true });
	});

	it('width のみ指定時も resize を呼ぶ', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		const { resize } = makeSharpPipeline();
		await svgToPng('<svg/>', '/output/chart.png', { width: 800 });
		expect(resize).toHaveBeenCalledWith(800, undefined, { fit: 'inside', withoutEnlargement: true });
	});

	it('height のみ指定時も resize を呼ぶ', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		const { resize } = makeSharpPipeline();
		await svgToPng('<svg/>', '/output/chart.png', { height: 600 });
		expect(resize).toHaveBeenCalledWith(undefined, 600, { fit: 'inside', withoutEnlargement: true });
	});

	it('出力パスをそのまま返す', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		makeSharpPipeline();
		const result = await svgToPng('<svg/>', '/output/chart.png');
		expect(result).toBe('/output/chart.png');
	});
});
