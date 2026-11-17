import { CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../lib/logger.js';
import { CONFIRMATION_META_KEY } from '../src/mcp-apps-meta.js';
import { describeConfirmationGate, withElicitedConfirmation } from '../src/private/elicitation.js';
import { APP_RESOURCE_MIME_TYPE, MCP_APPS_UI_EXTENSION_ID } from '../src/resources/app-resources.js';
import { readConfirmationResource } from '../src/resources/confirmation-resource.js';
import { _resetUiSnapshots, storeUiSnapshot } from '../src/ui-snapshot-cache.js';

vi.mock('../lib/logger.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/logger.js')>()),
	log: vi.fn(),
}));

const APP_URI = 'ui://order/confirm.html';
const RESOURCE_URI = 'bitbank-confirmation://order';
const APP_UI_CAPS = { extensions: { [MCP_APPS_UI_EXTENSION_ID]: { mimeTypes: [APP_RESOURCE_MIME_TYPE] } } };
const TOKEN = 'tok-gate-log';

function extraWith(caps: unknown, more: Record<string, unknown> = {}): Record<string, unknown> {
	return { server: { getClientCapabilities: () => caps }, ...more };
}

function storeWithToken(expiresAt = Date.now() + 60_000, sessionId?: string) {
	storeUiSnapshot(
		APP_URI,
		{ ok: true, summary: 'preview' },
		{ sessionId },
		{ [CONFIRMATION_META_KEY]: { confirmation_token: TOKEN, expires_at: expiresAt } },
		expiresAt,
	);
}

function loggedEvents(type: string): Record<string, unknown>[] {
	return vi
		.mocked(log)
		.mock.calls.map(([, event]) => event)
		.filter((event) => event.type === type);
}

afterEach(() => {
	_resetUiSnapshots();
	vi.unstubAllEnvs();
	vi.mocked(log).mockClear();
});

// 実機（Claude Desktop）で delivered:false の理由が切り分けられなかったので、閉じた条件と判定に使った宣言の出どころを残す。
describe('confirmation_resource_read のログ', () => {
	it('渡したときは reason が null で、判定に使った宣言の出どころが残る', () => {
		vi.stubEnv('BITBANK_MCP_APPS_EXECUTE', '1');
		storeWithToken();
		readConfirmationResource(RESOURCE_URI, 'order', extraWith(APP_UI_CAPS));
		expect(loggedEvents('confirmation_resource_read')).toEqual([
			{
				type: 'confirmation_resource_read',
				app: 'order',
				delivered: true,
				reason: null,
				gate: { envelope: 'none', initialize: 'app_ui', session: null, client: null, pid: process.pid },
			},
		]);
	});

	it.each([
		['オプトインが無い', { BITBANK_MCP_APPS_EXECUTE: '0' }, APP_UI_CAPS, 'order', 'apps_execute_disabled'],
		['MCP Apps UI を宣言していない', { BITBANK_MCP_APPS_EXECUTE: '1' }, {}, 'order', 'no_app_ui'],
		[
			'elicitation を宣言している',
			{ BITBANK_MCP_APPS_EXECUTE: '1' },
			{ ...APP_UI_CAPS, elicitation: {} },
			'order',
			'elicitation',
		],
		['登録されていない確認 UI', { BITBANK_MCP_APPS_EXECUTE: '1' }, APP_UI_CAPS, 'evil', 'unknown_app'],
	])('%s ときは理由を残す', (_label, env, caps, app, reason) => {
		for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
		storeWithToken();
		readConfirmationResource(RESOURCE_URI, app, extraWith(caps));
		expect(loggedEvents('confirmation_resource_read')[0]).toMatchObject({ delivered: false, reason });
	});

	it('スナップショットが無いときと、トークンの期限が切れているときを分けて残す', () => {
		vi.stubEnv('BITBANK_MCP_APPS_EXECUTE', '1');
		readConfirmationResource(RESOURCE_URI, 'order', extraWith(APP_UI_CAPS));
		storeWithToken(Date.now() - 1);
		readConfirmationResource(RESOURCE_URI, 'order', extraWith(APP_UI_CAPS));
		expect(loggedEvents('confirmation_resource_read').map((e) => e.reason)).toEqual(['no_snapshot', 'no_token']);
	});

	it('トークンもセッション ID もそのままは残さない', () => {
		vi.stubEnv('BITBANK_MCP_APPS_EXECUTE', '1');
		storeWithToken(Date.now() + 60_000, 'session-secret-id');
		readConfirmationResource(RESOURCE_URI, 'order', extraWith(APP_UI_CAPS, { sessionId: 'session-secret-id' }));
		const [event] = loggedEvents('confirmation_resource_read');
		expect(event).toMatchObject({ delivered: true });
		expect(event).toHaveProperty('gate.session', expect.stringMatching(/^[0-9a-f]{8}$/));
		expect(JSON.stringify(event)).not.toContain(TOKEN);
		expect(JSON.stringify(event)).not.toContain('session-secret-id');
	});
});

