import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertOk } from './_assertResult.js';

vi.mock('../tools/analyze_sma_snapshot.js', () => ({
	default: vi.fn(),
}));

import analyzeMtfSma, { toolDef } from '../tools/analyze_mtf_sma.js';
import analyzeSmaSnapshot from '../tools/analyze_sma_snapshot.js';

/** analyze_sma_snapshot の戻り値型。モックが実型からズレないよう明示する。 */
type SmaSnapshotResult = Awaited<ReturnType<typeof analyzeSmaSnapshot>>;

describe('analyze_mtf_sma', () => {
	const mockedAnalyzeSmaSnapshot = vi.mocked(analyzeSmaSnapshot);

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('inputSchema: timeframes は 1 件以上のみ許可するべき', () => {
		const parse = () => toolDef.inputSchema.parse({ pair: 'btc_jpy', timeframes: [], periods: [25, 75, 200] });
		expect(parse).toThrow();
	});

	it('requested timeframe に unknown が含まれる場合 confluence は aligned=false / direction=unknown であるべき', async () => {
		mockedAnalyzeSmaSnapshot
			.mockResolvedValueOnce({
				ok: true,
				summary: 'ok',
				data: {
					alignment: 'bullish',
					summary: { close: 100, align: 'bullish', position: 'above_all' },
					latest: { close: 100 },
					sma: { SMA_25: 90, SMA_75: 80, SMA_200: 70 },
					smas: {},
					crosses: [],
					recentCrosses: [],
					tags: ['sma_bullish_alignment'],
				},
				meta: {
					pair: 'btc_jpy',
					fetchedAt: '2024-01-01T00:00:00.000Z',
					type: '1day',
					count: 220,
					periods: [25, 75, 200],
				},
			})
			.mockResolvedValueOnce({
				ok: true,
				summary: 'ok',
				data: {
					alignment: 'unknown',
					summary: { close: 100, align: 'unknown', position: 'unknown' },
					latest: { close: 100 },
					sma: { SMA_25: null, SMA_75: null, SMA_200: null },
					smas: {},
					crosses: [],
					recentCrosses: [],
					tags: [],
				},
				meta: {
					pair: 'btc_jpy',
					fetchedAt: '2024-01-01T00:00:00.000Z',
					type: '1day',
					count: 220,
					periods: [25, 75, 200],
				},
			})
			.mockResolvedValueOnce({
				ok: true,
				summary: 'ok',
				data: {
					alignment: 'bullish',
					summary: { close: 100, align: 'bullish', position: 'above_all' },
					latest: { close: 100 },
					sma: { SMA_25: 90, SMA_75: 80, SMA_200: 70 },
					smas: {},
					crosses: [],
					recentCrosses: [],
					tags: ['sma_bullish_alignment'],
				},
				meta: {
					pair: 'btc_jpy',
					fetchedAt: '2024-01-01T00:00:00.000Z',
					type: '1day',
					count: 220,
					periods: [25, 75, 200],
				},
			});

		const res = await analyzeMtfSma('btc_jpy', ['1hour', '4hour', '1day'], [25, 75, 200]);

		assertOk(res);
		expect(res.data.confluence.aligned).toBe(false);
		expect(res.data.confluence.direction).toBe('unknown');
	});

	it('重複 timeframes 指定時は analyze_sma_snapshot を重複実行しないべき', async () => {
		mockedAnalyzeSmaSnapshot.mockResolvedValue({
			ok: true,
			summary: 'ok',
			data: {
				alignment: 'bullish',
				summary: { close: 100, align: 'bullish', position: 'above_all' },
				latest: { close: 100 },
				sma: { SMA_25: 90, SMA_75: 80, SMA_200: 70 },
				smas: {},
				crosses: [],
				recentCrosses: [],
				tags: ['sma_bullish_alignment'],
			},
			meta: {
				pair: 'btc_jpy',
				fetchedAt: '2024-01-01T00:00:00.000Z',
				type: '1day',
				count: 220,
				periods: [25, 75, 200],
			},
		});

		const res = await analyzeMtfSma('btc_jpy', ['1hour', '1hour', '4hour'], [25, 75, 200]);

		assertOk(res);
		expect(mockedAnalyzeSmaSnapshot).toHaveBeenCalledTimes(2);
	});

	function smaSnapshotOk(
		alignment: 'bullish' | 'bearish' | 'mixed' | 'unknown',
		metaExtra: { warning?: string; warnings?: string[] } = {},
	): SmaSnapshotResult {
		return {
			ok: true,
			summary: 'ok',
			data: {
				alignment,
				summary: { close: 100, align: alignment, position: alignment === 'bullish' ? 'above_all' : 'unknown' },
				latest: { close: 100 },
				sma: { SMA_25: 90, SMA_75: 80, SMA_200: 70 },
				smas: {},
				crosses: [],
				recentCrosses: [],
				tags: [],
			},
			meta: {
				pair: 'btc_jpy',
				fetchedAt: '2024-01-01T00:00:00.000Z',
				type: '1day',
				count: 220,
				periods: [25, 75, 200],
				...metaExtra,
			},
		};
	}

	it('失敗 TF の synthetic warning が `[tf]` prefix 付きで meta.warning に含まれる', async () => {
		mockedAnalyzeSmaSnapshot
			.mockResolvedValueOnce(smaSnapshotOk('bullish'))
			.mockResolvedValueOnce({ ok: false, summary: 'indicators failed', data: {}, meta: { errorType: 'internal' } })
			.mockResolvedValueOnce(smaSnapshotOk('bullish'));

		const res = await analyzeMtfSma('btc_jpy', ['1hour', '4hour', '1day'], [25, 75, 200]);

		assertOk(res);
		expect(res.meta?.warning).toContain('[4hour]');
		expect(res.meta?.warning).toContain('indicators failed');
	});

	it('子の meta.warning が `[tf]` prefix で集約される', async () => {
		mockedAnalyzeSmaSnapshot
			.mockResolvedValueOnce(smaSnapshotOk('bullish', { warning: '⚠️ partial fetch' }))
			.mockResolvedValueOnce(smaSnapshotOk('bullish'))
			.mockResolvedValueOnce(smaSnapshotOk('bullish'));

		const res = await analyzeMtfSma('btc_jpy', ['1hour', '4hour', '1day'], [25, 75, 200]);

		assertOk(res);
		expect(res.meta?.warning).toContain('[1hour]');
		expect(res.meta?.warning).toContain('partial fetch');
	});

	it('子の meta.warnings（計算層）が `[tf]` prefix で meta.warnings に統合される', async () => {
		mockedAnalyzeSmaSnapshot
			.mockResolvedValueOnce(smaSnapshotOk('bullish'))
			.mockResolvedValueOnce(smaSnapshotOk('bullish'))
			.mockResolvedValueOnce(smaSnapshotOk('bullish', { warnings: ['SMA_200: データ不足'] }));

		const res = await analyzeMtfSma('btc_jpy', ['1hour', '4hour', '1day'], [25, 75, 200]);

		assertOk(res);
		expect(res.meta?.warnings).toEqual(['[1day] SMA_200: データ不足']);
	});

	it('全 TF 成功 + warning 無しなら meta.warning / warnings は undefined', async () => {
		mockedAnalyzeSmaSnapshot.mockResolvedValue(smaSnapshotOk('bullish'));

		const res = await analyzeMtfSma('btc_jpy', ['1hour', '4hour', '1day'], [25, 75, 200]);

		assertOk(res);
		expect(res.meta?.warning).toBeUndefined();
		expect(res.meta?.warnings).toBeUndefined();
	});

	it('unknown を含む場合 confluence.summary 先頭に「信頼度低」警告が付く', async () => {
		mockedAnalyzeSmaSnapshot
			.mockResolvedValueOnce(smaSnapshotOk('bullish'))
			.mockResolvedValueOnce(smaSnapshotOk('unknown'))
			.mockResolvedValueOnce(smaSnapshotOk('bullish'));

		const res = await analyzeMtfSma('btc_jpy', ['1hour', '4hour', '1day'], [25, 75, 200]);

		assertOk(res);
		expect(res.data.confluence.summary.startsWith('⚠️ TF 取得不完全のため信頼度低')).toBe(true);
	});

	it('全 TF 整列で unknown 無しなら confluence.summary に「信頼度低」警告が付かない', async () => {
		mockedAnalyzeSmaSnapshot.mockResolvedValue(smaSnapshotOk('bullish'));
		const res = await analyzeMtfSma('btc_jpy', ['1hour', '4hour', '1day'], [25, 75, 200]);
		assertOk(res);
		expect(res.data.confluence.summary.startsWith('⚠️')).toBe(false);
	});

	it('content[0].text 先頭にも warning 行が含まれる（inline handler 経由）', async () => {
		mockedAnalyzeSmaSnapshot
			.mockResolvedValueOnce(smaSnapshotOk('bullish', { warning: '⚠️ partial fetch' }))
			.mockResolvedValueOnce(smaSnapshotOk('bullish'))
			.mockResolvedValueOnce(smaSnapshotOk('bullish'));

		const handlerRes = (await toolDef.handler({
			pair: 'btc_jpy',
			timeframes: ['1hour', '4hour', '1day'],
			periods: [25, 75, 200],
		})) as { content: Array<{ text: string }> };
		const text = handlerRes.content?.[0]?.text ?? '';
		expect(text.startsWith('⚠️ [1hour] partial fetch')).toBe(true);
	});
});

