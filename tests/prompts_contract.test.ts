import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { isPrivateApiEnabled } from '../src/private/config.js';
import { type PromptDef, prompts } from '../src/prompts.js';
import { allToolDefs } from '../src/tool-registry.js';

/** Private API 不要のプロンプト（常に公開） */
const publicPromptNames = [
	'🌅 おはようレポート',
	'🔰 BTCの価格を分析して',
	'🔰 ETHの価格を分析して',
	'🔰 今注目のコインは？',
	'中級：主要指標でBTCを分析して',
	'中級：BTCのフロー分析をして',
	'中級：BTCのパターン分析をして',
	'中級：BTCのサポレジを分析して',
];

/** Private API 必須のプロンプト（API キー設定時のみ公開） */
const privatePromptNames = ['💼 ポートフォリオ分析レポート'];

const expectedPromptNames = isPrivateApiEnabled()
	? ['🌅 おはようレポート', '💼 ポートフォリオ分析レポート', ...publicPromptNames.slice(1)]
	: publicPromptNames;

describe('prompts contract', () => {
	it(`MCP 公開対象は日本語名の ${expectedPromptNames.length} プロンプトに限定される（Private API ${isPrivateApiEnabled() ? '有効' : '無効'}）`, () => {
		expect(prompts).toHaveLength(expectedPromptNames.length);
		expect(prompts.map((prompt) => prompt.name)).toEqual(expectedPromptNames);
	});

	it('Private API 無効時はポートフォリオ Prompt が含まれない', () => {
		const names = prompts.map((p) => p.name);
		if (isPrivateApiEnabled()) {
			for (const name of privatePromptNames) {
				expect(names).toContain(name);
			}
		} else {
			for (const name of privatePromptNames) {
				expect(names).not.toContain(name);
			}
		}
	});

	it('公開プロンプトはすべて非 ASCII 名で description を持つ', () => {
		for (const prompt of prompts) {
			expect(/\P{ASCII}/u.test(prompt.name)).toBe(true);
			expect(prompt.description).toEqual(expect.any(String));
			expect(prompt.description.length).toBeGreaterThan(0);
		}
	});
});

// ────────────────────────────────────────────────────────────────
// プロンプトが指示する view 値の契約
//
// SDK v2 はハンドラ実行前に inputSchema で入力を検証するため、プロンプトが
// enum に無い view を指示すると、その指示どおり呼んだ時点で validation error になる
// （実例: get_flow_metrics に存在しない view=detailed を指示していた）。
// プロンプトは実行されないので通常のテストでは検出できない。ここで静的に突き合わせる。
// ────────────────────────────────────────────────────────────────

interface ViewUsage {
	promptName: string;
	toolName: string;
	view: string;
}

/**
 * `toolName(..., view=xxx, ...)` 形式の呼び出し例だけを見る（引数内にネスト括弧は想定しない）。
 * `view` の直後に `=` を要求するので `viewBox="0 0 480 140"` のような別語には当たらない。
 */
const TOOL_CALL_RE = /\b([a-z][a-z0-9_]*)\s*\(([^()]*)\)/g;
const VIEW_ARG_RE = /\bview\s*=\s*(?:"([^"]*)"|'([^']*)'|([\w-]+))/g;

function extractViewUsages(promptName: string, text: string): ViewUsage[] {
	const usages: ViewUsage[] = [];
	for (const [, toolName, argsText] of text.matchAll(TOOL_CALL_RE)) {
		for (const [, dq, sq, bare] of argsText.matchAll(VIEW_ARG_RE)) {
			usages.push({ promptName, toolName, view: dq ?? sq ?? bare });
		}
	}
	return usages;
}

function collectViewUsages(defs: readonly PromptDef[]): ViewUsage[] {
	return defs.flatMap((prompt) =>
		prompt.messages.flatMap((message) => message.content.flatMap((part) => extractViewUsages(prompt.name, part.text))),
	);
}

