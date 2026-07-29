# ADR-0007: 取引系 HITL の確認トークン受け渡し設計

- **Status**: Accepted
- **Date**: 2026-05-29
- **Updated**: 2026-07-29（MCP 2026-07-28 仕様の正式リリースを受けて「Future direction」を final 仕様と SDK 状況に合わせて更新）
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

> **2026-07-29 更新**: SEP-2322 は MCP 2026-07-28 仕様として正式リリースされ final となった。
> 以下は RC 時点の記述を final 仕様・SDK 状況に合わせて更新したもの。

2026-07-28 仕様で導入された **MRTR（`resultType: "input_required"`）** が本問題の構造的な解決策となる。
仕様上、MRTR はサーバー発リクエスト（`elicitation/create` / `sampling/createMessage` / `roots/list`）を
置き換えるものと位置づけられ、現行の経路 1（`elicitInput`）は旧方式となった。
（正式な非推奨リスト入りは Roots / Sampling / Logging。非推奨機能には最低 12 ヶ月の猶予があり、
`elicitation/create` も当面は動作継続する。）

フローは 2 リクエスト構成:

1. ツール呼び出しに対し、サーバーが `resultType: "input_required"` + `inputRequests`（キー付き確認要求）+
   `requestState`（不透明 blob）を返す
2. クライアントはユーザー回答を集め、同一キーの `inputResponses` と echo した `requestState` を付けて
   **元のツール呼び出しを再試行**する（JSON-RPC id は別。状態はすべてペイロードに載るため
   サーバーはステートレスに再開できる）

```json
{
  "resultType": "input_required",
  "inputRequests": {
    "confirm": {
      "type": "elicitation",
      "message": "この注文を発注しますか？",
      "requestedSchema": { "type": "boolean" }
    }
  },
  "requestState": "<opaque server-controlled blob>"
}
```

`requestState` はクライアントが中身を解釈せず verbatim に echo する不透明 blob だが、
**final 仕様は「opaque だが secret ではない」と明記しており、LLM / クライアントから可視になり得る**。
したがって `confirmation_token` / `expires_at` を格納する場合は平文や HMAC 付き平文ではなく
**暗号化する（または token 本体はサーバー内に保持し、署名付き参照 ID のみを格納する）**。
改ざん検知だけなら HMAC で足りるが、本件は token の LLM 不可視性が要件のため暗号化が基本。
（RC 時点の本 ADR は「LLM 不可視のまま round trip できる」としていたが、これは平文格納では成立しない。）

### 移行計画

- ~~**〜2026-07-28**: SEP-2322 final 確定を待つ~~ → **完了**（2026-07-28 仕様として正式リリース済み）
- **SDK 状況（2026-07-29 時点）**: TypeScript SDK は v2 系の新パッケージ
  （`@modelcontextprotocol/server` 2.0.0、2026-07-27 公開）が 2026-07-28 仕様と
  `inputRequired.elicit()` API を実装。現行使用中の v1 系（`@modelcontextprotocol/sdk` 1.x）には
  来ない見込みのため、MRTR 経路の実装には **SDK v2 移行**（パッケージ分割・`serverInfo` の
  `_meta` 移動・出力拡張子変更等の破壊的変更を含む）が前提となる。
- **移行着手の判断基準**（2026-Q4 目安に再評価）:
  1. `@modelcontextprotocol/server` 2.0.x がパッチを重ねて安定していること
  2. 主要ホスト（Claude Desktop / claude-ai）が 2026-07-28 仕様 + MRTR を扱えること
     （経路 1 の elicitation はホスト側が 1 年近く advertise しなかった前例があり、
     ホスト対応が実質の律速）
- **SDK v2 移行後**: `withElicitedConfirmation` に「`input_required` 返し」経路を追加。
  優先順位は `elicitation > MRTR > trust-host-approval > fallback` を基本としつつ、
  両対応ホストでは仕様上の後継である MRTR を優先する案も実装時に判断する。
- **クライアント実装が広く出揃ったタイミング**: `BITBANK_TRUST_HOST_APPROVAL` モードを deprecate → 撤去

トラッキング:
- 仕様（final）: https://modelcontextprotocol.io/seps/2322-MRTR
- リリース記事: https://blog.modelcontextprotocol.io/posts/2026-07-28/
- TS SDK v2: https://github.com/modelcontextprotocol/typescript-sdk/releases を月 1 で確認
  （`server@2.0.x` のパッチ状況と、主要ホストの MRTR 対応状況をあわせて見る）

## 関連

- 旧設計のセキュリティ修正: PR #532, commits `f0e1cce`, `85d21c7`
- UI 案内表示への調整 / `extra.server` 渡し方の修正: PR #585, #586
- 詳細実装ドキュメント: `docs/private-api.md`「`confirmation_token` の受け渡し」節
- 共通フロー実装: `src/private/elicitation.ts`
- 環境変数判定: `src/private/config.ts` の `isHostApprovalTrusted()`
