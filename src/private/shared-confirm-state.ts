// Claude Desktop はチャットのツール実行とカード（iframe）の要求を別々のサーバープロセスで受ける（ADR-0007 判断事項 D）。
// preview の控え・署名鍵に混ぜる乱数・使用済みトークンの印を、同じ OS ユーザーだけが読み書きできるフォルダで共有する。

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SharedRecordKind = 'snapshots';

const SUBDIRS = ['snapshots', 'used'] as const;

const NONCE_PATTERN = /^[0-9a-f]{64}$/;

const PURGE_INTERVAL_MS = 60_000;

// トークンの TTL の上限（confirmation.ts の MAX_TTL_MS）より長くしておく。中身を読めない印は、これより古いときだけ消す。
const UNREADABLE_MARKER_MAX_AGE_MS = 10 * 60_000;

let activeDir: string | null = null;
let configuredDir: string | undefined;
let lastPurgeMs: number | undefined;

/** 署名鍵の乱数はプロセスの中で一度決めたら変えない（途中で変わると発行済みのトークンが検証できなくなる）。 */
const SHARED_NONCE_KEY = Symbol.for('bitbank-lab-mcp.sharedConfirmState.nonce');

function defaultDir(): string {
	return path.join(os.homedir(), '.bitbank-lab-mcp', 'confirm');
}

function errorCode(err: unknown): string | undefined {
	return (err as { code?: unknown } | null)?.code as string | undefined;
}

function hashName(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

// Windows は mode を無視し、ACL を確かめる手段も入れていないので、本人だけに閉じられたと言えない。共有せずプロセス内の動きに戻す。
function isPrivateDir(p: string): boolean {
	if (process.platform === 'win32') return false;
	const st = fs.lstatSync(p);
	if (st.isSymbolicLink() || !st.isDirectory()) return false;
	if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
	if ((st.mode & 0o077) === 0) return true;
	fs.chmodSync(p, 0o700);
	return (fs.lstatSync(p).mode & 0o077) === 0;
}

function isOwnRegularFile(p: string): boolean {
	const st = fs.lstatSync(p);
	if (st.isSymbolicLink() || !st.isFile()) return false;
	return typeof process.getuid !== 'function' || st.uid === process.getuid();
}

export function enableSharedConfirmState(dir: string = configuredDir ?? defaultDir()): boolean {
	activeDir = null;
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		if (!isPrivateDir(dir)) return false;
		for (const sub of SUBDIRS) {
			const p = path.join(dir, sub);
			fs.mkdirSync(p, { recursive: true, mode: 0o700 });
			if (!isPrivateDir(p)) return false;
		}
	} catch {
		return false;
	}
	activeDir = dir;
	return true;
}

export function disableSharedConfirmState(): void {
	activeDir = null;
	lastPurgeMs = undefined;
}

export function isSharedConfirmStateEnabled(): boolean {
	return activeDir != null;
}

/** E2E がサーバーを起動する前に、ホームではなく一時フォルダを使わせるため。本番の場所は変えられない。 */
export function _setSharedConfirmStateDirForTests(dir: string | undefined): void {
	configuredDir = dir;
}

function readNonceFile(file: string): string | null {
	try {
		if (!isOwnRegularFile(file)) return null;
		const value = fs.readFileSync(file, 'utf8');
		return NONCE_PATTERN.test(value) ? value : null;
	} catch {
		return null;
	}
}

