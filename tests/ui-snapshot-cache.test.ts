import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../lib/logger.js';
import {
	disableSharedConfirmState,
	enableSharedConfirmState,
	writeSharedRecord,
} from '../src/private/shared-confirm-state.js';
import {
	_resetUiSnapshots,
	clearUiSnapshot,
	forgetSharedUiSnapshotMeta,
	getUiSnapshot,
	getUiSnapshotMeta,
	getUiSnapshotWithMeta,
	storeUiSnapshot,
	sweepSharedUiSnapshots,
	uiSnapshotKey,
} from '../src/ui-snapshot-cache.js';

vi.mock('../lib/logger.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/logger.js')>()),
	log: vi.fn(),
}));

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

// Claude Desktop は preview とカードの要求を別プロセスで受けるので、オプトイン時は控えをファイルでも共有する（ADR-0007 判断事項 D）。
describe.skipIf(process.platform === 'win32')('ui-snapshot-cache（プロセス間で共有するとき）', () => {
	const URI = 'ui://order/confirm.html';
	const now = 1_800_000_000_000;
	const structured = { ok: true, summary: 'preview' };
	const meta = { 'cc.bitbank/confirmation': { confirmation_token: 'tok-shared', expires_at: now + 60_000 } };
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-shared-'));
		enableSharedConfirmState(path.join(root, 'confirm'));
	});

	afterEach(() => {
		disableSharedConfirmState();
		_resetUiSnapshots();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('別プロセス（メモリが空）からも、控えとトークンを読める', () => {
		storeUiSnapshot(URI, structured, { nowMs: now }, meta, now + 60_000);
		_resetUiSnapshots();
		expect(getUiSnapshot(URI, { nowMs: now + 1000 })).toEqual(structured);
		expect(getUiSnapshotMeta(URI, { nowMs: now + 1000 })).toEqual(meta);
	});

	it('トークンの期限と控えの TTL は、ファイルから読んだときも守る', () => {
		storeUiSnapshot(URI, structured, { nowMs: now }, meta, now + 60_000);
		_resetUiSnapshots();
		expect(getUiSnapshotMeta(URI, { nowMs: now + 60_001 })).toBeNull();
		expect(getUiSnapshot(URI, { nowMs: now + 60_001 })).toEqual(structured);
		expect(getUiSnapshot(URI, { nowMs: now + 5 * 60_000 + 1 })).toBeNull();
	});

	it('別プロセスで消した控えは読めない', () => {
		storeUiSnapshot(URI, structured, { nowMs: now }, meta, now + 60_000);
		_resetUiSnapshots();
		clearUiSnapshot(URI);
		expect(getUiSnapshot(URI, { nowMs: now + 1000 })).toBeNull();
	});

	it('別プロセスが消したことは、メモリに控えが残っているプロセスにも伝わる', () => {
		storeUiSnapshot(URI, structured, { nowMs: now }, meta, now + 60_000);
		writeSharedRecord('snapshots', uiSnapshotKey(undefined, URI), { clearedAt: now + 5 });
		expect(getUiSnapshot(URI, { nowMs: now + 10 })).toBeNull();
		expect(getUiSnapshotMeta(URI, { nowMs: now + 10 })).toBeNull();
	});

	it('消したあとに preview し直した控えは読める', () => {
		storeUiSnapshot(URI, structured, { nowMs: now }, meta, now + 60_000);
		clearUiSnapshot(URI, { nowMs: now + 5 });
		storeUiSnapshot(URI, { ok: true, summary: 'again' }, { nowMs: now + 10 });
		_resetUiSnapshots();
		expect(getUiSnapshot(URI, { nowMs: now + 20 })).toEqual({ ok: true, summary: 'again' });
	});

	it('メモリとファイルで新しいほうを返す', () => {
		storeUiSnapshot(URI, { ok: true, summary: 'old' }, { nowMs: now });
		writeSharedRecord('snapshots', uiSnapshotKey(undefined, URI), {
			structuredContent: { ok: true, summary: 'new' },
			storedAt: now + 10,
		});
		expect(getUiSnapshot(URI, { nowMs: now + 20 })).toEqual({ ok: true, summary: 'new' });
	});

	it('別セッションの控えは、ファイルからも読めない', () => {
		storeUiSnapshot(URI, structured, { sessionId: 'a', nowMs: now }, meta, now + 60_000);
		_resetUiSnapshots();
		expect(getUiSnapshot(URI, { sessionId: 'b', nowMs: now + 1000 })).toBeNull();
		expect(getUiSnapshotMeta(URI, { sessionId: 'b', nowMs: now + 1000 })).toBeNull();
	});

	it('控えをファイルに書けなければ、警告をログに残す（カード側のプロセスからは読めない）', () => {
		fs.rmSync(path.join(root, 'confirm', 'snapshots'), { recursive: true });
		fs.writeFileSync(path.join(root, 'confirm', 'snapshots'), 'not a dir');
		storeUiSnapshot(URI, structured, { nowMs: now }, meta, now + 60_000);
		const events = vi.mocked(log).mock.calls.filter(([, e]) => e.type === 'shared_snapshot_write_failed');
		expect(events).toEqual([['warn', { type: 'shared_snapshot_write_failed', resourceUri: URI }]]);
		expect(JSON.stringify(events)).not.toContain('tok-shared');
		vi.mocked(log).mockClear();
	});

	function sharedFileText(): string {
		const dir = path.join(root, 'confirm', 'snapshots');
		return fs
			.readdirSync(dir)
			.map((n) => fs.readFileSync(path.join(dir, n), 'utf8'))
			.join('\n');
	}

	it('カードに渡したトークンはファイルから消し、別プロセスは内容だけを読める', () => {
		storeUiSnapshot(URI, structured, { nowMs: now }, meta, now + 60_000);
		forgetSharedUiSnapshotMeta(URI, {}, 'tok-shared');
		expect(sharedFileText()).not.toContain('tok-shared');
		// 発行したプロセスのメモリには残る（同じプロセスで動くホストの挙動は変えない）。
		expect(getUiSnapshotMeta(URI, { nowMs: now + 1000 })).toEqual(meta);
		_resetUiSnapshots();
		expect(getUiSnapshot(URI, { nowMs: now + 1000 })).toEqual(structured);
		expect(getUiSnapshotMeta(URI, { nowMs: now + 1000 })).toBeNull();
	});

	it('掃除で、TTL を過ぎた控えと消した印のファイルを消す（期限切れのトークンは検証で弾かれるので、控えごと消える）', () => {
		storeUiSnapshot(URI, structured, { nowMs: now }, meta, now + 60_000);
		sweepSharedUiSnapshots(now + 60_001);
		expect(sharedFileText()).toContain('preview');

		sweepSharedUiSnapshots(now + 5 * 60_000 + 1);
		expect(sharedFileText()).toBe('');

		clearUiSnapshot(URI, { nowMs: now });
		sweepSharedUiSnapshots(now + 5 * 60_000 + 1);
		expect(sharedFileText()).toBe('');
	});

	it('渡したトークンと違うトークン（新しい preview）は消さない', () => {
		storeUiSnapshot(URI, structured, { nowMs: now }, meta, now + 60_000);
		const newer = { 'cc.bitbank/confirmation': { confirmation_token: 'tok-newer', expires_at: now + 70_000 } };
		storeUiSnapshot(URI, { ok: true, summary: 'newer' }, { nowMs: now + 10 }, newer, now + 70_000);
		forgetSharedUiSnapshotMeta(URI, {}, 'tok-shared');
		_resetUiSnapshots();
		expect(getUiSnapshotMeta(URI, { nowMs: now + 20 })).toEqual(newer);
	});

	it('掃除は、期限内のトークンと TTL 内の控えを残す', () => {
		storeUiSnapshot(URI, structured, { nowMs: now }, meta, now + 60_000);
		sweepSharedUiSnapshots(now + 1000);
		expect(sharedFileText()).toContain('tok-shared');
	});

	it('形の合わないファイルは無視する', () => {
		writeSharedRecord('snapshots', uiSnapshotKey(undefined, URI), { structuredContent: 'x', storedAt: 'y' });
		expect(getUiSnapshot(URI, { nowMs: now })).toBeNull();
	});
});