/** ツールの inputSchema から view サブスキーマを取り出す（無ければ undefined） */
function viewSchemaOf(toolName: string): z.ZodTypeAny | undefined {
	const def = allToolDefs.find((d) => d.name === toolName);
	if (!def) return undefined;
	const shape = (def.inputSchema as unknown as { shape?: Record<string, z.ZodTypeAny> }).shape;
	return shape?.view;
}

/** エラーメッセージ用に有効値を取り出す。ZodDefault / ZodOptional を剥がして ZodEnum の options を読む */
function viewOptionsOf(schema: z.ZodTypeAny): string[] | undefined {
	let current: unknown = schema;
	while (current) {
		const options = (current as { options?: unknown }).options;
		if (Array.isArray(options)) return options.map(String);
		const inner = (current as { unwrap?: () => unknown }).unwrap?.();
		if (inner == null || inner === current) return undefined;
		current = inner;
	}
	return undefined;
}

/** プロンプトが指示する view のうち、実際には validation error になるものを列挙する */
function findInvalidViewUsages(usages: readonly ViewUsage[]): string[] {
	const errors: string[] = [];
	for (const { promptName, toolName, view } of usages) {
		if (!allToolDefs.some((d) => d.name === toolName)) {
			errors.push(`${promptName}: 未登録のツール ${toolName}(view=${view}) を指示している`);
			continue;
		}
		const viewSchema = viewSchemaOf(toolName);
		if (!viewSchema) {
			errors.push(`${promptName}: ${toolName} に view パラメータは無いのに view=${view} を指示している`);
			continue;
		}
		if (!viewSchema.safeParse(view).success) {
			const valid = viewOptionsOf(viewSchema)?.join(' / ') ?? '(enum を特定できず)';
			errors.push(`${promptName}: ${toolName}(view=${view}) は無効。有効値: ${valid}`);
		}
	}
	return errors;
}

describe('prompts の view 値がツールの Zod enum と一致する', () => {
	it('全プロンプトのツール呼び出し例の view が有効値である', () => {
		expect(findInvalidViewUsages(collectViewUsages(prompts))).toEqual([]);
	});

	it('抽出が空振りしていない（正規表現が壊れたら気づける）', () => {
		expect(collectViewUsages(prompts).length).toBeGreaterThan(0);
	});

	it('無効値を混ぜたプロンプトは検出される（検査自体の有効性）', () => {
		const invalid: PromptDef[] = [
			{
				name: 'テスト用',
				description: 'テスト用',
				// get_flow_metrics の enum は summary / compact / buckets / full なので detailed は無効
				messages: [
					{
						role: 'user',
						content: [{ type: 'text', text: 'get_flow_metrics(pair=btc_jpy, view=detailed)' }],
					},
				],
			},
		];
		const errors = findInvalidViewUsages(collectViewUsages(invalid));
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('get_flow_metrics(view=detailed) は無効');
	});

	it('未登録ツール・view 非対応ツールへの view 指定も検出される', () => {
		const usages: ViewUsage[] = [
			{ promptName: 'テスト用', toolName: 'no_such_tool', view: 'full' },
			{ promptName: 'テスト用', toolName: 'get_ticker', view: 'full' },
		];
		const errors = findInvalidViewUsages(usages);
		expect(errors[0]).toContain('未登録のツール');
		expect(errors[1]).toContain('view パラメータは無い');
	});

	it('viewBox 等の別語や日本語括弧を誤検出しない', () => {
		const text = [
			'viewBox="0 0 480 140"、preserveAspectRatio="none" で枠に追従。',
			'現在値(last)・前日比(24h) と (last−open)/open は対象外。',
			'get_candles(pair="btc_jpy", type="1hour", limit=24, view="items")',
		].join('\n');
		expect(extractViewUsages('テスト用', text)).toEqual([
			{ promptName: 'テスト用', toolName: 'get_candles', view: 'items' },
		]);
	});
});
