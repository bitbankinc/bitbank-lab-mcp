// .claude/rules/tools.md の「LLM は content[0].text だけが見える」を E2E で機械的に強制する、決定論的な品質チェック。
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { expect } from 'vitest';

type CallToolResult = Awaited<ReturnType<Client['callTool']>>;

/** handler が McpResponse を返すと respond() が再ラップするので Result は structuredContent.structuredContent に入り、plain Result なら structuredContent 直下に ok がある。両方を透過的に扱う。 */
function sc(result: CallToolResult): Record<string, unknown> | undefined {
	const raw = result.structuredContent as Record<string, unknown> | undefined;
	if (!raw) return undefined;
	if ('ok' in raw) return raw;
	const inner = raw.structuredContent as Record<string, unknown> | undefined;
	if (inner && 'ok' in inner) return inner;
	return raw;
}

function extractText(result: CallToolResult): string {
	return (result.content as Array<{ type: string; text: string }>)
		.filter((c) => c.type === 'text')
		.map((c) => c.text)
		.join('\n');
}

export function assertContentRichness(result: CallToolResult, opts: { minLines?: number } = {}): void {
	const structured = sc(result);
	const text = extractText(result);
	const isOk = structured?.ok === true;

	if (isOk) {
		const lines = text.split('\n').filter((l) => l.trim().length > 0);
		const minLines = opts.minLines ?? 2;
		expect(
			lines.length,
			`[ContentRichness] ok レスポンスの content が ${minLines} 行未満。` +
				'summary だけを返していませんか？ handler で content テキストにデータを含めてください。' +
				`\n実際の content:\n${text.slice(0, 200)}`,
		).toBeGreaterThanOrEqual(minLines);
	}

	expect(text.length, '[ContentRichness] content テキストが空です').toBeGreaterThan(0);
}

export function assertOkStructure(result: CallToolResult): void {
	const structured = sc(result);
	const text = extractText(result);

	expect(structured, '[OkStructure] structuredContent が存在しません').toBeDefined();
	expect(structured?.ok, '[OkStructure] structuredContent.ok が true ではありません').toBe(true);

	const summary = structured?.summary;
	expect(typeof summary, '[OkStructure] summary が string ではありません').toBe('string');
	expect((summary as string).length, '[OkStructure] summary が空です').toBeGreaterThan(0);

	expect(text.length, '[OkStructure] content テキストが空です').toBeGreaterThan(0);
}

export function assertFailStructure(result: CallToolResult): void {
	const structured = sc(result);
	const text = extractText(result);

	expect(structured, '[FailStructure] structuredContent が存在しません').toBeDefined();
	expect(structured?.ok, '[FailStructure] structuredContent.ok が false ではありません').toBe(false);

	const meta = structured?.meta as Record<string, unknown> | undefined;
	expect(meta?.errorType, '[FailStructure] meta.errorType が存在しません').toBeDefined();
	expect(typeof meta?.errorType, '[FailStructure] meta.errorType が string ではありません').toBe('string');

	expect(text.length, '[FailStructure] エラー時の content テキストが空です').toBeGreaterThan(0);
}

/** 短すぎる description では LLM がツールを正しく選べないので、最低文字数を課す。 */
export function assertDescriptionQuality(
	tools: Array<{ name: string; description?: string }>,
	opts: { minLength?: number } = {},
): void {
	const minLength = opts.minLength ?? 15;
	for (const tool of tools) {
		expect(tool.description, `[DescriptionQuality] ツール "${tool.name}" に description がありません`).toBeDefined();
		expect(
			(tool.description ?? '').length,
			`[DescriptionQuality] ツール "${tool.name}" の description が短すぎます (${minLength}文字未満): "${tool.description}"`,
		).toBeGreaterThanOrEqual(minLength);
	}
}

export function assertErrorClarity(result: CallToolResult, opts: { minLength?: number } = {}): void {
	const structured = sc(result);
	const text = extractText(result);
	const minLength = opts.minLength ?? 5;

	expect(structured?.ok, '[ErrorClarity] ok: false のレスポンスが前提です').toBe(false);

	expect(
		text.length,
		`[ErrorClarity] エラーメッセージが短すぎます (${minLength}文字未満): "${text}"`,
	).toBeGreaterThanOrEqual(minLength);
}

export function assertOkQuality(result: CallToolResult, opts: { minLines?: number } = {}): void {
	assertOkStructure(result);
	assertContentRichness(result, opts);
}

export function assertFailQuality(result: CallToolResult, opts: { minLength?: number } = {}): void {
	assertFailStructure(result);
	assertErrorClarity(result, opts);
}
