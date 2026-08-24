/**
 * MCP Apps（SEP-1865）ホスト向け `_meta` 経由 execute 経路のセキュリティ回帰。
 *
 * ADR-0007「テストで固定する不変条件」1〜8 に対応する。**最重要は
 * 「content / structuredContent にトークンが出ない」**（ここが破れると設計が崩壊する）。
 *
 * 設計の要点:
 *   - トークンはツール結果 `_meta` にのみ載る。LLM は `_meta` を読めない（計測済み）ため、
 *     「トークンを提示できるか」が iframe 起源と LLM 起源を分ける唯一の判定基準になる
 *   - 有効化は 2 段の AND（運用者のオプトイン AND MCP Apps UI 宣言 + MIME 型）
 *   - elicitation 対応ホストには一切載せない（優先順位の不変条件）
 */

import { isInputRequiredResult } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_RESOURCE_MIME_TYPE, MCP_APPS_UI_EXTENSION_ID } from '../../src/resources/app-resources.js';
import { mockBitbankSuccess, mockSpotPairsResponse } from '../fixtures/private-api.js';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

const ORDER_ARGS = { pair: 'btc_jpy', amount: '0.01', side: 'buy' as const, type: 'limit' as const, price: '14000000' };
const CANCEL_ARGS = { pair: 'btc_jpy', order_id: 2001 };
const CANCEL_BULK_ARGS = { pair: 'btc_jpy', order_ids: [3001, 3002] };

/** `_meta` に載る確認トークンのキー（`src/mcp-apps-meta.ts` と同じ値であることも検証する）。 */
const META_KEY = 'cc.bitbank/confirmation';

type HandlerResult = {
	content?: { text: string }[];
	structuredContent?: Record<string, unknown>;
	_meta?: Record<string, unknown>;
};

/** MCP Apps UI を宣言するホストの ctx（initialize 経由）。 */
function appUiCtx(mimeTypes: unknown = [APP_RESOURCE_MIME_TYPE]): Record<string, unknown> {
	return {
		server: {
			getClientCapabilities: () => ({ extensions: { [MCP_APPS_UI_EXTENSION_ID]: { mimeTypes } } }),
		},
	};
}

/** MCP Apps UI 宣言を per-request envelope で渡す ctx。 */
function envelopeCtx(clientCapabilities: unknown, initCapabilities?: unknown): Record<string, unknown> {
	return {
		...(initCapabilities !== undefined ? { server: { getClientCapabilities: () => initCapabilities } } : {}),
		mcpReq: { envelope: { clientCapabilities } },
	};
}

const APP_UI_CAPS = { extensions: { [MCP_APPS_UI_EXTENSION_ID]: { mimeTypes: [APP_RESOURCE_MIME_TYPE] } } };

function installFetchMock() {
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
		if (url.includes('/spot/pairs')) {
			return new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 });
		}
		if (url.includes('/ticker')) {
			return new Response(JSON.stringify(mockBitbankSuccess({ last: '15000000' })), { status: 200 });
		}
		if (url.includes('/user/spot/order_info') || url.includes('/v1/user/spot/order?')) {
			return new Response(
				JSON.stringify(
					mockBitbankSuccess({
						order_id: 2001,
						pair: 'btc_jpy',
						side: 'buy',
						type: 'limit',
						start_amount: '0.01',
						remaining_amount: '0.01',
						executed_amount: '0',
						price: '14000000',
						average_price: '0',
						status: 'UNFILLED',
						ordered_at: 1710000000000,
					}),
				),
				{ status: 200 },
			);
		}
		if (url.includes('/cancel_orders')) {
			return new Response(JSON.stringify(mockBitbankSuccess({ orders: [] })), { status: 200 });
		}
		if (url.includes('/cancel_order')) {
			return new Response(
				JSON.stringify(
					mockBitbankSuccess({
						order_id: 2001,
						pair: 'btc_jpy',
						side: 'buy',
						type: 'limit',
						start_amount: '0.01',
						remaining_amount: '0',
						executed_amount: '0',
						average_price: '0',
						status: 'CANCELED_UNFILLED',
						ordered_at: 1710000000000,
					}),
				),
				{ status: 200 },
			);
		}
		if (url.includes('/user/spot/order')) {
			return new Response(
				JSON.stringify(
					mockBitbankSuccess({
						order_id: 99999,
						pair: 'btc_jpy',
						side: 'buy',
						type: 'limit',
						start_amount: '0.01',
						remaining_amount: '0.01',
						executed_amount: '0',
						average_price: '0',
						status: 'UNFILLED',
						ordered_at: 1710000000000,
					}),
				),
				{ status: 200 },
			);
		}
		return new Response(JSON.stringify({ success: 1, data: {} }), { status: 200 });
	}) as unknown as typeof fetch;
}

