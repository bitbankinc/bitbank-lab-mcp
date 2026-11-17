import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appResourceUriFor, CONFIRMATION_META_KEY, confirmationResourceUri } from '../src/mcp-apps-meta.js';
import { disableSharedConfirmState, enableSharedConfirmState } from '../src/private/shared-confirm-state.js';
import { APP_RESOURCE_MIME_TYPE, MCP_APPS_UI_EXTENSION_ID } from '../src/resources/app-resources.js';
import { readConfirmationResource } from '../src/resources/confirmation-resource.js';
import { _resetUiSnapshots, storeUiSnapshot } from '../src/ui-snapshot-cache.js';

const APP_URI = 'ui://order/confirm.html';
const RESOURCE_URI = 'bitbank-confirmation://order';
const APP_UI_CAPS = { extensions: { [MCP_APPS_UI_EXTENSION_ID]: { mimeTypes: [APP_RESOURCE_MIME_TYPE] } } };
const STRUCTURED = { ok: true, summary: 'preview', data: { preview: { pair: 'btc_jpy', amount: '0.001' } } };

function extraWith(caps: unknown, sessionId?: string): Record<string, unknown> {
	return { server: { getClientCapabilities: () => caps }, ...(sessionId ? { sessionId } : {}) };
}

function storeWithToken(expiresAt = Date.now() + 60_000, sessionId?: string) {
	const confirmation = { confirmation_token: 'tok-resource', expires_at: expiresAt };
	storeUiSnapshot(APP_URI, STRUCTURED, { sessionId }, { [CONFIRMATION_META_KEY]: confirmation }, expiresAt);
	return confirmation;
}

function bodyOf(result: { contents: Array<{ text?: string }> }): unknown {
	return JSON.parse(result.contents[0]?.text ?? 'null');
}

afterEach(() => {
	_resetUiSnapshots();
	vi.unstubAllEnvs();
});

// ホストが結果 `_meta` を iframe に渡さないとき（Claude Desktop の更新後）の代わりの経路。`get_ui_snapshot` の `_meta` と同じ条件でだけトークンを渡す（ADR-0007）。
describe('readConfirmationResource', () => {
	it('オプトイン + MCP Apps UI 宣言 + elicitation 非対応なら、注文の内容とトークンを本文で返す', () => {
		vi.stubEnv('BITBANK_MCP_APPS_EXECUTE', '1');
		const confirmation = storeWithToken();

		const result = readConfirmationResource(RESOURCE_URI, 'order', extraWith(APP_UI_CAPS));

		expect(result.contents[0]?.uri).toBe(RESOURCE_URI);
		expect(result.contents[0]?.mimeType).toBe('application/json');
		expect(bodyOf(result)).toEqual({ structuredContent: STRUCTURED, confirmation });
		expect(result).not.toHaveProperty('_meta');
	});

	it('オプトインが無ければトークンも内容も返さない', () => {
		storeWithToken();
		expect(bodyOf(readConfirmationResource(RESOURCE_URI, 'order', extraWith(APP_UI_CAPS)))).toEqual({});
	});

	it('MCP Apps UI を宣言しないクライアントには返さない', () => {
		vi.stubEnv('BITBANK_MCP_APPS_EXECUTE', '1');
		storeWithToken();
		expect(bodyOf(readConfirmationResource(RESOURCE_URI, 'order', extraWith({})))).toEqual({});
	});

	it('elicitation を宣言したクライアントには返さない（確認ダイアログを優先する）', () => {
		vi.stubEnv('BITBANK_MCP_APPS_EXECUTE', '1');
		storeWithToken();
		const caps = { ...APP_UI_CAPS, elicitation: {} };
		expect(bodyOf(readConfirmationResource(RESOURCE_URI, 'order', extraWith(caps)))).toEqual({});
	});

	it('トークンの期限が切れていたら返さない', () => {
		vi.stubEnv('BITBANK_MCP_APPS_EXECUTE', '1');
		storeWithToken(Date.now() - 1);
		expect(bodyOf(readConfirmationResource(RESOURCE_URI, 'order', extraWith(APP_UI_CAPS)))).toEqual({});
	});

	it('別セッションのスナップショットは返さない', () => {
		vi.stubEnv('BITBANK_MCP_APPS_EXECUTE', '1');
		storeWithToken(Date.now() + 60_000, 'session-a');
		expect(bodyOf(readConfirmationResource(RESOURCE_URI, 'order', extraWith(APP_UI_CAPS, 'session-b')))).toEqual({});
	});

	it('登録されていない確認 UI の名前には返さない', () => {
		vi.stubEnv('BITBANK_MCP_APPS_EXECUTE', '1');
		storeWithToken();
		expect(bodyOf(readConfirmationResource('bitbank-confirmation://evil', 'evil', extraWith(APP_UI_CAPS)))).toEqual({});
		expect(bodyOf(readConfirmationResource(RESOURCE_URI, ['order'], extraWith(APP_UI_CAPS)))).toEqual({});
	});
});

// リソースは読んだだけではトークンを消さない。消すのは、カードが受け取ったと知らせたとき（get_ui_snapshot の confirmation_token。ADR-0007 判断事項 D）。
describe.skipIf(process.platform === 'win32')('readConfirmationResource（プロセス間で共有するとき）', () => {
	it('別プロセスのカードが何度読んでも、知らせが来るまではトークンを返す', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-resource-shared-'));
		try {
			enableSharedConfirmState(path.join(root, 'confirm'));
			vi.stubEnv('BITBANK_MCP_APPS_EXECUTE', '1');
			const confirmation = storeWithToken();
			_resetUiSnapshots();

			const expected = { structuredContent: STRUCTURED, confirmation };
			expect(bodyOf(readConfirmationResource(RESOURCE_URI, 'order', extraWith(APP_UI_CAPS)))).toEqual(expected);
			expect(bodyOf(readConfirmationResource(RESOURCE_URI, 'order', extraWith(APP_UI_CAPS)))).toEqual(expected);
		} finally {
			disableSharedConfirmState();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe('confirmationResourceUri / appResourceUriFor', () => {
	it('確認 UI の URI からリソース URI を作り、名前から確認 UI の URI に戻せる', () => {
		expect(confirmationResourceUri('ui://order/confirm.html')).toBe('bitbank-confirmation://order');
		expect(confirmationResourceUri('ui://cancel/confirm.html')).toBe('bitbank-confirmation://cancel');
		expect(appResourceUriFor('cancel')).toBe('ui://cancel/confirm.html');
	});

	it('確認 UI 以外の URI からは作らない', () => {
		expect(confirmationResourceUri('ui://order/other.html')).toBeUndefined();
		expect(confirmationResourceUri('https://example.com/confirm.html')).toBeUndefined();
	});
});
