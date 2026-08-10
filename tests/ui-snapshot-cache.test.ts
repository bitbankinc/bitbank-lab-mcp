/**
 * src/ui-snapshot-cache.ts のユニットテスト。
 *
 * MCP Apps ウィジェットの pull 型 hydration に使うスナップショットの
 * 保存・取得・TTL・セッション境界を検証する。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
	_resetUiSnapshots,
	clearUiSnapshot,
	getUiSnapshot,
	storeUiSnapshot,
	uiSnapshotKey,
} from '../src/ui-snapshot-cache.js';

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

	it('同一セッション・同一 URI は最新の内容で上書きされる', () => {
		storeUiSnapshot(URI, { ok: true, summary: 'old' }, { sessionId: 'session-a' });
		const latest = { ok: true, summary: 'new' };
		storeUiSnapshot(URI, latest, { sessionId: 'session-a' });
		expect(getUiSnapshot(URI, { sessionId: 'session-a' })).toBe(latest);
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
		storeUiSnapshot(URI, { ok: true }, { nowMs: now });
		expect(getUiSnapshot(URI, { nowMs: now + TTL_MS })).not.toBeNull();
	});

	it('TTL 超過で null になる', () => {
		const now = 1_000_000;
		storeUiSnapshot(URI, { ok: true }, { nowMs: now });
		expect(getUiSnapshot(URI, { nowMs: now + TTL_MS + 1 })).toBeNull();
		// 期限切れエントリは削除され、以降も null のまま
		expect(getUiSnapshot(URI, { nowMs: now })).toBeNull();
	});

	it('session A の UI スナップショットを session B が取得できない', () => {
		storeUiSnapshot(URI, { ok: true, summary: 'a' }, { sessionId: 'session-a' });
		expect(getUiSnapshot(URI, { sessionId: 'session-b' })).toBeNull();
		expect(getUiSnapshot(URI)).toBeNull();
		expect(getUiSnapshot(URI, { sessionId: 'session-a' })).toMatchObject({ summary: 'a' });
	});

	it('別セッションが同一 URI を保存しても相互に上書きしない', () => {
		storeUiSnapshot(URI, { ok: true, summary: 'a' }, { sessionId: 'session-a' });
		storeUiSnapshot(URI, { ok: true, summary: 'b' }, { sessionId: 'session-b' });
		expect(getUiSnapshot(URI, { sessionId: 'session-a' })).toMatchObject({ summary: 'a' });
		expect(getUiSnapshot(URI, { sessionId: 'session-b' })).toMatchObject({ summary: 'b' });
	});

	it('clearUiSnapshot は指定 URI のみ破棄する（stdio）', () => {
		storeUiSnapshot('ui://order/confirm.html', { ok: true, summary: 'order' });
		storeUiSnapshot('ui://cancel/confirm.html', { ok: true, summary: 'cancel' });
		clearUiSnapshot('ui://cancel/confirm.html');
		expect(getUiSnapshot('ui://cancel/confirm.html')).toBeNull();
		expect(getUiSnapshot('ui://order/confirm.html')).not.toBeNull();
	});

	it('session A の clear は session B の同一 URI を削除しない', () => {
		storeUiSnapshot(URI, { ok: true, summary: 'a' }, { sessionId: 'session-a' });
		storeUiSnapshot(URI, { ok: true, summary: 'b' }, { sessionId: 'session-b' });
		clearUiSnapshot(URI, { sessionId: 'session-a' });
		expect(getUiSnapshot(URI, { sessionId: 'session-a' })).toBeNull();
		expect(getUiSnapshot(URI, { sessionId: 'session-b' })).toMatchObject({ summary: 'b' });
	});

	it('セッションレス（stdio）同士は一致として扱い取得できる', () => {
		storeUiSnapshot(URI, { ok: true });
		expect(getUiSnapshot(URI)).not.toBeNull();
	});

	it('uiSnapshotKey は sessionId + resourceUri 相当', () => {
		expect(uiSnapshotKey('sess-1', URI)).toBe(`sess-1\0${URI}`);
		expect(uiSnapshotKey(undefined, URI)).toBe(`\0${URI}`);
	});
});
