// 研究用の起動口（ADR-0008）。npm の配布物には入らない。
import '../src/env.js'; // 最初に読む（src/server.ts と同じ順）。lib/logger.ts などがモジュール評価時に環境変数を読むため
import { runLab } from './main.js';

const code = await runLab({
	argv: process.argv.slice(2),
	writeStderr: (message) => {
		process.stderr.write(message);
	},
	// 静的 import にすると、差し替えより先にサーバーが起動する。必ず動的 import にする
	startServer: () => import('../src/server.js'),
});
// process.exit() は使わない。パイプへの stderr 書き込みが非同期の環境（macOS）で、メッセージが切れうるため（失敗時はサーバーを読み込んでいないので、イベントループが空になって自然に終わる）。
if (code !== 0) process.exitCode = code;
