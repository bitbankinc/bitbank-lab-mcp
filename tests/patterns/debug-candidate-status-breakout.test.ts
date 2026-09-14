/**
 * tests/patterns/debug-candidate-status-breakout.test.ts
 *
 * `view=debug` の候補行に `status` / `breakoutDirection` が届くことの回帰テスト（issue #160）。
 *
 * 背景: この 2 つは `CandDebugEntry` が元から持つが、**検出器によって置き場所が割れている**。
 *
 * | 検出器 | status | breakoutDirection |
 * |---|---|---|
 * | `detect_triangles` / `detect_pennants` | `details.status` | `details.breakout.direction` |
 * | `detect_wedges`（形成中） / `detect_hs`（形成中, #155） | top-level | top-level（H&S は持たない） |
 * | `detect_wedges`（完成済み = `revamped_ok`, #162） | top-level | `details.breakInfo.direction` |
 *
 * 読む側（`formatDebugView` の候補行）で 3 系統を 1 回だけ解決する。ここが 1 箇所である
 * ことが要点で、`formatCandidateDetails` 側でも出すと triangle / pennant だけ 2 行に散る。
 *
 * 出力スキーマ（`src/schema/patterns.ts` の candidates）に無いフィールドは
 * `DetectPatternsOutputSchema.parse` で **strip される**ため、スキーマ側の宣言も
 * 「content に出るか」の一部になっている（#155 の `status` と同じ理由）。
 */
import { describe, expect, it, vi } from 'vitest';
import { asMockResult, assertOk } from '../_assertResult.js';

vi.mock('../../tools/analyze_indicators.js', () => ({
	default: vi.fn(),
}));

import { formatDebugView } from '../../src/handlers/detectPatternsViewsHandler.js';
import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';
import { buildBtcJpy2026Candles } from '../fixtures/btc_jpy_1day_2026.js';

type Candle = { isoTime: string; open: number; high: number; low: number; close: number; volume: number };

/** 日足 1 本。close に対して high/low を等幅にずらす（本テストは価格構造そのものを見ない）。 */
function makeCandle(dayOffset: number, close: number): Candle {
	return {
		isoTime: new Date(Date.UTC(2026, 0, 1 + dayOffset)).toISOString(),
		open: close,
		high: close + 3,
		low: close - 3,
		close,
		volume: 100,
	};
}

/** 終値列を日足列に変換する。 */
function fromCloses(closes: number[]): Candle[] {
	return closes.map((close, index) => makeCandle(index, close));
}

/** tests/detect_patterns_fixtures.test.ts の同名 fixture と同じ価格列 */
const SYMMETRICAL_TRIANGLE_CLOSES = [
	120, 126, 132, 137, 130, 122, 116, 110, 104, 100, 106, 114, 120, 128, 134, 128, 120, 115, 108, 104, 110, 118, 124,
	130, 126, 120, 116, 112, 108, 114, 120, 126, 124, 120, 117, 114,
];
/** ブレイクアウトまで含む三角保ち合い（`buildDescendingTriangleInvalidBreakoutCandles` と同じ価格列） */
const BREAKOUT_TRIANGLE_CLOSES = [
	130, 140, 132, 122, 100, 118, 120, 130, 124, 116, 100, 112, 125, 118, 101, 110, 120, 114, 100, 108, 115, 110, 101,
	107, 128, 132, 130, 128, 126, 124,
];
const BULL_PENNANT_CLOSES = [
	100, 110, 122, 136, 150, 165, 158, 162, 154, 160, 155, 159, 156, 158, 157, 157.8, 157.2, 158.1, 157.4, 170, 172, 174,
];
const RISING_WEDGE_CLOSES = [
	100, 106, 112, 118, 124, 130, 119, 108, 113, 118, 124, 129, 134, 125, 116, 120, 125, 129, 134, 138, 131, 124, 128,
	131, 135, 138, 142, 137, 132, 135, 138, 140, 143, 146, 143,
];

/** 完成済みウェッジ fixture の形状。傾き比 2.5 で収束し、apex は i=100（窓の終端より未来）。 */
const COMPLETED_WEDGE_BARS = 90;
/** 余弦の周期。既定 `swingDepth`=7 でも SG ピボットが山谷として立つ長さ。 */
const COMPLETED_WEDGE_PERIOD = 16;
const completedWedgeUpper = (i: number) => 200 - 0.5 * i;
const completedWedgeLower = (i: number) => 170 - 0.2 * i;

