import { applyHostFonts, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';

type HostStyleVariables = Parameters<typeof applyHostStyleVariables>[0];

// tests から NodeNext 解決で読むと McpUiHostContext を import できない（パッケージの型が拡張子なしで再エクスポートしている）ので、読む部分だけを型にする。
interface HostStylesContext {
	styles?: { variables?: Partial<HostStyleVariables>; css?: { fonts?: string } };
}

// style.css が var() で参照する仕様上の色の変数。ホストは一部だけ渡してよいので、1 つでも欠けたら色は当てずにフォールバックの配色でそろえる（背景か文字の片方だけ入れ替わると読めなくなる）。
const PALETTE_KEYS = [
	'--color-background-primary',
	'--color-background-secondary',
	'--color-background-tertiary',
	'--color-text-primary',
	'--color-text-secondary',
	'--color-border-primary',
] as const;

function hasFullPalette(variables: Partial<HostStyleVariables>): boolean {
	return PALETTE_KEYS.every((key) => variables[key] !== undefined);
}

// ext-apps の applyHostStyleVariables は上書きするだけで消さないので、前に当てた配色を自分で外す。
function clearColorVariables(): void {
	const style = document.documentElement.style;
	for (let i = style.length - 1; i >= 0; i--) {
		const name = style.item(i);
		if (name.startsWith('--color-')) style.removeProperty(name);
	}
}

// styles は { variables, css: { fonts } } の入れ子なので、styles をそのまま渡すと変数もフォントも当たらない。
export function applyHostStyles(ctx: HostStylesContext | undefined): void {
	const variables = ctx?.styles?.variables;
	if (variables) {
		let toApply = variables;
		if (!hasFullPalette(variables)) {
			// 前の配色が残ると、一部だけの配色に切り替えたホストのテーマと食い違うので、フォールバックに戻す。
			clearColorVariables();
			toApply = Object.fromEntries(Object.entries(variables).filter(([key]) => !key.startsWith('--color-')));
		}
		if (Object.keys(toApply).length > 0) applyHostStyleVariables(toApply as HostStyleVariables);
	}
	if (ctx?.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}