/** 発注 API（POST /v1/user/spot/order）の呼び出し回数。GET 照会は除外する。 */
function countOrderApiCalls(): number {
	const fetchMock = globalThis.fetch as unknown as { mock: { calls: Array<[unknown]> } };
	return fetchMock.mock.calls.filter((c) => {
		const url = String(c[0]);
		return url.includes('/v1/user/spot/order') && !url.includes('?') && !url.includes('cancel');
	}).length;
}

beforeEach(() => {
	process.env = { ...originalEnv };
	process.env.BITBANK_API_KEY = 'test_key';
	process.env.BITBANK_API_SECRET = 'test_secret';
	installFetchMock();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	process.env = { ...originalEnv };
	vi.restoreAllMocks();
	vi.resetModules();
});

const PREVIEW_CASES = [
	{ name: 'preview_order', load: () => import('../../tools/private/preview_order.js'), args: ORDER_ARGS },
	{
		name: 'preview_cancel_order',
		load: () => import('../../tools/private/preview_cancel_order.js'),
		args: CANCEL_ARGS,
	},
	{
		name: 'preview_cancel_orders',
		load: () => import('../../tools/private/preview_cancel_orders.js'),
		args: CANCEL_BULK_ARGS,
	},
] as const;

/** `_meta` に載ったトークンを取り出す（無ければ undefined）。 */
function metaToken(result: HandlerResult): string | undefined {
	return (result._meta?.[META_KEY] as { confirmation_token?: string } | undefined)?.confirmation_token;
}

describe('不変条件 1: content / structuredContent にトークンが出ない（最重要）', () => {
	for (const c of PREVIEW_CASES) {
		it(`${c.name}: オプトイン on + MCP Apps ホストでも content / structuredContent には載らない`, async () => {
			process.env.BITBANK_MCP_APPS_EXECUTE = '1';
			const { toolDef } = await c.load();
			const result = (await toolDef.handler(c.args as never, appUiCtx())) as HandlerResult;

			// 前提: この構成では実際にトークンが `_meta` に載っている
			const token = metaToken(result);
			expect(token).toBeTypeOf('string');

			// 本体: content / structuredContent のどこにもトークン値が現れない
			expect(JSON.stringify(result.content)).not.toContain(token);
			expect(JSON.stringify(result.structuredContent)).not.toContain(token);
			// フィールド名としても露出しない
			expect(JSON.stringify(result.structuredContent)).not.toContain('confirmation_token');
			expect(JSON.stringify(result.content)).not.toContain('confirmation_token');
		});
	}

	it('execute 成功応答にもトークンが混入しない', async () => {
		process.env.BITBANK_MCP_APPS_EXECUTE = '1';
		const { toolDef: previewDef } = await import('../../tools/private/preview_order.js');
		const preview = (await previewDef.handler(ORDER_ARGS as never, appUiCtx())) as HandlerResult;
		const payload = preview._meta?.[META_KEY] as { confirmation_token: string; expires_at: number };

		const { toolDef: createDef } = await import('../../tools/private/create_order.js');
		const executed = (await createDef.handler(
			{ ...ORDER_ARGS, confirmation_token: payload.confirmation_token, token_expires_at: payload.expires_at },
			appUiCtx(),
		)) as HandlerResult & { ok?: boolean };

		expect(executed.ok).toBe(true);
		expect(JSON.stringify(executed)).not.toContain(payload.confirmation_token);
	});
});

