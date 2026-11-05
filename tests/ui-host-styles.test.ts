import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ext = vi.hoisted(() => ({ applyHostStyleVariables: vi.fn(), applyHostFonts: vi.fn() }));
vi.mock('@modelcontextprotocol/ext-apps', () => ext);

import { applyHostStyles } from '../ui/shared/host-styles.js';

const FULL_PALETTE = {
	'--color-background-primary': '#101010',
	'--color-background-secondary': '#1a1a1a',
	'--color-background-tertiary': '#242424',
	'--color-text-primary': '#ffffff',
	'--color-text-secondary': '#a0a0a0',
	'--color-border-primary': '#333333',
};

// node には document が無いので、html 要素の inline style（length / item / removeProperty）だけを模す。
function stubDocumentStyle(initial: Record<string, string>): Map<string, string> {
	const props = new Map(Object.entries(initial));
	const style = {
		get length() {
			return props.size;
		},
		item: (i: number) => [...props.keys()][i] ?? '',
		removeProperty: (name: string) => {
			props.delete(name);
			return '';
		},
	};
	vi.stubGlobal('document', { documentElement: { style } });
	return props;
}

describe('確認 UI のホストのスタイルの適用', () => {
	beforeEach(() => {
		ext.applyHostStyleVariables.mockClear();
		ext.applyHostFonts.mockClear();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('styles.variables を変数として、styles.css.fonts をフォントとして当てる', () => {
		const variables = { ...FULL_PALETTE, '--font-sans': '"Host Sans", sans-serif' };
		const fonts = '@font-face { font-family: "Host Sans"; src: local("Arial"); }';
		applyHostStyles({ styles: { variables, css: { fonts } } });
		expect(ext.applyHostStyleVariables).toHaveBeenCalledExactlyOnceWith(variables);
		expect(ext.applyHostFonts).toHaveBeenCalledExactlyOnceWith(fonts);
	});

	it('配色が一部しか無いときは色を当てず、色以外の変数だけを当てる', () => {
		stubDocumentStyle({});
		// 暗い背景と白い文字だけで、カードの背景（secondary）が無い。当てるとカードが白地に白文字になる。
		applyHostStyles({
			styles: {
				variables: {
					'--color-background-primary': '#101010',
					'--color-text-primary': '#ffffff',
					'--font-sans': 'serif',
				},
			},
		});
		expect(ext.applyHostStyleVariables).toHaveBeenCalledExactlyOnceWith({ '--font-sans': 'serif' });
	});

	it('配色が一部しか無く、色以外の変数も無いときは何も当てない', () => {
		stubDocumentStyle({});
		applyHostStyles({ styles: { variables: { '--color-text-primary': '#ffffff' } } });
		expect(ext.applyHostStyleVariables).not.toHaveBeenCalled();
	});

	it('前にそろった配色を当てたあと、一部だけの配色が来たら前の色を外してフォールバックに戻す', () => {
		const props = stubDocumentStyle({ ...FULL_PALETTE, '--font-sans': 'serif', 'color-scheme': 'dark' });
		applyHostStyles({ styles: { variables: { '--color-background-primary': '#ffffff' } } });
		expect([...props.keys()]).toEqual(['--font-sans', 'color-scheme']);
	});

	it('styles.variables を含まない更新では、前に当てた色を外さない', () => {
		const props = stubDocumentStyle({ ...FULL_PALETTE });
		applyHostStyles({ styles: { css: { fonts: '@font-face { font-family: "X"; src: local("Arial"); }' } } });
		expect([...props.keys()]).toEqual(Object.keys(FULL_PALETTE));
	});

	it.each([
		['コンテキストが無い', undefined],
		['styles が無い', {}],
		['styles が空', { styles: {} }],
		['css に fonts が無い', { styles: { css: {} } }],
	])('%s ときは何も当てない', (_label, ctx) => {
		applyHostStyles(ctx);
		expect(ext.applyHostStyleVariables).not.toHaveBeenCalled();
		expect(ext.applyHostFonts).not.toHaveBeenCalled();
	});
});
