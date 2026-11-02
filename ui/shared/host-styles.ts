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

function variablesToApply(variables: Partial<HostStyleVariables>): Partial<HostStyleVariables> {
	if (PALETTE_KEYS.every((key) => variables[key] !== undefined)) return variables;
	return Object.fromEntries(Object.entries(variables).filter(([key]) => !key.startsWith('--color-')));
}

// styles は { variables, css: { fonts } } の入れ子なので、styles をそのまま渡すと変数もフォントも当たらない。
export function applyHostStyles(ctx: HostStylesContext | undefined): void {
	const variables = ctx?.styles?.variables;
	if (variables) {
		const toApply = variablesToApply(variables);
		if (Object.keys(toApply).length > 0) applyHostStyleVariables(toApply as HostStyleVariables);
	}
	if (ctx?.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}