describe('不変条件 2: オプトイン off では `_meta` にトークンが載らない', () => {
	for (const c of PREVIEW_CASES) {
		it(`${c.name}: 環境変数未設定なら MCP Apps ホストでも載らない`, async () => {
			const { toolDef } = await c.load();
			const result = (await toolDef.handler(c.args as never, appUiCtx())) as HandlerResult;
			expect(metaToken(result)).toBeUndefined();
			expect(JSON.stringify(result)).not.toContain('confirmation_token');
		});
	}

	it('`1` 以外の値（true）ではオプトインとみなさない', async () => {
		process.env.BITBANK_MCP_APPS_EXECUTE = 'true';
		const { toolDef } = await import('../../tools/private/preview_order.js');
		const result = (await toolDef.handler(ORDER_ARGS as never, appUiCtx())) as HandlerResult;
		expect(metaToken(result)).toBeUndefined();
	});
});

describe('不変条件 3: MCP Apps UI 宣言 / MIME 型が無いホストには載らない', () => {
	const rejected: Array<{ label: string; ctx: () => Record<string, unknown> }> = [
		{ label: 'capability を一切宣言しない', ctx: () => ({}) },
		{ label: 'extensions が空', ctx: () => ({ server: { getClientCapabilities: () => ({ extensions: {} }) } }) },
		{
			label: 'mimeTypes キーが無い',
			ctx: () => ({ server: { getClientCapabilities: () => ({ extensions: { [MCP_APPS_UI_EXTENSION_ID]: {} } }) } }),
		},
		{ label: 'mimeTypes が空配列', ctx: () => appUiCtx([]) },
		{ label: 'mimeTypes に該当型が無い', ctx: () => appUiCtx(['text/html']) },
		{ label: 'mimeTypes が配列でない', ctx: () => appUiCtx(APP_RESOURCE_MIME_TYPE) },
	];

	for (const r of rejected) {
		it(`${r.label} → トークンを載せない`, async () => {
			process.env.BITBANK_MCP_APPS_EXECUTE = '1';
			const { toolDef } = await import('../../tools/private/preview_order.js');
			const result = (await toolDef.handler(ORDER_ARGS as never, r.ctx())) as HandlerResult;
			expect(metaToken(result)).toBeUndefined();
		});
	}

	it('拡張キーの存在だけでは不可（mimeTypes 欠落は fail-closed）', async () => {
		process.env.BITBANK_MCP_APPS_EXECUTE = '1';
		const { clientSupportsAppUi } = await import('../../src/private/elicitation.js');
		expect(
			clientSupportsAppUi({
				server: { getClientCapabilities: () => ({ extensions: { [MCP_APPS_UI_EXTENSION_ID]: {} } }) },
			}),
		).toBe(false);
		expect(clientSupportsAppUi(appUiCtx())).toBe(true);
	});
});

describe('不変条件 4: capability の取得元が食い違う場合は envelope を権威とする', () => {
	it('envelope が非対応・initialize が対応 → 載せない（狭い側に倒す）', async () => {
		process.env.BITBANK_MCP_APPS_EXECUTE = '1';
		const { toolDef } = await import('../../tools/private/preview_order.js');
		const result = (await toolDef.handler(
			ORDER_ARGS as never,
			envelopeCtx({ extensions: {} }, APP_UI_CAPS),
		)) as HandlerResult;
		expect(metaToken(result)).toBeUndefined();
	});

	it('envelope が対応・initialize が非対応 → 載せる', async () => {
		process.env.BITBANK_MCP_APPS_EXECUTE = '1';
		const { toolDef } = await import('../../tools/private/preview_order.js');
		const result = (await toolDef.handler(
			ORDER_ARGS as never,
			envelopeCtx(APP_UI_CAPS, { extensions: {} }),
		)) as HandlerResult;
		expect(metaToken(result)).toBeTypeOf('string');
	});

	it('envelope に clientCapabilities が無い場合のみ initialize へフォールバックする', async () => {
		process.env.BITBANK_MCP_APPS_EXECUTE = '1';
		const { clientSupportsAppUi } = await import('../../src/private/elicitation.js');
		const ctx = { server: { getClientCapabilities: () => APP_UI_CAPS }, mcpReq: { envelope: {} } };
		expect(clientSupportsAppUi(ctx)).toBe(true);
	});
});