// 一時ファイルに書いてから link で置くので、別プロセスが書きかけ（空）の値を読むことがない。link は既にあれば EEXIST で失敗する。
function createNonceFile(file: string): void {
	const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
	fs.writeFileSync(tmp, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
	try {
		fs.linkSync(tmp, file);
	} catch (err) {
		if (errorCode(err) !== 'EEXIST') throw err;
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

export function sharedNonce(): string | null {
	if (activeDir == null) return null;
	const store = globalThis as unknown as Record<symbol, { dir: string; value: string | null } | undefined>;
	const cached = store[SHARED_NONCE_KEY];
	if (cached?.dir === activeDir) return cached.value;
	const file = path.join(activeDir, 'nonce');
	let value: string | null;
	try {
		if (!fs.existsSync(file)) createNonceFile(file);
		value = readNonceFile(file);
	} catch {
		value = null;
	}
	store[SHARED_NONCE_KEY] = { dir: activeDir, value };
	return value;
}

export function _forgetSharedNonce(): void {
	const store = globalThis as unknown as Record<symbol, unknown>;
	delete store[SHARED_NONCE_KEY];
}

function purgeUsedMarkers(dir: string, nowMs: number): void {
	if (lastPurgeMs != null && nowMs - lastPurgeMs < PURGE_INTERVAL_MS) return;
	lastPurgeMs = nowMs;
	const usedDir = path.join(dir, 'used');
	for (const name of fs.readdirSync(usedDir)) {
		const file = path.join(usedDir, name);
		try {
			const content = fs.readFileSync(file, 'utf8');
			const expiresAt = content === '' ? Number.NaN : Number(content);
			const expired = Number.isFinite(expiresAt)
				? nowMs > expiresAt
				: nowMs - fs.statSync(file).mtimeMs > UNREADABLE_MARKER_MAX_AGE_MS;
			if (expired) fs.rmSync(file, { force: true });
		} catch {
			// 別プロセスが同時に消した等。次の掃除で拾う。
		}
	}
}

export type SharedUseResult = 'recorded' | 'already_used' | 'unavailable' | 'disabled';

/** 排他作成（`wx`）で印を置くので、2 つのプロセスが同じトークンを同時に使っても片方しか recorded にならない。 */
export function recordSharedTokenUse(token: string, expiresAt: number, nowMs: number = Date.now()): SharedUseResult {
	if (activeDir == null) return 'disabled';
	try {
		purgeUsedMarkers(activeDir, nowMs);
	} catch {
		// 掃除の失敗で使用の記録まで止めない。
	}
	const name = hashName(token);
	// used/ の外で書き終えてから link で置く。中身の無い印を別プロセスの掃除が期限切れと見て消し、同じトークンが 2 回通るのを防ぐ。
	const staging = path.join(activeDir, `${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
	try {
		fs.writeFileSync(staging, String(expiresAt), { mode: 0o600, flag: 'wx' });
		fs.linkSync(staging, path.join(activeDir, 'used', name));
		return 'recorded';
	} catch (err) {
		return errorCode(err) === 'EEXIST' ? 'already_used' : 'unavailable';
	} finally {
		try {
			fs.rmSync(staging, { force: true });
		} catch {
			// 残っても used/ の外なので、使用済みの判定には影響しない。
		}
	}
}

function recordPath(kind: SharedRecordKind, key: string): string | null {
	return activeDir == null ? null : path.join(activeDir, kind, `${hashName(key)}.json`);
}

// 共有が無効なら書く必要が無いので true を返す。
export function writeSharedRecord(kind: SharedRecordKind, key: string, value: unknown): boolean {
	const file = recordPath(kind, key);
	return file == null ? true : writeFileAtomically(file, value);
}

// rename で置き換えるので、読む側が書きかけの JSON を見ることがない。
function writeFileAtomically(file: string, value: unknown): boolean {
	const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
		fs.renameSync(tmp, file);
		return true;
	} catch {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			// 書けない状態なら消せないこともある。読む側は .json しか見ない。
		}
		return false;
	}
}

export function readSharedRecord(kind: SharedRecordKind, key: string): unknown {
	const file = recordPath(kind, key);
	if (file == null) return null;
	try {
		if (!isOwnRegularFile(file)) return null;
		return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
	} catch {
		return null;
	}
}

export function deleteSharedRecord(kind: SharedRecordKind, key: string): void {
	const file = recordPath(kind, key);
	if (file == null) return;
	try {
		fs.rmSync(file, { force: true });
	} catch {
		// 消せなくても、読む側が期限と TTL で古い控えを捨てる。
	}
}

// 読んでから書き換えるまでに別プロセスが新しい内容を置いていたら（rename で i-node が変わる）、手を出さない。
// 残る隙は確認と rename の間だけで、そこで負けても失うのは新しい控え（カードにボタンが出ない）で、誤った発注にはならない。
function sameFile(file: string, ino: number): boolean {
	try {
		return fs.statSync(file).ino === ino;
	} catch {
		return false;
	}
}

export function updateSharedRecord(
	kind: SharedRecordKind,
	key: string,
	update: (value: unknown) => unknown | undefined,
): boolean {
	const file = recordPath(kind, key);
	if (file == null) return false;
	try {
		if (!isOwnRegularFile(file)) return false;
		const { ino } = fs.statSync(file);
		const next = update(JSON.parse(fs.readFileSync(file, 'utf8')));
		if (next === undefined || !sameFile(file, ino)) return false;
		return writeFileAtomically(file, next);
	} catch {
		return false;
	}
}

// ファイル名はキーのハッシュで元のキーに戻せないので、中身だけを見て判断させる。読めない・壊れたファイルは消す。
export function sweepSharedRecords(kind: SharedRecordKind, decide: (value: unknown) => 'keep' | 'remove'): void {
	if (activeDir == null) return;
	const dir = path.join(activeDir, kind);
	let names: string[];
	try {
		names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
	} catch {
		return;
	}
	for (const name of names) {
		const file = path.join(dir, name);
		try {
			if (!isOwnRegularFile(file)) continue;
			const { ino } = fs.statSync(file);
			let value: unknown;
			try {
				value = JSON.parse(fs.readFileSync(file, 'utf8'));
			} catch {
				value = undefined;
			}
			if ((value === undefined || decide(value) === 'remove') && sameFile(file, ino)) fs.rmSync(file, { force: true });
		} catch {
			// 別プロセスが同時に消した等。次の掃除で拾う。
		}
	}
}
