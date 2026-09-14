import type { McpResponse } from '../../src/tool-definition.js';

/**
 * handler の戻り値（Result | McpResponse | InputRequiredResult union）を
 * McpResponse として扱うためのテスト用ヘルパ。
 * union に InputRequiredResult が入っているため素の
 * `as { structuredContent: ... }` は TS2352 になる。
 */
export function asMcp<T = Record<string, unknown>>(
	r: unknown,
): Omit<McpResponse, 'structuredContent'> & { structuredContent: T } {
	return r as Omit<McpResponse, 'structuredContent'> & { structuredContent: T };
}