describe('不変条件 5: elicitation 対応ホストにはオプトイン on でもトークンを載せない', () => {
	for (const c of PREVIEW_CASES) {
		it(`${c.name}: elicitation 宣言時は _meta に載らない`, async () => {
			process.env.BITBANK_MCP_APPS_EXECUTE = '1';
			const { toolDef } = await c.load();
			// elicitation と MCP Apps UI の両方を宣言するホスト
			const ctx = {
				server: {
					getClientCapabilities: () => ({ elicitation: {}, ...APP_UI_CAPS }),
				},
			};
			const result = await toolDef.handler(c.args as never, ctx);
			// elicitation 経路が実際に選ばれたことを確認する。これが無いと、ハンドラが
			// エラーで落ちた場合でも「トークンが無い」だけでテストが通ってしまう。
			expect(isInputRequiredResult(result)).toBe(true);
			expect(metaToken(result as HandlerResult)).toBeUndefined();
			expect(JSON.stringify(result)).not.toContain('confirmation_token');
		});
	}

	// pull 型 hydration（get_ui_snapshot）は preview とは**別リクエスト**なので、
	// 「elicitation 非対応と判定したあとだけ `_meta` を付ける」という preview 側の構造では
	// 守れない。スナップショットはリクエスト A（elicitation 非宣言）で作られ、リクエスト B
	// （elicitation 宣言）から読み出せてしまうため、取得側でも同じ条件を課す必要がある。
	const SNAPSHOT_URI = 'ui://order/confirm.html';

	async function seedTokenSnapshot() {
		const { storeUiSnapshot, _resetUiSnapshots } = await import('../../src/ui-snapshot-cache.js');
		_resetUiSnapshots();
		const expiresAt = Date.now() + 60_000;
		storeUiSnapshot(
			SNAPSHOT_URI,
			{ ok: true, data: { preview: { pair: 'btc_jpy' } } },
			{},
			{ [META_KEY]: { confirmation_token: 'tok_seed', expires_at: expiresAt } },
			expiresAt,
		);
	}

	it('get_ui_snapshot: initialize で elicitation を宣言するホストには _meta に載らない', async () => {
		process.env.BITBANK_MCP_APPS_EXECUTE = '1';
		await seedTokenSnapshot();
		const { toolDef } = await import('../../tools/get_ui_snapshot.js');
		const ctx = { server: { getClientCapabilities: () => ({ elicitation: {}, ...APP_UI_CAPS }) } };

		const result = (await toolDef.handler({ resource_uri: SNAPSHOT_URI }, ctx)) as HandlerResult;

		expect(result._meta).toBeUndefined();
		expect(JSON.stringify(result)).not.toContain('tok_seed');
		// プレビューの再描画は従来どおり生きている（安全側に倒しすぎない）
		expect(result.structuredContent).toBeDefined();
	});

	// リクエストごとに capability が変わりうる 2026-07-28 系ではこちらが実際に到達する経路。
	it('get_ui_snapshot: envelope で elicitation を宣言するリクエストにも載らない', async () => {
		process.env.BITBANK_MCP_APPS_EXECUTE = '1';
		await seedTokenSnapshot();
		const { toolDef } = await import('../../tools/get_ui_snapshot.js');

		const result = (await toolDef.handler(
			{ resource_uri: SNAPSHOT_URI },
			envelopeCtx({ elicitation: {}, ...APP_UI_CAPS }),
		)) as HandlerResult;

		expect(result._meta).toBeUndefined();
		expect(JSON.stringify(result)).not.toContain('tok_seed');
		expect(result.structuredContent).toBeDefined();
	});

	// 逆側の固定: elicitation 非対応なら従来どおり載る（過剰に塞いで経路 2 を殺していないこと）
	it('get_ui_snapshot: elicitation 非対応ホストには従来どおり載る', async () => {
		process.env.BITBANK_MCP_APPS_EXECUTE = '1';
		await seedTokenSnapshot();
		const { toolDef } = await import('../../tools/get_ui_snapshot.js');

		const result = (await toolDef.handler({ resource_uri: SNAPSHOT_URI }, appUiCtx())) as HandlerResult;

		expect(metaToken(result)).toBe('tok_seed');
	});
});

