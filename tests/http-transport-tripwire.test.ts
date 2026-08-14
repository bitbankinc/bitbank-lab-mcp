/**
 * stdio 以外のトランスポート追加を検知する仕掛け（ADR-0007「判断事項 B」の強制）。
 *
 * ADR-0007 は `confirmation_token` の session / principal 束縛を「今回は見送り、ただし
 * **HTTP トランスポート追加時の必須前提**」として記録している。しかし ADR の散文は CI で
 * 落ちないので、実装時に見落とされる。本テストはその 1 点だけを機械的に固定する。
 *
 * なぜ必須前提なのか:
 *   - `confirmation_token` の HMAC ペイロードは `action + params + expiresAt` だけで、
 *     session も principal も含まない（`src/private/confirmation.ts`）。
 *     同じ secret を持つプロセス／セッションであれば、誰が提示しても検証を通る。
 *   - UI スナップショットのキーは `sessionId ?? ''`（`src/ui-snapshot-cache.ts`）、
 *     MRTR の bind も同じく `?? ''`（`src/private/request-state.ts`）で、
 *     **未設定の sessionId と空文字が同一キーに畳まれる**。
 *   - stdio は 1 接続なので今日は越境先が無く、束縛を足しても no-op。だが HTTP を足した
 *     瞬間、クライアント A の preview で発行したトークンをクライアント B が execute に
 *     使えるようになる（トークンは `_meta` 経由で iframe に渡っており、ゲートは
 *     リクエスト単位で判定されるため）。
 *
 * これは**厳密な証明ではなく tripwire** である。`*ServerTransport` という命名を外れた
 * 独自クラスや、別モジュール経由の接続は検知できない。目的は「気づかずに通ってしまう」を
 * 減らすことであって、迂回不能な関門を作ることではない。
 *
 * 検知は「実際のインスタンス化（`new *ServerTransport(`）」と「import 文」に限定する。
 * 生の識別子を拾うと、`server.ts` のコメントに「HTTP を足すときは…」と書いただけで落ちる。
 * CLAUDE.md がこの要件を明記している以上そういうコメントは書かれうるし、**誤検知する
 * tripwire は最初に消される**ので、取りこぼしよりノイズの方が害が大きい。
 */

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

	// クラス名の網に掛からない追加（`createStreamableHttpServer()` 等）も、SDK の
	// サブパス import は変わるので、そちら側からも押さえる。
	// 行頭の import 文に限定し、散文中の同じ文字列は拾わない。
	it('src/server.ts が読み込む SDK サブパスは stdio だけ', () => {
		const subpaths = [...SERVER_SOURCE.matchAll(/^\s*import[^;]*?from\s+'@modelcontextprotocol\/server(\/[^']*)?'/gm)]
			.map((m) => m[1] ?? '(root)')
			.filter((v, i, a) => a.indexOf(v) === i)
			.sort();

		expect(subpaths, REQUIREMENT).toEqual(['(root)', '/stdio']);
	});
});