describe('analyze_mtf_sma: 表示分岐とエラー経路', () => {
	const mockedAnalyzeSmaSnapshot = vi.mocked(analyzeSmaSnapshot);

	afterEach(() => {
		vi.clearAllMocks();
	});

	function snapshotOk(smas: Record<string, unknown>, recentCrosses: unknown[] = []): SmaSnapshotResult {
		return {
			ok: true,
			summary: 'ok',
			data: {
				alignment: 'mixed',
				summary: { close: 100, align: 'mixed', position: 'between' },
				latest: { close: 100 },
				sma: { SMA_200: null },
				smas,
				crosses: [],
				recentCrosses,
				tags: [],
			},
			meta: { pair: 'btc_jpy', fetchedAt: '2026-01-01T00:00:00.000Z' },
		} as unknown as SmaSnapshotResult;
	}

	it('SMA 値が null のときは n/a・位置 =・乖離なしで表示する', async () => {
		mockedAnalyzeSmaSnapshot.mockResolvedValueOnce(
			snapshotOk({ '200': { value: null, distancePct: null, slope: 'flat' } }),
		);
		const res = (await toolDef.handler({ pair: 'btc_jpy', timeframes: ['1day'], periods: [200] })) as {
			content: Array<{ text: string }>;
		};
		const text = res.content?.[0]?.text ?? '';
		expect(text).toContain('SMA200=n/a =');
		expect(text).not.toContain('(%');
	});

	it('pricePosition / distancePct / recentCrosses があれば ▲・乖離・recent を表示する', async () => {
		mockedAnalyzeSmaSnapshot.mockResolvedValueOnce(
			snapshotOk({ '200': { value: 95, distancePct: 5.26, slope: 'rising', pricePosition: 'above' } }, [
				{ type: 'golden_cross', pair: [25, 75], barsAgo: 3, date: '2026-01-10' },
			]),
		);
		const res = (await toolDef.handler({ pair: 'btc_jpy', timeframes: ['1day'], periods: [200] })) as {
			content: Array<{ text: string }>;
		};
		const text = res.content?.[0]?.text ?? '';
		expect(text).toContain('SMA200=95 ▲ (+5.26%) slope=rising');
		expect(text).toContain('recent: golden_cross(25/75, 3ago)');
	});

	it('snapshot が例外を投げたら fail を返す（catch 経路）', async () => {
		mockedAnalyzeSmaSnapshot.mockRejectedValueOnce(new Error('boom'));
		const res = await analyzeMtfSma('btc_jpy', ['1day']);
		expect(res.ok).toBe(false);
	});
});
