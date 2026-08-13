/**
 * TTL + 件数上限つきの「使用済み記録」セット（replay ガード用の共通データ構造）。
 *
 * 使用済みの confirmation token（`src/private/confirmation.ts`）や requestState の nonce
 * （`src/private/request-state.ts`）のように、**一度使ったキーを TTL の間だけ覚えておき、
 * 再提示を拒否する**用途のために切り出したもの。
 *
 * 設計上の最重要ルール — **生存エントリを追い出さない**:
 *   容量を空けるために未期限切れのエントリを LRU 等で退避すると、その token / nonce は
 *   「未使用」状態に巻き戻り、replay が黙って通る。メモリ上限のためにワンタイム性を
 *   犠牲にしてはいけないので、容量到達時は
 *     1. 期限切れエントリを purge する（古い＝挿入順の先頭側から）
 *     2. それでも空きが無ければ `add` を失敗させる
 *   の順で処理し、呼び出し側に実行を拒否させる（fail-closed）。
 *
 * ワンタイム性の保証範囲:
 *   保証されるのは `expiresAtMs` までの間だけ。期限切れ後は記録が消えるため、
 *   同じキーを再び `add` できる。呼び出し側は「記録の有無」とは別に、token / nonce 自身の
 *   有効期限も必ず検証すること（`validateToken` が期限チェックを先に行うのと同じ理由）。
 *
 * ログ:
 *   このモジュールは key の本文を保持するだけで、**どこにも出力しない**。
 *   token / nonce は `.claude/rules/sensitive-data.md` の CRITICAL 分類にあたるため、
 *   呼び出し側もログには `stats()` が返す件数系のメタ情報のみを記録すること。
 *
 * 使い方:
 *   const used = new BoundedExpiringSet();
 *   used.startCleanupTimer();
 *   const res = used.add(token, expiresAt);
 *   if (!res.added) return reject(res.reason);
 */

/**
 * 記録件数の既定上限。
 *
 * 算出根拠 — TTL × 想定ピークレート:
 *   - 保持期間: 最長 300 秒。confirmation token は既定 60 秒（`ORDER_CONFIRM_TTL_MS`）で
 *     上限 300 秒（`MAX_TTL_MS`）、requestState の nonce は 300 秒（`REQUEST_STATE_TTL_SECONDS`）。
 *   - 想定ピーク確認レート: 20 件/秒。HITL 確認は人手起点なので実運用では 1 件/秒にも届かないが、
 *     自動化クライアントの連投を見込んで 20 倍のマージンを取る。
 *   → 300 秒 × 20 件/秒 = 6,000 件。切り上げて 10,000 件。
 *
 * メモリ概算 — 1 エントリあたり:
 *   - key: HMAC-SHA256 の hex = 64 文字 ≈ 64B + 文字列ヘッダ ≈ 24B → 約 88B
 *     （nonce は 32 文字なので約半分。長い方に合わせて見積もる）
 *   - value: expiresAt。ms epoch は Smi 範囲外なので heap number 扱い → 約 16B
 *   - Map のエントリ配列 + ハッシュ表（負荷率の余白込み） → 約 96B
 *   → 合計 約 200B/件。10,000 件で 約 2MB。`MAX_ENTRIES_CEILING` の 100,000 件でも 約 20MB。
 */
export const DEFAULT_MAX_ENTRIES = 10_000;

/**
 * 上限値の clamp 先（≈20MB 相当）。
 * 環境変数やコンストラクタ引数でこれを超える値を渡してもここで頭打ちにする。
 */
export const MAX_ENTRIES_CEILING = 100_000;

/** 既定の定期 purge 間隔: 60秒（`src/private/confirmation.ts` の `CLEANUP_INTERVAL_MS` と揃える） */
export const DEFAULT_PURGE_INTERVAL_MS = 60_000;

/** 件数上限を上書きする環境変数名。不正値は `DEFAULT_MAX_ENTRIES` にフォールバックする。 */
export const MAX_ENTRIES_ENV = 'REPLAY_GUARD_MAX_ENTRIES';

/** `add` が失敗した理由 */
export type AddRejectReason =
	/** 同じ key が生存中の記録として既に存在する（= replay） */
	| 'already_recorded'
	/** 件数上限に達しており、期限切れを purge しても空きを作れなかった */
	| 'capacity_exceeded';