describe('describeConfirmationGate', () => {
	it('per-request envelope と initialize の宣言を別々に返す', () => {
		const extra = extraWith(APP_UI_CAPS, { mcpReq: { envelope: { [CLIENT_CAPABILITIES_META_KEY]: {} } } });
		expect(describeConfirmationGate(extra)).toEqual({
			envelope: 'no_app_ui',
			initialize: 'app_ui',
			session: null,
			client: null,
			pid: process.pid,
		});
		expect(describeConfirmationGate(undefined)).toEqual({
			envelope: 'none',
			initialize: 'none',
			session: null,
			client: null,
			pid: process.pid,
		});
	});

	it('接続時のクライアント名とプロセス ID を返す', () => {
		const extra = {
			server: { getClientCapabilities: () => ({}), getClientVersion: () => ({ name: 'claude-ai', version: '1' }) },
		};
		expect(describeConfirmationGate(extra)).toMatchObject({ client: 'claude-ai', pid: process.pid });
	});

	it('同じセッション ID なら同じ値、違えば違う値になる', () => {
		const a = describeConfirmationGate(extraWith({}, { sessionId: 'a' })).session;
		expect(describeConfirmationGate(extraWith({}, { sessionId: 'a' })).session).toBe(a);
		expect(describeConfirmationGate(extraWith({}, { sessionId: 'b' })).session).not.toBe(a);
	});
});

describe('confirmation_meta のログ（preview 側）', () => {
	const opts = {
		action: 'create_order',
		bindArgs: { pair: 'btc_jpy' },
		summary: 'preview summary',
		confirmTitle: 'Confirm',
		onDeclinedText: 'declined',
		declinedStructured: {},
		onConfirmed: vi.fn(),
		fallback: { content: [{ type: 'text' as const, text: 'FALLBACK' }], structuredContent: {} },
		metaConfirmation: { confirmation_token: TOKEN, expires_at: Date.now() + 60_000 },
		appUiFallbackText: 'APP_UI',
	};

	it('トークンを載せたかどうかと、判定に使った宣言の出どころを残す', async () => {
		vi.stubEnv('BITBANK_MCP_APPS_EXECUTE', '1');
		await withElicitedConfirmation({ ...opts, extra: extraWith(APP_UI_CAPS) });
		vi.stubEnv('BITBANK_MCP_APPS_EXECUTE', '0');
		await withElicitedConfirmation({ ...opts, extra: extraWith(APP_UI_CAPS) });
		const events = loggedEvents('confirmation_meta');
		expect(events).toEqual([
			{
				type: 'confirmation_meta',
				attached: true,
				gate: { envelope: 'none', initialize: 'app_ui', session: null, client: null, pid: process.pid },
			},
			{
				type: 'confirmation_meta',
				attached: false,
				gate: { envelope: 'none', initialize: 'app_ui', session: null, client: null, pid: process.pid },
			},
		]);
		expect(JSON.stringify(events)).not.toContain(TOKEN);
	});
});
