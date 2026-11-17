import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	_forgetSharedNonce,
	deleteSharedRecord,
	disableSharedConfirmState,
	enableSharedConfirmState,
	isSharedConfirmStateEnabled,
	readSharedRecord,
	recordSharedTokenUse,
	sharedNonce,
	sweepSharedRecords,
	updateSharedRecord,
	writeSharedRecord,
} from '../../src/private/shared-confirm-state.js';

let root: string;
let dir: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-confirm-'));
	dir = path.join(root, 'confirm');
});

afterEach(() => {
	disableSharedConfirmState();
	_forgetSharedNonce();
	fs.rmSync(root, { recursive: true, force: true });
});

function modeOf(p: string): number {
	return fs.statSync(p).mode & 0o777;
}

// Claude Desktop がチャットのツール実行とカードの要求を別プロセスで受けるので、確認に要る状態をファイルで共有する（ADR-0007 判断事項 D）。
describe.skipIf(process.platform === 'win32')('enableSharedConfirmState', () => {
	it('自分だけが読み書きできるフォルダを作って有効にする', () => {
		expect(enableSharedConfirmState(dir)).toBe(true);
		expect(isSharedConfirmStateEnabled()).toBe(true);
		for (const p of [dir, path.join(dir, 'snapshots'), path.join(dir, 'used')]) {
			expect(fs.lstatSync(p).isDirectory()).toBe(true);
			expect(modeOf(p)).toBe(0o700);
		}
	});

	it('既存のフォルダが他人にも開いていれば、自分だけに絞ってから使う', () => {
		fs.mkdirSync(dir, { mode: 0o755 });
		fs.chmodSync(dir, 0o755);
		expect(enableSharedConfirmState(dir)).toBe(true);
		expect(modeOf(dir)).toBe(0o700);
	});

	it('フォルダがシンボリックリンクなら使わない（共有しない）', () => {
		const target = path.join(root, 'elsewhere');
		fs.mkdirSync(target, { mode: 0o700 });
		fs.symlinkSync(target, dir);
		expect(enableSharedConfirmState(dir)).toBe(false);
		expect(isSharedConfirmStateEnabled()).toBe(false);
	});

	it('フォルダの場所にファイルがあれば使わない', () => {
		fs.writeFileSync(dir, 'x');
		expect(enableSharedConfirmState(dir)).toBe(false);
	});

	it('Windows では共有しない（mode では他人の読み取りを防げず、ACL も確かめていない）', () => {
		const original = Object.getOwnPropertyDescriptor(process, 'platform');
		Object.defineProperty(process, 'platform', { value: 'win32' });
		try {
			expect(enableSharedConfirmState(dir)).toBe(false);
			expect(isSharedConfirmStateEnabled()).toBe(false);
		} finally {
			if (original) Object.defineProperty(process, 'platform', original);
		}
	});
});

describe.skipIf(process.platform === 'win32')('sharedNonce', () => {
	it('無効なら null を返す', () => {
		expect(sharedNonce()).toBeNull();
	});

	it('初回に作り、別のプロセス（記憶を消した状態）からも同じ値を読む', () => {
		enableSharedConfirmState(dir);
		const first = sharedNonce();
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(modeOf(path.join(dir, 'nonce'))).toBe(0o600);

		_forgetSharedNonce();
		expect(sharedNonce()).toBe(first);
	});

	it('中身が壊れていれば使わない（null。呼び出し側はプロセスごとの乱数に戻す）', () => {
		enableSharedConfirmState(dir);
		fs.writeFileSync(path.join(dir, 'nonce'), 'broken', { mode: 0o600 });
		expect(sharedNonce()).toBeNull();
	});

	it('シンボリックリンクは読まない', () => {
		enableSharedConfirmState(dir);
		const target = path.join(root, 'nonce-target');
		fs.writeFileSync(target, 'a'.repeat(64));
		fs.symlinkSync(target, path.join(dir, 'nonce'));
		expect(sharedNonce()).toBeNull();
	});
});

