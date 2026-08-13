# ADR-0007: 取引系 HITL の確認トークン受け渡し設計

- **Status**: **Proposed**（2026-08-13 改訂案: MCP Apps ホスト限定・オプトインで `_meta` 経由の iframe 実行経路を再導入）
  - 直前の Accepted 版は「2026-08-10 の Decision（Superseded）」節に保持する。**下記「レビュー判断事項」A / B が
    未決の間は Proposed のままとし、実装に着手しない。** 未決のまま Accepted にすると、この ADR を満たしつつ
    動かない実行経路を出荷できてしまう
- **Date**: 2026-05-29
- **Updated**:
  - 2026-07-29（MCP 2026-07-28 仕様の正式リリースを受けて「Future direction」を final 仕様と SDK 状況に合わせて更新。同日、SDK v2 移行 + MRTR 経路の実装を完了）
  - 2026-08-10（`BITBANK_TRUST_HOST_APPROVAL` による token 露出 / UI execute 経路を撤去。execute は elicitation/MRTR のみ）
  - 2026-08-10（`requestState` を SDK `bind` で session/principal + MCP method に束縛。UI スナップショットキーを `sessionId + resourceUri` 化）
  - **2026-08-13（本改訂）**: ホスト実測を受けて Decision を差し替え。`_meta` **限定**・**オプトイン**・**MCP Apps UI 宣言ホスト限定**で iframe ボタンからの execute を再導入する。`structuredContent` への token 再露出は引き続き禁止

## Decision（2026-08-13 改訂案 — Proposed）

取引系 HITL の `confirmation_token` は、**既定ではこれまでどおりサーバープロセス内に閉じる**。
elicitation / MRTR（SEP-2322）対応ホストでは従来どおりネイティブ確認ダイアログのみで execute する（第一選択・変更なし）。

そのうえで、**elicitation を宣言しないが MCP Apps UI（SEP-1865）を宣言するホスト**に限り、
**運用者の明示的オプトイン**（新規環境変数 `BITBANK_MCP_APPS_EXECUTE=1`）がある場合のみ、
`confirmation_token` / `expires_at` を**ツール結果の `_meta` にのみ**載せて iframe へ配送し、
`create_order` / `cancel_order` / `cancel_orders` の MCP handler を**有効なトークンを伴う呼び出しに限って**解錠する。

**トークンが認可の実体になる。** サーバーは iframe 起源の `tools/call` と LLM 起源の `tools/call` を
区別できない（SEP-1865 に origin marker が無い。この事実は 2026-08-10 時点から変わっていない）。
したがって唯一の判定基準は「**LLM が読めないチャネルにしか出していない値を提示できるか**」になる。
この設計は仕様の保証ではなく**ホスト実装の観測された挙動**に依存する。だから既定 off である。

### 2026-08-10 の Decision（Superseded）

> execute は elicitation / MRTR のユーザー明示 accept のみ。SEP-1865 iframe 起源の `tools/call` を
> サーバー側で安全に識別できないため、token を `structuredContent` に載せる UI 実行経路
> （旧 `BITBANK_TRUST_HOST_APPROVAL=1`）は採用しない。

この判断は**当時の情報では妥当だった**。撤去した旧経路は token を `structuredContent` に載せており、
`structuredContent` をモデルコンテキストへ入れるホスト（VS Code、および OpenAI Apps SDK 慣習の
ホスト全般）では LLM が token を直接読める。本リポジトリは Codex / Cursor 向け manifest
（`.codex-plugin/` / `.cursor-plugin/`）を配布しているため、これは理論上のリスクではなく
実配布対象に当たる。**旧経路をそのまま戻すことは今回も禁止する。**

変わったのは「どのチャネルなら LLM に見えないか」の実測値であって、
「`structuredContent` は安全である」という評価ではない。

## Context

