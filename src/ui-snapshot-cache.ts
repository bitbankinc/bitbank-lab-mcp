/**
 * MCP Apps ウィジェット向けの直近ツール応答スナップショット。
 *
 * 一部ホスト（2026-07-28 ロールアウト後の Claude Desktop 等）で
 * `ui/notifications/tool-result` が iframe に配信されない事象が確認されている。
 * その場合でもウィジェットが自力で内容を復元（pull 型 hydration）できるよう、
 * `_meta.ui.resourceUri` を持つツールの直近の structuredContent を
 * `sessionId + resourceUri` 単位で保持し、`get_ui_snapshot` ツール経由で再提供する。
 *
 * セキュリティ境界:
 *   - ここで保持・返却するのは「ホストへ送信済みのツール応答」そのものであり、
 *     新たな情報露出は発生しない。preview 応答の structuredContent からは
 *     confirmation_token が strip 済みのため、スナップショット経由でも token は露出しない。
 *   - Map キーは `sessionId + resourceUri` 相当。別セッションが同一 URI を
 *     上書き・取得・削除できない（stdio では sessionId が undefined 同士で一致し、
 *     既存の単一接続挙動を維持する）。
 */

/** スナップショットの保持期間（ms）。確認フローの実用時間に合わせる。 */
const SNAPSHOT_TTL_MS = 5 * 60_000;

interface SnapshotEntry {
	structuredContent: Record<string, unknown>;
	storedAt: number;
}

export interface SnapshotScope {
	/** 呼び出し元接続のセッション ID（ToolHandlerExtra の sessionId） */
	sessionId?: string;
	/** 現在時刻（テスト用にオーバーライド可能） */
	nowMs?: number;
}

const snapshots = new Map<string, SnapshotEntry>();

/** sessionId + resourceUri を Map キーにする。秘密情報は含めない。 */
export function uiSnapshotKey(sessionId: string | undefined, resourceUri: string): string {
	return `${sessionId ?? ''}\0${resourceUri}`;
}

/** ツール応答送出時に呼び、session 境界付きで最新スナップショットを保持する。 */
export function storeUiSnapshot(
	resourceUri: string,
	structuredContent: Record<string, unknown>,
	scope: SnapshotScope = {},
): void {
	snapshots.set(uiSnapshotKey(scope.sessionId, resourceUri), {
		structuredContent,
		storedAt: scope.nowMs ?? Date.now(),
	});
}

/**
 * 有効期限内かつ同一セッション・同一 URI のスナップショットを返す。無ければ null。
 * キーに sessionId を含むため、別セッションのエントリとは独立。
 */
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

/**
 * 指定セッション・リソースのスナップショットを破棄する。
 * 取引実行（create_order / cancel_order(s)）の成功時に呼び、実行済み内容の
 * 「操作可能な確認カード」が再描画時に復元されて二重実行を誘発するのを防ぐ。
 * 別セッションの同一 URI エントリには触れない。
 */
export function clearUiSnapshot(resourceUri: string, scope: SnapshotScope = {}): void {
	snapshots.delete(uiSnapshotKey(scope.sessionId, resourceUri));
}

/** スナップショットをすべて破棄する（テスト用）。 */
export function _resetUiSnapshots(): void {
	snapshots.clear();
}
