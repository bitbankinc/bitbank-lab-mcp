// 確認 UI（iframe）の pull 型 hydration を駆動する純粋モジュールなので、React も jsdom も使わず node 環境 + フェイクタイマーで固定する（issue #29）。

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
	confirmationResourceToSnapshot,
	DEFAULT_INITIAL_DELAY_MS,
	DEFAULT_RETRY_DELAYS_MS,
	keepConfirmationMeta,
	pullConfirmationIfMissing,
	type SnapshotHydrationOptions,
	type SnapshotHydrationPhase,
	startSnapshotHydration,
} from '../src/mcp-apps-hydration.js';
import { CONFIRMATION_META_KEY } from '../src/mcp-apps-meta.js';

/** テスト用の短い既定値（既定値そのものは別テストで確認する） */
const INITIAL_DELAY_MS = 2_500;
const RETRY_DELAYS_MS = [2_000, 4_000] as const;

interface Harness {
	fetchSnapshot: Mock<() => Promise<unknown>>;
	apply: Mock<(result: unknown) => void>;
	onPhase: Mock<(phase: SnapshotHydrationPhase) => void>;
	phases: SnapshotHydrationPhase[];
	hydrated: { value: boolean };
}

/** 既定の引数一式を作る。`isHydrated` は `hydrated.value` を読む（テスト中に切り替えられる） */
function makeHarness(): Harness {
	const phases: SnapshotHydrationPhase[] = [];
	return {
		fetchSnapshot: vi.fn<() => Promise<unknown>>(async () => ({ structuredContent: { ok: true } })),
		apply: vi.fn<(result: unknown) => void>(),
		onPhase: vi.fn<(phase: SnapshotHydrationPhase) => void>((phase) => {
			phases.push(phase);
		}),
		phases,
		hydrated: { value: false },
	};
}