bitbank の Private API は注文発注・キャンセル（`create_order` / `cancel_order` / `cancel_orders`）を扱うため、
ユーザーの最終確認（Human-in-the-Loop, HITL）を必ず経由しなければ実行できない設計が必要。

実装にあたって以下の制約と歴史的経緯がある:

1. **MCP の仕様面**: `structuredContent` / `content` / `_meta` のいずれも基本仕様では「LLM 可視」を
   排除する保証が無い。OpenAI Apps SDK は `_meta` を iframe 専用とする慣習を持つが、これは MCP
   基本仕様の保証ではなく、ホスト個別の挙動。
2. **SEP-1865 (MCP Apps / iframe UI)**: iframe ↔ サーバー間の `tools/call` には origin marker が無く、
   サーバーから「iframe 起源の呼び出しか LLM 起源の呼び出しか」を識別できない。
3. **elicitation / MRTR**: サーバーがクライアントに確認要求を返し、ユーザー応答付きで再試行する経路。
   `getClientCapabilities().elicitation`（または MRTR envelope）で advertise されているクライアントでのみ動作する。
4. **歴史的経緯**:
   - 旧実装は `confirmation_token` を `structuredContent.data` に含めて返していた → iframe がそれを読んで
     ボタンを描画し `app.callServerTool('create_order', { token })` で実行
   - この設計は LLM が `structuredContent` を読み取れる場合に HITL バイパス可能
     （インジェクション攻撃で「preview の直後に create_order を直接呼ぶ」誘導が成立）
   - 2026-05-21 のセキュリティ修正 (#532 / commits `f0e1cce` / `85d21c7`) で token を `structuredContent`
     から strip するよう変更。同時に elicitation 経路を主流にした
   - 主要クライアントが elicitation を advertise していなかったため、`BITBANK_TRUST_HOST_APPROVAL=1`
     オプトインで token 再露出する妥協モードを一時的に用意した
   - **しかし tool description やホスト承認 UI は認可制御にならない**。token が見えれば LLM / 任意クライアントが
     ユーザーの iframe ボタン押下なしに execute を呼べる。2026-08-10 にこの妥協モードを撤去した（PR #31）

### 撤去後に判明した実務上の問題

PR #31 以降、**Claude Desktop から発注・取消ができない**。preview までは動作し、実行段階で
「このホストは確認フローに対応していない」という fallback が返る。Claude Desktop は本サーバーの
主想定クライアント（README「最も多くの方が使う想定の MCP クライアント」）であり、
機能の中核が主要ホストで到達不能になっている。

### 計測 1: チャネル可視性（Claude Desktop 実測 / 2026-08）

3 チャネルに互いに素なマーカーを載せ、生 JSON-RPC で wire 上に 3 つとも存在することを確認した
うえで、Desktop 上のモデルに何が見えるかを問い合わせた。

| チャネル | モデルに渡ったか |
|---|---|
| `content[0].text` | **渡った** |
| `structuredContent` | 渡らなかった |
| ツール結果 `_meta` | 渡らなかった |

### 計測 2: elicitation / MRTR の可否（Claude Desktop 実測 / 2026-08）

capability ゲートを持たない probe で `input_required` を返した結果:

```text
env.negotiatedProtocolVersion       "2025-11-25"
env.initializeClientCapabilities    {"extensions":{"io.modelcontextprotocol/ui":{"mimeTypes":["text/html;profile=mcp-app"]}}}
env.initializeClientInfo            {"name":"claude-ai","version":"0.1.0"}
env.hasElicitationCapability        {"viaInitialize":false,"viaEnvelope":false}
```

- **Desktop が宣言している capability は MCP Apps UI ただ 1 つ。** elicitation も sampling も roots も無い
- SDK は capability 未宣言を検知して `elicitation/create` を**送信すらしない**（push 0 回、`isError: true`）
- したがって `clientSupportsElicitation` のゲートを外しても何も解決しない（SDK が塞ぐ）。
  **ゲート削除は選択肢に入らない**
- negotiate されたのは 2025-11-25。本リポジトリ SDK の `LATEST_PROTOCOL_VERSION` と同値で、
  2026-07-28 は土俵に上がっていない

**結論: elicitation 対応を待つには Anthropic 側の実装と本リポジトリ SDK 更新の両方が必要で、ETA が無い。**

### 計測 3: 仕様側の記述（Web 調査 / 2026-08-13 再確認）

MCP Apps（SEP-1865）の仕様本文 `specification/2026-01-26/apps.mdx` に該当記述がある。

> - `content`: Text representation for model context and text-only hosts
> - `structuredContent`: Structured data optimized for UI rendering (not added to model context)
> - `_meta`: Additional metadata (timestamps, version info, etc.) not intended for model context

出典: <https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx>
（SEP-1865: <https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1865>）

**ただしこの 3 点は `### Best Practices` 見出しの下の箇条書きで、MUST / SHOULD / REQUIRED を伴わない**
（2026-08-13 に本文を取得して確認）。ホストへの適合要件ではなく、意図の説明である。

一方 OpenAI Apps SDK には公式記述がある。

> Only `structuredContent` and `content` appear in the conversation transcript. The host forwards `_meta`
> to the component so you can hydrate UI without exposing the data to the model.

出典: <https://developers.openai.com/apps-sdk/reference>

**つまり OpenAI 慣習では `structuredContent` はモデル可視。** チャネルの扱いはベンダー間で一致していないが、
**`_meta` を「モデルに出さない」とする点だけは両陣営で一致している。** これが `_meta` 限定にする根拠。

## Decision の詳細

### 3 層の経路

```text
1. elicitation / MRTR 対応ホスト   → ネイティブ確認ダイアログで完結（token は server 内に閉じる。第一選択・変更なし）
2. MCP Apps UI 宣言ホスト
   （mimeTypes に text/html;profile=mcp-app を含む）
   かつ運用者オプトイン on        → token を結果 `_meta` にのみ載せ、iframe ボタンからの execute を解錠
3. それ以外                       → preview のみ返す（execute 不可。token は返さない。従来どおり）
```

経路の選択は引き続き `src/private/elicitation.ts` の `withElicitedConfirmation` に集約する。

**優先順位は逆転させない。** `clientSupportsElicitation(extra)` が真のホストには
**`_meta` にトークンを載せない**（経路 2 に落ちない）。これを不変条件としてテストで固定する:
*elicitation を宣言したホストは、オプトインが on でもトークンを一切受け取らない。*

### 有効化ゲート（2 段の AND）

トークンを発行するのは次の**両方**を満たす場合のみ。片方でも欠ければ経路 3（従来の preview のみ）。

1. **明示的なオプトイン** — 環境変数 `BITBANK_MCP_APPS_EXECUTE=1`（既定 off）。
   判定関数は `src/private/config.ts` に `isAppUiExecuteEnabled()` として置く。
   - **`BITBANK_TRUST_HOST_APPROVAL` は再利用しない。** 同変数は「撤去済み・設定しても無視される」と
     README / docs / ADR / `isHostApprovalTrusted()` の 4 箇所に記録済みで、意味を差し替えると
     読み手が「無効化されたはずの経路が復活した」と誤読する。`isHostApprovalTrusted()` は
     常に `false` を返すまま残し、今回の判定には一切関与させない。
2. **クライアントが MCP Apps UI を宣言しており、かつ本サーバーの UI リソースを描画できること** —
   `extensions["io.modelcontextprotocol/ui"]` の存在**だけでは足りない**。
   `mimeTypes` が `text/html;profile=mcp-app` を含むことまで要求する。

   ```json
   { "capabilities": { "extensions": { "io.modelcontextprotocol/ui": {
       "mimeTypes": ["text/html;profile=mcp-app"] } } } }
   ```

   - 仕様上 `mimeTypes` は **REQUIRED**（"Array of supported content types (REQUIRED, e.g.,
     `["text/html;profile=mcp-app"]`)"）で、`text/html;profile=mcp-app` が MVP のベースライン型。
     出典: <https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx>
     （2026-08-13 に本文取得して確認）
   - 本サーバーの確認 UI は `APP_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app'`
     （`src/resources/app-resources.ts`）で配信している。**この型を描画できないホストでは
     確認カードそのものが出ないため、トークンを載せる意味が無く、露出面が増えるだけ**になる。
     判定には同定数を再利用し、文字列を二重定義しない
   - 計測 2 の Desktop 実測値は `{"mimeTypes":["text/html;profile=mcp-app"]}` を含んでおり、
     この追加ゲートで対象ホストが落ちないことを確認済み
   - `mimeTypes` が欠落／空／該当型を含まない場合は**トークンを一切載せない**（fail-closed）

   **capability の取得元が食い違う場合の解決順序**: per-request envelope
   （`extra.mcpReq.envelope.clientCapabilities`）が存在すればそれを**権威として採用**し、
   無い場合にのみ `server.getClientCapabilities()`（`initialize` 時の宣言）へフォールバックする。
   - 2026-07-28 系はリクエストごとの capability 提示が前提であり、envelope が「UI 非対応」と
     言っているのに `initialize` 時の宣言を根拠に載せるのは、より新しい宣言を無視することになる
   - **これは `clientSupportsElicitation`（両者の OR）とは意図的に異なる。** あちらは
     「elicitation を試してよいか」の判定で、OR で誤っても SDK が塞ぐだけ。こちらは
     「bearer token を渡してよいか」の判定なので、食い違いは狭い側に倒す
   - 両方の欠落・食い違いパターンをテストで固定する

