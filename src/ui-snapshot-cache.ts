// 一部ホストで ui/notifications/tool-result が iframe に配信されないので、get_ui_snapshot の pull 型 hydration 用に直近の応答を保持する。
// 保持するのはホストへ送信済みの応答だけだが、`_meta` は確認トークンを含みうるので getUiSnapshotMeta で別扱いにする。

import { log } from '../lib/logger.js';
import { readConfirmationMeta } from './mcp-apps-meta.js';
import {
	deleteSharedRecord,
	readSharedRecord,
	sweepSharedRecords,
	updateSharedRecord,
	writeSharedRecord,
} from './private/shared-confirm-state.js';

const SNAPSHOT_TTL_MS = 5 * 60_000;

interface SnapshotEntry {
	structuredContent: Record<string, unknown>;
	storedAt: number;
	meta?: Record<string, unknown>;
	/** スナップショットの保持期間はトークン TTL より長いので、この時刻を過ぎたら `meta` は返さない（使えない bearer 値を取得可能な場所に置かない）。 */
	metaExpiresAtMs?: number;
}

export interface SnapshotScope {
	sessionId?: string;
	nowMs?: number;
}

const snapshots = new Map<string, SnapshotEntry>();

/** 未設定の `sessionId` と空文字を同一キーに畳んでいる。HTTP トランスポートを足すと別クライアントが確認トークン入りの `_meta` を読み出せるので、同じ PR で「未設定は fail-closed」に変える（ADR-0007 判断事項 B、`tests/http-transport-tripwire.test.ts`）。 */
export function uiSnapshotKey(sessionId: string | undefined, resourceUri: string): string {
	return `${sessionId ?? ''}\0${resourceUri}`;
}

