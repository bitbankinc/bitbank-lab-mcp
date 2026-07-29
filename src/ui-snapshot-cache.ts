/**
 * MCP Apps ウィジェット向けの直近ツール応答スナップショット。
 *
 * 一部ホスト（2026-07-28 ロールアウト後の Claude Desktop 等）で
 * `ui/notifications/tool-result` が iframe に配信されない事象が確認されている。
 * その場合でもウィジェットが自力で内容を復元（pull 型 hydration）できるよう、
 * `_meta.ui.resourceUri` を持つツールの直近の structuredContent を
 * resourceUri 単位で保持し、`get_ui_snapshot` ツール経由で再提供する。
 *
 * セキュリティ境界: ここで保持・返却するのは「ホストへ送信済みのツール応答」
 * そのものであり、新たな情報露出は発生しない（trust-host モードで token を含む
 * 場合も、ホストへ返した structuredContent と同一内容）。
 */

/** スナップショットの保持期間（ms）。確認フローの実用時間に合わせる。 */
const SNAPSHOT_TTL_MS = 5 * 60_000;

interface SnapshotEntry {
	structuredContent: Record<string, unknown>;
	storedAt: number;
}

const snapshots = new Map<string, SnapshotEntry>();

/** ツール応答送出時に呼び、resourceUri 単位で最新スナップショットを保持する。 */
export function storeUiSnapshot(
	resourceUri: string,
	structuredContent: Record<string, unknown>,
	nowMs: number = Date.now(),
): void {
	snapshots.set(resourceUri, { structuredContent, storedAt: nowMs });
}

/** 有効期限内のスナップショットを返す。無ければ null。 */
export function getUiSnapshot(resourceUri: string, nowMs: number = Date.now()): Record<string, unknown> | null {
	const entry = snapshots.get(resourceUri);
	if (!entry) return null;
	if (nowMs - entry.storedAt > SNAPSHOT_TTL_MS) {
		snapshots.delete(resourceUri);
		return null;
	}
	return entry.structuredContent;
}

/** スナップショットをすべて破棄する（テスト用）。 */
export function _resetUiSnapshots(): void {
	snapshots.clear();
}