### トークン配送チャネル（`_meta` 限定）

- 載せる先は**ツール結果レベルの `_meta`** のみ。キーは名前空間付きで
  `_meta["cc.bitbank/confirmation"] = { confirmation_token, expires_at }` とする。
- **`content` と `structuredContent` には載せない。** 既存の `stripConfirmationTokenFields`
  （`src/private/elicitation.ts`）は多層防御として**維持する**。トークンは strip 済みの
  structuredContent とは別に `_meta` へ組み立てる（strip を迂回する経路を作らない）。
- ツール結果レベルの `_meta` は現状 `src/server.ts` の `respond()` が組み立てていないため、
  `McpResponse` に optional な `_meta` を足し、`respond()` が存在時のみ透過する経路を追加する。
  - **注意**: コード中の `_meta` の多くは**ツール定義側**（`registerTool` に渡す `ui.resourceUri` /
    `ui.visibility` 等）で、**ツール結果の `_meta` とは別物**。混同しない。
  - `CallToolResult` は `ResultSchema = z.looseObject({ _meta: … })` を extend しており、
    結果レベル `_meta` は仕様上の正規フィールド。SDK はそのまま透過する（計測で確認済み）。

### execute ハンドラの条件付き解錠

現在 3 ツールの MCP handler は無条件で `fail(DIRECT_EXECUTE_FORBIDDEN_MESSAGE,
DIRECT_EXECUTE_FORBIDDEN_ERROR_TYPE)` を返す（`tools/private/create_order.ts` /
`cancel_order.ts` / `cancel_orders.ts`）。これを次に変える。

