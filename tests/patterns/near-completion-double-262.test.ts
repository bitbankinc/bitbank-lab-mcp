/**
 * issue #262 Phase 2 — double の「構造完成・ブレイク待ち」を `near_completion` で出す。
 *
 * 完成済み 4 経路（strict / relaxed × top / bottom）は以前、`findBreakoutIdx` が −1 のとき
 * `no_breakout` で棄却して終わっていた。`detect_triples` / `detect_hs` の完成済み経路は同じ状況で
 * `status: 'near_completion'` を出しており、**double 2 型だけがこの status を一度も出さなかった**。
 * 同時に、`tryFormingDoubleBottom`（削除済み）が**同じ段階**を `status: 'forming'` という
 * 誤ラベルで出していた。
 *
 * 本ファイルが固定するもの:
 *
 * 1. 3 点が揃い・未ブレイク・突破確認窓の内側 → `near_completion`（top / bottom）
 * 2. 窓を過ぎたら `expired` / `invalidReason: 'forming_expired'`（#126 G4 を完成済み経路で再現）
 * 3. 谷（山）ゾーンへ再進入したら `invalid` / `re_entered_trough_zone`（#126 G5 を同上）
 * 4. `includeForming: false` では 1〜3 のどれも出ない（未ブレイク構造は forming バケット）
 * 5. **同じ形にブレイクを足すと `completed` になる**（`near_completion` → `completed` の連続性）
 * 6. 凍結済み実データにも同じ形が実在する（Phase 1 のメモ §8 の「形 07」を指名）
 *
 * ゲート集合そのものの回帰は既存ファイルが持つ（`size-gates-forming-doubles.test.ts` /
 * `neckline-side-forming-triple-double.test.ts` / `level-diff-double.test.ts`）。
 * **ここは status の決まり方だけを見る。**
 *
 * ## 合成 fixture の作り方（数値の根拠）
 *
 * どちらも 3 水準（外側 2 点が同値・中間 1 点）を線形の脚でつないだ**ヒゲ無し**の列で、
 * `extremePrice === close` にして閾値の計算を素の割り算で読めるようにしてある
 * （`size-gates-forming-doubles.test.ts` と同じ理由）。
 *
 * - **先頭の脚**（bottom は 130 → 100、top は 70 → 100）は構造ゲート（#126）が要求する
 *   「谷1 の前にネックライン水準を終値で抜けた事象」を作るためのもの。戻り率は
 *   `(112 − 100) / (130 − 100) = 0.4` で `RETRACEMENT_MIN` 0.2 〜 `RETRACEMENT_MAX` 0.9 の内側。
 * - **第2構成点の直後を 1 本で大きく戻す**のは、谷ゾーン（`valley + 高さ × 0.25` = 103）を
 *   1 本目で抜けないと `re_entered_trough_zone` が先に当たり、window 内でも `invalid` に
 *   なってしまうため。`invalid` のケースはこれを意図的に破っている。
 * - ネックライン突破は終値ベース ±1.5% バッファなので、bottom は `112 × 1.015 = 113.68` を
 *   **超えなければ**未ブレイク、超えれば `completed`。top は `88 × 0.985 = 86.68`。
 */
import { describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import { asMockResult, assertOk } from '../_assertResult.js';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';
import { buildBtcJpy1hour202608Candles } from '../fixtures/btc_jpy_1hour_2026_08.js';

type Candle = { isoTime: string; open: number; high: number; low: number; close: number; volume: number };
type Pattern = {
	type: string;
	status?: string;
	invalidReason?: string;
	pivots?: Array<{ idx: number }>;
	breakoutBarIndex?: number;
	confirmation?: { type?: string };
	targetProgressOmittedReason?: string;
};

/** ヒゲ無しのローソク（`extremePrice === close`）。固定の起点から i 本後。 */
function mkCandle(i: number, close: number): Candle {
	const isoTime = dayjs.utc('2026-01-01T00:00:00Z').add(i, 'day').toISOString();
	return { isoTime, open: close, high: close, low: close, close, volume: 100 };
}

/** `[bars, endPrice][]` を線形補間して終値列にする。折り返し点がそのままピボット候補になる。 */
function legs(start: number, spec: Array<[bars: number, endPrice: number]>): number[] {
	const out = [start];
	let cur = start;
	for (const [bars, end] of spec) {
		for (let i = 1; i <= bars; i++) out.push(cur + ((end - cur) * i) / bars);
		cur = end;
	}
	return out.map((v) => Math.round(v * 1000) / 1000);
}

const toCandles = (closes: number[]) => closes.map((c, i) => mkCandle(i, c));

/**
 * 谷1（idx 9 / 100）→ 山（idx 17 / 112）→ 谷2（idx 25 / 100）＋ 末尾。
 * 末尾の 1 本目（idx 26）を 106 に跳ねさせて谷ゾーン（103）を即座に抜ける。
 */
function doubleBottom(tail: Array<[bars: number, endPrice: number]>): Candle[] {
	return toCandles(legs(130, [[9, 100], [8, 112], [8, 100], [1, 106], ...tail]));
}

/**
 * 山1（idx 9 / 100）→ 谷（idx 17 / 88）→ 山2（idx 25 / 100）＋ 末尾。
 * {@link doubleBottom} の上下対称で、山ゾーンは `100 − 12 × 0.25 = 97`。
 */
function doubleTop(tail: Array<[bars: number, endPrice: number]>): Candle[] {
	return toCandles(legs(70, [[9, 100], [8, 88], [8, 100], [1, 94], ...tail]));
}

/**
 * 1 系列を `detect_patterns` に流し、要求した種別の `data.patterns` だけを返す。
 * `includeInvalid: true` を既定にしてあるのは、`expired` / `invalid` も同じ表で見たいため
 * （`includeForming: false` のケースでは意図的に両方を渡し、それでも出ないことを確かめている）。
 */
async function detect(
	candles: Candle[],
	want: 'double_top' | 'double_bottom',
	opts: Record<string, unknown> = {},
	tf = '1day',
): Promise<Pattern[]> {
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
	);
	const res = await detectPatterns('btc_jpy', tf, candles.length, {
		patterns: [want],
		swingDepth: 2,
		includeForming: true,
		includeCompleted: true,
		includeInvalid: true,
		...opts,
	});
	assertOk(res);
	return (res.data.patterns as unknown as Pattern[]).filter((p) => p.type === want);
}

/** 構成点の idx（外側 2 点 + 中間）。合成 fixture ではどのケースも同じ 3 点になる。 */
const MAIN_POINTS = [9, 17, 25];

