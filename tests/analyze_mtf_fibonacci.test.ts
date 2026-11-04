import { afterEach, describe, expect, it, vi } from 'vitest';
import { asMockResult, assertOk } from './_assertResult.js';

vi.mock('../tools/analyze_fibonacci.js', () => ({
	default: vi.fn(),
}));

import analyzeFibonacci from '../tools/analyze_fibonacci.js';
import analyzeMtfFibonacci, { toolDef } from '../tools/analyze_mtf_fibonacci.js';

type FibLevel = {
	ratio: number;
	price: number;
	distancePct: number;
	isNearest: boolean;
};

function fibOk(days: number, currentPrice: number, levels: FibLevel[], metaExtra: Record<string, unknown> = {}) {
	return {
		ok: true,
		summary: `${days}d ok`,
		data: {
			pair: 'btc_jpy',
			currentPrice,
			trend: 'up',
			swingHigh: { price: 120, date: '2026-01-10' },
			swingLow: { price: 80, date: '2026-01-01' },
			levels,
		},
		meta: { lookbackDays: days, ...metaExtra },
	};
}

describe('analyze_mtf_fibonacci', () => {
	const mockedAnalyzeFibonacci = vi.mocked(analyzeFibonacci);

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('inputSchema: lookbackDays は 1 件以上のみ許可するべき', () => {
		const parse = () => toolDef.inputSchema.parse({ pair: 'btc_jpy', lookbackDays: [] });
		expect(parse).toThrow();
	});

	it('3期間の近接した水準は strong confluence として集約されるべき', async () => {
		mockedAnalyzeFibonacci
			.mockResolvedValueOnce(
				asMockResult(fibOk(30, 100, [{ ratio: 0.382, price: 100.4, distancePct: 0.4, isNearest: true }])),
			)
			.mockResolvedValueOnce(
				asMockResult(fibOk(90, 100, [{ ratio: 0.5, price: 100.8, distancePct: 0.8, isNearest: true }])),
			)
			.mockResolvedValueOnce(
				asMockResult(fibOk(180, 100, [{ ratio: 0.618, price: 101.1, distancePct: 1.1, isNearest: true }])),
			);

		const res = await analyzeMtfFibonacci('btc_jpy', [30, 90, 180]);

		assertOk(res);
		expect(res.data.confluence).toHaveLength(1);
		expect(res.data.confluence[0].strength).toBe('strong');
		expect(res.data.confluence[0].priceZone).toEqual([100.4, 101.1]);
	});

	it('重複 lookbackDays 指定時は analyze_fibonacci を重複実行しないべき', async () => {
		mockedAnalyzeFibonacci.mockResolvedValue(
			asMockResult(fibOk(30, 100, [{ ratio: 0.5, price: 100, distancePct: 0, isNearest: true }])),
		);

		const res = await analyzeMtfFibonacci('btc_jpy', [30, 30, 90]);

		assertOk(res);
		expect(mockedAnalyzeFibonacci).toHaveBeenCalledTimes(2);
	});

	it('失敗期間が `[Nd]` prefix 付きで meta.warning に集約される', async () => {
		mockedAnalyzeFibonacci
			.mockResolvedValueOnce(
				asMockResult(fibOk(30, 100, [{ ratio: 0.5, price: 100, distancePct: 0, isNearest: true }])),
			)
			.mockResolvedValueOnce(
				asMockResult({ ok: false, summary: 'analyzeFibonacci failed', meta: { errorType: 'internal' } }),
			)
			.mockResolvedValueOnce(
				asMockResult(fibOk(180, 100, [{ ratio: 0.618, price: 101, distancePct: 1, isNearest: true }])),
			);

		const res = await analyzeMtfFibonacci('btc_jpy', [30, 90, 180]);

		assertOk(res);
		expect(res.meta?.warning).toContain('[90d]');
		expect(res.meta?.warning).toContain('analyzeFibonacci failed');
	});

	it('子の meta.warning が `[Nd]` prefix 付きで集約される', async () => {
		mockedAnalyzeFibonacci
			.mockResolvedValueOnce(
				asMockResult(
					fibOk(30, 100, [{ ratio: 0.5, price: 100, distancePct: 0, isNearest: true }], {
						warning: '⚠️ partial fetch',
					}),
				),
			)
			.mockResolvedValueOnce(
				asMockResult(fibOk(90, 100, [{ ratio: 0.5, price: 100, distancePct: 0, isNearest: true }])),
			);

		const res = await analyzeMtfFibonacci('btc_jpy', [30, 90]);

		assertOk(res);
		expect(res.meta?.warning).toContain('[30d]');
		expect(res.meta?.warning).toContain('partial fetch');
	});

	it('全期間成功 + warning 無しなら meta.warning は undefined', async () => {
		mockedAnalyzeFibonacci.mockResolvedValue(
			asMockResult(fibOk(30, 100, [{ ratio: 0.5, price: 100, distancePct: 0, isNearest: true }])),
		);

		const res = await analyzeMtfFibonacci('btc_jpy', [30, 90, 180]);

		assertOk(res);
		expect(res.meta?.warning).toBeUndefined();
	});

	it('失敗期間がある場合「信頼度低」警告が summary に含まれる', async () => {
		mockedAnalyzeFibonacci
			.mockResolvedValueOnce(
				asMockResult(fibOk(30, 100, [{ ratio: 0.5, price: 100, distancePct: 0, isNearest: true }])),
			)
			.mockResolvedValueOnce(asMockResult({ ok: false, summary: 'failed', meta: { errorType: 'internal' } }))
			.mockResolvedValueOnce(
				asMockResult(fibOk(180, 100, [{ ratio: 0.5, price: 100, distancePct: 0, isNearest: true }])),
			);

		const res = await analyzeMtfFibonacci('btc_jpy', [30, 90, 180]);

		assertOk(res);
		expect(res.summary).toContain('一部期間のデータ取得失敗のため合流解釈の信頼度低');
		expect(res.meta?.warning).toContain('一部期間のデータ取得失敗のため合流解釈の信頼度低');
	});

	it('全期間成功時は「信頼度低」警告が summary に含まれない', async () => {
		mockedAnalyzeFibonacci.mockResolvedValue(
			asMockResult(fibOk(30, 100, [{ ratio: 0.5, price: 100, distancePct: 0, isNearest: true }])),
		);

		const res = await analyzeMtfFibonacci('btc_jpy', [30, 90]);

		assertOk(res);
		expect(res.summary).not.toContain('信頼度低');
	});

	it('content[0].text 先頭にも warning 行が含まれる', async () => {
		mockedAnalyzeFibonacci
			.mockResolvedValueOnce(
				asMockResult(
					fibOk(30, 100, [{ ratio: 0.5, price: 100, distancePct: 0, isNearest: true }], {
						warning: '⚠️ partial fetch',
					}),
				),
			)
			.mockResolvedValueOnce(
				asMockResult(fibOk(90, 100, [{ ratio: 0.5, price: 100, distancePct: 0, isNearest: true }])),
			);

		const res = await analyzeMtfFibonacci('btc_jpy', [30, 90]);

		assertOk(res);
		const text = res.content?.[0]?.text ?? '';
		expect(text.startsWith('⚠️ [30d] partial fetch')).toBe(true);
	});
});