/**
 * 完成済みウェッジ（`detect_wedges` の回帰ベースパス = `reason: 'revamped_ok'`）に届く合成列。
 *
 * 上の終値列 fixture では**形成中パスにしか届かない**ため、そちらでは完成済みパスの
 * 候補行を検証できない（issue #162）。回帰パスは SG 平滑化ピボットの**終値**に
 * 回帰直線を当てるので、山の終値が上限線・谷の終値がちょうど下限線に乗る列を作る
 * （ヒゲは終値 ±0.3 — タッチ判定の閾値 0.5% に入り、かつ線を越えない）。
 *
 * `breakout: true` で末尾に上限線を大きく上抜ける 6 本を足す（→ `status=completed`）。
 * `false` なら最後までウェッジ内に収まる（→ `status=near_completion`、方向なし）。
 */
function buildCompletedFallingWedgeCandles({ breakout }: { breakout: boolean }): Candle[] {
	const withWick = (dayOffset: number, close: number, wick: number): Candle => ({
		...makeCandle(dayOffset, close),
		open: close,
		high: close + wick,
		low: close - wick,
	});
	const candles: Candle[] = [];
	for (let i = 0; i < COMPLETED_WEDGE_BARS; i++) {
		const mid = (completedWedgeUpper(i) + completedWedgeLower(i)) / 2;
		const half = (completedWedgeUpper(i) - completedWedgeLower(i)) / 2;
		candles.push(withWick(i, mid + half * Math.cos((2 * Math.PI * i) / COMPLETED_WEDGE_PERIOD), 0.3));
	}
	if (breakout) {
		const lastUpper = completedWedgeUpper(COMPLETED_WEDGE_BARS - 1);
		for (let k = 0; k < 6; k++) {
			candles.push(withWick(COMPLETED_WEDGE_BARS + k, lastUpper + 8 + k * 2, 1));
		}
	}
	return candles;
}

type Candidate = {
	type: string;
	accepted: boolean;
	reason?: string;
	status?: string;
	breakoutDirection?: string | null;
	details?: Record<string, unknown>;
};

const mockedAnalyzeIndicators = vi.mocked(analyzeIndicators);

/** `analyze_indicators` をモックして `detectPatterns` を 1 回呼ぶ（既定で形成中を含める）。 */
async function run(candles: Candle[], opts: Record<string, unknown> = {}) {
	mockedAnalyzeIndicators.mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
	);
	return detectPatterns('btc_jpy', '1day', candles.length, { includeForming: true, ...opts });
}

/** 候補行（`1. ✅ type …`）だけを取り出す。details 行と混ざると「どこに出たか」が見えない。 */
function candidateHeaderLines(text: string, type: string): string[] {
	return text.split('\n').filter((l) => new RegExp(`^\\d+\\. (✅|❌) ${type}\\b`).test(l));
}

/** 検出結果を `view=debug` の content テキストに整形する（LLM が実際に受け取る文字列）。 */
function debugText(res: Parameters<typeof formatDebugView>[3] & { meta?: unknown }): string {
	return formatDebugView('hdr', (res.meta ?? {}) as never, [], res).content[0].text;
}

