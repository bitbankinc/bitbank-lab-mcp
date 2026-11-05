import type { McpResponse } from '../../src/tool-definition.js';

/** handler の戻り値は Result | McpResponse | InputRequiredResult の union で、InputRequiredResult が入っているので素の `as { structuredContent: ... }` は TS2352 になる。 */
export function asMcp<T = Record<string, unknown>>(
	r: unknown,
): Omit<McpResponse, 'structuredContent'> & { structuredContent: T } {
	return r as Omit<McpResponse, 'structuredContent'> & { structuredContent: T };
}