```text
ゲート（オプトイン AND MCP Apps UI 宣言 + MIME 型）が偽 → direct_execute_forbidden（従来どおり）
ゲートが真 かつ 引数に confirmation_token が無い     → direct_execute_forbidden（従来どおり）
ゲートが真 かつ 引数に confirmation_token がある     → 既定 export を呼ぶ。トークン検証は既存の
                                                       validateToken に委ね、不正・期限切れ・使用済み・
                                                       別注文は既存の errorType でそのまま失敗させる
```

監査ログの `route` は既存の `'ui-button'` を使う（型・ログ形式は変更不要）。
`'elicitation'` / `'ui-button'` / `'direct-text'` の 3 値で、事故時にどの経路で実行されたかを追える。

#### 拒否メッセージ（`DIRECT_EXECUTE_FORBIDDEN_MESSAGE`）の扱い

現在の文言は「execute は elicitation/MRTR 経由のみ」「`confirmation_token` はクライアントに返らない」と
断言しており、オプトイン on では**事実に反する**。`errorType` は `direct_execute_forbidden` のまま、
文言だけを両構成で正しい表現に直す。

**ただし「有効な `confirmation_token` を添えれば実行できる」とは書かない。** この文言は
`content[0].text` に載る＝**LLM が読む唯一のチャネル**であり、認可の実体がトークン所持である以上、
「トークンを探して添えろ」と教えることはプロンプトインジェクションの誘導面をこちらから広げる行為になる。
LLM はトークンを入手できないので実害には直結しないが、**攻撃者に手順書を渡す必要は無い。**

