import { describe, expect, it } from 'vitest';
import { collectUpstreamWarnings, extractUpstreamWarning, prependWarnings } from '../lib/warning-propagation.js';

describe('prependWarnings', () => {
	it('meta.warning と meta.warnings を別行で先頭に連結する', () => {
		const text = prependWarnings('BODY', {
			warning: '⚠️ 3日中1日の取得に失敗',
			warnings: ['SMA_200: データ不足'],
		});
		expect(text.startsWith('⚠️ 3日中1日の取得に失敗')).toBe(true);
		expect(text).toContain('⚠️ SMA_200: データ不足');
		// default separator は '\n\n' (handler 系で空行を挟む)
		expect(text).toContain('\n\nBODY');
	});

	it('⚠️ プレフィックスがなければ自動で付ける', () => {
		const text = prependWarnings('BODY', {
			warning: 'partial fetch',
			warnings: ['SMA_200: データ不足'],
		});
		expect(text).toContain('⚠️ partial fetch');
		expect(text).toContain('⚠️ SMA_200: データ不足');
	});

	it('両方とも空なら body をそのまま返す', () => {
		expect(prependWarnings('BODY', {})).toBe('BODY');
		expect(prependWarnings('BODY', { warnings: [] })).toBe('BODY');
		expect(prependWarnings('BODY', { warning: '', warnings: [] })).toBe('BODY');
	});

	it('warnings のみでも先頭に連結される', () => {
		const text = prependWarnings('BODY', { warnings: ['SMA_5: データ不足'] });
		expect(text.startsWith('⚠️ SMA_5: データ不足')).toBe(true);
	});

	it('warning のみでも先頭に連結される', () => {
		const text = prependWarnings('BODY', { warning: '⚠️ partial fetch' });
		expect(text.startsWith('⚠️ partial fetch')).toBe(true);
	});

	it('meta が null / undefined でも body を返す', () => {
		expect(prependWarnings('BODY', null)).toBe('BODY');
		expect(prependWarnings('BODY', undefined)).toBe('BODY');
	});

	it('warnings 配列の空要素はスキップする', () => {
		const text = prependWarnings('BODY', { warnings: ['', 'SMA_200: データ不足', ''] });
		const warningLines = text.split('\n\nBODY')[0].split('\n');
		expect(warningLines).toEqual(['⚠️ SMA_200: データ不足']);
	});

	it('warning が改行入りの場合、行ごとに ⚠️ プレフィックスを付ける', () => {
		const text = prependWarnings('BODY', {
			warning: '[flow] X\n[volatility] Y',
		});
		expect(text).toContain('⚠️ [flow] X');
		expect(text).toContain('⚠️ [volatility] Y');
	});

	it("separator: '\\n\\n'（デフォルト）で warning と本文の間に空行が入る", () => {
		const text = prependWarnings('BODY', { warning: 'partial fetch' });
		expect(text).toBe('⚠️ partial fetch\n\nBODY');
	});

	it("separator: '\\n' で空行が入らない（1 行で連結される）", () => {
		const text = prependWarnings('BODY', { warning: 'partial fetch' }, { separator: '\n' });
		expect(text).toBe('⚠️ partial fetch\nBODY');
		expect(text.includes('\n\n')).toBe(false);
	});

	it("separator: '\\n' でも warning + warnings 両方を含む", () => {
		const text = prependWarnings(
			'BODY',
			{ warning: '⚠️ partial fetch', warnings: ['SMA_200: データ不足'] },
			{ separator: '\n' },
		);
		expect(text).toBe('⚠️ partial fetch\n⚠️ SMA_200: データ不足\nBODY');
	});
});

