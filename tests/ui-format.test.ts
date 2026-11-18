import { describe, expect, it } from 'vitest';
import {
	formatAmount,
	formatPair,
	formatPrice,
	formatQuote,
	orderIdNote,
	sideLabel,
	typeLabel,
} from '../ui/shared/format.js';

describe('formatPair', () => {
	it('アンダースコア区切りを大文字スラッシュ表記にする', () => {
		expect(formatPair('btc_jpy')).toBe('BTC/JPY');
	});
});

describe('formatAmount', () => {
	it('null / undefined は —', () => {
		expect(formatAmount(null)).toBe('—');
		expect(formatAmount(undefined)).toBe('—');
	});
	it('数値文字列は ja-JP 区切り・暗号資産 8 桁まで', () => {
		expect(formatAmount('12345678.123456789')).toBe('12,345,678.12345679');
		expect(formatAmount('0.00000001')).toBe('0.00000001');
	});
	it('数値にならない文字列はそのまま返す', () => {
		expect(formatAmount('abc')).toBe('abc');
	});
});

describe('formatQuote / formatPrice', () => {
	it('JPY は ¥ 付き整数、非 JPY は 8 桁まで', () => {
		expect(formatQuote(15000000.6, true)).toBe('¥15,000,001');
		expect(formatQuote(0.12345678, false)).toBe('0.12345678');
	});
	it('formatPrice: 空値は —、非数値はそのまま、数値は formatQuote', () => {
		expect(formatPrice(undefined, true)).toBe('—');
		expect(formatPrice('', true)).toBe('—');
		expect(formatPrice('xyz', true)).toBe('xyz');
		expect(formatPrice('100', true)).toBe('¥100');
	});
});

describe('sideLabel', () => {
	it('現物: buy/sell のラベルとクラス', () => {
		expect(sideLabel('buy')).toEqual({ text: '買い', className: 'side-buy' });
		expect(sideLabel('sell')).toEqual({ text: '売り', className: 'side-sell' });
	});
	it('信用: side × positionSide で新規/決済を判定する', () => {
		expect(sideLabel('buy', 'long').text).toBe('買い（信用新規・ロング）');
		expect(sideLabel('sell', 'long').text).toBe('売り（信用決済・ロング）');
		expect(sideLabel('sell', 'short').text).toBe('売り（信用新規・ショート）');
		expect(sideLabel('buy', 'short').text).toBe('買い（信用決済・ショート）');
	});
});

describe('typeLabel', () => {
	it('既知の注文タイプを日本語化し、未知はそのまま返す', () => {
		expect(typeLabel('limit')).toBe('指値');
		expect(typeLabel('market')).toBe('成行');
		expect(typeLabel('stop')).toBe('逆指値');
		expect(typeLabel('stop_limit')).toBe('逆指値指値');
		expect(typeLabel('post_only')).toBe('post_only');
	});
});

// 発注完了の表示で、create_order の summary に入っている注文 ID をカードがもう一度足していた。
describe('orderIdNote', () => {
	it('完了メッセージに注文 ID が入っていれば、足さない', () => {
		const summary = '注文発注完了: BTC/JPY\n  注文ID: 1001\n  ステータス: UNFILLED';
		expect(orderIdNote(summary, 1001)).toBeNull();
	});

	it('完了メッセージに注文 ID が無ければ（既定の文言のとき）、足す', () => {
		expect(orderIdNote('注文を受け付けました', 1001)).toBe('注文ID: 1001');
	});

	it('別の注文 ID しか入っていなければ、足す', () => {
		expect(orderIdNote('注文ID: 1', 12)).toBe('注文ID: 12');
	});

	it('桁の多い別の注文 ID を、同じ ID と取り違えない', () => {
		expect(orderIdNote('注文ID: 123', 12)).toBe('注文ID: 12');
	});

	it('注文 ID が分からなければ、何も足さない', () => {
		expect(orderIdNote('注文を受け付けました', null)).toBeNull();
	});
});
