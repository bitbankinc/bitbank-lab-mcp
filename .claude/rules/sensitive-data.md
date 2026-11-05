---
paths:
  - "tools/private/**/*.ts"
  - "src/private/**/*.ts"
  - "src/handlers/**/*.ts"
  - "lib/logger.ts"
  - "src/server.ts"
---

# 機密情報の取り扱いポリシー

## 機密情報の分類

### CRITICAL — 認証情報（漏洩＝アカウント侵害）

| 情報 | 所在 |
|---|---|
| `BITBANK_API_KEY` | 環境変数 → `src/private/config.ts` → HTTP ヘッダー |
| `BITBANK_API_SECRET` | 環境変数 → `src/private/config.ts` → HMAC 署名・確認トークン生成 |
| `ACCESS-SIGNATURE` | `src/private/auth.ts` で生成される HMAC 署名 |
| `confirmation_token` | `src/private/confirmation.ts` で生成される注文認可トークン |

### HIGH — 財務・個人情報（漏洩＝資産状況や身元の特定）

| 情報 | 所在 |
|---|---|
| 資産残高（保有量・評価額） | `get_my_assets` |
| 取引履歴（約定価格・数量・手数料） | `get_my_trade_history` |
| 注文情報（価格・数量・ステータス） | `get_order` / `get_my_orders` |
| 入出金履歴（金額・日時） | `get_my_deposit_withdrawal` |
| 暗号資産アドレス | 出金履歴の `address` フィールド |
| 銀行名 | 出金履歴の `bank_name` フィールド |
| ブロックチェーン txid | 入出金履歴の `txid` フィールド |
| ポートフォリオ損益 | `analyze_my_portfolio` |

### API が返すが出力に含めてはいけないもの

bitbank API レスポンスには含まれるが、ツール出力から意図的に除外しているフィールド:

- `account_number`（銀行口座番号）
- `account_owner`（口座名義）
- `branch_name`（支店名）
- `account_type`（口座種別）

これらを新たにツール出力に追加してはならない。

## ログ出力のルール

### 原則

- **CRITICAL 情報はログに書かない。** 例外なし。
- **HIGH 情報はツール実行結果（result）に含めない。** `logToolRun` は `ok` / `summary` / `meta` のみ記録する。
- ツール入力（input）は `maskSensitiveFields()`（`lib/logger.ts`）を通してから記録する。

### マスク対象フィールド

`lib/logger.ts` の `SENSITIVE_KEYS` で管理する。現在のマスク対象:

- `confirmation_token`
- `token`

新しい機密フィールドが input に追加される場合は `SENSITIVE_KEYS` に追加すること。

### エラーメッセージ

- API エラー応答の生のボディをエラーメッセージに含める場合は、認証情報やユーザー固有情報が混入しないことを確認する。
- `client.ts` の `toPrivateApiError` では応答本文の先頭 200 文字を含めている。bitbank API は認証情報をレスポンスに含めないため現状は安全だが、変更時は注意する。

## 開発時のチェックリスト

### Private ツール新規追加・修正時

1. **入力に機密フィールドがあるか？** → `SENSITIVE_KEYS` に追加
2. **API レスポンスに個人情報が含まれるか？** → 出力マッピングで必要なフィールドのみ抽出し、口座番号・名義等は除外
3. **エラーメッセージに機密情報が混入しないか？** → `catch` ブロックで返すメッセージを確認
4. **`content` テキストに不要な機密情報を含めていないか？** → LLM に渡す `content[0].text` の内容を確認

### テスト

- 専用の `tests/private/security.test.ts` は現行リポジトリでは管理対象外（`.gitignore` で除外）
- `tests/private/*.test.ts`（各 Private ツールのテスト）で、エラー系レスポンスに認証情報が漏洩しないことを検証する
- 新規 Private ツール追加時も同様に、漏洩防止ケースを必ず追加する