describe('不変条件 6: トークン無しの直接呼び出しは direct_execute_forbidden', () => {
	const EXECUTE_CASES = [
		{ name: 'create_order', load: () => import('../../tools/private/create_order.js'), args: ORDER_ARGS },
		{ name: 'cancel_order', load: () => import('../../tools/private/cancel_order.js'), args: CANCEL_ARGS },
		{ name: 'cancel_orders', load: () => import('../../tools/private/cancel_orders.js'), args: CANCEL_BULK_ARGS },
	] as const;

	for (const c of EXECUTE_CASES) {
		it(`${c.name}: ゲート off で拒否され API を呼ばない`, async () => {
			const { toolDef } = await c.load();
			const result = (await toolDef.handler(c.args as never, appUiCtx())) as {
				ok: boolean;
				meta?: { errorType?: string };
			};
			expect(result.ok).toBe(false);
			expect(result.meta?.errorType).toBe('direct_execute_forbidden');
			expect(countOrderApiCalls()).toBe(0);
		});

		it(`${c.name}: ゲート on でもトークン無しなら拒否され API を呼ばない`, async () => {
			process.env.BITBANK_MCP_APPS_EXECUTE = '1';
			const { toolDef } = await c.load();
			const result = (await toolDef.handler(c.args as never, appUiCtx())) as {
				ok: boolean;
				meta?: { errorType?: string };
			};
			expect(result.ok).toBe(false);
			expect(result.meta?.errorType).toBe('direct_execute_forbidden');
			expect(countOrderApiCalls()).toBe(0);
		});
	}

	it('有効なトークンを持っていてもゲート off なら拒否される', async () => {
		// トークンはオプトイン on で発行しておき、execute 時だけ off に戻す。
		process.env.BITBANK_MCP_APPS_EXECUTE = '1';
		const { toolDef: previewDef } = await import('../../tools/private/preview_order.js');
		const preview = (await previewDef.handler(ORDER_ARGS as never, appUiCtx())) as HandlerResult;
		const payload = preview._meta?.[META_KEY] as { confirmation_token: string; expires_at: number };

		process.env.BITBANK_MCP_APPS_EXECUTE = '0';
		const { toolDef: createDef } = await import('../../tools/private/create_order.js');
		const result = (await createDef.handler(
			{ ...ORDER_ARGS, confirmation_token: payload.confirmation_token, token_expires_at: payload.expires_at },
			appUiCtx(),
		)) as { ok: boolean; meta?: { errorType?: string } };

		expect(result.ok).toBe(false);
		expect(result.meta?.errorType).toBe('direct_execute_forbidden');
		expect(countOrderApiCalls()).toBe(0);
	});
});

