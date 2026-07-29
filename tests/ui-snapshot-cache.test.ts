/**
 * src/ui-snapshot-cache.ts のユニットテスト。
 *
 * MCP Apps ウィジェットの pull 型 hydration に使うスナップショットの
 * 保存・取得・TTL・上書きを検証する。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { _resetUiSnapshots, getUiSnapshot, storeUiSnapshot } from '../src/ui-snapshot-cache.js';

const URI = 'ui://order/confirm.html';
const TTL_MS = 5 * 60_000;

afterEach(() => {
	_resetUiSnapshots();
});

describe('ui-snapshot-cache', () => {
	it('未登録の URI は null を返す', () => {
		expect(getUiSnapshot(URI)).toBeNull();
	});

	it('store した structuredContent がそのまま返る', () => {
		const structured = { ok: true, summary: 's', data: { preview: { pair: 'btc_jpy' } } };
		storeUiSnapshot(URI, structured);
		expect(getUiSnapshot(URI)).toBe(structured);
	});

	it('同一 URI は最新の内容で上書きされる', () => {
		storeUiSnapshot(URI, { ok: true, summary: 'old' });
		const latest = { ok: true, summary: 'new' };
		storeUiSnapshot(URI, latest);
		expect(getUiSnapshot(URI)).toBe(latest);
	});

	it('URI ごとに独立して保持される', () => {
		const order = { ok: true, summary: 'order' };
		const cancel = { ok: true, summary: 'cancel' };
		storeUiSnapshot('ui://order/confirm.html', order);
		storeUiSnapshot('ui://cancel/confirm.html', cancel);
		expect(getUiSnapshot('ui://order/confirm.html')).toBe(order);
		expect(getUiSnapshot('ui://cancel/confirm.html')).toBe(cancel);
	});

	it('TTL ちょうどは有効（off-by-one）', () => {
		const now = 1_000_000;
		storeUiSnapshot(URI, { ok: true }, now);
		expect(getUiSnapshot(URI, now + TTL_MS)).not.toBeNull();
	});

	it('TTL 超過で null になる', () => {
		const now = 1_000_000;
		storeUiSnapshot(URI, { ok: true }, now);
		expect(getUiSnapshot(URI, now + TTL_MS + 1)).toBeNull();
		// 期限切れエントリは削除され、以降も null のまま
		expect(getUiSnapshot(URI, now)).toBeNull();
	});
});
