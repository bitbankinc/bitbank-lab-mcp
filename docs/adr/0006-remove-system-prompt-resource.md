# ADR-0006: `src/system-prompt.ts` の削除 — Server Instructions の責務逸脱

- **Status**: Accepted
- **Date**: 2026-04-28
- **Decision**: `src/system-prompt.ts` および `prompt://system` リソース配信を削除する

## 背景

`src/system-prompt.ts` は MCP の **Server Instructions**（ツールの使い方を理解するためにLLMが常に読むべき情報）として書かれたファイルだった。
しかし運用と内容の両面で、MCP 公式仕様（[Server Instructions: Giving LLMs a user manual for your server](https://blog.modelcontextprotocol.io/posts/2025-11-03-using-server-instructions/)）から逸脱していた。

### 配線の問題

- `McpServer` コンストラクタの `instructions` パラメータには渡されていない
- `resources/list` / `resources/read` 経由で `prompt://system` URI として公開されるのみ
- 結果、ホストが System Prompt として自動注入できず、ユーザーが UI のリソースピッカーから明示的に選んだ場合のみ会話に添付される動作になっていた

### 内容の問題（MCP 仕様アンチパターンに該当）

| 現セクション | アンチパターン |
|---|---|
| ユーザーレベル判定（初心者/中級/上級の兆候） | "Change model personality or behavior" |
| Prompts 活用ルール（Pattern 1〜6 のルーティング） | 存在しない Prompt 名（`beginner_market_check` 等）への誘導。クライアント側のオーケストレーションの仕事 |
| 応答スタイルガイドライン | "general behavioral instructions, or anything unrelated to the tools or servers" |
| 判断フローチャート / チェックリスト / 実装例 | "Don't write a manual" — 439 行の長文化 |
| 取引実行ガイドライン | "Don't rely on instructions for any critical actions ... especially in security or privacy domains. These are better implemented as deterministic rules or hooks." |

## 決定

`src/system-prompt.ts` を削除し、`prompt://system` リソース配信も廃止する。

### 削除可能と判断した根拠

1. **取引安全（HITL）はコード側で完全に強制済み** — `src/private/confirmation.ts` の `validateToken()` が `create_order` / `cancel_order` / `cancel_orders` ハンドラ冒頭で必須検証されており、`confirmation_token` / `token_expires_at` が Zod スキーマで required。`preview_*` を経由しない直接呼び出しは拒否される（HMAC-SHA256 + timing-safe 比較 + TTL + 使用済み再利用防止）
2. **Prompt ルーティング指示は無効** — 言及されていた `beginner_market_check` 等は `src/prompts.ts` に存在しない。LLM をハルシネーション方向に誘導していた
3. **応答スタイル指示は各 Prompt に内包済み** — `src/prompts.ts` の各 `messages.text` に表現ルール・出力フォーマット・対象ユーザー像が記述されており、System Prompt 不在でも各 Prompt の動作は変わらない
4. **データ整合性ポリシーは LLM の汎用能力 + Prompt 内出力フォーマットで担保** — 個別の出力フォーマット制約のほうが効果的

MCP 公式ブログの "**No instructions are better than poorly written instructions**" に従い、修正よりも削除を選択する。

## 影響範囲

- 削除: `src/system-prompt.ts`, `tests/src/system-prompt.test.ts`
- 修正: `src/server.ts`（import と `resources/list` / `resources/read` ハンドラの除去）
- 修正: `tests/server_smoke.test.ts`（resources 系アサーションの除去）
- 修正: `tools/private/create_order.ts`（コメント中の system-prompt 参照を「コードによる HITL 強制」表記に変更）

## 将来の Server Instructions の扱い

仮に今後 Server Instructions を提供する場合は、以下を厳守する。

- `McpServer({ name, version }, { instructions })` のコンストラクタ引数経由で渡す
- `resources/list` で公開しない（ユーザー UI に露出させない）
- 内容は **ツール間の関係性 / 運用制約 / データ整合性のみ**。人格・スタイル制御は書かない
- 簡潔に保つ（公式ブログの推奨は数行〜十数行程度）
- セキュリティ/プライバシー上の重要動作は Instructions に依存させない（コードで決定論的に強制する）
