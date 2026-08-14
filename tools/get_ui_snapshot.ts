/**
 * get_ui_snapshot — MCP Apps ウィジェット向けの直近ツール応答スナップショット取得。
 *
 * 一部ホストで `ui/notifications/tool-result` が iframe に配信されない事象への
 * 自己復元（pull 型 hydration）用。ウィジェットは接続成立後、一定時間結果通知が
 * 届かない場合に本ツールを `app.callServerTool` で呼び、直近の preview 応答を
 * 取得して自力で描画する。
 *
 * 返す内容は「ホストへ送信済みのツール応答」そのものであり、新たな情報露出は無い
 * （詳細は src/ui-snapshot-cache.ts のヘッダコメント参照）。
 *
 * `_meta` については有効化ゲート（`isAppUiExecuteAllowed`）に加えて、**elicitation 非対応で
 * あること**まで確認した場合のみ返す。MCP Apps 実行経路が有効なとき、`_meta` には確認トークンが
 * 含まれうるため（push 配信が効かないホスト向けの pull 復元。ADR-0007 判断事項 A）。
 */

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
		// スナップショットは sessionId + resourceUri をキーに保持されている。
		// 呼び出し元のセッションを渡し、別セッションからの読み出しを拒否する
		// （stdio では両者 undefined で一致し、挙動は変わらない）。
		const sessionId = (extra as { sessionId?: string } | undefined)?.sessionId;
		const snapshot = getUiSnapshot(resource_uri, { sessionId });
		if (!snapshot) {
			return fail('表示できるスナップショットがありません。preview ツールを再実行してください', 'snapshot_not_found');
		}
		// `_meta` は確認トークンを含みうるため、**preview 側が実際にトークンを載せる条件と
		// 同じもの**を通した場合のみ返す。2 段ゲート（オプトイン AND MCP Apps UI 宣言 + MIME 型）
		// に加え、elicitation 非対応であることまで要求する。
		//
		// preview 側（`withElicitedConfirmation`）は「elicitation 非対応と判定したあとの
		// fallback 経路でのみ `_meta` を付ける」という**構造**で不変条件 5（elicitation を
		// 宣言したホストにはトークンを一切載せない。ADR-0007）を保証している。pull 型 hydration は
		// preview とは別リクエストなので同じ構造では守れず、ここで条件式として揃える必要がある。
		// 揃えないと「リクエスト A（elicitation 非宣言）で作られたトークン付きスナップショットを、
		// リクエスト B（elicitation 宣言）が読み出す」経路で不変条件 5 が破れる。
		//
		// ゲートが閉じていれば従来どおり structuredContent だけを返す（プレビューの再描画は生きる）。
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
