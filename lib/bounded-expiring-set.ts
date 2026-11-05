// 生存エントリを追い出さない。容量のために未期限切れを退避すると token / nonce が未使用に巻き戻り replay が通るので、空きが作れなければ add を失敗させる（fail-closed）。
// key は保持するだけでどこにも出力しない（token / nonce は sensitive-data の CRITICAL）。呼び出し側も stats() の件数だけをログに出す。

// TTL 最長 300 秒 × 想定ピーク 20 件/秒 = 6,000 件を切り上げた値（1 件約 200B で約 2MB）。
export const DEFAULT_MAX_ENTRIES = 10_000;

export const MAX_ENTRIES_CEILING = 100_000;

/** 既定の定期 purge 間隔: 60秒（`src/private/confirmation.ts` の `CLEANUP_INTERVAL_MS` と揃える） */
export const DEFAULT_PURGE_INTERVAL_MS = 60_000;

export const MAX_ENTRIES_ENV = 'REPLAY_GUARD_MAX_ENTRIES';

export type AddRejectReason = 'already_recorded' | 'capacity_exceeded' | 'invalid_expiry';

// 判別可能ユニオンにして、added で絞り込まないと reason を読めないようにしている（呼び出し側が黙って握り潰せない）。
export type AddResult = { readonly added: true } | { readonly added: false; readonly reason: AddRejectReason };

export interface BoundedExpiringSetStats {
	size: number;
	maxEntries: number;
	purgedTotal: number;
	rejectedTotal: number;
	invalidExpiryTotal: number;
}

export interface BoundedExpiringSetOptions {
	maxEntries?: number;
	purgeIntervalMs?: number;
}

/** 非有限値・1 未満はデフォルトへ、上限超過は clamp（`getTtlMs` と同じ扱い） */
function normalizeMaxEntries(value: number | undefined): number {
	if (value == null || !Number.isFinite(value) || value < 1) return DEFAULT_MAX_ENTRIES;
	return Math.min(Math.floor(value), MAX_ENTRIES_CEILING);
}

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

// nowMs が非有限だと期限比較が全て false になり replay が黙って通るので、劣化させず TypeError を投げる（メッセージに key は含めない）。
function assertFiniteNow(nowMs: number, method: string): void {
	if (!Number.isFinite(nowMs)) {
		throw new TypeError(`BoundedExpiringSet.${method}: nowMs must be a finite number`);
	}
}

export class BoundedExpiringSet {
	// 挿入順 = 期限順（TTL 一定のとき）を使って通常は先頭だけを走査し、容量到達時のみ全走査にフォールバックする。
	private readonly store = new Map<string, number>();

	private readonly maxEntriesValue: number;
	private readonly purgeIntervalMs: number;
	private cleanupTimerId: ReturnType<typeof setInterval> | null = null;
	private purgedTotal = 0;
	private rejectedTotal = 0;
	private invalidExpiryTotal = 0;

	constructor(opts: BoundedExpiringSetOptions = {}) {
		this.maxEntriesValue = normalizeMaxEntries(opts.maxEntries ?? envMaxEntries());
		this.purgeIntervalMs = normalizePurgeInterval(opts.purgeIntervalMs);
	}

	get maxEntries(): number {
		return this.maxEntriesValue;
	}

	// added === false なら理由を問わず操作を拒否させる。TTL の上限クランプは呼び出し側の責務で、ここでは長さを見ない。
	add(key: string, expiresAtMs: number, nowMs: number = Date.now()): AddResult {
		assertFiniteNow(nowMs, 'add');

		// 非有限の expiresAt は状態を触る前に弾く。NaN は経路ごとに生存 / 期限切れの判定が食い違い、Infinity は容量を専有して先頭走査を止める。
		if (!Number.isFinite(expiresAtMs)) {
			this.invalidExpiryTotal++;
			return { added: false, reason: 'invalid_expiry' };
		}

		// 先頭が生存していれば比較 1 回で抜けるので、エントリ数に比例した CPU 消費を避けられる。
		this.purgeExpiredPrefix(nowMs);

		const existing = this.store.get(key);
		if (existing != null) {
			if (nowMs <= existing) return { added: false, reason: 'already_recorded' };
			// 期限切れの残骸。ワンタイム性は TTL 内でのみ保証するので、消して再記録を許す。
			this.store.delete(key);
			this.purgedTotal++;
		}

		if (this.store.size >= this.maxEntriesValue) {
			this.purgeExpired(nowMs);
			if (this.store.size >= this.maxEntriesValue) {
				this.rejectedTotal++;
				return { added: false, reason: 'capacity_exceeded' };
			}
		}

		this.store.set(key, expiresAtMs);
		return { added: true };
	}

	has(key: string, nowMs: number = Date.now()): boolean {
		assertFiniteNow(nowMs, 'has');
		const expiresAt = this.store.get(key);
		if (expiresAt == null) return false;
		if (nowMs > expiresAt) {
			this.store.delete(key);
			this.purgedTotal++;
			return false;
		}
		return true;
	}

	purgeExpired(nowMs: number = Date.now()): number {
		assertFiniteNow(nowMs, 'purgeExpired');
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

	// 事前条件: nowMs が有限（呼び出し元の add が検証済み）。
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

	size(): number {
		return this.store.size;
	}

	clear(): void {
		this.store.clear();
	}

	stats(): BoundedExpiringSetStats {
		return {
			size: this.store.size,
			maxEntries: this.maxEntriesValue,
			purgedTotal: this.purgedTotal,
			rejectedTotal: this.rejectedTotal,
			invalidExpiryTotal: this.invalidExpiryTotal,
		};
	}

	// アクセス時 purge だけだと無アクセス期間のエントリが TTL 超過後も残り続ける。
	startCleanupTimer(): void {
		if (this.cleanupTimerId != null) return;
		this.cleanupTimerId = setInterval(() => this.purgeExpired(), this.purgeIntervalMs);
		// プロセス終了をブロックしないよう unref（stdio サーバー / テストの終了を妨げない）
		if (typeof this.cleanupTimerId === 'object' && 'unref' in this.cleanupTimerId) {
			this.cleanupTimerId.unref();
		}
	}

	stopCleanupTimer(): void {
		if (this.cleanupTimerId != null) {
			clearInterval(this.cleanupTimerId);
			this.cleanupTimerId = null;
		}
	}

	isCleanupTimerActive(): boolean {
		return this.cleanupTimerId != null;
	}
}
