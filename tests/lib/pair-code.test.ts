/**
 * lib/pair-code — API が返す pair シンボルの取得境界正規化のユニットテスト。
 *
 * 消費側（`portfolio/calc.ts` / 各 Private ツール）は「pair は小文字」を前提に
 * `t.pair === \`${asset}_jpy\`` の突き合わせ・`replace('_jpy', '')` による asset 導出・
 * `includes('jpy')` の JPY 判定を組んでいる。その前提を担保するのがこのユーティリティなので、
 *   - 大文字が確実に小文字化されること
 *   - 既に小文字のレコード（＝現行 API の実挙動）では出力が 1 バイトも変わらないこと
 * の 2 点を機械的に固定する。
 */

import { describe, expect, it } from 'vitest';
import { isJpyQuotedPair, normalizePairCode, normalizePairCodes, withNormalizedPair } from '../../lib/pair-code.js';

describe('normalizePairCode', () => {
	it('大文字を小文字へ正規化する', () => {
		expect(normalizePairCode('BTC_JPY')).toBe('btc_jpy');
		expect(normalizePairCode('Xrp_Jpy')).toBe('xrp_jpy');
	});

	it('小文字はそのまま返す', () => {
		expect(normalizePairCode('btc_jpy')).toBe('btc_jpy');
	});

	it('前後の空白を落とす', () => {
		expect(normalizePairCode('  BTC_JPY ')).toBe('btc_jpy');
	});

	it('空文字はそのまま空文字を返す', () => {
		expect(normalizePairCode('')).toBe('');
	});

	/**
	 * 取得境界でやるのは「前後の空白除去 + 小文字化」の 2 つのみ。形式検証
	 * （`lib/validate.ts` の `normalizePair`）や ALLOWED_PAIRS 検証（`ensurePair`）を
	 * 持ち込まない——口座に非対応 pair（上場廃止ペア等）の履歴があっても取得層で落としてはならない。
	 */
	it('形式不正・未対応 pair も drop / throw せず小文字化して通す', () => {
		expect(normalizePairCode('NOTAPAIR')).toBe('notapair');
		expect(normalizePairCode('MONA_BTC')).toBe('mona_btc');
		expect(() => normalizePairCode('')).not.toThrow();
	});
});

describe('withNormalizedPair', () => {
	it('pair のみを小文字化し、他フィールドは触らない', () => {
		expect(withNormalizedPair({ trade_id: 1, pair: 'BTC_JPY', side: 'buy' })).toEqual({
			trade_id: 1,
			pair: 'btc_jpy',
			side: 'buy',
		});
	});

	it('既に小文字のレコードは同一参照のまま通す', () => {
		const record = { trade_id: 1, pair: 'btc_jpy' };
		expect(withNormalizedPair(record)).toBe(record);
	});

	it('入力レコードを破壊的に変更しない', () => {
		const record = { pair: 'BTC_JPY' };
		withNormalizedPair(record);
		expect(record.pair).toBe('BTC_JPY');
	});

	it('pair が string でないレコードは throw せずそのまま通す', () => {
		const record = { trade_id: 1 } as unknown as { pair: string; trade_id: number };
		expect(() => withNormalizedPair(record)).not.toThrow();
		expect(withNormalizedPair(record)).toBe(record);
	});
});

describe('normalizePairCodes', () => {
	it('空配列を空配列で返す', () => {
		expect(normalizePairCodes([])).toEqual([]);
	});

	it('pair のみを小文字化し、他フィールドは触らない', () => {
		const records = [
			{ trade_id: 1, pair: 'BTC_JPY', amount: '1' },
			{ trade_id: 2, pair: 'ETH_JPY', amount: '2' },
		];
		expect(normalizePairCodes(records)).toEqual([
			{ trade_id: 1, pair: 'btc_jpy', amount: '1' },
			{ trade_id: 2, pair: 'eth_jpy', amount: '2' },
		]);
	});

	it('入力レコードを破壊的に変更しない', () => {
		const records = [{ pair: 'BTC_JPY' }];
		normalizePairCodes(records);
		expect(records[0].pair).toBe('BTC_JPY');
	});

	/**
	 * 回帰防止の要。現行 API は小文字を返すので、正規化を挟んでも既存出力は変わらない
	 * ことを「参照が同一」で示す（オブジェクトを作り直していないので JSON も不変）。
	 */
	it('既に小文字のレコードは同一参照のまま通す（既存レスポンスに対してノーオペ）', () => {
		const records = [
			{ trade_id: 1, pair: 'btc_jpy' },
			{ trade_id: 2, pair: 'eth_jpy' },
		];
		const result = normalizePairCodes(records);
		expect(result[0]).toBe(records[0]);
		expect(result[1]).toBe(records[1]);
	});
});

describe('isJpyQuotedPair', () => {
	it("小文字 pair を従来どおり判定する（includes('jpy') 挙動の保存）", () => {
		expect(isJpyQuotedPair('btc_jpy')).toBe(true);
		expect(isJpyQuotedPair('eth_btc')).toBe(false);
		// 既存の includes 判定は base 側 JPY も真になる。lib/price.ts の isJpyPair
		// （endsWith('_jpy')）とは条件が違うので、ここで挙動を固定しておく
		expect(isJpyQuotedPair('jpy_btc')).toBe(true);
	});

	it('大文字・前後空白のユーザー入力でも判定が崩れない', () => {
		expect(isJpyQuotedPair('BTC_JPY')).toBe(true);
		expect(isJpyQuotedPair('  Btc_Jpy ')).toBe(true);
		expect(isJpyQuotedPair('ETH_BTC')).toBe(false);
	});
});
