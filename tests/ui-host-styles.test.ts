import { beforeEach, describe, expect, it, vi } from 'vitest';

const ext = vi.hoisted(() => ({ applyHostStyleVariables: vi.fn(), applyHostFonts: vi.fn() }));
vi.mock('@modelcontextprotocol/ext-apps', () => ext);

import { applyHostStyles } from '../ui/shared/host-styles.js';

describe('確認 UI のホストのスタイルの適用', () => {
	beforeEach(() => {
		ext.applyHostStyleVariables.mockClear();
		ext.applyHostFonts.mockClear();
	});

	it('styles.variables を変数として、styles.css.fonts をフォントとして当てる', () => {
		const variables = { '--color-background-primary': '#101010' };
		const fonts = '@font-face { font-family: "Host Sans"; src: local("Arial"); }';
		applyHostStyles({ styles: { variables, css: { fonts } } } as never);
		expect(ext.applyHostStyleVariables).toHaveBeenCalledExactlyOnceWith(variables);
		expect(ext.applyHostFonts).toHaveBeenCalledExactlyOnceWith(fonts);
	});

	it.each([
		['コンテキストが無い', undefined],
		['styles が無い', { theme: 'dark' }],
		['styles が空', { styles: {} }],
		['css に fonts が無い', { styles: { css: {} } }],
	])('%s ときは何も当てない', (_label, ctx) => {
		applyHostStyles(ctx as never);
		expect(ext.applyHostStyleVariables).not.toHaveBeenCalled();
		expect(ext.applyHostFonts).not.toHaveBeenCalled();
	});
});