function start(h: Harness, overrides: Partial<SnapshotHydrationOptions> = {}): () => void {
	return startSnapshotHydration({
		fetchSnapshot: h.fetchSnapshot,
		isHydrated: () => h.hydrated.value,
		apply: h.apply,
		onPhase: h.onPhase,
		initialDelayMs: INITIAL_DELAY_MS,
		retryDelaysMs: RETRY_DELAYS_MS,
		...overrides,
	});
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('startSnapshotHydration', () => {
	it('既定値は UI の現行挙動（初回 2.5 秒 / 試行 3 回 / 間隔 2・4 秒）に一致する', () => {
		expect(DEFAULT_INITIAL_DELAY_MS).toBe(2_500);
		expect([...DEFAULT_RETRY_DELAYS_MS]).toEqual([2_000, 4_000]);
		expect(1 + DEFAULT_RETRY_DELAYS_MS.length).toBe(3);
	});

	it('初回待ちの間は fetchSnapshot を呼ばず waiting だけを通知する', async () => {
		const h = makeHarness();
		start(h);

		expect(h.phases).toEqual(['waiting']);
		await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS - 1);
		expect(h.fetchSnapshot).toHaveBeenCalledTimes(0);
	});

	it('初回で成功: apply が 1 回、onPhase は waiting → restoring のみ', async () => {
		const h = makeHarness();
		h.apply.mockImplementation(() => {
			h.hydrated.value = true;
		});
		start(h);

		await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

		expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);
		expect(h.apply).toHaveBeenCalledTimes(1);
		expect(h.apply).toHaveBeenCalledWith({ structuredContent: { ok: true } });
		expect(h.phases).toEqual(['waiting', 'restoring']);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('1 回目 reject → 2 回目成功: 間隔は retryDelaysMs[0]', async () => {
		const h = makeHarness();
		h.fetchSnapshot.mockRejectedValueOnce(new Error('snapshot failed'));
		start(h);

		await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
		expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);

		// retryDelaysMs[0] の直前ではまだ 2 回目が走らない
		await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] - 1);
		expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(h.fetchSnapshot).toHaveBeenCalledTimes(2);
		expect(h.apply).toHaveBeenCalledTimes(1);
		expect(h.phases).not.toContain('failed');
	});

	it('全試行 reject: fetchSnapshot 3 回・apply 0 回・failed ちょうど 1 回・タイマーが残らない', async () => {
		const h = makeHarness();
		h.fetchSnapshot.mockRejectedValue(new Error('snapshot failed'));
		start(h);

		await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
		await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
		await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1]);

		expect(h.fetchSnapshot).toHaveBeenCalledTimes(3);
		expect(h.apply).toHaveBeenCalledTimes(0);
		expect(h.phases.filter((p) => p === 'failed')).toHaveLength(1);
		expect(h.phases.at(-1)).toBe('failed');
		expect(vi.getTimerCount()).toBe(0);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.fetchSnapshot).toHaveBeenCalledTimes(3);
		expect(h.phases.filter((p) => p === 'failed')).toHaveLength(1);
	});

	it('リトライ無し（retryDelaysMs: []）は 1 回で failed（切り出し前の現行挙動の再現）', async () => {
		const h = makeHarness();
		h.fetchSnapshot.mockRejectedValue(new Error('snapshot failed'));
		start(h, { retryDelaysMs: [] });

		await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

		expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);
		expect(h.phases).toEqual(['waiting', 'restoring', 'failed']);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('abort（issue #29 の指摘 2）', () => {
	it('初回待ちの途中で止めると fetchSnapshot を 1 回も呼ばない', async () => {
		const h = makeHarness();
		const stop = start(h);

		await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS - 1);
		stop();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(h.fetchSnapshot).toHaveBeenCalledTimes(0);
		expect(h.apply).toHaveBeenCalledTimes(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('試行中（pending）に止めてから resolve しても apply / onPhase を呼ばない', async () => {
		const h = makeHarness();
		let resolveFetch: ((value: unknown) => void) | undefined;
		h.fetchSnapshot.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveFetch = resolve;
				}),
		);
		const stop = start(h);

		await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
		expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);
		const phasesAtStop = [...h.phases];

		stop();
		resolveFetch?.({ structuredContent: { ok: true } });
		await vi.advanceTimersByTimeAsync(60_000);

		expect(h.apply).toHaveBeenCalledTimes(0);
		expect(h.phases).toEqual(phasesAtStop);
	});

	it('試行中（pending）に止めてから reject しても次の試行を予約しない', async () => {
		const h = makeHarness();
		let rejectFetch: ((reason: unknown) => void) | undefined;
		h.fetchSnapshot.mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					rejectFetch = reject;
				}),
		);
		const stop = start(h);

		await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
		stop();
		rejectFetch?.(new Error('snapshot failed'));
		await vi.advanceTimersByTimeAsync(60_000);

		expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);
		expect(h.phases).not.toContain('failed');
		expect(vi.getTimerCount()).toBe(0);
	});

	it('リトライ待ちの途中で止めると次の試行が予約されない', async () => {
		const h = makeHarness();
		h.fetchSnapshot.mockRejectedValue(new Error('snapshot failed'));
		const stop = start(h);

		await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
		expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);

		stop();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);
		expect(h.phases).not.toContain('failed');
		expect(vi.getTimerCount()).toBe(0);
	});

	it('止める関数を 2 回呼んでも壊れない', async () => {
		const h = makeHarness();
		const stop = start(h);

		stop();
		expect(() => stop()).not.toThrow();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(h.fetchSnapshot).toHaveBeenCalledTimes(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('isHydrated（push 配信が先に届いたケース）', () => {
	it('初回待ちの間に true になったら 1 回も呼ばない', async () => {
		const h = makeHarness();
		start(h);

		await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS - 1);
		h.hydrated.value = true;
		await vi.advanceTimersByTimeAsync(60_000);

		expect(h.fetchSnapshot).toHaveBeenCalledTimes(0);
		expect(h.apply).toHaveBeenCalledTimes(0);
		expect(h.phases).toEqual(['waiting']);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('1 回目 reject 後に true になったら 2 回目を呼ばず failed も出さない', async () => {
		const h = makeHarness();
		h.fetchSnapshot.mockImplementation(async () => {
			h.hydrated.value = true;
			throw new Error('snapshot failed');
		});
		start(h);

		await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
		await vi.advanceTimersByTimeAsync(60_000);

		expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);
		expect(h.apply).toHaveBeenCalledTimes(0);
		expect(h.phases).toEqual(['waiting', 'restoring']);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('resolve 後・apply 前に true になったら apply を呼ばない', async () => {
		const h = makeHarness();
		h.fetchSnapshot.mockImplementation(async () => {
			h.hydrated.value = true;
			return { structuredContent: { ok: true } };
		});
		start(h);

		await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

		expect(h.apply).toHaveBeenCalledTimes(0);
		expect(h.phases).not.toContain('failed');
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('apply が例外を投げる', () => {
	it('リトライ経路に乗り、次の試行で成功すれば failed は出ない', async () => {
		const h = makeHarness();
		h.apply.mockImplementationOnce(() => {
			throw new Error('apply failed');
		});
		start(h);

		await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
		expect(h.apply).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);

		expect(h.fetchSnapshot).toHaveBeenCalledTimes(2);
		expect(h.apply).toHaveBeenCalledTimes(2);
		expect(h.phases).not.toContain('failed');
	});

	it('最後まで投げ続ければ failed がちょうど 1 回', async () => {
		const h = makeHarness();
		h.apply.mockImplementation(() => {
			throw new Error('apply failed');
		});
		start(h);

		await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
		await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
		await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1]);

		expect(h.apply).toHaveBeenCalledTimes(3);
		expect(h.phases.filter((p) => p === 'failed')).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('UI と同じ形の apply（取り込めなければ投げる）で、空スナップショットが failed に到達する', async () => {
		// resolve したが preview を含まないスナップショット（サーバー側キャッシュが未投入 等）を成功として扱うと「復元中」のまま固まるので、両 UI と同じく applyPreviewResult のあと hasPreviewRef が false なら投げる（#29）。
		const h = makeHarness();
		let hasPreview = false;
		h.fetchSnapshot.mockResolvedValue({ structuredContent: { ok: true } });
		h.apply.mockImplementation((result) => {
			const structured = (result as { structuredContent?: { data?: { preview?: unknown } } }).structuredContent;
			if (structured?.data?.preview) {
				hasPreview = true;
				return;
			}
			throw new Error('snapshot did not contain a usable preview');
		});
		start(h);

		await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
		await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
		await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1]);

		expect(hasPreview).toBe(false);
		expect(h.fetchSnapshot).toHaveBeenCalledTimes(3);
		expect(h.phases.filter((p) => p === 'failed')).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('空スナップショットのあと preview を含むスナップショットが返れば復元して終わる', async () => {
		const h = makeHarness();
		let hasPreview = false;
		h.fetchSnapshot
			.mockResolvedValueOnce({ structuredContent: { ok: true } })
			.mockResolvedValue({ structuredContent: { ok: true, data: { preview: { pair: 'btc_jpy' } } } });
		h.apply.mockImplementation((result) => {
			const structured = (result as { structuredContent?: { data?: { preview?: unknown } } }).structuredContent;
			if (structured?.data?.preview) {
				hasPreview = true;
				h.hydrated.value = true;
				return;
			}
			throw new Error('snapshot did not contain a usable preview');
		});
		start(h);

		await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
		await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);

		expect(hasPreview).toBe(true);
		expect(h.fetchSnapshot).toHaveBeenCalledTimes(2);
		expect(h.phases).not.toContain('failed');
		expect(vi.getTimerCount()).toBe(0);
	});

	it('fetchSnapshot が同期的に投げてもリトライ経路に乗る', async () => {
		const h = makeHarness();
		h.fetchSnapshot.mockImplementation(() => {
			throw new Error('sync throw');
		});
		start(h);

		await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
		await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
		await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1]);

		expect(h.fetchSnapshot).toHaveBeenCalledTimes(3);
		expect(h.phases.filter((p) => p === 'failed')).toHaveLength(1);
	});
});

describe('タイマー注入', () => {
	it('タイマー実装をペアで差し替えられる（既定の globalThis を使わない）', async () => {
		const h = makeHarness();
		const scheduledDelays: number[] = [];
		let clearedCount = 0;
		const stop = start(h, {
			// 予約と取り消しはペアでしか差し替えられない（片方だけだと ID を取り違える）。
			timers: {
				setTimeout: (handler, timeout) => {
					scheduledDelays.push(timeout);
					return globalThis.setTimeout(handler, timeout);
				},
				clearTimeout: (id) => {
					clearedCount += 1;
					globalThis.clearTimeout(id);
				},
			},
		});

		expect(scheduledDelays).toEqual([INITIAL_DELAY_MS]);

		stop();
		expect(clearedCount).toBe(1);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.fetchSnapshot).toHaveBeenCalledTimes(0);
	});

	it('onPhase 未指定でも動く', async () => {
		const fetchSnapshot = vi.fn(async () => ({ ok: true }));
		const apply = vi.fn();
		startSnapshotHydration({
			fetchSnapshot,
			isHydrated: () => false,
			apply,
			initialDelayMs: INITIAL_DELAY_MS,
			retryDelaysMs: [],
		});

		await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

		expect(apply).toHaveBeenCalledTimes(1);
	});
});

// Claude Desktop の更新後、ホストが ui/notifications/tool-result の `_meta` を iframe に渡さず、確認トークンが届かなくなった（確認カードのボタンが出ない）。
describe('pullConfirmationIfMissing（push にトークンが無いときの取り直し）', () => {
	const TOKEN_META = { [CONFIRMATION_META_KEY]: { confirmation_token: 'tok', expires_at: 1_900_000_000_000 } };
	const PREVIEW = {
		ok: true,
		data: { preview: { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit', price: '100' } },
	};

	it('push の `_meta` にトークンがあれば取り直さない', async () => {
		const fetchSnapshot = vi.fn(async () => ({ _meta: TOKEN_META }));
		const apply = vi.fn();
		const applied = await pullConfirmationIfMissing({
			structured: PREVIEW,
			meta: TOKEN_META,
			sources: [fetchSnapshot],
			apply,
			isAborted: () => false,
		});
		expect(applied).toBe(false);
		expect(fetchSnapshot).not.toHaveBeenCalled();
		expect(apply).not.toHaveBeenCalled();
	});

	it('push にトークンが無く、スナップショットにあれば、その結果を 1 回だけ apply する', async () => {
		const snapshot = { structuredContent: structuredClone(PREVIEW), _meta: TOKEN_META };
		const fetchSnapshot = vi.fn(async () => snapshot);
		const apply = vi.fn();
		const applied = await pullConfirmationIfMissing({
			structured: PREVIEW,
			meta: undefined,
			sources: [fetchSnapshot],
			apply,
			isAborted: () => false,
		});
		expect(applied).toBe(true);
		expect(fetchSnapshot).toHaveBeenCalledTimes(1);
		expect(apply).toHaveBeenCalledTimes(1);
		expect(apply).toHaveBeenCalledWith(snapshot);
	});

	it('スナップショットにもトークンが無ければ apply しない（ボタンは出さないまま）', async () => {
		const fetchSnapshot = vi.fn(async () => ({ structuredContent: PREVIEW }));
		const apply = vi.fn();
		const applied = await pullConfirmationIfMissing({
			structured: PREVIEW,
			meta: {},
			sources: [fetchSnapshot],
			apply,
			isAborted: () => false,
		});
		expect(applied).toBe(false);
		expect(fetchSnapshot).toHaveBeenCalledTimes(1);
		expect(apply).not.toHaveBeenCalled();
	});

	it('スナップショットが別の preview に置き換わっていたら、トークンがあっても apply しない', async () => {
		const other = { ok: true, data: { preview: { ...PREVIEW.data.preview, amount: '0.5' } } };
		const fetchSnapshot = vi.fn(async () => ({ structuredContent: other, _meta: TOKEN_META }));
		const apply = vi.fn();
		const applied = await pullConfirmationIfMissing({
			structured: PREVIEW,
			meta: undefined,
			sources: [fetchSnapshot],
			apply,
			isAborted: () => false,
		});
		expect(applied).toBe(false);
		expect(apply).not.toHaveBeenCalled();
	});

	it('キーの並びが違うだけなら同じ preview とみなす', async () => {
		const reordered = {
			data: { preview: { price: '100', type: 'limit', side: 'buy', amount: '0.001', pair: 'btc_jpy' } },
			ok: true,
		};
		const fetchSnapshot = vi.fn(async () => ({ structuredContent: reordered, _meta: TOKEN_META }));
		const apply = vi.fn();
		const applied = await pullConfirmationIfMissing({
			structured: PREVIEW,
			meta: undefined,
			sources: [fetchSnapshot],
			apply,
			isAborted: () => false,
		});
		expect(applied).toBe(true);
	});

	it('1 つ目の取り直しにトークンが無ければ、2 つ目（確認トークンのリソース）を試す', async () => {
		const snapshotWithoutToken = vi.fn(async () => ({ structuredContent: PREVIEW }));
		const fromResource = { structuredContent: PREVIEW, _meta: TOKEN_META };
		const resource = vi.fn(async () => fromResource);
		const apply = vi.fn();
		const applied = await pullConfirmationIfMissing({
			structured: PREVIEW,
			meta: undefined,
			sources: [snapshotWithoutToken, resource],
			apply,
			isAborted: () => false,
		});
		expect(applied).toBe(true);
		expect(snapshotWithoutToken).toHaveBeenCalledTimes(1);
		expect(resource).toHaveBeenCalledTimes(1);
		expect(apply).toHaveBeenCalledWith(fromResource);
	});

	it('1 つ目の取り直しが失敗しても、2 つ目を試す', async () => {
		const failing = vi.fn(async () => {
			throw new Error('timeout');
		});
		const resource = vi.fn(async () => ({ structuredContent: PREVIEW, _meta: TOKEN_META }));
		const apply = vi.fn();
		const applied = await pullConfirmationIfMissing({
			structured: PREVIEW,
			meta: undefined,
			sources: [failing, resource],
			apply,
			isAborted: () => false,
		});
		expect(applied).toBe(true);
		expect(apply).toHaveBeenCalledTimes(1);
	});

	it('1 つ目で取れたら 2 つ目は呼ばない', async () => {
		const snapshot = vi.fn(async () => ({ structuredContent: PREVIEW, _meta: TOKEN_META }));
		const resource = vi.fn(async () => ({ structuredContent: PREVIEW, _meta: TOKEN_META }));
		const apply = vi.fn();
		await pullConfirmationIfMissing({
			structured: PREVIEW,
			meta: undefined,
			sources: [snapshot, resource],
			apply,
			isAborted: () => false,
		});
		expect(resource).not.toHaveBeenCalled();
		expect(apply).toHaveBeenCalledTimes(1);
	});

	it('取り直しに失敗しても例外を投げず、apply しない', async () => {
		const fetchSnapshot = vi.fn(async () => {
			throw new Error('timeout');
		});
		const apply = vi.fn();
		await expect(
			pullConfirmationIfMissing({
				structured: PREVIEW,
				meta: undefined,
				sources: [fetchSnapshot],
				apply,
				isAborted: () => false,
			}),
		).resolves.toBe(false);
		expect(apply).not.toHaveBeenCalled();
	});

	it('取り直しの途中で iframe が破棄された（または新しい push が届いた）ら apply しない', async () => {
		let aborted = false;
		const fetchSnapshot = vi.fn(async () => {
			aborted = true;
			return { structuredContent: PREVIEW, _meta: TOKEN_META };
		});
		const apply = vi.fn();
		const applied = await pullConfirmationIfMissing({
			structured: PREVIEW,
			meta: undefined,
			sources: [fetchSnapshot],
			apply,
			isAborted: () => aborted,
		});
		expect(applied).toBe(false);
		expect(apply).not.toHaveBeenCalled();
	});
});

describe('confirmationResourceToSnapshot（確認トークンのリソースの本文を読む）', () => {
	const CONFIRMATION = { confirmation_token: 'tok', expires_at: 1_900_000_000_000 };
	const resourceResult = (text: string) => ({ contents: [{ uri: 'bitbank-confirmation://order', text }] });

	it('本文の内容とトークンを、スナップショットと同じ形（structuredContent + `_meta`）にして返す', () => {
		const structured = { ok: true, data: { preview: { pair: 'btc_jpy' } } };
		const result = confirmationResourceToSnapshot(
			resourceResult(JSON.stringify({ structuredContent: structured, confirmation: CONFIRMATION })),
		);
		expect(result).toEqual({ structuredContent: structured, _meta: { [CONFIRMATION_META_KEY]: CONFIRMATION } });
	});

	it('トークンが無い本文（条件を満たさないときの `{}`）は undefined', () => {
		expect(confirmationResourceToSnapshot(resourceResult('{}'))).toBeUndefined();
	});

	it('JSON として読めない本文や、contents が無い結果は undefined', () => {
		expect(confirmationResourceToSnapshot(resourceResult('not json'))).toBeUndefined();
		expect(confirmationResourceToSnapshot({})).toBeUndefined();
		expect(confirmationResourceToSnapshot(undefined)).toBeUndefined();
	});
});

// トークンは共有ファイルから 1 回しか渡さないので、同じ preview がトークン無しで届き直しても、受け取り済みのトークンを消さない（ADR-0007 判断事項 D）。
describe('keepConfirmationMeta', () => {
	const structured = { ok: true, data: { preview: { pair: 'btc_jpy', amount: '0.001' } } };
	const withToken = { [CONFIRMATION_META_KEY]: { confirmation_token: 'tok-keep', expires_at: Date.now() + 60_000 } };

	it('同じ内容がトークン無しで届いたら、受け取り済みの `_meta` を返す', () => {
		const sameButReordered = { data: { preview: { amount: '0.001', pair: 'btc_jpy' } }, ok: true };
		expect(keepConfirmationMeta({ structured, meta: withToken }, sameButReordered, undefined)).toBe(withToken);
	});

	it('別の内容なら、受け取り済みのトークンを持ち越さない', () => {
		const other = { ok: true, data: { preview: { pair: 'btc_jpy', amount: '1' } } };
		expect(keepConfirmationMeta({ structured, meta: withToken }, other, {})).toEqual({});
	});

	it('届いた結果にトークンがあれば、それを使う', () => {
		const fresh = { [CONFIRMATION_META_KEY]: { confirmation_token: 'tok-new', expires_at: Date.now() + 60_000 } };
		expect(keepConfirmationMeta({ structured, meta: withToken }, structured, fresh)).toBe(fresh);
	});

	it('受け取り済みのトークンが期限切れなら持ち越さない（取り直しに進ませる）', () => {
		const expired = { [CONFIRMATION_META_KEY]: { confirmation_token: 'tok-old', expires_at: 1_000 } };
		expect(keepConfirmationMeta({ structured, meta: expired }, structured, undefined, 2_000)).toBeUndefined();
	});

	it('受け取り済みのトークンが無ければ、届いた `_meta` のまま', () => {
		expect(keepConfirmationMeta(null, structured, undefined)).toBeUndefined();
	});
});
