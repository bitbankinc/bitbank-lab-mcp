// 一部ホストで ui/notifications/tool-result が iframe に配信されないので、get_ui_snapshot の pull 型 hydration 用に直近の応答を保持する。
// 保持するのはホストへ送信済みの応答だけだが、`_meta` は確認トークンを含みうるので getUiSnapshotMeta で別扱いにする。

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
	snapshots.set(uiSnapshotKey(scope.sessionId, resourceUri), {
		structuredContent,
		storedAt: scope.nowMs ?? Date.now(),
		...(meta ? { meta } : {}),
		...(metaExpiresAtMs != null ? { metaExpiresAtMs } : {}),
	});
}

/** `_meta` にだけ短い期限と呼び出し側のゲート判定を課すため `getUiSnapshot` と分けている。呼び出し側は返す前に `isAppUiExecuteAllowed` を必ず確認すること（ここではゲート判定をしない）。 */
export function getUiSnapshotMeta(resourceUri: string, scope: SnapshotScope = {}): Record<string, unknown> | null {
	const key = uiSnapshotKey(scope.sessionId, resourceUri);
	const entry = snapshots.get(key);
	if (!entry?.meta) return null;
	const now = scope.nowMs ?? Date.now();
	// エントリの削除は getUiSnapshot に任せる（ここで消すと preview の再描画まで巻き添えになる）。
	if (now - entry.storedAt > SNAPSHOT_TTL_MS) return null;
	// トークンの期限切れ。entry は消さず `_meta` だけ落とす。
	if (entry.metaExpiresAtMs != null && now > entry.metaExpiresAtMs) return null;
	return entry.meta;
}

export function getUiSnapshot(resourceUri: string, scope: SnapshotScope = {}): Record<string, unknown> | null {
	const key = uiSnapshotKey(scope.sessionId, resourceUri);
	const entry = snapshots.get(key);
	if (!entry) return null;
	if ((scope.nowMs ?? Date.now()) - entry.storedAt > SNAPSHOT_TTL_MS) {
		snapshots.delete(key);
		return null;
	}
	return entry.structuredContent;
}

export function clearUiSnapshot(resourceUri: string, scope: SnapshotScope = {}): void {
	snapshots.delete(uiSnapshotKey(scope.sessionId, resourceUri));
}

export function _resetUiSnapshots(): void {
	snapshots.clear();
}
