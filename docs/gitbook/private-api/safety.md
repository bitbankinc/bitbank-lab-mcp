---
description: 発注・キャンセルを守る2ステップ確認（HITL）と事前バリデーションの仕組み
---

# 取引の安全設計（2段階確認）

取引操作（発注・キャンセル）には、誤操作・誤発注を防ぐための安全設計が組み込まれています。

{% hint style="warning" %}
ここで説明する安全対策は、誤操作や誤発注を防ぐための**補助機能**であり、その完全な防止を保証するものではありません。注文内容は必ずご自身で確認のうえ、自己の判断と責任で取引してください。
{% endhint %}

## 2ステップ確認（HITL: Human-in-the-Loop）

発注・キャンセルは **preview → ユーザーの明示確認 → execute** が必須です。AI が単独で注文を確定することはできません。

```text
発注:
1. preview_order   → 注文内容を表示（確認トークンは AI から読めない経路にのみ載る）
2. ユーザーの明示確認 → create_order を実行

キャンセル:
1. preview_cancel_order / preview_cancel_orders → キャンセル内容を表示
2. ユーザーの明示確認                          → cancel_order / cancel_orders を実行
```

* 確認トークンは **HMAC-SHA256** で生成されます（`BITBANK_API_SECRET` を鍵に使用）。**AI が読み取れる経路（`content` / `structuredContent`）には決して載りません。**
* 有効期限は **デフォルト60秒**（`ORDER_CONFIRM_TTL_MS` 環境変数で変更可能）。
* トークンは**一度きり**しか使えません（同じトークンでの二重発注は拒否されます）。
* preview 時と実行時でパラメータが一致しない場合は**改ざんとして拒否**されます。
* `requestState` は呼び出し元セッション（または認証 principal）と MCP method に束縛され、別セッションでの再利用を拒否します（stdio では従来どおり）。
* `create_order` / `cancel_order` / `cancel_orders` を MCP `tools/call` から直接呼んでもサーバー側で拒否されます。

## 確認の経路はクライアントによって変わります

| クライアント | 実行経路 | 設定 |
| --- | --- | --- |
| 確認ダイアログ（elicitation / MRTR）対応 | ネイティブダイアログで確認 | 不要（第一選択） |
| MCP Apps UI 対応（Claude Desktop 等） | 確認カードのボタンで実行 | `BITBANK_MCP_APPS_EXECUTE=1`（**既定は無効**） |
| どちらも非対応 | プレビューのみ。実行不可 | — |

{% hint style="danger" %}
**`BITBANK_MCP_APPS_EXECUTE=1` を設定する前に**

このオプションは確認トークンをツール結果の `_meta` にのみ載せ、確認カードのボタンからの実行を許可します。安全性は「**ホストが `_meta` を AI に渡さない**」という前提に依存します。

* **仕様上の保証ではありません。** MCP Apps 仕様の該当記述は "Best Practices" の箇条書きで、MUST / SHOULD を伴いません
* **ホストのアップデートで前提が崩れても、サーバー側では検知できません。壊れ方は静かです**
* この領域は実装が流動的です

万一トークンが漏れた場合でも、被害は **「直前にプレビューした注文 1 件（一括取消ならプレビュー済みの注文 ID 集合 1 セット）が、60 秒以内に 1 回だけ実行される」** に限定されます。トークンは注文内容に束縛されているため、攻撃者が金額・数量・ペア・方向を選ぶことはできません。

**以上を理解したうえで有効化してください。既定では無効です。**
{% endhint %}

{% hint style="info" %}
確認トークンは「ユーザーの最終確認を経たことの証拠」です。旧 `BITBANK_TRUST_HOST_APPROVAL`（iframe に token を `structuredContent` で載せる妥協モード）はセキュリティ上撤去済みで、設定しても無視されます。ホスト環境による挙動の違いと設計の詳細は GitHub の [docs/private-api.md](https://github.com/bitbankinc/bitbank-lab-mcp/blob/main/docs/private-api.md) と [ADR-0007](https://github.com/bitbankinc/bitbank-lab-mcp/blob/main/docs/adr/0007-hitl-confirmation-token-delivery.md) を参照してください。
{% endhint %}

## 発注前の事前バリデーション

`preview_order` は、bitbank の公式エンドポイント `GET /spot/pairs` から取得したペア仕様に照らして、発注前に内容を検証します。bitbank 側でエラーになる前に、わかりやすい日本語メッセージで止めます。

| チェック項目 | 失敗条件 |
| --- | --- |
| ペア存在 | `/spot/pairs` に該当ペアが無い |
| 取引可否 | 取引が無効化されている |
| 注文停止フラグ | 注文受付が停止されている |
| 最小/最大注文数量 | 数量が許容範囲外 |
| 数量・価格の精度 | 有効小数桁数が許容を超える |

{% hint style="info" %}
`/spot/pairs` の取得が一時的に失敗した場合は、発注を完全停止せず warning に留めて継続します（最終的な保護は bitbank 本 API 側の同等エラーで担保されます）。warning は結果の末尾に `⚠️` ブロックとして表示されます。
{% endhint %}

## 監査ログ

* 取引操作は専用カテゴリ `trade_action` でログに記録されます。
* チェーンハッシュ（SHA-256）でログの改ざんを検知できます。

## エラー時のクレデンシャル保護

* 認証エラーは静的メッセージを返し、レスポンスボディをエコーしません。
* API キー・シークレットがログ・エラーメッセージに混入しないことをテストで検証しています。

## 関連ページ

* セットアップと権限の選び方 → [概要とセットアップ](setup.md)
* 対応ツール・注文タイプ → [ツールと注文タイプ](tools.md)