方針: 直接実行が不可であることと、正規の入口が `preview_*` であることのみを述べ、
実行手段の内訳（elicitation ダイアログか確認カードのボタンか）はホスト構成に依存するため断定しない。
同じ理由で、ツール description からも「`confirmation_token` はクライアントに返らない」の断言を外す
（`preview_*` 系 3 ツールと execute 系 3 ツールの description が対象）。

### 既存の防御は 1 つも外さない

| 防御 | 実装 | 本改訂での扱い |
|---|---|---|
| `argsDigest` / パラメータ束縛 | `confirmation.ts` の HMAC ペイロード（action + params + expiresAt）、MRTR 側は `request-state.ts` の `digestArgs` | 変更なし。別注文のトークンでの実行は `token_invalid` |
| TTL 60 秒（上限 5 分） | `ORDER_CONFIRM_TTL_MS` / `MAX_TTL_MS` | 変更なし |
| ワンタイム | `validateToken` が `BoundedExpiringSet` に登録できた場合のみ成功（fail-closed） | 変更なし |
| session / principal / method 束縛 | `request-state.ts` の `bind` | 変更なし（MRTR 経路にのみ適用。下記「レビュー判断事項 B」参照） |
| 実行後のスナップショット破棄 | `clearUiSnapshot` | 変更なし |

これらにより、**トークンが漏れた場合の最悪ケースは「ユーザーが直前にプレビューしたその注文 1 件、
または `preview_cancel_orders` でプレビューした注文 ID 集合 1 セットが、60 秒以内に 1 回だけ実行される」**
に限定される。任意の注文は作れず、金額・数量・ペア・方向を攻撃者が選ぶこともできない。
**この性質は本改訂で維持する。**

`cancel_orders` のトークンは `{ pair, order_ids }` に HMAC 束縛されるため、被害範囲は
「ユーザーが実際にプレビューした ID 集合」と一致する（ID を足すことも入れ替えることもできない）。
運用者が影響を過小評価しないよう、README / `safety.md` でも「注文 1 件」ではなく
**「プレビュー済みの注文 1 件、または プレビュー済み ID 集合 1 セット」**と書く。

### テストで固定する不変条件

人手のレビューに委ねず機械的に固定する。**最重要は 1 番目**（ここが破れると設計が崩壊する）。

1. **`content` / `structuredContent` にトークンが出ない** — 全経路（accept / decline / fallback /
   `get_ui_snapshot` / エラー応答）で、応答全体を JSON 文字列化してトークン値の部分一致で検査する
2. オプトイン off のとき `_meta` にトークンが載らない
3. オプトイン on でも、MCP Apps UI 未宣言 / `mimeTypes` 欠落 / `mimeTypes` に
   `text/html;profile=mcp-app` を含まないホストには載らない
4. capability の取得元が食い違う場合（envelope が非対応 × `initialize` が対応、およびその逆）に
   envelope が優先される
