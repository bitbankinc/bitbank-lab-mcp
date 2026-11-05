export interface TtlCacheOptions {
	ttlMs: number;
	maxEntries?: number;
}

interface Entry<V> {
	value: V;
	ts: number;
}

export class TtlCache<V> {
	private readonly ttlMs: number;
	private readonly maxEntries: number;
	private readonly store = new Map<string, Entry<V>>();

	constructor(opts: TtlCacheOptions) {
		this.ttlMs = opts.ttlMs;
		this.maxEntries = opts.maxEntries ?? Infinity;
	}

	get(key: string): V | undefined {
		const entry = this.store.get(key);
		if (!entry) return undefined;
		if (Date.now() - entry.ts > this.ttlMs) {
			this.store.delete(key);
			return undefined;
		}
		return entry.value;
	}

	set(key: string, value: V): void {
		if (this.store.size >= this.maxEntries && !this.store.has(key)) {
			const oldest = this.store.keys().next().value;
			if (oldest != null) this.store.delete(oldest);
		}
		// Re-insert to refresh insertion order (relevant for FIFO eviction)
		this.store.delete(key);
		this.store.set(key, { value, ts: Date.now() });
	}

	has(key: string): boolean {
		return this.get(key) !== undefined;
	}

	delete(key: string): boolean {
		return this.store.delete(key);
	}

	clear(): void {
		this.store.clear();
	}

	get size(): number {
		return this.store.size;
	}
}
