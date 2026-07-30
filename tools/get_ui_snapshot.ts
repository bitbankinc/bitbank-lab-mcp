/**
 * get_ui_snapshot — MCP Apps ウィジェット向けの直近ツール応答スナップショット取得。
 *
 * 一部ホストで `ui/notifications/tool-result` が iframe に配信されない事象への
 * 自己復元（pull 型 hydration）用。ウィジェットは接続成立後、一定時間結果通知が
 * 届かない場合に本ツールを `app.callServerTool` で呼び、直近の preview 応答を
 * 取得して自力で描画する。
 *
 * 返す内容は「ホストへ送信済みのツール応答の structuredContent」そのものであり、
 * 新たな情報露出は無い（詳細は src/ui-snapshot-cache.ts のヘッダコメント参照）。
 */

import { fail } from '../lib/result.js';
import { GetUiSnapshotInputSchema } from '../src/schema/ui.js';
import type { ToolDefinition } from '../src/tool-definition.js';
import { getUiSnapshot } from '../src/ui-snapshot-cache.js';

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
		// スナップショットは保存元接続の sessionId にバインドされている。
		// 呼び出し元のセッションを渡し、別セッションからの読み出しを拒否する
		// （stdio では両者 undefined で一致し、挙動は変わらない）。
		const sessionId = (extra as { sessionId?: string } | undefined)?.sessionId;
		const snapshot = getUiSnapshot(resource_uri, { sessionId });
		if (!snapshot) {
			return fail('表示できるスナップショットがありません。preview ツールを再実行してください', 'snapshot_not_found');
		}
		return {
			content: [
				{
					type: 'text',
					text: 'MCP Apps ウィジェット向けスナップショット（直近の preview 応答の再送。内容は元の応答と同一）',
				},
			],
			structuredContent: snapshot,
		};
	},
};