5. **elicitation を宣言したホストには、オプトイン on でもトークンが載らない**（優先順位の不変条件）
6. トークン無しの `create_order` / `cancel_order` / `cancel_orders` 直接呼び出しが
   `direct_execute_forbidden` で拒否される（ゲート on / off の両方で）
7. 不正・期限切れ・使用済み・別注文（`argsDigest` / HMAC パラメータ不一致）のトークンでの実行が拒否される
8. `get_ui_snapshot` が `expires_at` 経過後に `_meta` を返さない（`structuredContent` は返す）

さらに **stdio サブプロセスの E2E 回帰**（`tests/e2e/**`）を 1 本足し、実際の `tools/call` 応答で
`_meta["cc.bitbank/confirmation"]` が存在し、かつ `content` / `structuredContent` にトークンが
含まれないことを wire レベルで確認する。単体テストは `respond()` の組み立てまでしか見ないため、
SDK が結果レベル `_meta` を実際に透過することの確認にはならない（計測では確認済みだが、
SDK 更新で静かに壊れうる箇所なので回帰を張る）。

> **注意**: `tests/e2e/**` は `npm test` の対象外で PR でも走らない（`CLAUDE.md`）。
> この 1 本は手動 / nightly（`npm run test:e2e`）でのみ実行される。PR でのゲートは
> 上記 1〜8 の単体・結合テストが担う。

## レビュー判断事項（実装前に確定させたい）

### A. pull 型 hydration（`get_ui_snapshot`）へトークンを載せるか

**背景**: 一部ホスト（2026-07-28 ロールアウト後の Claude Desktop で確認済み）は
`ui/notifications/tool-result` を iframe に配信しない。そのため iframe は接続後 2.5 秒で
`get_ui_snapshot` を呼んで直近の preview 応答を自力で復元する（`src/ui-snapshot-cache.ts`）。
スナップショットは `structuredContent` しか保持していないため、**push 配信が効かないホストでは
`_meta` のトークンが iframe に届かず、ボタンは押せてもトークンを持たない**。
つまり push 経路だけに賭けると、**まさに今回ターゲットにしているホストで機能しない可能性がある。**

**推奨**: スナップショットに `_meta` も保持し、`get_ui_snapshot` の結果 `_meta` として同じ
名前空間キーで返す。ゲートは preview 側とまったく同じ 2 段（オプトイン AND MCP Apps UI 宣言 +
MIME 型）を課す。根拠は、これがチャネルを増やさず（同じ結果 `_meta`）、境界も増やさない
（スナップショットは既に `sessionId + resourceUri` 束縛・実行成功時に `clearUiSnapshot`）ため。
トークン自体の TTL 60 秒・ワンタイム・パラメータ束縛はそのまま効く。

**ただし保持期間を揃える必要がある。** スナップショットの TTL は 5 分（`SNAPSHOT_TTL_MS`）だが
トークンの既定 TTL は 60 秒で、`_meta` をそのまま複製すると `get_ui_snapshot` が
**期限切れトークンを残り 4 分間返し続ける**。実害は限定的（`validateToken` が `token_expired` で
弾くので実行はされない）が、使えない bearer 値を取得可能な場所に置き続ける理由が無い。

したがってスナップショット側の契約を次のようにする:

- token を含むエントリは `expires_at` を一緒に保持し、**`expires_at` を過ぎたら `_meta` を返さない**
  （`structuredContent` は従来どおり 5 分まで返す。プレビュー内容の再描画は期限切れ後も有効なため）
- token を含まないエントリの挙動は現状のまま（TTL 5 分、変更なし）
- 期限切れ `_meta` を落とすのは「取得時に判定して省く」方式とし、entry ごと消さない
  （消すと preview の再描画まで巻き添えで死ぬ）

**代替案（push 限定）**: `get_ui_snapshot` は従来どおり `structuredContent` のみ返す。露出面は最小だが、
Desktop で機能しない可能性が残り、その場合は「壊れていることに気づけないまま出荷」になる。

