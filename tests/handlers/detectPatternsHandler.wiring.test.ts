/**
 * tests/handlers/detectPatternsHandler.wiring.test.ts
 *
 * `DetectPatternsInputSchema` ⇔ `detectPatternsHandler` の配線契約テスト（issue #151）。
 *
 * handler は入力を**分割代入で受けてから** `detectPatterns()` に手で並べ直している。
 * 分割代入は「列挙し忘れたプロパティ」を型エラーにしないので、スキーマにフィールドを
 * 足しても handler に書き忘れた瞬間、**typecheck も既存テストも通ったまま値だけが
 * 落ちる**。#151（`headProminencePct` が MCP 経由で届かず常に時間軸オート値に落ちていた）が
 * まさにこれで、スキーマ・core・検出器の 3 層は正しく通っていたのに handler の分割代入
 * だけが欠けていた。
 *
 * そこで「スキーマのキー集合」と「handler が core へ渡す opts のキー集合」の対応を
 * ここで機械的に固定する。core に渡さないキーは `NOT_FORWARDED` に理由付きで列挙する
 * （`tests/patterns/invariants.test.ts` の到達性 allowlist と同じ idiom。
 * 行が stale になったら落ちるようにしておく）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../tools/detect_patterns.js', () => ({
	default: vi.fn(),
}));

import { toolDef } from '../../src/handlers/detectPatternsHandler.js';
import { DetectPatternsInputSchema } from '../../src/schema/patterns.js';
import detectPatterns from '../../tools/detect_patterns.js';

const mockedDetectPatterns = vi.mocked(detectPatterns);

afterEach(() => {
	vi.clearAllMocks();
});

/** handler が `DetectPatternsOutputSchema.parse` を通せる最小の ok 結果。 */
function makeOkResult() {
	return {
		ok: true,
		summary: '0件を検出',
		data: { patterns: [] },
		meta: { pair: 'eth_jpy', type: '4hour', count: 0, fetchedAt: '2026-01-01T00:00:00Z' },
	};
}

/**
 * **全キーにスキーマ既定値と異なる値**を入れた入力。
 *
 * 既定値と同じ値を置くと「渡っていないのに偶然一致する」ため配線の検証にならない。
 * 下の網羅テストがスキーマのキー集合との一致を強制するので、スキーマにフィールドを
 * 足したらここにも値を足すことになる。
 */
const FULL_INPUT = {
	pair: 'eth_jpy',
	type: '4hour',
	limit: 120,
	patterns: ['head_and_shoulders'],
	swingDepth: 4,
	tolerancePct: 0.03,
	minBarsBetweenSwings: 6,
	headProminencePct: 0.02,
	view: 'debug',
	requireCurrentInPattern: true,
	currentRelevanceDays: 14,
	includeForming: true,
	includeCompleted: false,
	includeInvalid: true,
	tz: 'UTC',
} as const;

/**
 * **意図的に** `detectPatterns()` の opts へ渡さないキーと、その理由。
 *
 * 行を足すときは理由を必ず書くこと。下の stale 検出テストが
 * 「実際には渡るようになった行」を落とす。
 */
const NOT_FORWARDED: ReadonlyArray<{ key: string; reason: string }> = [
	{ key: 'pair', reason: 'ensurePair で正規化して第 1 位置引数として渡す（opts ではない）' },
	{ key: 'type', reason: '第 2 位置引数として渡す（opts ではない）' },
	{ key: 'limit', reason: '第 3 位置引数として渡す（opts ではない）' },
	{
		key: 'view',
		reason: 'handler 内で content の整形（formatDebugView 等）に消費する。core は opts.view を参照しない',
	},
];

const notForwarded = new Map(NOT_FORWARDED.map((e) => [e.key, e]));

/** handler を 1 回呼び、`detectPatterns()` に渡された opts（第 4 引数）を返す。 */
async function captureForwardedOpts(): Promise<Record<string, unknown>> {
	mockedDetectPatterns.mockResolvedValueOnce(makeOkResult() as never);
	const parsed = DetectPatternsInputSchema.parse(FULL_INPUT);
	await toolDef.handler(parsed);
	expect(mockedDetectPatterns).toHaveBeenCalledTimes(1);
	return mockedDetectPatterns.mock.calls[0][3] as Record<string, unknown>;
}

describe('detectPatternsHandler — スキーマ ⇔ core 呼び出しの配線', () => {
	const schemaKeys = Object.keys(DetectPatternsInputSchema.shape);

	it('FULL_INPUT がスキーマの全キーを網羅している（新フィールド追加時の書き忘れ検出）', () => {
		expect(Object.keys(FULL_INPUT).sort()).toEqual([...schemaKeys].sort());
	});

	it('NOT_FORWARDED の各行が実在するスキーマキーを指している（typo 検出）', () => {
		for (const entry of NOT_FORWARDED) {
			expect(schemaKeys, `NOT_FORWARDED のキー: ${entry.key}`).toContain(entry.key);
			expect(entry.reason.length, `NOT_FORWARDED: ${entry.key} に理由が無い`).toBeGreaterThan(0);
		}
		expect(notForwarded.size, 'NOT_FORWARDED に重複行がある').toBe(NOT_FORWARDED.length);
	});

	it('NOT_FORWARDED 以外のスキーマキーはすべて opts に載り、値がそのまま渡る', async () => {
		const opts = await captureForwardedOpts();
		const missing: string[] = [];
		const mismatched: string[] = [];
		for (const key of schemaKeys) {
			if (notForwarded.has(key)) continue;
			if (!Object.hasOwn(opts, key)) {
				missing.push(key);
				continue;
			}
			const expected = (FULL_INPUT as Record<string, unknown>)[key];
			if (JSON.stringify(opts[key]) !== JSON.stringify(expected)) {
				mismatched.push(`${key}: 渡った値 ${JSON.stringify(opts[key])} ≠ 入力 ${JSON.stringify(expected)}`);
			}
		}
		expect(
			missing,
			`detectPatterns() の opts に載っていないスキーマキー（handler の分割代入 / 呼び出しに追加するか、` +
				`意図的に渡さないなら NOT_FORWARDED に理由付きで足すこと）:\n${missing.join('\n')}`,
		).toEqual([]);
		expect(mismatched, `値が入力と異なるキー:\n${mismatched.join('\n')}`).toEqual([]);
	});

	it('NOT_FORWARDED のキーは実際に opts へ渡っていない（stale 行の検出）', async () => {
		const opts = await captureForwardedOpts();
		for (const entry of NOT_FORWARDED) {
			expect(
				Object.hasOwn(opts, entry.key),
				`NOT_FORWARDED: ${entry.key} は opts に渡るようになっている。NOT_FORWARDED から行を消すこと`,
			).toBe(false);
		}
	});

	it('スキーマに無いキーを opts に混ぜていない', async () => {
		const opts = await captureForwardedOpts();
		const unexpected = Object.keys(opts).filter((k) => !schemaKeys.includes(k));
		expect(unexpected, `スキーマに無いキーが opts に載っている:\n${unexpected.join('\n')}`).toEqual([]);
	});
});