// 内容とトークンを別々に読むと、その間に置かれた新しい preview のトークンを古い内容に添えて返しうるので、同じ控えから返す。
describe('getUiSnapshotWithMeta', () => {
	const now = 1_800_000_000_000;
	const meta = { 'cc.bitbank/confirmation': { confirmation_token: 'tok-pair', expires_at: now + 60_000 } };

	it('内容とトークンを同じ控えから返す', () => {
		storeUiSnapshot(URI, { ok: true, summary: 'a' }, { nowMs: now }, meta, now + 60_000);
		expect(getUiSnapshotWithMeta(URI, { nowMs: now + 1 })).toEqual({
			structuredContent: { ok: true, summary: 'a' },
			meta,
		});
	});

	it('トークンの期限が切れていれば、内容だけを返す', () => {
		storeUiSnapshot(URI, { ok: true, summary: 'a' }, { nowMs: now }, meta, now + 60_000);
		expect(getUiSnapshotWithMeta(URI, { nowMs: now + 60_001 })).toEqual({
			structuredContent: { ok: true, summary: 'a' },
			meta: null,
		});
	});

	it('控えが無い・TTL を過ぎていれば null を返す', () => {
		expect(getUiSnapshotWithMeta(URI, { nowMs: now })).toBeNull();
		storeUiSnapshot(URI, { ok: true, summary: 'a' }, { nowMs: now });
		expect(getUiSnapshotWithMeta(URI, { nowMs: now + TTL_MS + 1 })).toBeNull();
	});
});
