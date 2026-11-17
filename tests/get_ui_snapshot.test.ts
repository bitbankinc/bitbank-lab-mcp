import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIRMATION_META_KEY } from '../src/mcp-apps-meta.js';
import { clientSupportsElicitation, isAppUiExecuteAllowed } from '../src/private/elicitation.js';
import { disableSharedConfirmState, enableSharedConfirmState } from '../src/private/shared-confirm-state.js';
import {
	APP_RESOURCE_MIME_TYPE,
	appResourceRegistry,
	MCP_APPS_UI_EXTENSION_ID,
} from '../src/resources/app-resources.js';
import { GetUiSnapshotInputSchema, UI_SNAPSHOT_RESOURCE_URIS } from '../src/schema/ui.js';
import { _resetUiSnapshots, storeUiSnapshot } from '../src/ui-snapshot-cache.js';
import { toolDef } from '../tools/get_ui_snapshot.js';

const URI = 'ui://order/confirm.html';

afterEach(() => {
	_resetUiSnapshots();
	vi.unstubAllEnvs();
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

	it('session A のスナップショットを session B が取得できない（キー分離）', async () => {
		storeUiSnapshot(URI, { ok: true, summary: 'a' }, { sessionId: 'session-a' });
		storeUiSnapshot(URI, { ok: true, summary: 'b' }, { sessionId: 'session-b' });

		const fromB = (await toolDef.handler({ resource_uri: URI }, { sessionId: 'session-b' })) as {
			structuredContent: Record<string, unknown>;
		};
		expect(fromB.structuredContent).toMatchObject({ summary: 'b' });

		const fromA = (await toolDef.handler({ resource_uri: URI }, { sessionId: 'session-a' })) as {
			structuredContent: Record<string, unknown>;
		};
		expect(fromA.structuredContent).toMatchObject({ summary: 'a' });
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

	// url モードだけを宣言したホストは form 形式の elicitation を処理できず、preview 側は fallback（`_meta` にトークンを載せる経路）へ倒れる。snapshot 側の `isAppUiExecuteAllowed && !clientSupportsElicitation` も同じ述語なので、ここで判定がずれないことを固定する（#27）。
	it('url モードのみを宣言したホストで snapshot 側の判定が preview 側と一致する（#27）', async () => {
		vi.stubEnv('BITBANK_MCP_APPS_EXECUTE', '1');
		const meta = { [CONFIRMATION_META_KEY]: { confirmation_token: 'tok-url-only', expires_at: Date.now() + 60_000 } };
		storeUiSnapshot(URI, { ok: true, summary: 'preview summary' }, {}, meta, Date.now() + 60_000);

		const extra = {
			mcpReq: {
				envelope: {
					[CLIENT_CAPABILITIES_META_KEY]: {
						elicitation: { url: {} },
						extensions: { [MCP_APPS_UI_EXTENSION_ID]: { mimeTypes: [APP_RESOURCE_MIME_TYPE] } },
					},
				},
			},
		};

		// preview 側の判定: form 非対応なので fallback（= `_meta` 配送）経路
		expect(clientSupportsElicitation(extra)).toBe(false);
		expect(isAppUiExecuteAllowed(extra)).toBe(true);

		// snapshot 側の判定: 同じ述語を使っているので `_meta` を返す
		const result = (await toolDef.handler({ resource_uri: URI }, extra)) as { _meta?: Record<string, unknown> };
		expect(result._meta).toEqual(meta);
	});
});

// 共有ファイルのトークンは、カードが受け取ったと知らせたら消す。読んだだけで消すと、ホストが `_meta` を落としたときにリソースから取り直せない（ADR-0007 判断事項 D）。
describe.skipIf(process.platform === 'win32')('handler（プロセス間で共有するとき）', () => {
	const extra = {
		server: {
			getClientCapabilities: () => ({
				extensions: { [MCP_APPS_UI_EXTENSION_ID]: { mimeTypes: [APP_RESOURCE_MIME_TYPE] } },
			}),
		},
	};
	let root: string;

	function sharedText(): string {
		const dir = path.join(root, 'confirm', 'snapshots');
		return fs
			.readdirSync(dir)
			.map((n) => fs.readFileSync(path.join(dir, n), 'utf8'))
			.join('');
	}

	function storeFromOtherProcess(token: string) {
		const expiresAt = Date.now() + 60_000;
		storeUiSnapshot(
			URI,
			{ ok: true, summary: 'preview' },
			{},
			{ [CONFIRMATION_META_KEY]: { confirmation_token: token, expires_at: expiresAt } },
			expiresAt,
		);
		_resetUiSnapshots();
	}

	afterEach(() => {
		disableSharedConfirmState();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('読んだだけではファイルのトークンを消さない（ホストが `_meta` を落としても、カードが取り直せる）', async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-snapshot-shared-'));
		enableSharedConfirmState(path.join(root, 'confirm'));
		vi.stubEnv('BITBANK_MCP_APPS_EXECUTE', '1');
		storeFromOtherProcess('tok-once');

		const first = (await toolDef.handler({ resource_uri: URI }, extra)) as { _meta?: Record<string, unknown> };
		expect(first._meta?.[CONFIRMATION_META_KEY]).toMatchObject({ confirmation_token: 'tok-once' });
		const second = (await toolDef.handler({ resource_uri: URI }, extra)) as { _meta?: Record<string, unknown> };
		expect(second._meta?.[CONFIRMATION_META_KEY]).toMatchObject({ confirmation_token: 'tok-once' });
	});

	it('カードが受け取ったトークンを知らせたら、ファイルから消す', async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-snapshot-shared-'));
		enableSharedConfirmState(path.join(root, 'confirm'));
		vi.stubEnv('BITBANK_MCP_APPS_EXECUTE', '1');
		storeFromOtherProcess('tok-once');

		await toolDef.handler({ resource_uri: URI, confirmation_token: 'tok-once' }, extra);

		expect(sharedText()).not.toContain('tok-once');
		const after = (await toolDef.handler({ resource_uri: URI }, extra)) as {
			_meta?: Record<string, unknown>;
			structuredContent?: unknown;
		};
		expect(after._meta).toBeUndefined();
		expect(after.structuredContent).toEqual({ ok: true, summary: 'preview' });
	});

	it('知らせたトークンが今のトークンと違えば消さない', async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-snapshot-shared-'));
		enableSharedConfirmState(path.join(root, 'confirm'));
		vi.stubEnv('BITBANK_MCP_APPS_EXECUTE', '1');
		storeFromOtherProcess('tok-current');

		await toolDef.handler({ resource_uri: URI, confirmation_token: 'tok-other' }, extra);

		expect(sharedText()).toContain('tok-current');
	});
});

describe('GetUiSnapshotInputSchema（受け取りの知らせ）', () => {
	it('confirmation_token は省略でき、渡すなら文字列', () => {
		expect(GetUiSnapshotInputSchema.safeParse({ resource_uri: URI, confirmation_token: 'x' }).success).toBe(true);
		expect(GetUiSnapshotInputSchema.safeParse({ resource_uri: URI, confirmation_token: 1 }).success).toBe(false);
	});
});
