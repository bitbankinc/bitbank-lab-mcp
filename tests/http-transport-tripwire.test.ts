// ADR-0007 判断事項 B の強制。`confirmation_token` の session / principal 束縛は HTTP トランスポート追加時の必須前提だが、ADR の散文は CI で落ちないので、stdio 以外のトランスポート追加をここで機械的に検知する。
// HMAC ペイロードは `action + params + expiresAt` だけで session も principal も含まず（署名鍵の per-process nonce はプロセス境界を閉じるだけで、HTTP では 1 プロセスに複数セッションが同居する）、UI スナップショットのキー（`src/ui-snapshot-cache.ts`）と MRTR の bind（`src/private/request-state.ts`）も未設定の sessionId を空文字に畳むので、HTTP を足した瞬間にクライアント A の preview で発行したトークンをクライアント B が execute に使えるようになる。
// 厳密な証明ではなく tripwire（`*ServerTransport` の命名を外れた独自クラスや別モジュール経由の接続は検知できない）。検知を実際のインスタンス化と import 文に限るのは、`server.ts` のコメントに「HTTP を足すときは…」と書いただけで落ちる誤検知の tripwire は最初に消されるため。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_SOURCE = fs.readFileSync(path.join(PACKAGE_ROOT, 'src', 'server.ts'), 'utf8');

/** 検知したときに出す手順。ADR を読み直さなくても次の一手が分かるようにする。 */
const REQUIREMENT = [
	'',
	'src/server.ts に stdio 以外のトランスポートが追加されています。',
	'',
	'ADR-0007「判断事項 B」により、この変更は **同じ PR で** 次を実装しない限り入れられません:',
	'',
	'  (a) confirmation_token の HMAC に session / principal を含める',
	'      現状 src/private/confirmation.ts の payload は action + params + expiresAt のみ。',
	'      署名鍵の per-process nonce は session 束縛ではない（HTTP では 1 プロセスに複数セッションが同居する）。',
	'      束縛が無いと、別クライアントが持ち出したトークンでも validateToken を通ります。',
	'',
	'  (b) 未設定の sessionId を空文字に畳まない（未設定は fail-closed）',
	'      src/ui-snapshot-cache.ts の uiSnapshotKey と',
	"      src/private/request-state.ts の bindRequestStateContext が `?? ''` しています。",
	'      畳んだままだと別セッションが同一キーのスナップショットを読み出せます。',
	'      ただし stdio では sessionId が無いのが正常なので、無条件 fail-closed にはできません。',
	'      「HTTP トランスポートが有効なときだけ未設定を拒否する」条件付きにしてください。',
	'',
	'実装したうえで、本テストの許可リストを更新してください。',
	'',
].join('\n');

describe('トランスポート追加の tripwire（ADR-0007 判断事項 B）', () => {
	// `new` を伴う実際のインスタンス化だけを見る（コメントや文字列中の言及では落とさない）。
	it('src/server.ts がインスタンス化するトランスポートは StdioServerTransport だけ', () => {
		const transports = [...SERVER_SOURCE.matchAll(/\bnew\s+(\w*ServerTransport)\s*\(/g)]
			.map((m) => m[1])
			.filter((v, i, a) => a.indexOf(v) === i)
			.sort();

		expect(transports, REQUIREMENT).toEqual(['StdioServerTransport']);
	});

	// クラス名の網に掛からない追加（`createStreamableHttpServer()` 等）も SDK のサブパス import は変わるので、行頭の import 文に限ってそちら側からも押さえる。
	it('src/server.ts が読み込む SDK サブパスは stdio だけ', () => {
		const subpaths = [...SERVER_SOURCE.matchAll(/^\s*import[^;]*?from\s+'@modelcontextprotocol\/server(\/[^']*)?'/gm)]
			.map((m) => m[1] ?? '(root)')
			.filter((v, i, a) => a.indexOf(v) === i)
			.sort();

		expect(subpaths, REQUIREMENT).toEqual(['(root)', '/stdio']);
	});
});