describe('extractUpstreamWarning', () => {
	it('正常な meta から warning と warnings を取り出す', () => {
		const out = extractUpstreamWarning({
			warning: '⚠️ partial fetch',
			warnings: ['SMA_200: データ不足'],
		});
		expect(out).toEqual({
			warning: '⚠️ partial fetch',
			warnings: ['SMA_200: データ不足'],
		});
	});

	it('meta が undefined / null なら空オブジェクトを返す', () => {
		expect(extractUpstreamWarning(undefined)).toEqual({});
		expect(extractUpstreamWarning(null)).toEqual({});
	});

	it('warning / warnings が存在しないキーなら結果に含まれない', () => {
		expect(extractUpstreamWarning({})).toEqual({});
		expect(extractUpstreamWarning({ pair: 'btc_jpy' })).toEqual({});
	});

	it('warnings が非配列なら無視する', () => {
		expect(extractUpstreamWarning({ warning: 'x', warnings: 'oops' })).toEqual({ warning: 'x' });
		expect(extractUpstreamWarning({ warnings: { foo: 'bar' } })).toEqual({});
	});

	it('warning が string 以外なら無視する', () => {
		expect(extractUpstreamWarning({ warning: 123 })).toEqual({});
		expect(extractUpstreamWarning({ warning: '' })).toEqual({});
	});

	it('warnings 配列内の非 string 要素はフィルタリングされる', () => {
		const out = extractUpstreamWarning({
			warnings: ['SMA_200: データ不足', 42, null, '', 'EMA_200: データ不足'],
		});
		expect(out).toEqual({ warnings: ['SMA_200: データ不足', 'EMA_200: データ不足'] });
	});

	it('warnings が全て無効値なら結果に含まれない', () => {
		expect(extractUpstreamWarning({ warnings: [null, '', undefined] })).toEqual({});
		expect(extractUpstreamWarning({ warnings: [] })).toEqual({});
	});

	it('不正型（number / string）なら空オブジェクトを返す', () => {
		expect(extractUpstreamWarning(42)).toEqual({});
		expect(extractUpstreamWarning('warning')).toEqual({});
	});

	it('結果はそのままスプレッドして下流 meta に載せられる形', () => {
		const upstream = extractUpstreamWarning({ warning: 'x', warnings: ['y'] });
		const downstream = { pair: 'btc_jpy', ...upstream };
		expect(downstream).toEqual({ pair: 'btc_jpy', warning: 'x', warnings: ['y'] });
	});
});

describe('collectUpstreamWarnings', () => {
	it('空配列なら undefined を返す', () => {
		expect(collectUpstreamWarnings([])).toBeUndefined();
	});

	it('すべて warning なしなら undefined を返す', () => {
		expect(
			collectUpstreamWarnings([
				{ source: 'flow' },
				{ source: 'volatility', warning: undefined },
				{ source: 'indicators', warning: '' },
			]),
		).toBeUndefined();
	});

	it('一部 source のみ warning ありの場合、その source だけ返す', () => {
		const out = collectUpstreamWarnings([
			{ source: 'flow', warning: '⚠️ flow データ部分欠損' },
			{ source: 'volatility' },
			{ source: 'indicators' },
		]);
		expect(out).toBe('[flow] flow データ部分欠損');
	});

	it('複数 source の warning を改行で連結する', () => {
		const out = collectUpstreamWarnings([
			{ source: 'flow', warning: '⚠️ flow データ部分欠損' },
			{ source: 'volatility', warning: '⚠️ volatility 不正OHLCをスキップ' },
		]);
		expect(out).toBe('[flow] flow データ部分欠損\n[volatility] volatility 不正OHLCをスキップ');
	});

	it('改行入り warning は行ごとに分割して prefix を付与する', () => {
		const out = collectUpstreamWarnings([{ source: 'flow', warning: '⚠️ 行1\n⚠️ 行2' }]);
		expect(out).toBe('[flow] 行1\n[flow] 行2');
	});

	it('⚠️ プレフィックスがなくても処理する（prefix なしの素のメッセージ）', () => {
		const out = collectUpstreamWarnings([{ source: 'flow', warning: 'プレーンメッセージ' }]);
		expect(out).toBe('[flow] プレーンメッセージ');
	});

	it('⚠️ プレフィックスは除去され、source prefix のみが残る', () => {
		const out = collectUpstreamWarnings([{ source: 'indicators', warning: '⚠️ 取得層警告' }]);
		expect(out).toBe('[indicators] 取得層警告');
		expect(out?.startsWith('⚠️')).toBe(false);
	});

	it('warning 内の空行はスキップされる', () => {
		const out = collectUpstreamWarnings([{ source: 'flow', warning: '行1\n\n  \n行2' }]);
		expect(out).toBe('[flow] 行1\n[flow] 行2');
	});
});
