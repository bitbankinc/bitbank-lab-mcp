import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_RESOURCE_MIME_TYPE, appResourceRegistry } from '../src/resources/app-resources.js';

describe('appResourceRegistry', () => {
	it('order / cancel の 2 リソースを MCP Apps MIME type で公開する', () => {
		expect(appResourceRegistry).toHaveLength(2);
		expect(appResourceRegistry.map((r) => r.uri)).toEqual(['ui://order/confirm.html', 'ui://cancel/confirm.html']);
		for (const r of appResourceRegistry) {
			expect(r.mimeType).toBe(APP_RESOURCE_MIME_TYPE);
		}
	});

	it('read() はビルド済み HTML を返し、2 回目はキャッシュから同じ内容を返す', async () => {
		for (const r of appResourceRegistry) {
			const first = await r.read();
			expect(first).toContain('<');
			expect(first.length).toBeGreaterThan(100);
			const second = await r.read();
			expect(second).toBe(first);
		}
	});
});

describe('appResourceRegistry: 読み込み失敗', () => {
	afterEach(() => {
		vi.doUnmock('node:fs/promises');
		vi.resetModules();
	});

	it('失敗時はビルド案内付きで throw し、キャッシュされず次の read で復帰する', async () => {
		vi.resetModules();
		const readFile = vi.fn().mockRejectedValueOnce(new Error('ENOENT')).mockResolvedValueOnce('<html>ok</html>');
		vi.doMock('node:fs/promises', () => ({ readFile }));
		const mod = await import('../src/resources/app-resources.js');
		const r = mod.appResourceRegistry[0];
		await expect(r.read()).rejects.toThrow('npm run build:ui');
		await expect(r.read()).resolves.toBe('<html>ok</html>');
	});
});
