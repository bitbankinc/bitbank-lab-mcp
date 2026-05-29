# ADR-0002: 取引系 HITL の確認トークン受け渡し設計

- **Status**: Accepted
- **Date**: 2026-05-29
- **Decision**: 取引系 HITL の `confirmation_token` 配送を 3 層構造で扱う。デフォルトはサーバープロセス内に閉じ、`BITBANK_TRUST_HOST_APPROVAL=1` のオプトインで SEP-1865 iframe ボタン経路を有効化する。長期的には MCP SEP-2322 (Multi Round-Trip Requests / `InputRequiredResult`) への置き換えを想定する。

## Context

bitbank の Private API は注文発注・キャンセル（`create_order` / `cancel_order` / `cancel_orders`）を扱うため、ユーザーの最終確認（Human-in-the-Loop, HITL）を必ず経由しなければ実行できない設計が必要。

実装にあたって以下の制約と歴史的経緯がある:

1. **MCP の仕様面**: `structuredContent` / `content` / `_meta` のいずれも基本仕様では「LLM 可視」を排除する保証が無い。OpenAI Apps SDK は `_meta` を iframe 専用とする慣習を持つが、これは MCP 基本仕様の保証ではなく、ホスト個別の挙動。
2. **SEP-1865 (MCP Apps / iframe UI)**: iframe ↔ サーバー間の `tools/call` には origin marker が無く、サーバーから「iframe 起源の呼び出しか LLM 起源の呼び出しか」を識別できない。
3. **elicitation**: サーバーがクライアントに `elicitInput` を投げてネイティブダイアログを出す機能。`getClientCapabilities().elicitation` で advertise されているクライアントでのみ動作する。Claude Desktop / claude-ai は 2026-05 時点で advertise していないことを実機ログで確認。
4. **歴史的経緯**:
   - 旧実装は `confirmation_token` を `structuredContent.data` に含めて返していた → iframe がそれを読んでボタンを描画し `app.callServerTool('create_order', { token })` で実行
   - この設計は LLM が `structuredContent` を読み取れる場合に HITL バイパス可能（インジェクション攻撃で「preview の直後に create_order を直接呼ぶ」誘導が成立）
   - 2026-05-21 のセキュリティ修正 (#532 / commits `f0e1cce` / `85d21c7`) で token を `structuredContent` から strip するよう変更。同時に elicitation 経路を主流にした
   - しかし主要クライアントが elicitation を advertise していないため、Claude Desktop / claude-ai で発注経路そのものが消失した（spec 適合だが UX 破綻）

## Decision

### 3 層の経路を順位制で並べる

```
1. elicitation 対応ホスト         → ネイティブダイアログで完結（token は server 内に閉じる）
2. trust-host-approval モード     → iframe ボタン経路（token を structuredContent に含めて返す）
3. それ以外                       → preview のみ返す（execute 不可）
```

経路の選択は `src/private/elicitation.ts` の `withElicitedConfirmation` に集約。

### `BITBANK_TRUST_HOST_APPROVAL=1` の意味づけ

「ホスト（Claude Desktop / claude-ai 等）のツール承認 UI を最終 gate として信頼する」というユーザーの明示的なオプトイン宣言として扱う。

このモードでは:
- `confirmation_token` / `expires_at` が `structuredContent.data` に含まれる
- iframe (SEP-1865) が token を読んで `app.callServerTool` を呼ぶ経路が動く
- LLM も `structuredContent` 経由で token を見られるが、ホストのツール承認 UI が（"Allow always" を押さない限り）人間クリックを要求する前提で運用する

### LLM への明示的な制約

`create_order` / `cancel_order` / `cancel_orders` のツール description に強い文言を入れる:

> ⚠️ LLM はこのツールを直接呼び出してはならない。常に preview_* 経由でのみ呼び出すこと。

これは強制力こそ無いが、LLM の自制を促す soft gate として機能する。

## Consequences

### Pros

- デフォルト挙動は spec 適合・安全側（token を露出しない）
- 個人責任で UX を取りたいユーザーは env 1 つで opt-in できる
- elicitation 対応クライアントが増えれば自動的に経路 1 にシフトする（コード変更不要）
- 短期 / 中期 / 長期の移行パスが明確
- 既存テストはすべて維持される（デフォルト挙動は変わらない）

### Cons

- `BITBANK_TRUST_HOST_APPROVAL=1` 時のセキュリティは「ホスト承認 UI が機能する」という仕様外の前提に依存する
- "Allow always" を押すユーザーには HITL gate が事実上無効化される（READMEで警告）
- 3 経路の分岐ロジックが `withElicitedConfirmation` 内に存在し続ける（SEP-2322 移行までの暫定）

### 想定リスクの境界

| リスク | 評価 |
|---|---|
| 1 回のバイパスで失える金額 | 1 件分の注文。bitbank 側の残高・最小/最大数量制限内 |
| アカウント全資産が一発で消える | × token は注文 1 件にしか効かない、有効期限短い |
| 不可逆性 | 約定すれば取り消し不可（指値だけは未約定中にキャンセル可） |
| 検知容易性 | 会話ログに `create_order` 実行が残るので事後検知容易 |
| 損失上限 | 入金額 / 利用可能保証金で頭打ち |

## Future direction: SEP-2322 (Multi Round-Trip Requests) への移行

MCP 2026-07-28 release candidate で導入される **`InputRequiredResult`** が本問題の構造的な解決策となる:

```json
{
  "resultType": "inputRequired",
  "inputRequests": {
    "confirm": {
      "type": "elicitation",
      "message": "この注文を発注しますか？",
      "schema": { "type": "boolean" }
    }
  },
  "requestState": "<opaque server-controlled blob>"
}
```

`requestState` はサーバーが任意の文字列（HMAC / 暗号文）にできる**不透明 blob**で、クライアントは中身を解釈せず echo するだけ。`confirmation_token` / `expires_at` を `requestState` に格納すれば LLM 不可視のまま round trip できる。

### 移行計画

- **〜2026-07-28**: SEP-2322 final 確定を待つ。spec ドリフトに備え PoC は作らない
- **2026-07-28 以降**: TypeScript SDK の対応状況を見る（SDK PR を watch）
- **SDK 対応後**: `withElicitedConfirmation` に「`InputRequiredResult` 返し」経路を追加。優先順位は `elicitation > InputRequiredResult > trust-host-approval > fallback`
- **クライアント実装が広く出揃ったタイミング**: `BITBANK_TRUST_HOST_APPROVAL` モードを deprecate → 撤去

トラッキング:
- 仕様: https://modelcontextprotocol.io/seps/2322-MRTR
- リリース予定: https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/
- TS SDK 実装: `gh pr list -R modelcontextprotocol/typescript-sdk --search "InputRequiredResult OR SEP-2322"` を月 1 で確認

## 関連

- 旧設計のセキュリティ修正: PR #532, commits `f0e1cce`, `85d21c7`
- UI 案内表示への調整 / `extra.server` 渡し方の修正: PR #585, #586
- 詳細実装ドキュメント: `docs/private-api.md`「`confirmation_token` の受け渡し」節
- 共通フロー実装: `src/private/elicitation.ts`
- 環境変数判定: `src/private/config.ts` の `isHostApprovalTrusted()`
