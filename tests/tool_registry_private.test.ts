import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PRIVATE_TOOL_NAMES = [
	'get_my_assets',
	'get_my_trade_history',
	'get_my_orders',
	'analyze_my_portfolio',
	'get_my_deposit_withdrawal',
	'preview_order',
	'create_order',
	'preview_cancel_order',
	'cancel_order',
	'preview_cancel_orders',
	'cancel_orders',
	'get_order',
	'get_orders_info',
	'get_margin_status',
	'get_margin_positions',
	'get_margin_trade_history',
] as const;

describe('tool-registry — Private API 分岐', () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it('APIキー設定時に 16 プライベートツールが追加される', async () => {
		process.env.BITBANK_API_KEY = 'test-key';
		process.env.BITBANK_API_SECRET = 'test-secret';

		const { allToolDefs } = await import('../src/tool-registry.js');
		const names = allToolDefs.map((t) => t.name);

		for (const privateName of PRIVATE_TOOL_NAMES) {
			expect(names, `${privateName} が allToolDefs に含まれるべき`).toContain(privateName);
		}
		// 公開 33 + プライベート 16 = 49
		expect(names).toHaveLength(49);
	});

	it('APIキー未設定時にプライベートツールが含まれない', async () => {
		delete process.env.BITBANK_API_KEY;
		delete process.env.BITBANK_API_SECRET;

		const { allToolDefs } = await import('../src/tool-registry.js');
		const names = allToolDefs.map((t) => t.name);

		for (const privateName of PRIVATE_TOOL_NAMES) {
			expect(names, `${privateName} が含まれていてはいけない`).not.toContain(privateName);
		}
		expect(names).toHaveLength(33);
	});

	it('プライベートツールも基本要素を持つ', async () => {
		process.env.BITBANK_API_KEY = 'test-key';
		process.env.BITBANK_API_SECRET = 'test-secret';

		const { allToolDefs } = await import('../src/tool-registry.js');
		const privateTools = allToolDefs.filter((t) =>
			PRIVATE_TOOL_NAMES.includes(t.name as (typeof PRIVATE_TOOL_NAMES)[number]),
		);

		expect(privateTools).toHaveLength(16);
		for (const toolDef of privateTools) {
			expect(toolDef.name).toEqual(expect.any(String));
			expect(toolDef.description.length).toBeGreaterThan(0);
			expect(toolDef.inputSchema).toBeTruthy();
			expect(typeof toolDef.handler).toBe('function');
		}
	});
});
