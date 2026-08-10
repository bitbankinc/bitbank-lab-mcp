# ADR-0007: 取引系 HITL の確認トークン受け渡し設計

- **Status**: Accepted（2026-08-10 更新: trust-host UI 実行経路をセキュリティ上撤去）
- **Date**: 2026-05-29
- **Updated**:
  - 2026-07-29（MCP 2026-07-28 仕様の正式リリースを受けて「Future direction」を final 仕様と SDK 状況に合わせて更新。同日、SDK v2 移行 + MRTR 経路の実装を完了）
  - 2026-08-10（`BITBANK_TRUST_HOST_APPROVAL` による token 露出 / UI execute 経路を撤去。execute は elicitation/MRTR のみ）
  - 2026-08-10（`requestState` を SDK `bind` で session/principal + MCP method に束縛。UI スナップショットキーを `sessionId + resourceUri` 化）
- **Decision**: 取引系 HITL の `confirmation_token` はサーバープロセス内に閉じ、クライアントへ返さない。execute は elicitation / MRTR（SEP-2322）のユーザー明示 accept のみで行う。SEP-1865 iframe 起源の `tools/call` をサーバー側で安全に識別できないため、token を `structuredContent` に載せる UI 実行経路（旧 `BITBANK_TRUST_HOST_APPROVAL=1`）は採用しない。

## Context

bitbank の Private API は注文発注・キャンセル（`create_order` / `cancel_order` / `cancel_orders`）を扱うため、ユーザーの最終確認（Human-in-the-Loop, HITL）を必ず経由しなければ実行できない設計が必要。

実装にあたって以下の制約と歴史的経緯がある:

1. **MCP の仕様面**: `structuredContent` / `content` / `_meta` のいずれも基本仕様では「LLM 可視」を排除する保証が無い。OpenAI Apps SDK は `_meta` を iframe 専用とする慣習を持つが、これは MCP 基本仕様の保証ではなく、ホスト個別の挙動。
2. **SEP-1865 (MCP Apps / iframe UI)**: iframe ↔ サーバー間の `tools/call` には origin marker が無く、サーバーから「iframe 起源の呼び出しか LLM 起源の呼び出しか」を識別できない。
3. **elicitation / MRTR**: サーバーがクライアントに確認要求を返し、ユーザー応答付きで再試行する経路。`getClientCapabilities().elicitation`（または MRTR envelope）で advertise されているクライアントでのみ動作する。
4. **歴史的経緯**:
   - 旧実装は `confirmation_token` を `structuredContent.data` に含めて返していた → iframe がそれを読んでボタンを描画し `app.callServerTool('create_order', { token })` で実行
   - この設計は LLM が `structuredContent` を読み取れる場合に HITL バイパス可能（インジェクション攻撃で「preview の直後に create_order を直接呼ぶ」誘導が成立）
   - 2026-05-21 のセキュリティ修正 (#532 / commits `f0e1cce` / `85d21c7`) で token を `structuredContent` から strip するよう変更。同時に elicitation 経路を主流にした
   - 主要クライアントが elicitation を advertise していなかったため、`BITBANK_TRUST_HOST_APPROVAL=1` オプトインで token 再露出する妥協モードを一時的に用意した
   - **しかし tool description やホスト承認 UI は認可制御にならない**。token が見えれば LLM / 任意クライアントがユーザーの iframe ボタン押下なしに execute を呼べる。2026-08-10 にこの妥協モードを撤去した

## Decision

### 2 層の経路

```text
1. elicitation / MRTR 対応ホスト  → ネイティブ確認ダイアログで完結（token は server 内に閉じる）
2. それ以外                       → preview のみ返す（execute 不可。token は返さない）
```

経路の選択は `src/private/elicitation.ts` の `withElicitedConfirmation` に集約。

### `BITBANK_TRUST_HOST_APPROVAL` の扱い（撤去）

環境変数 `BITBANK_TRUST_HOST_APPROVAL=1` を設定しても **効果はない**（`isHostApprovalTrusted()` は常に `false`）。後方互換のため関数名と env 読み取りの痕跡は残すが、token を `structuredContent` に載せる経路は存在しない。

理由:
- SEP-1865 では UI 起源の `tools/call` をサーバー側で認証できない
- 「ホスト承認 UI を信頼する」「LLM は description に従う」は強制力のある認可ではない
- したがって UI 経由 execute を許すと、token 漏洩 = HITL バイパスが成立する

### execute ツールの MCP ハンドラ拒否

`create_order` / `cancel_order` / `cancel_orders` の `toolDef.handler`（MCP `tools/call`）は常に `direct_execute_forbidden` で拒否する。
preview の elicitation accept は各関数の default export をプロセス内で直接呼び出すため、この拒否の外にある。

### LLM への明示的な制約

description に「直接呼び出してはならない」と書くことは補助に過ぎず、**認可の根拠にしない**。強制はサーバー側の token 非露出 + MCP handler 拒否で行う。

## Consequences

### Pros

- デフォルトも trust-host 設定時も、token がクライアントに漏れない
- LLM / 任意クライアントが preview 応答から execute を成立させられない
- ユーザーの明示確認は elicitation/MRTR の accept としてサーバー側で検証される
- decline / cancel / replay / 期限切れは execute しない

### Cons

- elicitation / MRTR 非対応ホストではチャット内での発注・取消ができない（preview のみ。手動は bitbank アプリ/ウェブ）
- SEP-1865 確認カードの「確定」ボタン経路は使えない（プレビュー表示のみ）

### 想定リスクの境界

| リスク | 評価 |
|---|---|
| preview 応答からの HITL バイパス | × token / 同等 credential を返さない |
| MCP tools/call での直接 execute | × handler が常に拒否 |
| elicitation accept の replay | × one-time nonce で拒否 |
| アカウント全資産が一発で消える | × accept は 1 件（または preview した ID 集合）にバインド |

## Future direction: SEP-2322 (Multi Round-Trip Requests)

> **2026-07-29 更新**: SEP-2322 は MCP 2026-07-28 仕様として正式リリースされ final となった。
> MRTR 経路は実装済み（第一選択）。

`requestState` は秘匿保証が無いため token を載せない。nonce + 引数 digest を署名して載せ、HMAC / 期限 / bind（呼び出し元セッションまたは認証 principal + 元の MCP method。SDK `createRequestStateCodec.bind`）+ action / digest / one-time nonce（`withElicitedConfirmation`）で検証する。stdio（sessionId 未設定）では既存挙動を維持し、HTTP 等で sessionId / principal が得られる場合は越境再利用を fail-closed で拒否する。

UI スナップショット（`src/ui-snapshot-cache.ts`）も `sessionId + resourceUri` をキーにし、別セッションによる取得・上書き・削除を防ぐ。

UI 起源の安全な識別（origin marker 等）が MCP 仕様に入り、サーバー側で認証可能になった場合に限り、iframe 実行経路の再検討余地がある。現状の仕様では再導入しない。

## 関連

- 旧設計のセキュリティ修正: PR #532, commits `f0e1cce`, `85d21c7`
- UI 案内表示への調整 / `extra.server` 渡し方の修正: PR #585, #586
- trust-host 経路の撤去: 本 ADR の 2026-08-10 更新
- 詳細実装ドキュメント: `docs/private-api.md`「`confirmation_token` の受け渡し」節
- 共通フロー実装: `src/private/elicitation.ts`
- 環境変数判定（常に false）: `src/private/config.ts` の `isHostApprovalTrusted()`