/**
 * `add` の結果。
 *
 * 判別可能ユニオンにしてあるので、`reason` を読むには必ず `added` で絞り込む必要がある。
 * `if (!res.added)` を書かずに理由を参照することはできない（呼び出し側が黙って握り潰せない）。
 */
export type AddResult = { readonly added: true } | { readonly added: false; readonly reason: AddRejectReason };

/** 観測用カウンタ。key の本文は一切含まない。 */
export interface BoundedExpiringSetStats {
	/** 現在の記録件数（期限切れが残っている場合は含む） */
	size: number;
	/** 有効な件数上限（clamp 適用後） */
	maxEntries: number;
	/** 除去した期限切れエントリの累計 */
	purgedTotal: number;
	/** 容量超過で拒否した `add` の累計 */
	rejectedTotal: number;
}

export interface BoundedExpiringSetOptions {
	/**
	 * 件数上限。省略時は環境変数 `REPLAY_GUARD_MAX_ENTRIES`、それも無ければ `DEFAULT_MAX_ENTRIES`。
	 * 非有限値・1 未満はデフォルトへフォールバックし、`MAX_ENTRIES_CEILING` で clamp する。
	 */
	maxEntries?: number;
	/** 定期 purge の間隔（ms）。非有限値・0 以下はデフォルトへフォールバック。 */
	purgeIntervalMs?: number;
}

/** 非有限値・1 未満はデフォルトへ、上限超過は clamp（`getTtlMs` と同じ扱い） */
function normalizeMaxEntries(value: number | undefined): number {
	if (value == null || !Number.isFinite(value) || value < 1) return DEFAULT_MAX_ENTRIES;
	return Math.min(Math.floor(value), MAX_ENTRIES_CEILING);
}

/** 環境変数の生値を数値化する。未設定・空文字は undefined（＝デフォルト採用） */
function envMaxEntries(): number | undefined {
	const raw = process.env[MAX_ENTRIES_ENV];
	if (!raw) return undefined;
	// NaN もここを通すが normalizeMaxEntries がデフォルトへ落とす
	return Number(raw);
}

function normalizePurgeInterval(value: number | undefined): number {
	if (value == null || !Number.isFinite(value) || value <= 0) return DEFAULT_PURGE_INTERVAL_MS;
	return value;
}

export class BoundedExpiringSet {
	/**
	 * key → expiresAt(ms)。
	 *
	 * Map は挿入順を保持するので、**TTL が呼び出し間で一定であれば挿入順 = 期限順**になる。
	 * この性質を使って通常経路では先頭側だけを走査し（`purgeExpiredPrefix`）、最初に
	 * 生存エントリへ当たった時点で打ち切る。TTL が不揃いな呼び出し方をされると先頭走査では
	 * 取りこぼすため、容量到達時のみ全走査（`purgeExpired`）にフォールバックする。
	 */
	private readonly store = new Map<string, number>();

	private readonly maxEntriesValue: number;
	private readonly purgeIntervalMs: number;
	private cleanupTimerId: ReturnType<typeof setInterval> | null = null;
	private purgedTotal = 0;
	private rejectedTotal = 0;

	constructor(opts: BoundedExpiringSetOptions = {}) {
		this.maxEntriesValue = normalizeMaxEntries(opts.maxEntries ?? envMaxEntries());
		this.purgeIntervalMs = normalizePurgeInterval(opts.purgeIntervalMs);
	}

	/** 有効な件数上限（clamp 適用後） */
	get maxEntries(): number {
		return this.maxEntriesValue;
	}

