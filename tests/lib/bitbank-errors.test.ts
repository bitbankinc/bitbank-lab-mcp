import { describe, expect, it } from 'vitest';
import { getBitbankErrorMessage } from '../../src/lib/bitbank-errors.js';

describe('getBitbankErrorMessage — 注文照会・キャンセル系', () => {
	it('50009: 指定された注文が見つからない', () => {
		expect(getBitbankErrorMessage(50009)).toBe('指定された注文が見つかりません（3ヶ月以上前の注文は参照不可）');
	});

	it('50010: キャンセル不可', () => {
		expect(getBitbankErrorMessage(50010)).toBe('この注文はキャンセルできません');
	});

	it('50026: 既にキャンセル済み', () => {
		expect(getBitbankErrorMessage(50026)).toBe('この注文は既にキャンセル済みです');
	});

	it('50027: 既に約定済み', () => {
		expect(getBitbankErrorMessage(50027)).toBe('この注文は既に約定済みです');
	});
});

describe('getBitbankErrorMessage — 信用取引固有エラー', () => {
	it('50058: 信用取引未審査', () => {
		expect(getBitbankErrorMessage(50058)).toBe(
			'信用取引の審査が完了していません。bitbank の管理画面から申込・審査を行ってください',
		);
	});

	it('50059 / 50060: 新規建注文を一時的に制限（同一文言）', () => {
		const msg = '新規建注文を一時的に制限しています。しばらく時間を空けてから再試行してください';
		expect(getBitbankErrorMessage(50059)).toBe(msg);
		expect(getBitbankErrorMessage(50060)).toBe(msg);
	});

	it('50061: 新規建可能額超過', () => {
		expect(getBitbankErrorMessage(50061)).toBe(
			'新規建可能額を上回っています。保証金を追加するか、建玉を決済してください',
		);
	});

	it('50062: 建玉数量超過', () => {
		expect(getBitbankErrorMessage(50062)).toBe('建玉数量を上回っています。保有建玉数量を確認してください');
	});

	it('50078: 信用取引における新規建て注文不可', () => {
		expect(getBitbankErrorMessage(50078)).toBe('現在、信用取引における新規建て注文はご利用いただけません');
	});
});

describe('getBitbankErrorMessage — 現物・共通エラー', () => {
	it('60001: 残高不足', () => {
		expect(getBitbankErrorMessage(60001)).toBe('残高が不足しています。保有資産を確認してください');
	});

	it('60002: 成行買い数量上限', () => {
		expect(getBitbankErrorMessage(60002)).toBe('成行買い注文の数量上限を超えています');
	});

	it('60003 / 60004: 数量範囲外', () => {
		expect(getBitbankErrorMessage(60003)).toBe('注文数量が最小数量を下回っています');
		expect(getBitbankErrorMessage(60004)).toBe('注文数量が最大数量を超えています');
	});

	it('60005 / 60006: 価格範囲外', () => {
		expect(getBitbankErrorMessage(60005)).toBe('注文価格が下限を下回っています');
		expect(getBitbankErrorMessage(60006)).toBe('注文価格が上限を超えています');
	});

	it('60011: 同時注文上限', () => {
		expect(getBitbankErrorMessage(60011)).toBe(
			'同時注文数の上限（30件）に達しています。既存注文をキャンセルしてください',
		);
	});

	it('60016: トリガー価格不正', () => {
		expect(getBitbankErrorMessage(60016)).toBe('トリガー価格が不正です');
	});
});

describe('getBitbankErrorMessage — 取引制限系', () => {
	it('70004: 買い注文制限', () => {
		expect(getBitbankErrorMessage(70004)).toBe('現在、買い注文が制限されています');
	});

	it('70005: 売り注文制限', () => {
		expect(getBitbankErrorMessage(70005)).toBe('現在、売り注文が制限されています');
	});

	it('70006: 通貨ペアの取引制限', () => {
		expect(getBitbankErrorMessage(70006)).toBe('現在、この通貨ペアの取引が制限されています');
	});

	it('70009: 成行注文制限', () => {
		expect(getBitbankErrorMessage(70009)).toBe('現在、成行注文が制限されています。指値注文をお試しください');
	});

	it('70020: サーキットブレイク中の成行制限', () => {
		expect(getBitbankErrorMessage(70020)).toBe(
			'サーキットブレイク中または板寄せ中のため、成行注文は制限されています。指値注文を使うか、再開後に再試行してください',
		);
	});
});

describe('getBitbankErrorMessage — 入力形式', () => {
	it('数値文字列も受け付ける', () => {
		expect(getBitbankErrorMessage('60001')).toBe('残高が不足しています。保有資産を確認してください');
	});

	it('未登録コードは undefined を返す', () => {
		expect(getBitbankErrorMessage(99999)).toBeUndefined();
	});

	it('認証系（20001）は登録対象外（client.ts 側で扱う）', () => {
		expect(getBitbankErrorMessage(20001)).toBeUndefined();
	});

	it('レート制限（10009）は登録対象外（client.ts 側で扱う）', () => {
		expect(getBitbankErrorMessage(10009)).toBeUndefined();
	});

	it('メンテナンス系（10007 / 10008）は登録対象外', () => {
		expect(getBitbankErrorMessage(10007)).toBeUndefined();
		expect(getBitbankErrorMessage(10008)).toBeUndefined();
	});

	it('非整数の文字列は undefined を返す', () => {
		expect(getBitbankErrorMessage('abc')).toBeUndefined();
		expect(getBitbankErrorMessage('60001.5')).toBeUndefined();
	});

	it('小数値は undefined を返す', () => {
		expect(getBitbankErrorMessage(60001.5)).toBeUndefined();
	});
});
