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
 *     confirmation_token が strip 済みのため、structuredContent 経由で token は露出しない。
 *   - **`_meta` は別扱い**。MCP Apps 実行経路（ADR-0007）が有効な場合、`_meta` には
 *     confirmation_token が入りうる。これは push 配信（`ui/notifications/tool-result`）が
 *     効かないホストでも iframe がボタンを描画できるようにするため。したがって:
 *       - `_meta` の取得は `getUiSnapshotMeta` に分離し、トークンの有効期限
 *         （`metaExpiresAtMs`）を過ぎたら返さない（スナップショット TTL 5 分 >
 *         トークン TTL 60 秒なので、同じ期限では期限切れトークンを返し続けてしまう）
 *       - 呼び出し側（`get_ui_snapshot`）は返す前に有効化ゲートを必ず確認する
 *   - Map キーは `sessionId + resourceUri` 相当。別セッションが同一 URI を
 *     上書き・取得・削除できない（stdio では sessionId が undefined 同士で一致し、
 *     既存の単一接続挙動を維持する）。
 */

/** スナップショットの保持期間（ms）。確認フローの実用時間に合わせる。 */
const SNAPSHOT_TTL_MS = 5 * 60_000;

interface SnapshotEntry {
	structuredContent: Record<string, unknown>;
	storedAt: number;
	/**
	 * ツール結果レベルの `_meta`（確認トークンを含みうる）。
	 * push 配信が効かないホストでも iframe がボタンを描画できるよう保持する。
	 */
	meta?: Record<string, unknown>;
	/**
	 * `meta` に含まれる確認トークンの有効期限（unix ms）。
	 *
	 * スナップショットの保持期間（5 分）はトークン TTL（既定 60 秒）より長いため、
	 * `meta` をそのまま返し続けると**期限切れトークンを最大 4 分間返し続ける**ことになる。
	 * `validateToken` が弾くので実行はされないが、使えない bearer 値を取得可能な場所に
	 * 置いておく理由が無いので、この時刻を過ぎたら `meta` は返さない。
	 */
	metaExpiresAtMs?: number;
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

/**
 * ツール応答送出時に呼び、session 境界付きで最新スナップショットを保持する。
 *
 * @param meta - ツール結果レベルの `_meta`。確認トークンを含む場合は
 *   `metaExpiresAtMs` も渡し、期限後に返らないようにすること。
 * @param metaExpiresAtMs - `meta` を返してよい期限（unix ms）。未指定なら
 *   `meta` はスナップショット TTL の範囲で返る（トークンを含まない `_meta` 用）。
 */
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

/**
 * 有効期限内かつ同一セッション・同一 URI のスナップショットの `_meta` を返す。無ければ null。
 *
 * `getUiSnapshot` と分けているのは、`_meta`（＝確認トークンを含みうる）にだけ
 * **より短い期限**と呼び出し側のゲート判定を課すため。`structuredContent` は
 * プレビューの再描画に使うので期限切れ後も TTL 内は返し続ける。
 *
 * ⚠️ 呼び出し側は返す前に `isAppUiExecuteAllowed` を必ず確認すること。
 * 本関数はゲート判定を行わない（保持と配送の責務を分ける）。
 */
export function getUiSnapshotMeta(resourceUri: string, scope: SnapshotScope = {}): Record<string, unknown> | null {
	const key = uiSnapshotKey(scope.sessionId, resourceUri);
	const entry = snapshots.get(key);
	if (!entry?.meta) return null;
	const now = scope.nowMs ?? Date.now();
	// スナップショット自体の TTL 切れ。エントリの削除は getUiSnapshot 側に任せる
	// （ここで消すと preview の再描画まで巻き添えで死ぬ）。
	if (now - entry.storedAt > SNAPSHOT_TTL_MS) return null;
	// トークンの期限切れ。entry は消さず `_meta` だけ落とす。
	if (entry.metaExpiresAtMs != null && now > entry.metaExpiresAtMs) return null;
	return entry.meta;
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