	/**
	 * key を使用済みとして記録する。
	 *
	 * - 未記録（または記録が期限切れ）かつ空きがある → `{ added: true }`
	 * - 生存中の記録が既にある → `{ added: false, reason: 'already_recorded' }`（replay）
	 * - 期限切れを purge しても空きが作れない → `{ added: false, reason: 'capacity_exceeded' }`
	 *
	 * 容量を空けるために生存エントリを追い出すことはない。呼び出し側は
	 * `added === false` の場合、理由を問わず対象の操作を拒否すること。
	 *
	 * @param key - 記録するキー（token / nonce 等）。ログには出さない。
	 * @param expiresAtMs - 記録の有効期限（epoch ms）。過去を渡した場合は直後に期限切れ扱いになる。
	 * @param nowMs - 現在時刻（テスト用にオーバーライド可能）
	 */
	add(key: string, expiresAtMs: number, nowMs: number = Date.now()): AddResult {
		// 通常経路の掃除。先頭が生存していれば比較 1 回で抜けるので、
		// エントリ数に比例した CPU 消費（= CPU 側の攻撃面）を避けられる。
		this.purgeExpiredPrefix(nowMs);

		const existing = this.store.get(key);
		if (existing != null) {
			if (nowMs <= existing) return { added: false, reason: 'already_recorded' };
			// 期限切れの残骸。ワンタイム性は TTL 内でのみ保証するので、消して再記録を許す。
			this.store.delete(key);
			this.purgedTotal++;
		}

		if (this.store.size >= this.maxEntriesValue) {
			// 先頭走査で足りなかった（TTL が不揃い等）→ 全走査で最後の空きを探す
			this.purgeExpired(nowMs);
			if (this.store.size >= this.maxEntriesValue) {
				// 生存エントリの追い出しはしない。ここで失敗させ、呼び出し側に拒否させる。
				this.rejectedTotal++;
				return { added: false, reason: 'capacity_exceeded' };
			}
		}

		this.store.set(key, expiresAtMs);
		return { added: true };
	}

	/**
	 * key が生存中の記録として存在するか。期限切れは「存在しない」として扱い、
	 * 該当エントリはこの場で除去する（アクセス時 purge、O(1)）。
	 */
	has(key: string, nowMs: number = Date.now()): boolean {
		const expiresAt = this.store.get(key);
		if (expiresAt == null) return false;
		if (nowMs > expiresAt) {
			this.store.delete(key);
			this.purgedTotal++;
			return false;
		}
		return true;
	}

	/** 期限切れエントリを全走査で除去し、除去件数を返す。 */
	purgeExpired(nowMs: number = Date.now()): number {
		let purged = 0;
		for (const [key, expiresAt] of this.store) {
			if (nowMs > expiresAt) {
				this.store.delete(key);
				purged++;
			}
		}
		this.purgedTotal += purged;
		return purged;
	}

	/**
	 * 挿入順の先頭側から期限切れを除去し、最初の生存エントリで打ち切る。
	 * TTL が一定という前提の下では全期限切れを除去できる（前提が崩れた場合の
	 * 取りこぼしは `add` の容量到達時に `purgeExpired` がカバーする）。
	 */
	private purgeExpiredPrefix(nowMs: number): number {
		let purged = 0;
		for (const [key, expiresAt] of this.store) {
			// 先頭が生存 → 以降も生存（TTL 一定前提）
			if (nowMs <= expiresAt) break;
			this.store.delete(key);
			purged++;
		}
		this.purgedTotal += purged;
		return purged;
	}

	/** 現在の記録件数（期限切れが残っている場合は含む） */
	size(): number {
		return this.store.size;
	}

	/** 全記録を破棄する（テスト用 / プロセス内リセット用）。累計カウンタは保持する。 */
	clear(): void {
		this.store.clear();
	}

	/** 観測用カウンタのスナップショット。key の本文は含まない。 */
	stats(): BoundedExpiringSetStats {
		return {
			size: this.store.size,
			maxEntries: this.maxEntriesValue,
			purgedTotal: this.purgedTotal,
			rejectedTotal: this.rejectedTotal,
		};
	}

	/**
	 * 定期 purge を開始する（重複起動しない）。
	 * アクセス時 purge だけに頼ると、無アクセス期間のエントリが TTL 超過後も残り続ける。
	 */
	startCleanupTimer(): void {
		if (this.cleanupTimerId != null) return;
		this.cleanupTimerId = setInterval(() => this.purgeExpired(), this.purgeIntervalMs);
		// プロセス終了をブロックしないよう unref（stdio サーバー / テストの終了を妨げない）
		if (typeof this.cleanupTimerId === 'object' && 'unref' in this.cleanupTimerId) {
			this.cleanupTimerId.unref();
		}
	}

	/** 定期 purge を停止する（複数回呼んでも安全）。 */
	stopCleanupTimer(): void {
		if (this.cleanupTimerId != null) {
			clearInterval(this.cleanupTimerId);
			this.cleanupTimerId = null;
		}
	}

	/** 定期 purge タイマーが稼働中かどうか。 */
	isCleanupTimerActive(): boolean {
		return this.cleanupTimerId != null;
	}
}