describe('debug candidates: status / breakoutDirection の配線（issue #160）', () => {
	it('triangle の status は content から消えず、候補行に 1 回だけ出る（details 行には出さない）', async () => {
		const res = await run(fromCloses(SYMMETRICAL_TRIANGLE_CLOSES), { patterns: ['triangle'] });
		assertOk(res);
		const cands = (res.meta.debug?.candidates ?? []) as Candidate[];
		const detected = cands.filter((c) => c.accepted && c.reason === 'detected');
		expect(detected.length).toBeGreaterThan(0);
		// 置き場所は details 側（検出器は触っていない）
		for (const c of detected) expect(typeof c.details?.status).toBe('string');

		const text = debugText(res);
		const headers = candidateHeaderLines(text, 'triangle_symmetrical').filter((l) => l.includes('(detected)'));
		expect(headers.length).toBe(detected.length);
		for (const l of headers) expect(l).toMatch(/ status=(completed|invalid|forming|near_completion)\b/);

		// 二重表示の禁止: 旧 `touchCount: N, status: …, confidence: …` 行は status を持たない。
		expect(text).toContain('touchCount: ');
		expect(text).not.toMatch(/touchCount: [^\n]*status/);
		// 1 候補につき status の出現は 1 回
		for (const l of text.split('\n')) expect(l.match(/status=/g)?.length ?? 0).toBeLessThanOrEqual(1);
	});

	it('triangle の breakoutDirection が候補行に出る（details.breakout.direction 由来）', async () => {
		const res = await run(fromCloses(BREAKOUT_TRIANGLE_CLOSES), { patterns: ['triangle'] });
		assertOk(res);
		const cands = (res.meta.debug?.candidates ?? []) as Candidate[];
		const withBreakout = cands.filter((c) => (c.details?.breakout as { direction?: string } | null)?.direction != null);
		expect(withBreakout.length).toBeGreaterThan(0);
		// 置き場所は details 側。top-level には無い（検出器は触っていない）
		for (const c of withBreakout) expect(c.breakoutDirection).toBeUndefined();

		const text = debugText(res);
		const dirLines = text.split('\n').filter((l) => /^\d+\. .* breakoutDirection=(up|down)\b/.test(l));
		expect(dirLines.length).toBe(withBreakout.length);
	});

	it('pennant / flag の status と breakoutDirection が候補行に出る', async () => {
		const res = await run(fromCloses(BULL_PENNANT_CLOSES), { patterns: ['pennant'] });
		assertOk(res);
		const cands = (res.meta.debug?.candidates ?? []) as Candidate[];
		const detected = cands.filter((c) => c.accepted && c.reason === 'detected');
		expect(detected.length).toBeGreaterThan(0);

		const text = debugText(res);
		const headers = candidateHeaderLines(text, 'bull_pennant').filter((l) => l.includes('(detected)'));
		expect(headers.length).toBeGreaterThan(0);
		for (const l of headers) {
			expect(l).toMatch(/ status=(completed|invalid|forming|near_completion)\b/);
			expect(l).toMatch(/ breakoutDirection=(up|down)\b/);
		}
	});

	it('wedge の status / breakoutDirection は top-level にあり、候補行に出る', async () => {
		const res = await run(fromCloses(RISING_WEDGE_CLOSES), { patterns: ['rising_wedge', 'falling_wedge'] });
		assertOk(res);
		const cands = (res.meta.debug?.candidates ?? []) as Candidate[];
		const accepted = cands.filter((c) => c.accepted);
		expect(accepted.length).toBeGreaterThan(0);
		// 置き場所は top-level。**スキーマに宣言が無いと parse で strip される**ので、
		// ここが落ちたら schema/patterns.ts の candidates を疑う。
		for (const c of accepted) expect(typeof c.status).toBe('string');

		const text = debugText(res);
		const headers = candidateHeaderLines(text, 'rising_wedge').filter((l) => l.includes('✅'));
		expect(headers.length).toBeGreaterThan(0);
		for (const l of headers) expect(l).toMatch(/ status=(completed|invalid|forming|near_completion)\b/);
	});

	it('完成済みウェッジ（revamped_ok）の status / breakoutDirection が候補行に出る（issue #162）', async () => {
		const res = await run(buildCompletedFallingWedgeCandles({ breakout: true }), { patterns: ['falling_wedge'] });
		assertOk(res);
		const cands = (res.meta.debug?.candidates ?? []) as Candidate[];
		const completed = cands.filter((c) => c.accepted && c.reason === 'revamped_ok');
		expect(completed.length).toBeGreaterThan(0);
		for (const c of completed) {
			// status は top-level。**この push 地点の式は completed / near_completion しか返さない**
			// （`status4b` の型には invalid もあるが到達しない）ので値を固定で見る。
			expect(c.status).toBe('completed');
			// 方向は 3 つ目の置き場所。top-level にも `details.breakout` にも無い。
			expect(c.breakoutDirection).toBeUndefined();
			expect(c.details?.breakout).toBeUndefined();
			expect((c.details?.breakInfo as { direction?: string } | null)?.direction).toBe('up');
		}

		const text = debugText(res);
		const headers = candidateHeaderLines(text, 'falling_wedge').filter((l) => l.includes('(revamped_ok)'));
		expect(headers.length).toBe(completed.length);
		for (const l of headers) {
			expect(l).toMatch(/ status=completed\b/);
			expect(l).toMatch(/ breakoutDirection=up\b/);
		}
	});

	it('ブレイク未検出の完成済みウェッジ候補は status=near_completion で breakoutDirection を出さない', async () => {
		const res = await run(buildCompletedFallingWedgeCandles({ breakout: false }), { patterns: ['falling_wedge'] });
		assertOk(res);
		const cands = (res.meta.debug?.candidates ?? []) as Candidate[];
		const nearCompletion = cands.filter((c) => c.accepted && c.reason === 'revamped_ok');
		expect(nearCompletion.length).toBeGreaterThan(0);
		for (const c of nearCompletion) {
			expect(c.status).toBe('near_completion');
			// 検出器は「未ブレイク」を `breakInfo: null` で答える。方向が無いことを
			// `breakoutDirection=null` と書いても読み手に情報が増えないので行に出さない（#160 の規則）。
			expect(c.details?.breakInfo).toBeNull();
		}

		const text = debugText(res);
		const headers = candidateHeaderLines(text, 'falling_wedge').filter((l) => l.includes('(revamped_ok)'));
		expect(headers.length).toBe(nearCompletion.length);
		for (const l of headers) {
			expect(l).toMatch(/ status=near_completion\b/);
			expect(l).not.toContain('breakoutDirection=');
		}
	});

	it('形成中 H&S の成功エントリ（#155）の status が候補行に出る', async () => {
		// #155 の再現条件（実データ fixture）。合成列では形成中 H&S の成功パスに入らない。
		const res = await run(buildBtcJpy2026Candles() as Candle[], {
			patterns: ['head_and_shoulders', 'inverse_head_and_shoulders'],
			headProminencePct: 0.01,
			includeCompleted: true,
			includeInvalid: true,
		});
		assertOk(res);
		const cands = (res.meta.debug?.candidates ?? []) as Candidate[];
		const forming = cands.filter((c) => c.accepted && c.status === 'forming');
		expect(forming.length).toBeGreaterThan(0);

		const text = debugText(res);
		const headers = candidateHeaderLines(text, 'head_and_shoulders').filter((l) => l.includes('✅'));
		expect(headers.filter((l) => l.includes('status=forming')).length).toBe(forming.length);
		// `details.method` は status と重複するが落とさない。`forming_hs_provisional`（暫定右肩）の
		// 区別は method 側にしか無く、status だけでは表現できない。
		expect(text).toMatch(/method: forming_i?hs/);
	});
});