describe.skipIf(process.platform === 'win32')('recordSharedTokenUse', () => {
	const now = 1_800_000_000_000;

	it('無効なら disabled を返す', () => {
		expect(recordSharedTokenUse('tok', now + 60_000, now)).toBe('disabled');
	});

	it('同じトークンは 2 回目に already_used になる（別プロセスからの使用も含む）', () => {
		enableSharedConfirmState(dir);
		expect(recordSharedTokenUse('tok-a', now + 60_000, now)).toBe('recorded');
		expect(recordSharedTokenUse('tok-a', now + 60_000, now + 1)).toBe('already_used');
		expect(recordSharedTokenUse('tok-b', now + 60_000, now + 2)).toBe('recorded');
	});

	it('ファイル名にトークンそのものを使わない', () => {
		enableSharedConfirmState(dir);
		recordSharedTokenUse('tok-secret-value', now + 60_000, now);
		const names = fs.readdirSync(path.join(dir, 'used'));
		expect(names).toHaveLength(1);
		expect(names[0]).not.toContain('tok-secret-value');
		expect(modeOf(path.join(dir, 'used', names[0] as string))).toBe(0o600);
	});

	it('書き込めなければ unavailable を返す（呼び出し側は実行を拒否する）', () => {
		enableSharedConfirmState(dir);
		fs.rmSync(path.join(dir, 'used'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'used'), 'not a dir');
		expect(recordSharedTokenUse('tok', now + 60_000, now)).toBe('unavailable');
	});

	it('書きかけ（中身が空）の印は掃除で消さず、同じトークンは already_used のまま', () => {
		enableSharedConfirmState(dir);
		const marker = path.join(dir, 'used', createHash('sha256').update('tok-racing').digest('hex'));
		fs.writeFileSync(marker, '', { mode: 0o600 });
		// 掃除は「中身を読めない印」を作られた時刻で判断するので、テストの時計に合わせる。
		fs.utimesSync(marker, now / 1000, now / 1000);
		expect(recordSharedTokenUse('tok-other', now + 60_000, now)).toBe('recorded');
		expect(fs.existsSync(marker)).toBe(true);
		expect(recordSharedTokenUse('tok-racing', now + 60_000, now)).toBe('already_used');
	});

	it('印は中身を書き終えてから used/ に現れる（書きかけを他プロセスに見せない）', () => {
		enableSharedConfirmState(dir);
		recordSharedTokenUse('tok-a', now + 60_000, now);
		const [name] = fs.readdirSync(path.join(dir, 'used'));
		expect(fs.readFileSync(path.join(dir, 'used', name as string), 'utf8')).toBe(String(now + 60_000));
		expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
	});

	it('中身を読めない印も、十分に古ければ掃除で消す', () => {
		enableSharedConfirmState(dir);
		const marker = path.join(dir, 'used', createHash('sha256').update('tok-stale').digest('hex'));
		fs.writeFileSync(marker, '', { mode: 0o600 });
		fs.utimesSync(marker, (now - 11 * 60_000) / 1000, (now - 11 * 60_000) / 1000);
		recordSharedTokenUse('tok-other', now + 60_000, now);
		expect(fs.existsSync(marker)).toBe(false);
	});

	it('期限を過ぎた印は、次に記録するときに消す', () => {
		enableSharedConfirmState(dir);
		recordSharedTokenUse('tok-old', now + 1_000, now);
		recordSharedTokenUse('tok-new', now + 200_000, now + 120_000);
		expect(fs.readdirSync(path.join(dir, 'used'))).toHaveLength(1);
	});
});

