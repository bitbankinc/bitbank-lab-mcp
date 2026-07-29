/**
 * tools/get_ui_snapshot.ts のユニットテスト。
 *
 * MCP Apps ウィジェットの pull 型 hydration 用ツールの入力スキーマと
 * ok / fail 分岐を検証する。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { appResourceRegistry } from '../src/resources/app-resources.js';
import { GetUiSnapshotInputSchema, UI_SNAPSHOT_RESOURCE_URIS } from '../src/schema/ui.js';
import { _resetUiSnapshots, storeUiSnapshot } from '../src/ui-snapshot-cache.js';
import { toolDef } from '../tools/get_ui_snapshot.js';

const URI = 'ui://order/confirm.html';

afterEach(() => {
	_resetUiSnapshots();
});

describe('GetUiSnapshotInputSchema', () => {
	it('登録済みリソース URI を受理する', () => {
		expect(GetUiSnapshotInputSchema.safeParse({ resource_uri: URI }).success).toBe(true);
	});

	it('未知の URI は拒否する', () => {
		expect(GetUiSnapshotInputSchema.safeParse({ resource_uri: 'ui://unknown/x.html' }).success).toBe(false);
	});

	it('resource_uri 欠損は拒否する', () => {
		expect(GetUiSnapshotInputSchema.safeParse({}).success).toBe(false);
	});

	it('enum が appResourceRegistry の URI 一覧とドリフトしていない', () => {
		expect([...UI_SNAPSHOT_RESOURCE_URIS].sort()).toEqual(appResourceRegistry.map((r) => r.uri).sort());
	});
});

describe('handler', () => {
	it('スナップショットが無い場合は fail(snapshot_not_found) を返す', async () => {
		const result = (await toolDef.handler({ resource_uri: URI })) as {
			ok: boolean;
			summary: string;
			meta: { errorType: string };
		};
		expect(result.ok).toBe(false);
		expect(result.meta.errorType).toBe('snapshot_not_found');
		expect(result.summary).toContain('preview ツールを再実行');
	});

	it('スナップショットがあれば structuredContent としてそのまま返す', async () => {
		const structured = {
			ok: true,
			summary: 'preview summary',
			data: { preview: { pair: 'btc_jpy' } },
			meta: { action: 'create_order' },
		};
		storeUiSnapshot(URI, structured);

		const result = (await toolDef.handler({ resource_uri: URI })) as {
			content: Array<{ type: string; text: string }>;
			structuredContent: Record<string, unknown>;
		};
		expect(result.structuredContent).toBe(structured);
		// LLM 向け content テキストには「再送であること」を明示する
		expect(result.content[0]?.text).toContain('再送');
	});

	it('別セッションで保存されたスナップショットは返さない（セッションバインド）', async () => {
		storeUiSnapshot(URI, { ok: true, summary: 'other session' }, { sessionId: 'session-a' });

		// セッションレス（stdio 相当）の呼び出しでは取得できない
		const noSession = (await toolDef.handler({ resource_uri: URI })) as { ok: boolean };
		expect(noSession.ok).toBe(false);

		// 別セッションからも取得できない
		const otherSession = (await toolDef.handler({ resource_uri: URI }, { sessionId: 'session-b' })) as {
			ok: boolean;
		};
		expect(otherSession.ok).toBe(false);

		// 同一セッションからは取得できる
		const sameSession = (await toolDef.handler({ resource_uri: URI }, { sessionId: 'session-a' })) as {
			structuredContent: Record<string, unknown>;
		};
		expect(sameSession.structuredContent).toMatchObject({ summary: 'other session' });
	});

	it('URI ごとに独立したスナップショットを返す', async () => {
		const orderSnap = { ok: true, summary: 'order' };
		storeUiSnapshot('ui://order/confirm.html', orderSnap);

		const cancelResult = (await toolDef.handler({ resource_uri: 'ui://cancel/confirm.html' })) as { ok: boolean };
		expect(cancelResult.ok).toBe(false);

		const orderResult = (await toolDef.handler({ resource_uri: 'ui://order/confirm.html' })) as {
			structuredContent: Record<string, unknown>;
		};
		expect(orderResult.structuredContent).toBe(orderSnap);
	});
});