**本 ADR は推奨案を前提に書いているが、ここは明示的にレビューで確定させたい。**

### B. `confirmation_token` を session / principal に束縛するか

MRTR の `requestState` は `bind` で session/principal + method に束縛されているが、
`confirmation_token`（`confirmation.ts`）にはこの束縛が無い。経路 2 では preview と execute が
**別リクエスト**になるため、束縛が無いとトークンを持ち出した別セッションからの実行を弾けない。

**現状の実効リスクはゼロに近い**: 本サーバーは `StdioServerTransport` のみで起動し
（`src/server.ts`）、`sessionId` は常に undefined、principal も無い。束縛を足しても今日は no-op。

**推奨**: 今回のスコープでは追加せず、**HTTP トランスポートを追加する際の必須前提として本 ADR に記録する**
（スコープを膨らませず、忘れないようにする）。ここもレビューで確定させたい。

## Consequences

### Pros

- Claude Desktop（主想定クライアント）で発注・取消がチャットから完結する。PR #31 以降の機能欠落が解消する
- 既定は従来どおり token 非露出。**何も設定しなければ 2026-08-10 の設計そのまま**
- トークンは両陣営の慣習が一致している唯一のチャネル（`_meta`）にしか出ない。
  `structuredContent` をモデルに渡すホスト（VS Code / OpenAI 慣習）でも LLM は読めない
- elicitation 対応ホストの挙動は 1 ビットも変わらない（優先順位を維持し、経路 2 に落ちない）
- 漏洩時の被害は「直前にプレビューした注文 1 件が 60 秒以内に 1 回」に限定されたまま

### Cons

- **仕様上の保証に依存していない。** 依存しているのは ext-apps の Best Practices 箇条書き
  （MUST/SHOULD なし）と Claude Desktop の実測挙動であって、適合要件ではない
- **ホストのアップデートで壊れても、サーバー側では検知できない。** ホストが `_meta` を
  モデルコンテキストに含めるようになった瞬間、LLM は token を読めるようになるが、
  サーバーからはその変化が観測できない。**壊れ方は静か**
- 当該領域は実装が流動的（`structuredContent` の喪失回帰など、Anthropic のトラッカーに
  2026-05〜08 の issue が複数）。挙動は再測定なしに前提にできない
- 「iframe 起源か LLM 起源か」を識別できないという SEP-1865 の根本問題は未解決のまま。
  今回は「LLM が読めない値を持っているか」で代替しているだけ

### したがってオプトインであり、既定では無効

有効化は運用者の明示的な判断（`BITBANK_MCP_APPS_EXECUTE=1`）とし、README /
`docs/gitbook/private-api/safety.md` / ツール description の 3 箇所に上記 Cons を明記する。

## 想定リスクの境界

| リスク | 既定（オプトイン off） | オプトイン on + MCP Apps UI 宣言ホスト（MIME 型込み） |
|---|---|---|
| preview 応答からの HITL バイパス | × token / 同等 credential を返さない | △ **`_meta` がモデル可視になったホストでは成立する**（実測では非可視。これが本設計の唯一の依存点） |
| `structuredContent` からの token 取得 | × 常に strip | × 常に strip（変更なし） |
| MCP tools/call での直接 execute（token 無し） | × handler が常に拒否 | × handler が `direct_execute_forbidden` で拒否 |
| 期限切れ / 使用済み / 別注文の token での execute | × validateToken が拒否 | × validateToken が拒否（変更なし） |
| 攻撃者が任意の注文内容を作る | × token 未発行 | × token はプレビュー済みパラメータに HMAC 束縛 |
| token 漏洩時の最大被害 | 該当なし | 直前にプレビューした注文 1 件（`cancel_orders` ではプレビュー済み ID 集合 1 セット）× 60 秒 × 1 回 |
| elicitation accept の replay | × one-time nonce で拒否 | × 同左（経路 2 では nonce 経路を通らない） |
| アカウント全資産が一発で消える | × | × accept / token は 1 件（または preview した ID 集合）にバインド |
| 別セッションへの token 持ち出し | 該当なし | △ stdio では別セッションが存在しない。HTTP 化する場合は「レビュー判断事項 B」が必須前提 |