describe.skipIf(process.platform === 'win32')('writeSharedRecord / readSharedRecord / deleteSharedRecord', () => {
	it('書いた値を別のキーと混ぜずに読み戻し、消せる', () => {
		enableSharedConfirmState(dir);
		writeSharedRecord('snapshots', 'key-a', { a: 1 });
		writeSharedRecord('snapshots', 'key-b', { b: 2 });
		expect(readSharedRecord('snapshots', 'key-a')).toEqual({ a: 1 });
		expect(readSharedRecord('snapshots', 'key-b')).toEqual({ b: 2 });

		deleteSharedRecord('snapshots', 'key-a');
		expect(readSharedRecord('snapshots', 'key-a')).toBeNull();
		expect(readSharedRecord('snapshots', 'key-b')).toEqual({ b: 2 });
	});

	it('ファイルは自分だけが読めて、名前にキーそのものを使わない', () => {
		enableSharedConfirmState(dir);
		writeSharedRecord('snapshots', 'session\0ui://order/confirm.html', { a: 1 });
		const [name] = fs.readdirSync(path.join(dir, 'snapshots'));
		expect(name).not.toContain('order');
		expect(modeOf(path.join(dir, 'snapshots', name as string))).toBe(0o600);
	});

	it('無効なら書かず（true を返す）、読んでも null を返す', () => {
		expect(writeSharedRecord('snapshots', 'key', { a: 1 })).toBe(true);
		expect(readSharedRecord('snapshots', 'key')).toBeNull();
	});

	it('書けなければ false を返す', () => {
		enableSharedConfirmState(dir);
		expect(writeSharedRecord('snapshots', 'key', { a: 1 })).toBe(true);
		fs.rmSync(path.join(dir, 'snapshots'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'snapshots'), 'not a dir');
		expect(writeSharedRecord('snapshots', 'key', { a: 1 })).toBe(false);
	});

	it('壊れた JSON は null を返す', () => {
		enableSharedConfirmState(dir);
		writeSharedRecord('snapshots', 'key', { a: 1 });
		const [name] = fs.readdirSync(path.join(dir, 'snapshots'));
		fs.writeFileSync(path.join(dir, 'snapshots', name as string), '{broken');
		expect(readSharedRecord('snapshots', 'key')).toBeNull();
	});
});

describe.skipIf(process.platform === 'win32')('sweepSharedRecords', () => {
	it('判定に従って残す・消すを行い、壊れたファイルは消す', () => {
		enableSharedConfirmState(dir);
		writeSharedRecord('snapshots', 'keep', { v: 'keep' });
		writeSharedRecord('snapshots', 'remove', { v: 'remove' });
		writeSharedRecord('snapshots', 'broken', { v: 'broken' });
		const broken = fs.readdirSync(path.join(dir, 'snapshots')).find((n) => {
			const text = fs.readFileSync(path.join(dir, 'snapshots', n), 'utf8');
			return text.includes('broken');
		});
		fs.writeFileSync(path.join(dir, 'snapshots', broken as string), '{broken');

		sweepSharedRecords('snapshots', (value) => ((value as { v: string }).v === 'remove' ? 'remove' : 'keep'));

		expect(readSharedRecord('snapshots', 'keep')).toEqual({ v: 'keep' });
		expect(readSharedRecord('snapshots', 'remove')).toBeNull();
		expect(fs.readdirSync(path.join(dir, 'snapshots'))).toHaveLength(1);
	});

	it('無効なら何もしない', () => {
		expect(() => sweepSharedRecords('snapshots', () => 'remove')).not.toThrow();
	});
});

describe.skipIf(process.platform === 'win32')('updateSharedRecord', () => {
	it('今の中身から作った値で書き換え、undefined なら書き換えない', () => {
		enableSharedConfirmState(dir);
		writeSharedRecord('snapshots', 'key', { v: 1 });
		expect(updateSharedRecord('snapshots', 'key', (value) => ({ v: (value as { v: number }).v + 1 }))).toBe(true);
		expect(readSharedRecord('snapshots', 'key')).toEqual({ v: 2 });
		expect(updateSharedRecord('snapshots', 'key', () => undefined)).toBe(false);
		expect(readSharedRecord('snapshots', 'key')).toEqual({ v: 2 });
	});

	it('ファイルが無い・共有が無効なら何もしない', () => {
		expect(updateSharedRecord('snapshots', 'key', () => ({ v: 1 }))).toBe(false);
		enableSharedConfirmState(dir);
		expect(updateSharedRecord('snapshots', 'missing', () => ({ v: 1 }))).toBe(false);
		expect(readSharedRecord('snapshots', 'missing')).toBeNull();
	});
});
