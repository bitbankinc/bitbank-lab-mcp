/**
 * lib/asset-code — API が返す asset コードの取得境界正規化のユニットテスト。
 *
 * 消費側（portfolio/calc.ts 等）は「asset は小文字」を前提に JPY 判定・prices 検索・
 * Map キーを組んでいる。その前提を担保するのがこのユーティリティなので、
 *   - 大文字が確実に小文字化されること
 *   - 既に小文字のレコード（＝現行 API の実挙動）では出力が 1 バイトも変わらないこと
 * の 2 点を機械的に固定する。
 */

import { describe, expect, it } from 'vitest';
import { normalizeAssetCode, normalizeAssetCodes } from '../../lib/asset-code.js';

describe('normalizeAssetCode', () => {
	it('大文字を小文字へ正規化する', () => {
		expect(normalizeAssetCode('JPY')).toBe('jpy');
		expect(normalizeAssetCode('DOGE')).toBe('doge');
		expect(normalizeAssetCode('BtC')).toBe('btc');
	});

	it('小文字はそのまま返す', () => {
		expect(normalizeAssetCode('jpy')).toBe('jpy');
		expect(normalizeAssetCode('btc')).toBe('btc');
	});

	it('前後の空白を落とす', () => {
		expect(normalizeAssetCode('  JPY ')).toBe('jpy');
	});

	it('空文字はそのまま空文字を返す', () => {
		expect(normalizeAssetCode('')).toBe('');
	});
});

describe('normalizeAssetCodes', () => {
	it('空配列を空配列で返す', () => {
		expect(normalizeAssetCodes([])).toEqual([]);
	});

	it('asset のみを小文字化し、他フィールドは触らない', () => {
		const records = [
			{ uuid: 'dep-1', asset: 'JPY', amount: '1000', status: 'DONE' },
			{ uuid: 'dep-2', asset: 'DOGE', amount: '10', status: 'DONE' },
		];
		expect(normalizeAssetCodes(records)).toEqual([
			{ uuid: 'dep-1', asset: 'jpy', amount: '1000', status: 'DONE' },
			{ uuid: 'dep-2', asset: 'doge', amount: '10', status: 'DONE' },
		]);
	});

	it('入力レコードを破壊的に変更しない', () => {
		const records = [{ asset: 'JPY', amount: '1000' }];
		normalizeAssetCodes(records);
		expect(records[0].asset).toBe('JPY');
	});

	/**
	 * 回帰防止の要。現行 API は小文字を返すので、正規化を挟んでも既存出力は変わらない
	 * ことを「参照が同一」で示す（オブジェクトを作り直していないので JSON も不変）。
	 */
	it('既に小文字のレコードは同一参照のまま通す（既存レスポンスに対してノーオペ）', () => {
		const records = [
			{ uuid: 'dep-1', asset: 'jpy', amount: '1000' },
			{ uuid: 'dep-2', asset: 'btc', amount: '0.5' },
		];
		const result = normalizeAssetCodes(records);
		expect(result[0]).toBe(records[0]);
		expect(result[1]).toBe(records[1]);
	});

	it('asset が string でないレコードは throw せずそのまま通す', () => {
		const records = [{ uuid: 'dep-1', amount: '1000' } as unknown as { asset: string; uuid: string }];
		expect(() => normalizeAssetCodes(records)).not.toThrow();
		expect(normalizeAssetCodes(records)[0]).toBe(records[0]);
	});
});