describe('formatDebugView: status / breakoutDirection の解決規則', () => {
	const res = { ok: true as const, summary: 'debug', data: { patterns: [], overlays: null }, meta: {} };
	// biome-ignore lint/suspicious/noExplicitAny: test fixture
	const meta = (candidates: any[]) => ({ debug: { swings: [], candidates } });

	it('top-level と details のどちらに置かれていても同じ書式で出る', () => {
		const text = formatDebugView(
			'hdr',
			meta([
				{ type: 'rising_wedge', accepted: true, status: 'forming', breakoutDirection: 'up' },
				{
					type: 'triangle_ascending',
					accepted: true,
					reason: 'detected',
					details: { status: 'completed', breakout: { idx: 12, direction: 'down' }, touchCount: 5 },
				},
			]),
			[],
			res,
		).content[0].text;

		expect(text).toContain('rising_wedge status=forming breakoutDirection=up');
		expect(text).toContain('triangle_ascending (detected) status=completed breakoutDirection=down');
	});

	it('details.breakInfo.direction（wedge 完成済み）も候補行に出る', () => {
		// 3 つ目の置き場所（issue #162）。top-level にも `details.breakout` にも無い。
		const text = formatDebugView(
			'hdr',
			meta([
				{
					type: 'falling_wedge',
					accepted: true,
					reason: 'revamped_ok',
					status: 'completed',
					details: { breakInfo: { detected: true, breakIdx: 42, direction: 'up' }, score: 0.7 },
				},
			]),
			[],
			res,
		).content[0].text;

		expect(text).toContain('falling_wedge (revamped_ok) status=completed breakoutDirection=up');
	});

	it('details.breakInfo: null では breakoutDirection 行を出さない', () => {
		const text = formatDebugView(
			'hdr',
			meta([
				{
					type: 'falling_wedge',
					accepted: true,
					reason: 'revamped_ok',
					status: 'near_completion',
					details: { breakInfo: null },
				},
			]),
			[],
			res,
		).content[0].text;

		expect(text).toContain('falling_wedge (revamped_ok) status=near_completion');
		expect(text).not.toContain('breakoutDirection=');
	});

	it('details.breakout が details.breakInfo より優先される', () => {
		// 検出器が違うので実際には両方を持つエントリは無いが、優先順を暗黙にしない。
		const text = formatDebugView(
			'hdr',
			meta([
				{
					type: 'falling_wedge',
					accepted: true,
					details: { breakout: { direction: 'down' }, breakInfo: { direction: 'up' } },
				},
			]),
			[],
			res,
		).content[0].text;

		const header = text.split('\n').find((l) => l.startsWith('1. ')) ?? '';
		expect(header).toContain('breakoutDirection=down');
		expect(header.match(/breakoutDirection=/g)).toHaveLength(1);
	});

	it('details.breakout: null は details.breakInfo で上書きされない', () => {
		// top-level の `null` と同じ扱い。キーが在る＝「この検出器が未ブレイクと答えた」なので、
		// `??` で次の系統に落とすと「未ブレイクなのに方向がある」行になる。
		const text = formatDebugView(
			'hdr',
			meta([
				{
					type: 'triangle_ascending',
					accepted: true,
					reason: 'detected',
					details: { status: 'forming', breakout: null, breakInfo: { direction: 'up' }, touchCount: 4 },
				},
			]),
			[],
			res,
		).content[0].text;

		expect(text).toContain('triangle_ascending (detected) status=forming');
		expect(text).not.toContain('breakoutDirection=');
	});

	it('top-level が details より優先される（両方あるとき 1 回だけ出る）', () => {
		const text = formatDebugView(
			'hdr',
			meta([
				{
					type: 'triangle_ascending',
					accepted: true,
					reason: 'detected',
					status: 'forming',
					breakoutDirection: 'up',
					details: { status: 'completed', breakout: { idx: 3, direction: 'down' }, touchCount: 4 },
				},
			]),
			[],
			res,
		).content[0].text;

		const header = text.split('\n').find((l) => l.startsWith('1. ')) ?? '';
		expect(header).toContain('status=forming');
		expect(header).toContain('breakoutDirection=up');
		expect(header).not.toContain('completed');
		expect(header.match(/status=/g)).toHaveLength(1);
	});

	it('top-level の breakoutDirection: null は details 側で上書きされない', () => {
		// `null` は欠損ではなく「この検出器が未ブレイクと判定した」という値のある答え。
		// `c.breakoutDirection ?? details…` と書くと欠損と同じ扱いになり、details 側の
		// 方向が漏れて「未ブレイクなのに方向がある」という矛盾した行が出る。
		const text = formatDebugView(
			'hdr',
			meta([
				{
					type: 'rising_wedge',
					accepted: true,
					status: 'forming',
					breakoutDirection: null,
					details: { breakout: { idx: 7, direction: 'down' } },
				},
			]),
			[],
			res,
		).content[0].text;

		const header = text.split('\n').find((l) => l.startsWith('1. ')) ?? '';
		expect(header).toContain('rising_wedge status=forming');
		expect(header).not.toContain('breakoutDirection=');
	});

	it('未ブレイク（breakout: null / breakoutDirection: null）では breakoutDirection 行を出さない', () => {
		const text = formatDebugView(
			'hdr',
			meta([
				{ type: 'falling_wedge', accepted: true, status: 'forming', breakoutDirection: null },
				{
					type: 'bull_pennant',
					accepted: true,
					reason: 'detected',
					details: { status: 'forming', breakout: null, touchCount: 6 },
				},
				// details 自体が無い候補でも落ちない
				{ type: 'head_and_shoulders', accepted: true, status: 'forming' },
			]),
			[],
			res,
		).content[0].text;

		expect(text).not.toContain('breakoutDirection=');
		expect(text).toContain('falling_wedge status=forming');
		expect(text).toContain('bull_pennant (detected) status=forming');
		expect(text).toContain('head_and_shoulders status=forming');
	});

	it('status も breakoutDirection も無い候補では余計な語を出さない', () => {
		const text = formatDebugView(
			'hdr',
			meta([{ type: 'double_top', accepted: false, reason: 'head_not_higher' }]),
			[],
			res,
		).content[0].text;

		expect(text).toContain('❌ double_top [head_not_higher]');
		expect(text).not.toContain('status=');
		expect(text).not.toContain('breakoutDirection=');
	});

	it('凡例が ✅ 側の status の意味も説明する', () => {
		const text = formatDebugView('hdr', meta([]), [], res).content[0].text;
		expect(text).toContain('候補段階の棄却');
		expect(text).toContain('✅ の status = 候補を組み立てた時点の状態');
	});
});
