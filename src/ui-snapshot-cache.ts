/**
 * MCP Apps ウィジェット向けの直近ツール応答スナップショット。
 *
 * 一部ホスト（2026-07-28 ロールアウト後の Claude Desktop 等）で
 * `ui/notifications/tool-result` が iframe に配信されない事象が確認されている。
 * その場合でもウィジェットが自力で内容を復元（pull 型 hydration）できるよう、
 * `_meta.ui.resourceUri` を持つツールの直近の structuredContent を
 * resourceUri 単位で保持し、`get_ui_snapshot` ツール経由で再提供する。
 *
 * セキュリティ境界:
 *   - ここで保持・返却するのは「ホストへ送信済みのツール応答」そのものであり、
 *     新たな情報露出は発生しない。preview 応答の structuredContent からは
 *     confirmation_token が strip 済みのため、スナップショット経由でも token は露出しない。
 *   - stdio デプロイではプロセス = 単一接続のため接続間の境界は存在しないが、
 *     将来のセッションを持つトランスポート追加に備え、エントリは保存時の
 *     sessionId にバインドし、取得時に一致を要求する（別セッションのスナップ
 *     ショット読み出し = IDOR を構造的に防ぐ）。stdio では sessionId は
 *     保存・取得とも undefined で一致し、挙動は変わらない。
 */

/** スナップショットの保持期間（ms）。確認フローの実用時間に合わせる。 */
const SNAPSHOT_TTL_MS = 5 * 60_000;

interface SnapshotEntry {
	structuredContent: Record<string, unknown>;
	storedAt: number;
	/** 保存元接続のセッション ID。セッションレス（stdio）では undefined。 */
	sessionId: string | undefined;
}

interface SnapshotScope {
	/** 呼び出し元接続のセッション ID（ToolHandlerExtra の sessionId） */
	sessionId?: string;
	/** 現在時刻（テスト用にオーバーライド可能） */
	nowMs?: number;
}

const snapshots = new Map<string, SnapshotEntry>();

/** ツール応答送出時に呼び、resourceUri 単位で最新スナップショットを保持する。 */
export function storeUiSnapshot(
	resourceUri: string,
	structuredContent: Record<string, unknown>,
	scope: SnapshotScope = {},
): void {
	snapshots.set(resourceUri, {
		structuredContent,
		storedAt: scope.nowMs ?? Date.now(),
		sessionId: scope.sessionId,
	});
}

/**
 * 有効期限内かつ同一セッションのスナップショットを返す。無ければ null。
 * 保存時と異なるセッションからの取得は拒否する（stdio では両者 undefined で一致）。
 */
export function getUiSnapshot(resourceUri: string, scope: SnapshotScope = {}): Record<string, unknown> | null {
	const entry = snapshots.get(resourceUri);
	if (!entry) return null;
	if ((scope.nowMs ?? Date.now()) - entry.storedAt > SNAPSHOT_TTL_MS) {
		snapshots.delete(resourceUri);
		return null;
	}
	if (entry.sessionId !== scope.sessionId) return null;
	return entry.structuredContent;
}

/**
 * 指定リソースのスナップショットを破棄する。
 * 取引実行（create_order / cancel_order(s)）の成功時に呼び、実行済み内容の
 * 「操作可能な確認カード」が再描画時に復元されて二重実行を誘発するのを防ぐ。
 */
export function clearUiSnapshot(resourceUri: string): void {
	snapshots.delete(resourceUri);
}

/** スナップショットをすべて破棄する（テスト用）。 */
export function _resetUiSnapshots(): void {
	snapshots.clear();
}