describe('未ブレイクの double は near_completion（issue #262）', () => {
	describe('double_bottom', () => {
		it('3 点揃い・未ブレイク・窓内 → near_completion', async () => {
			// 谷2（idx 25）から 10 本後が終端。FORMING_EXPIRY_BARS = 20 の内側。
			const found = await detect(doubleBottom([[9, 109]]), 'double_bottom');
			expect(found).toHaveLength(1);
			expect(found[0].status).toBe('near_completion');
			expect(found[0].invalidReason).toBeUndefined();
			expect(found[0].pivots?.map((p) => p.idx)).toEqual(MAIN_POINTS);
			// ブレイク足が無いことを構造で示す（#224 症状 2）
			expect(found[0].breakoutBarIndex).toBeUndefined();
			expect(found[0].confirmation?.type).toBe('not_confirmed');
			expect(found[0].targetProgressOmittedReason).toBe('not_broken_out');
		});

		it('突破確認窓を過ぎたら expired / forming_expired（#126 G4）', async () => {
			// 谷2（idx 25）から 23 本後が終端。FORMING_EXPIRY_BARS = 20 を超える。
			const found = await detect(doubleBottom([[22, 109]]), 'double_bottom');
			expect(found).toHaveLength(1);
			expect(found[0].status).toBe('expired');
			expect(found[0].invalidReason).toBe('forming_expired');
		});

		it('谷ゾーンへ再進入したら invalid / re_entered_trough_zone（#126 G5）', async () => {
			// 谷ゾーンは 100 + (112 − 100) × 0.25 = 103。96 まで押すと終値で割る。
			// 96 は 2 谷の水準 100 から 4% 離れており（DOUBLE_LEVEL_MAX_PCT = 3%）、
			// 第3の谷としては同水準にならないので triple への再分類には回らない。
			const found = await detect(
				doubleBottom([
					[3, 96],
					[6, 106],
				]),
				'double_bottom',
			);
			expect(found).toHaveLength(1);
			expect(found[0].status).toBe('invalid');
			expect(found[0].invalidReason).toBe('re_entered_trough_zone');
		});

		it('ネックラインを終値で 1.5% 超えると completed（near_completion → completed の連続性）', async () => {
			// 112 × 1.015 = 113.68 を超える末尾。構成点は上の 3 ケースと同じ。
			const found = await detect(doubleBottom([[9, 118]]), 'double_bottom');
			expect(found).toHaveLength(1);
			// 完成済みは status を持たない（既存契約。`ranking.ts` の statusScore が単一ソース）
			expect(found[0].status).toBeUndefined();
			expect(found[0].pivots?.map((p) => p.idx)).toEqual(MAIN_POINTS);
			expect(found[0].breakoutBarIndex).toBeGreaterThan(25);
			expect(found[0].confirmation?.type).toBe('neckline_breakout');
		});
	});

	describe('double_top（上下対称）', () => {
		it('3 点揃い・未ブレイク・窓内 → near_completion', async () => {
			const found = await detect(doubleTop([[9, 91]]), 'double_top');
			expect(found).toHaveLength(1);
			expect(found[0].status).toBe('near_completion');
			expect(found[0].pivots?.map((p) => p.idx)).toEqual(MAIN_POINTS);
			expect(found[0].breakoutBarIndex).toBeUndefined();
			expect(found[0].confirmation?.type).toBe('not_confirmed');
		});

		it('突破確認窓を過ぎたら expired / forming_expired', async () => {
			const found = await detect(doubleTop([[22, 91]]), 'double_top');
			expect(found).toHaveLength(1);
			expect(found[0].status).toBe('expired');
			expect(found[0].invalidReason).toBe('forming_expired');
		});

		it('山ゾーンへ再進入したら invalid / re_entered_trough_zone', async () => {
			// 山ゾーンは 100 − 12 × 0.25 = 97。104 まで戻すと終値で超える。
			// 104 は 2 山の水準 100 から 4% 離れているので triple への再分類には回らない。
			const found = await detect(
				doubleTop([
					[3, 104],
					[6, 94],
				]),
				'double_top',
			);
			expect(found).toHaveLength(1);
			expect(found[0].status).toBe('invalid');
			expect(found[0].invalidReason).toBe('re_entered_trough_zone');
		});

		it('ネックラインを終値で 1.5% 割ると completed', async () => {
			// 88 × 0.985 = 86.68 を割る末尾。
			const found = await detect(doubleTop([[9, 82]]), 'double_top');
			expect(found).toHaveLength(1);
			expect(found[0].status).toBeUndefined();
			expect(found[0].confirmation?.type).toBe('neckline_breakout');
		});
	});

	/**
	 * `near_completion` / `expired` / `invalid` はいずれも**未ブレイクの構造**なので、
	 * `includeForming: false`（既定）では検出器が組み立てる前に `no_breakout` で抜ける。
	 * `includeInvalid: true` を渡しても出ないことまで見る——`expired` / `invalid` は
	 * `detect_patterns.ts` のライフサイクル絞り込みでは invalid バケットに入るので、
	 * **検出器側で止めていないとここから漏れる。**
	 */
	describe('includeForming: false では未ブレイクの構造を返さない', () => {
		const cases: Array<[label: string, candles: () => Candle[], want: 'double_top' | 'double_bottom']> = [
			['near_completion (bottom)', () => doubleBottom([[9, 109]]), 'double_bottom'],
			['expired (bottom)', () => doubleBottom([[22, 109]]), 'double_bottom'],
			[
				'invalid (bottom)',
				() =>
					doubleBottom([
						[3, 96],
						[6, 106],
					]),
				'double_bottom',
			],
			['near_completion (top)', () => doubleTop([[9, 91]]), 'double_top'],
			['expired (top)', () => doubleTop([[22, 91]]), 'double_top'],
		];
		for (const [label, candles, want] of cases) {
			it(label, async () => {
				const found = await detect(candles(), want, { includeForming: false });
				expect(found).toHaveLength(0);
			});
		}

		it('ブレイク済みの形は includeForming: false でも出る（絞り込みが completed を巻き込まない）', async () => {
			const found = await detect(doubleBottom([[9, 118]]), 'double_bottom', { includeForming: false });
			expect(found).toHaveLength(1);
			expect(found[0].status).toBeUndefined();
		});
	});
});

/**
 * Phase 1 のメモ tjackiet/bitbank-lab-mcp#262 の計測記録
 * §8-1 の **形 07**（実データ B = `btc_jpy_1hour_2026_08`、`1hour` / `swingDepth: 6` /
 * 終端 idx 253、構成点 219 - 230 - 236）。
 *
 * ablation B で `forming` として現れた 2 実体の 1 つで、§8-4 の目視判定は「呼べる」
 * （深さ 1.845%、両脚 11 本 / 6 本、山2 以降にネックラインを割り新高値なし）。
 * **本実装は完成済み経路のゲート集合で組む**ので Phase 1 の ablation B とは集合が変わりうる。
 * この実体が実際に残ることを指名で固定する。
 */
describe('凍結済み実データ（実データ B・Phase 1 §8 の形 07）', () => {
	it('double_top 219-230-236 が near_completion で出る', async () => {
		const candles = buildBtcJpy1hour202608Candles().slice(0, 254) as unknown as Candle[];
		const found = await detect(candles, 'double_top', { swingDepth: 6 }, '1hour');
		const hit = found.find((p) => p.pivots?.map((v) => v.idx).join('-') === '219-230-236');
		expect(hit, 'Phase 1 §8 の形 07 が data.patterns に居ない').toBeDefined();
		expect(hit?.status).toBe('near_completion');
	});
});