/** `meta` に確認トークンを含むときは `metaExpiresAtMs` も渡す（渡さないと `meta` はスナップショット TTL の間返り続ける）。 */
export function storeUiSnapshot(
	resourceUri: string,
	structuredContent: Record<string, unknown>,
	scope: SnapshotScope = {},
	meta?: Record<string, unknown>,
	metaExpiresAtMs?: number,
): void {
	const key = uiSnapshotKey(scope.sessionId, resourceUri);
	const entry: SnapshotEntry = {
		structuredContent,
		storedAt: scope.nowMs ?? Date.now(),
		...(meta ? { meta } : {}),
		...(metaExpiresAtMs != null ? { metaExpiresAtMs } : {}),
	};
	snapshots.set(key, entry);
	// 書けないと、カード側のプロセスは控えを読めずボタンが出ない（発注はされない側に倒れる）。原因を追えるよう記録だけ残す。
	if (!writeSharedRecord('snapshots', key, entry)) log('warn', { type: 'shared_snapshot_write_failed', resourceUri });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toSnapshotEntry(value: unknown): SnapshotEntry | undefined {
	if (!isRecord(value) || !isRecord(value.structuredContent) || typeof value.storedAt !== 'number') return undefined;
	if (value.meta !== undefined && !isRecord(value.meta)) return undefined;
	if (value.metaExpiresAtMs !== undefined && typeof value.metaExpiresAtMs !== 'number') return undefined;
	return value as unknown as SnapshotEntry;
}

function clearedAtOf(value: unknown): number | undefined {
	return isRecord(value) && typeof value.clearedAt === 'number' ? value.clearedAt : undefined;
}

// 共有が無効ならファイル側は常に null で、従来どおりメモリだけを見る。
function readEntry(key: string): SnapshotEntry | undefined {
	const memory = snapshots.get(key);
	const raw = readSharedRecord('snapshots', key);
	// 発注後に別プロセスが消した控えを、このプロセスのメモリから復元させない（カードにボタンが出直す）。
	const clearedAt = clearedAtOf(raw);
	if (clearedAt != null) {
		if (memory && memory.storedAt <= clearedAt) snapshots.delete(key);
		return memory && memory.storedAt > clearedAt ? memory : undefined;
	}
	const shared = toSnapshotEntry(raw);
	if (!shared) return memory;
	if (!memory) return shared;
	return shared.storedAt > memory.storedAt ? shared : memory;
}

/** `_meta` にだけ短い期限と呼び出し側のゲート判定を課すため `getUiSnapshot` と分けている。呼び出し側は返す前に `isAppUiExecuteAllowed` を必ず確認すること（ここではゲート判定をしない）。 */
function liveMeta(entry: SnapshotEntry, now: number): Record<string, unknown> | null {
	if (!entry.meta || now - entry.storedAt > SNAPSHOT_TTL_MS) return null;
	// トークンの期限切れ。entry は消さず `_meta` だけ落とす。
	if (entry.metaExpiresAtMs != null && now > entry.metaExpiresAtMs) return null;
	return entry.meta;
}

export function getUiSnapshotMeta(resourceUri: string, scope: SnapshotScope = {}): Record<string, unknown> | null {
	// エントリの削除は getUiSnapshot に任せる（ここで消すと preview の再描画まで巻き添えになる）。
	const entry = readEntry(uiSnapshotKey(scope.sessionId, resourceUri));
	return entry ? liveMeta(entry, scope.nowMs ?? Date.now()) : null;
}

function liveEntry(resourceUri: string, scope: SnapshotScope): SnapshotEntry | null {
	const key = uiSnapshotKey(scope.sessionId, resourceUri);
	const entry = readEntry(key);
	if (!entry) return null;
	if ((scope.nowMs ?? Date.now()) - entry.storedAt > SNAPSHOT_TTL_MS) {
		snapshots.delete(key);
		deleteSharedRecord('snapshots', key);
		return null;
	}
	return entry;
}

export function getUiSnapshot(resourceUri: string, scope: SnapshotScope = {}): Record<string, unknown> | null {
	return liveEntry(resourceUri, scope)?.structuredContent ?? null;
}

// 内容とトークンを同じ控えから返す。別々に読むと、その間に別プロセスが置いた新しい preview のトークンを古い内容に添えて返しうる。
export function getUiSnapshotWithMeta(
	resourceUri: string,
	scope: SnapshotScope = {},
): { structuredContent: Record<string, unknown>; meta: Record<string, unknown> | null } | null {
	const entry = liveEntry(resourceUri, scope);
	return entry
		? { structuredContent: entry.structuredContent, meta: liveMeta(entry, scope.nowMs ?? Date.now()) }
		: null;
}

export function clearUiSnapshot(resourceUri: string, scope: SnapshotScope = {}): void {
	const key = uiSnapshotKey(scope.sessionId, resourceUri);
	snapshots.delete(key);
	// ファイルを消すだけだと、控えをメモリに持つ別プロセスがそれを返し続けるので、消した時刻を残す。
	writeSharedRecord('snapshots', key, { clearedAt: scope.nowMs ?? Date.now() });
}

function withoutMeta(entry: SnapshotEntry): SnapshotEntry {
	const { meta: _meta, metaExpiresAtMs: _expires, ...rest } = entry;
	return rest;
}

// ファイルを読めるエージェントに残ったトークンを使わせないよう、カード側のプロセスに渡したらファイルから消す（ADR-0007 判断事項 D）。メモリは触らない。
// 渡したトークンと同じときだけ消す。読んだ後に新しい preview が置かれていたら、そのトークンは消さない。
export function forgetSharedUiSnapshotMeta(resourceUri: string, scope: SnapshotScope, deliveredToken: string): void {
	updateSharedRecord('snapshots', uiSnapshotKey(scope.sessionId, resourceUri), (value) => {
		const entry = toSnapshotEntry(value);
		const token = readConfirmationMeta(entry?.meta)?.confirmation_token;
		return entry && token === deliveredToken ? withoutMeta(entry) : undefined;
	});
}

// カードが一度も読まなかった控え（注文内容）をファイルに残し続けないための掃除。期限切れのトークンは検証で弾かれるので、控えごと TTL で消す。
export function sweepSharedUiSnapshots(nowMs: number = Date.now()): void {
	sweepSharedRecords('snapshots', (value) => {
		const clearedAt = clearedAtOf(value);
		if (clearedAt != null) return nowMs - clearedAt > SNAPSHOT_TTL_MS ? 'remove' : 'keep';
		const entry = toSnapshotEntry(value);
		return !entry || nowMs - entry.storedAt > SNAPSHOT_TTL_MS ? 'remove' : 'keep';
	});
}

const SWEEP_INTERVAL_MS = 30_000;
let sweepTimer: ReturnType<typeof setInterval> | undefined;

export function startSharedUiSnapshotSweep(): void {
	sweepSharedUiSnapshots();
	if (sweepTimer) return;
	sweepTimer = setInterval(() => sweepSharedUiSnapshots(), SWEEP_INTERVAL_MS);
	sweepTimer.unref?.();
}

export function stopSharedUiSnapshotSweep(): void {
	if (sweepTimer) clearInterval(sweepTimer);
	sweepTimer = undefined;
}

export function _resetUiSnapshots(): void {
	snapshots.clear();
}
