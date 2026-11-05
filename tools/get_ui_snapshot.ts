// _meta は確認トークンを含みうるので、有効化ゲートに加えて elicitation 非対応であることまで確認したときだけ返す（ADR-0007 判断事項 A）。
// 返すのはホストへ送信済みのツール応答そのもので、新たな情報露出は無い（src/ui-snapshot-cache.ts）。

import { fail } from '../lib/result.js';
import { clientSupportsElicitation, isAppUiExecuteAllowed } from '../src/private/elicitation.js';
import { GetUiSnapshotInputSchema } from '../src/schema/ui.js';
import type { ToolDefinition } from '../src/tool-definition.js';
import { getUiSnapshot, getUiSnapshotMeta } from '../src/ui-snapshot-cache.js';

export const toolDef: ToolDefinition = {
	name: 'get_ui_snapshot',
	description: [
		'[Internal / MCP Apps] 確認 UI（iframe）向けに、直近の preview 系ツール応答のスナップショットを返す。',
		'ホストがツール結果通知（ui/notifications/tool-result）を配信しない場合の UI 自己復元用。',
		'LLM が会話の応答生成のために呼ぶ必要はない（preview 系ツールの応答に同じ内容が含まれる）。',
	].join(' '),
	inputSchema: GetUiSnapshotInputSchema,
	handler: async (args, extra) => {
		const { resource_uri } = args as { resource_uri: string };
		// 呼び出し元のセッションを渡し、別セッションからの読み出しを拒否する（stdio では両者 undefined で一致する）。
		const sessionId = (extra as { sessionId?: string } | undefined)?.sessionId;
		const snapshot = getUiSnapshot(resource_uri, { sessionId });
		if (!snapshot) {
			return fail('表示できるスナップショットがありません。preview ツールを再実行してください', 'snapshot_not_found');
		}
		// preview 側と同じ条件で揃える。pull 型 hydration は preview と別リクエストなので、揃えないと elicitation 非宣言のリクエストで作ったトークン付きスナップショットを elicitation 宣言のリクエストが読み出し、不変条件 5 が破れる（ADR-0007）。
		const meta =
			isAppUiExecuteAllowed(extra) && !clientSupportsElicitation(extra)
				? getUiSnapshotMeta(resource_uri, { sessionId })
				: null;
		return {
			content: [
				{
					type: 'text',
					text: 'MCP Apps ウィジェット向けスナップショット（直近の preview 応答の再送。内容は元の応答と同一）',
				},
			],
			structuredContent: snapshot,
			...(meta ? { _meta: meta } : {}),
		};
	},
};