describe('不変条件 7: 不正・期限切れ・使用済み・別注文のトークンは拒否される', () => {
	async function mintOrderToken() {
		const { toolDef } = await import('../../tools/private/preview_order.js');
		const preview = (await toolDef.handler(ORDER_ARGS as never, appUiCtx())) as HandlerResult;
		return preview._meta?.[META_KEY] as { confirmation_token: string; expires_at: number };
	}

	beforeEach(() => {
		process.env.BITBANK_MCP_APPS_EXECUTE = '1';
	});

	it('改ざんされたトークンは token_invalid', async () => {
		const payload = await mintOrderToken();
		// 末尾 1 文字を**必ず別の文字**に差し替える。固定文字（例: 常に '0'）にすると、
		// HMAC hex の末尾が元からその文字だったとき改ざん後が原文と一致し、正しく検証が
		// 通ってしまう（`expiresAt` が実行ごとに変わるため約 1/16 でランダムに落ちる）。
		// `tests/private/request-state.test.ts` の tamper と同じ書き方に揃える。
		const token = payload.confirmation_token;
		const tampered = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
		const { toolDef } = await import('../../tools/private/create_order.js');
		const result = (await toolDef.handler(
			{ ...ORDER_ARGS, confirmation_token: tampered, token_expires_at: payload.expires_at },
			appUiCtx(),
		)) as { ok: boolean; meta?: { errorType?: string } };
		expect(result.ok).toBe(false);
		expect(result.meta?.errorType).toBe('token_invalid');
		expect(countOrderApiCalls()).toBe(0);
	});

	it('期限切れトークンは token_expired', async () => {
		const payload = await mintOrderToken();
		const { toolDef } = await import('../../tools/private/create_order.js');
		const result = (await toolDef.handler(
			{ ...ORDER_ARGS, confirmation_token: payload.confirmation_token, token_expires_at: Date.now() - 1 },
			appUiCtx(),
		)) as { ok: boolean; meta?: { errorType?: string } };
		expect(result.ok).toBe(false);
		expect(result.meta?.errorType).toBe('token_expired');
		expect(countOrderApiCalls()).toBe(0);
	});

	it('同じトークンの 2 回目は token_already_used（二重発注しない）', async () => {
		const payload = await mintOrderToken();
		const { toolDef } = await import('../../tools/private/create_order.js');
		const args = {
			...ORDER_ARGS,
			confirmation_token: payload.confirmation_token,
			token_expires_at: payload.expires_at,
		};
		const first = (await toolDef.handler(args, appUiCtx())) as { ok: boolean };
		const second = (await toolDef.handler(args, appUiCtx())) as { ok: boolean; meta?: { errorType?: string } };

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(false);
		expect(second.meta?.errorType).toBe('token_already_used');
		expect(countOrderApiCalls()).toBe(1);
	});

	it('別内容の注文に流用すると token_invalid（argsDigest / HMAC 束縛）', async () => {
		const payload = await mintOrderToken();
		const { toolDef } = await import('../../tools/private/create_order.js');
		const result = (await toolDef.handler(
			{
				...ORDER_ARGS,
				amount: '0.5', // プレビューしていない数量
				confirmation_token: payload.confirmation_token,
				token_expires_at: payload.expires_at,
			},
			appUiCtx(),
		)) as { ok: boolean; meta?: { errorType?: string } };
		expect(result.ok).toBe(false);
		expect(result.meta?.errorType).toBe('token_invalid');
		expect(countOrderApiCalls()).toBe(0);
	});

	it('cancel_order のトークンを create_order に流用できない（action 束縛）', async () => {
		const { toolDef: previewCancelDef } = await import('../../tools/private/preview_cancel_order.js');
		const preview = (await previewCancelDef.handler(CANCEL_ARGS as never, appUiCtx())) as HandlerResult;
		const payload = preview._meta?.[META_KEY] as { confirmation_token: string; expires_at: number };

		const { toolDef } = await import('../../tools/private/create_order.js');
		const result = (await toolDef.handler(
			{ ...ORDER_ARGS, confirmation_token: payload.confirmation_token, token_expires_at: payload.expires_at },
			appUiCtx(),
		)) as { ok: boolean; meta?: { errorType?: string } };
		expect(result.ok).toBe(false);
		expect(result.meta?.errorType).toBe('token_invalid');
		expect(countOrderApiCalls()).toBe(0);
	});
});

