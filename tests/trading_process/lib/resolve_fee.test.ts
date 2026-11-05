import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPairsSpecCache } from '../../../lib/pairs.js';
import { DEFAULT_FEE_BP, resolveBacktestFeeBp } from '../../../tools/trading_process/lib/resolve_fee.js';
import { jsonResponse, mockSpotPairsResponse } from '../../fixtures/private-api.js';

beforeEach(() => {
	clearPairsSpecCache();
});

afterEach(() => {
	vi.restoreAllMocks();
	clearPairsSpecCache();
});

describe('resolveBacktestFeeBp', () => {
	it('明示指定された fee_bp はそのまま尊重され、pairs を引かない（override 最優先）', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const res = await resolveBacktestFeeBp('btc_jpy', 25);
		expect(res).toEqual({ fee_bp: 25, source: 'explicit' });
		// pairs を引かない
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('明示指定 0 も override として尊重される', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const res = await resolveBacktestFeeBp('btc_jpy', 0);
		expect(res.fee_bp).toBe(0);
		expect(res.source).toBe('explicit');
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('未指定 → pairs の taker レートが bp 換算で使われる（0.001 → 10bp）', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			jsonResponse(mockSpotPairsResponse([{ name: 'xrp_jpy', taker_fee_rate_quote: '0.001' }])),
		);
		const res = await resolveBacktestFeeBp('xrp_jpy');
		expect(res.source).toBe('dynamic');
		expect(res.fee_bp).toBeCloseTo(10, 6);
		expect(res.warning).toBeUndefined();
	});

	it('未指定 + デフォルト fixture（taker 0.0012）→ 12bp', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(mockSpotPairsResponse()));
		const res = await resolveBacktestFeeBp('btc_jpy');
		expect(res.source).toBe('dynamic');
		expect(res.fee_bp).toBeCloseTo(12, 6);
	});

	it('pairs 取得失敗（ネットワークエラー）→ 12bp フォールバック＋warning', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
		const res = await resolveBacktestFeeBp('btc_jpy');
		expect(res.source).toBe('fallback');
		expect(res.fee_bp).toBe(DEFAULT_FEE_BP);
		expect(res.warning).toContain('取得失敗');
		expect(res.warning).toContain('12');
	});

	it('ペア未発見 → 12bp フォールバック＋warning', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(mockSpotPairsResponse()));
		const res = await resolveBacktestFeeBp('doge_jpy');
		expect(res.source).toBe('fallback');
		expect(res.fee_bp).toBe(DEFAULT_FEE_BP);
		expect(res.warning).toContain('doge_jpy');
		expect(res.warning).toContain('見つからない');
	});

	it('DEFAULT_FEE_BP は公称 12bp である', () => {
		expect(DEFAULT_FEE_BP).toBe(12);
	});
});
