import { applyHostFonts, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';

// tests から NodeNext 解決で読むと McpUiHostContext を import できない（パッケージの型が拡張子なしで再エクスポートしている）ので、読む部分だけを型にする。
interface HostStylesContext {
	styles?: { variables?: Parameters<typeof applyHostStyleVariables>[0]; css?: { fonts?: string } };
}

// styles は { variables, css: { fonts } } の入れ子なので、styles をそのまま渡すと変数もフォントも当たらない。
export function applyHostStyles(ctx: HostStylesContext | undefined): void {
	if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
	if (ctx?.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}