## 将来ホスト挙動が変わったときに何が壊れるか

| 変化 | 影響 | 検知可能性 |
|---|---|---|
| ホストが結果 `_meta` をモデルコンテキストに入れるようになる | **HITL バイパスが成立する**（LLM が token を読み、ユーザーのボタン押下なしに execute できる） | **サーバーからは検知不可**。定期的な再計測でしか気づけない |
| ホストが結果 `_meta` を iframe へ転送しなくなる | 機能が動かなくなる（fail-closed。ボタンを押しても token 無しで `direct_execute_forbidden`） | ユーザーには「実行できない」として見える。安全側 |
| ホストが `extensions["io.modelcontextprotocol/ui"]` の宣言をやめる、または `mimeTypes` から `text/html;profile=mcp-app` を落とす | ゲート 2 が閉じ、経路 3 に戻る（preview のみ） | 安全側 |
| ホストが elicitation を宣言し始める（`anthropics/claude-ai-mcp#153` 等） | 経路 1 が優先され、`_meta` 配送は自動的に止まる | 安全側。**その時点で本オプトインは役目を終える** |
| SEP-1865 に origin marker が入る | 「iframe 起源」をサーバー側で認証できるようになり、トークン提示への依存を減らせる | 仕様追従で対応 |

**再測定のトリガー**: Claude Desktop のメジャー更新時、および ext-apps 仕様の版が上がったとき。
計測 1（3 チャネルに互いに素なマーカーを載せてモデルに問う）を再実行して結果をこの ADR に追記する。

## Future direction: SEP-2322 (Multi Round-Trip Requests)

> **2026-07-29 更新**: SEP-2322 は MCP 2026-07-28 仕様として正式リリースされ final となった。
> MRTR 経路は実装済み（第一選択）。

`requestState` は秘匿保証が無いため token を載せない。nonce + 引数 digest を署名して載せ、
HMAC / 期限 / bind（呼び出し元セッションまたは認証 principal + 元の MCP method。
SDK `createRequestStateCodec.bind`）+ action / digest / one-time nonce（`withElicitedConfirmation`）で
検証する。stdio（sessionId 未設定）では既存挙動を維持し、HTTP 等で sessionId / principal が
得られる場合は越境再利用を fail-closed で拒否する。

UI スナップショット（`src/ui-snapshot-cache.ts`）も `sessionId + resourceUri` をキーにし、
別セッションによる取得・上書き・削除を防ぐ。

**本命は経路 1 の普及**である。Claude Desktop が elicitation を宣言すれば経路 2 は不要になる
（`anthropics/claude-ai-mcp#153` が Open・担当者付き。`clientInfo` が `claude-ai` であることから
claude.ai 向けトラッカーが Desktop の直接の窓口とみなせる）。計測 2 の実測値を添えて要望を出す。

## 関連

- 旧設計のセキュリティ修正: PR #532, commits `f0e1cce`, `85d21c7`
- UI 案内表示への調整 / `extra.server` 渡し方の修正: PR #585, #586
- trust-host 経路の撤去: PR #31（commits `8bb7ed3` / `4f1e8b7`）
- MCP Apps 仕様: <https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx>
- SEP-1865: <https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1865>
- OpenAI Apps SDK リファレンス: <https://developers.openai.com/apps-sdk/reference>
- 詳細実装ドキュメント: `docs/private-api.md`「`confirmation_token` の受け渡し」節
- 共通フロー実装: `src/private/elicitation.ts`
- 撤去済み環境変数の判定（常に false のまま）: `src/private/config.ts` の `isHostApprovalTrusted()`