describe('不変条件 8: get_ui_snapshot の `_meta` はゲートと期限に従う', () => {
	const RESOURCE_URI = 'ui://order/confirm.html';

	async function seedSnapshot(metaExpiresAtMs?: number) {
		const { storeUiSnapshot, _resetUiSnapshots } = await import('../../src/ui-snapshot-cache.js');
		_resetUiSnapshots();
		storeUiSnapshot(
			RESOURCE_URI,
			{ ok: true, data: { preview: { pair: 'btc_jpy' } } },
			{},
			{ [META_KEY]: { confirmation_token: 'tok_seed', expires_at: metaExpiresAtMs ?? Date.now() + 60_000 } },
			metaExpiresAtMs ?? Date.now() + 60_000,
		);
	}

	it('ゲート on なら `_meta` を返す', async () => {
		process.env.BITBANK_MCP_APPS_EXECUTE = '1';
		await seedSnapshot();
		const { toolDef } = await import('../../tools/get_ui_snapshot.js');
		const result = (await toolDef.handler({ resource_uri: RESOURCE_URI }, appUiCtx())) as HandlerResult;
		expect(metaToken(result)).toBe('tok_seed');
		// structuredContent 側には出ない
		expect(JSON.stringify(result.structuredContent)).not.toContain('tok_seed');
	});

	it('ゲート off なら `_meta` を返さない（structuredContent は返す）', async () => {
		await seedSnapshot();
		const { toolDef } = await import('../../tools/get_ui_snapshot.js');
		const result = (await toolDef.handler({ resource_uri: RESOURCE_URI }, appUiCtx())) as HandlerResult;
		expect(result._meta).toBeUndefined();
		expect(result.structuredContent).toBeDefined();
	});

	it('MCP Apps UI 未宣言なら `_meta` を返さない', async () => {
		process.env.BITBANK_MCP_APPS_EXECUTE = '1';
		await seedSnapshot();
		const { toolDef } = await import('../../tools/get_ui_snapshot.js');
		const result = (await toolDef.handler({ resource_uri: RESOURCE_URI }, {})) as HandlerResult;
		expect(result._meta).toBeUndefined();
		expect(result.structuredContent).toBeDefined();
	});

	it('トークンの期限を過ぎたら `_meta` を返さない（structuredContent は返し続ける）', async () => {
		process.env.BITBANK_MCP_APPS_EXECUTE = '1';
		await seedSnapshot(Date.now() - 1);
		const { toolDef } = await import('../../tools/get_ui_snapshot.js');
		const result = (await toolDef.handler({ resource_uri: RESOURCE_URI }, appUiCtx())) as HandlerResult;
		expect(result._meta).toBeUndefined();
		// プレビュー再描画はスナップショット TTL(5分) の範囲で生きている
		expect(result.structuredContent).toBeDefined();
	});
});

describe('`_meta` 経路の案内文言', () => {
	it('ゲート on では確認カードのボタン操作を案内する（トークンは含めない）', async () => {
		process.env.BITBANK_MCP_APPS_EXECUTE = '1';
		const { toolDef } = await import('../../tools/private/preview_order.js');
		const result = (await toolDef.handler(ORDER_ARGS as never, appUiCtx())) as HandlerResult;
		const text = result.content?.[0]?.text ?? '';
		expect(text).toContain('ボタンを押さない限り発注されません');
		expect(text).not.toContain('このホストでは取引実行に対応していません');
		expect(text).not.toContain(metaToken(result));
	});

	it('ゲート off では従来どおり「実行に対応していません」を案内する', async () => {
		const { toolDef } = await import('../../tools/private/preview_order.js');
		const result = (await toolDef.handler(ORDER_ARGS as never, appUiCtx())) as HandlerResult;
		const text = result.content?.[0]?.text ?? '';
		expect(text).toContain('このホストでは取引実行に対応していません');
		expect(text).not.toContain('ボタンを押さない限り');
	});
});

describe('`_meta` キーの契約', () => {
	it('サーバーと UI が共有する定数が期待値と一致する', async () => {
		const { CONFIRMATION_META_KEY } = await import('../../src/mcp-apps-meta.js');
		expect(CONFIRMATION_META_KEY).toBe(META_KEY);
	});

	it('readConfirmationMeta は形状不正を弾く', async () => {
		const { readConfirmationMeta } = await import('../../src/mcp-apps-meta.js');
		expect(readConfirmationMeta(undefined)).toBeUndefined();
		expect(readConfirmationMeta({})).toBeUndefined();
		expect(readConfirmationMeta({ [META_KEY]: {} })).toBeUndefined();
		expect(readConfirmationMeta({ [META_KEY]: { confirmation_token: '', expires_at: 1 } })).toBeUndefined();
		expect(readConfirmationMeta({ [META_KEY]: { confirmation_token: 'a', expires_at: Number.NaN } })).toBeUndefined();
		expect(readConfirmationMeta({ [META_KEY]: { confirmation_token: 'a', expires_at: 1 } })).toEqual({
			confirmation_token: 'a',
			expires_at: 1,
		});
	});
});
