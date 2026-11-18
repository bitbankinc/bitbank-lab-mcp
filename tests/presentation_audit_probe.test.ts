// 提示層データ正確性診断（2026-11-18）で確認した問題の回帰テスト。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatVolumeJPY } from '../lib/formatter.js';
import { PrepareDepthDataOutputSchema } from '../src/schemas.js';
import prepareDepthData from '../tools/prepare_depth_data.js';
import { asMockResult } from './_assertResult.js';

vi.mock('../lib/get-depth.js', () => ({ default: vi.fn() }));
vi.mock('../tools/get_candles.js', () => ({ default: vi.fn() }));

import getDepth from '../lib/get-depth.js';
import detectWhaleEvents from '../tools/detect_whale_events.js';
import getCandles from '../tools/get_candles.js';

const mockedGetDepth = vi.mocked(getDepth);
const mockedGetCandles = vi.mocked(getCandles);

function depthOk(meta: Record<string, unknown> = {}) {
	return asMockResult<Awaited<ReturnType<typeof getDepth>>>({
		ok: true,
		summary: 'depth ok',
		data: {
			asks: [
				[101, 0.8],
				[102, 1.2],
			],
			bids: [
				[99, 1.1],
				[98, 0.9],
			],
			timestamp: 1_700_000_000_000,
		},
		meta,
	});
}

function candlesOk(meta: Record<string, unknown> = {}) {
	return asMockResult<Awaited<ReturnType<typeof getCandles>>>({
		ok: true,
		summary: 'candles ok',
		data: { normalized: [{ close: 100 }, { close: 101 }] },
		meta,
	});
}

afterEach(() => {
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

describe('probe A: detect_whale_events の上流 warning 伝播', () => {
	it('getDepth / getCandles の meta.warning（不正レベル除外・partial fetch）が summary 先頭と meta に出る', async () => {
		mockedGetDepth.mockResolvedValueOnce(
			depthOk({
				warning:
					'⚠️ 上流レスポンスから 1件 の不正な板レベルを除外しました（bids: 0件 / asks: 1件、price/size が数値変換不能）',
			}),
		);
		mockedGetCandles.mockResolvedValueOnce(candlesOk({ warning: '⚠️ 一部期間の取得に失敗しました' }));
		const res = await detectWhaleEvents('btc_jpy', '1hour', 0.111);
		expect(res.ok).toBe(true);
		// biome-ignore lint/suspicious/noExplicitAny: probe assertion
		const r = res as any;
		expect(r.summary.startsWith('⚠️')).toBe(true);
		expect(r.summary).toContain('[depth] 上流レスポンスから 1件 の不正な板レベルを除外しました');
		expect(r.summary).toContain('[candles] 一部期間の取得に失敗しました');
		expect(r.meta.warning).toContain('[depth]');
		expect(r.meta.warning).toContain('[candles]');
	});
});

describe('probe B: detect_whale_events の観測時刻とキャッシュ開示', () => {
	it('summary に板スナップショットの 📸 時刻が出て、60 秒キャッシュのヒットは meta.cache で開示される', async () => {
		mockedGetDepth.mockResolvedValue(depthOk());
		mockedGetCandles.mockResolvedValue(candlesOk());
		const first = await detectWhaleEvents('btc_jpy', '1hour', 0.222);
		// biome-ignore lint/suspicious/noExplicitAny: probe assertion
		const f = first as any;
		expect(f.summary).toContain('📸');
		expect(f.summary).toContain('2023/11/15');
		expect(f.meta.snapshotAt).toBe('2023-11-14T22:13:20.000Z');
		expect(f.meta.cache).toBeUndefined();

		const second = await detectWhaleEvents('btc_jpy', '1hour', 0.222);
		// biome-ignore lint/suspicious/noExplicitAny: probe assertion
		const s = second as any;
		expect(s.summary).toBe(f.summary);
		expect(s.meta.cache).toEqual({ hit: true, key: 'btc_jpy:1hour:0.222' });
		expect(mockedGetDepth).toHaveBeenCalledTimes(1);
	});
});

describe('probe D: formatVolumeJPY の小額表示', () => {
	it('1 万円未満は 0万円 に潰さず円表記で出す', () => {
		expect(formatVolumeJPY(4_999)).toBe('4,999円');
		expect(formatVolumeJPY(5_000)).toBe('5,000円');
		expect(formatVolumeJPY(10_000)).toBe('1万円');
		expect(formatVolumeJPY(123_456_789)).toBe('1.2億円');
	});
});

describe('probe E: prepare_depth_data の JSON 往復（market_data_audit §3 パターン）', () => {
	it('stringify → parse 後も schema parse が成功し summary / data が不変', async () => {
		mockedGetDepth.mockResolvedValueOnce(
			asMockResult<Awaited<ReturnType<typeof getDepth>>>({
				ok: true,
				summary: 'depth ok',
				data: {
					asks: [
						['101', '0.8'],
						['102', '1.2'],
					],
					bids: [
						['99', '1.1'],
						['98', '0.9'],
					],
					timestamp: 1_700_000_000_000,
				},
				meta: {},
			}),
		);
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		expect(res.ok).toBe(true);
		const revived = JSON.parse(JSON.stringify(res));
		const parsed = PrepareDepthDataOutputSchema.parse(revived);
		// biome-ignore lint/suspicious/noExplicitAny: probe assertion
		expect((parsed as any).summary).toBe((res as any).summary);
		// biome-ignore lint/suspicious/noExplicitAny: probe assertion
		expect((parsed as any).data).toEqual((res as any).data);
	});
});
