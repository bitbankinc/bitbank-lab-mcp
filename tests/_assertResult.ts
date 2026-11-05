import { expect } from 'vitest';
import type { FailResult } from '../src/schema/types.js';

// biome-ignore lint/suspicious/noExplicitAny: テスト専用 — deep property access を許容する
type AnyRecord = Record<string, any>;

export function assertOk<T>(
	res: T,
): asserts res is T & { ok: true; summary: string; data: AnyRecord; meta: AnyRecord } {
	expect((res as { ok?: boolean }).ok).toBe(true);
}

export function assertFail<T>(res: T): asserts res is T & FailResult<AnyRecord> {
	expect((res as { ok?: boolean }).ok).toBe(false);
}

export function asMockResult<T>(value: unknown): T {
	return value as T;
}
