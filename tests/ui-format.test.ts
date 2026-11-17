import { describe, expect, it } from 'vitest';
import { orderIdNote } from '../ui/shared/format.js';

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
