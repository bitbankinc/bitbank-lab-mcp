import { z } from 'zod';

/** `src/resources/app-resources.ts` の appResourceRegistry と一致させる（ドリフトは tests/get_ui_snapshot.test.ts で検出する）。 */
export const UI_SNAPSHOT_RESOURCE_URIS = ['ui://order/confirm.html', 'ui://cancel/confirm.html'] as const;

export const GetUiSnapshotInputSchema = z.object({
	resource_uri: z
		.enum(UI_SNAPSHOT_RESOURCE_URIS)
		.describe('スナップショットを取得する MCP Apps リソース URI（ウィジェット自身の URI を指定する）'),
});
