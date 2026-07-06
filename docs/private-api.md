# Private API ガイド

bitbank の Private API を使って、自分の資産確認・注文操作・ポートフォリオ分析を行うためのガイドです。

## セットアップ

### 1. bitbank で API キーを発行

[bitbank 設定画面](https://app.bitbank.cc/account/api) で API キーを発行してください。**必要最小限の権限のみ付与する**ことを強く推奨します（最小権限の原則）。

| やりたいこと | 必要な権限 |
|---|---|
| 資産確認・ポートフォリオ分析（読み取り専用） | **「参照」のみ** ← 最も安全、迷ったらこちら |
| 上記 + AI に発注・キャンセル操作も任せたい | 「参照」+「取引」 |

- ⚠️ **「出金」権限は絶対に有効化しないでください**。本 MCP サーバーは出金系ツールを実装していないため、この権限を付ける必要は一切ありません。漏洩時の資産流出を避けるためです。
- **IP 制限**: bitbank 側で API キーに IP 制限を設定できる場合は、可能な限り設定を推奨します。

### 2. API キーの渡し方

クライアントによって渡し方が異なります。

#### Claude Code（Plugin install 推奨）

`/plugin install` で導入した場合は、`/plugin` の設定画面から `api_key` / `api_secret` を入力するだけで OK です。OS のキーチェーンに保管されます（手動で env を書く必要はありません）。

#### Antigravity CLI（旧 Gemini CLI・Plugin install 推奨）

`gemini-extension.json` の `settings` で対話的に入力すれば `.env` ファイルに保管されます（旧 Gemini CLI 拡張形式は Antigravity CLI が後方互換で読み込みます）。

#### Claude Desktop（手動設定）

`claude_desktop_config.json` の `env` ブロックに直接記入します:

```json
{
  "mcpServers": {
    "bitbank-lab": {
      "command": "npx",
      "args": ["-y", "bitbank-lab-mcp"],
      "env": {
        "BITBANK_API_KEY": "your_api_key",
        "BITBANK_API_SECRET": "your_api_secret"
      }
    }
  }
}
```

設定後、Claude Desktop を `Cmd+Q`（Windows は完全終了）で再起動してください。

#### Cursor / Codex（シェル環境変数）

シェルから環境変数を export してから起動します。`~/.zshrc` や `~/.bashrc` に書いておくと永続化されます。

```bash
export BITBANK_API_KEY="your_api_key"
export BITBANK_API_SECRET="your_api_secret"
```

#### 開発時（CLI から直接起動）

```bash
export BITBANK_API_KEY="your_api_key"
export BITBANK_API_SECRET="your_api_secret"
npx -y bitbank-lab-mcp
```

### 3. 確認

サーバー起動時のログに `Private API tools enabled` と表示されれば有効化されています。
キー未設定時は `Private API tools disabled` と表示され、Private ツールはスキップされます。

## キー管理の責任範囲

| 責任 | 範囲 |
|---|---|
| MCP サーバー | API キーはメモリ上のみで保持。ログ・エラーメッセージへの漏洩を防止（テスト済み） |
| ユーザー | 環境変数の安全な管理。`.env` ファイルを使う場合は `.gitignore` に追加すること |
| bitbank | API キーの発行・無効化・IP 制限 |

## 安全設計

### 入力バリデーション

- Zod スキーマによるパラメータの型・範囲チェック
- 注文タイプ別の必須パラメータ検証（limit → price 必須 等）
- stop 注文のトリガー価格妥当性チェック（即時発動の防止）
- `/spot/pairs` に照らした事前バリデーション（次節参照）

### ペア仕様の事前バリデーション（`/spot/pairs`）

`preview_order` は bitbank の公式エンドポイント `GET /spot/pairs` から取得したペア仕様に照らして、発注前に以下を検証する。bitbank 側で 60003 / 60004 / 60005 / 60006 / 70004 等のエラーになる前に分かりやすい日本語メッセージで止める。

| チェック項目 | 失敗条件 | bitbank で発生し得るエラー |
|---|---|---|
| ペア存在 | `/spot/pairs` に該当 `pair` が無い | 30000 番台 |
| 取引可否 | `is_enabled=false` | 70004 |
| 注文停止フラグ | `stop_order` / `stop_order_and_cancel` | 70004 系 |
| タイプ別停止 | `stop_market_order` / `stop_stop_order` / `stop_stop_limit_order` | 70004 系 |
| サイド別停止 | `stop_buy_order` / `stop_sell_order` | 70004 系 |
| 信用新規建て停止 | `stop_margin_long_order`（buy+long） / `stop_margin_short_order`（sell+short） | 70004 系 |
| 最小注文数量 | `amount < unit_amount` | 60003 / 60004 |
| 最大注文数量 | `amount > limit_max_amount`（limit / stop_limit）/ `market_max_amount`（market / stop） | 60011 |
| 数量精度 | `amount` の有効小数桁数 > `amount_digits` | 60005 / 60006 |
| 価格精度 | `price` / `trigger_price` の有効小数桁数 > `price_digits` | 60005 / 60006 |

**キャッシュ**:
- TTL はデフォルト 60 分。`BITBANK_SPOT_PAIRS_TTL_MS` 環境変数で上書き可能（ミリ秒）。
- ペア仕様は頻繁には変わらないため長めの TTL を採用している。

**API 取得失敗時の挙動（重要）**:
- `/spot/pairs` の取得が失敗した場合（HTTP 5xx / タイムアウト / ネットワークエラー / `success:0`）は、**プレビュー処理を完全停止せず warning に留めて発注を継続**する設計。
  - 理由: 仕様取得が一時的に落ちる度に全ユーザーが発注できなくなると UX が著しく悪化する。
  - 代替の保護: bitbank 本 API 側で同等のエラーコード（60003 / 60004 / 60005 / 60006 / 70004 等）が必ず返るため、最終的な保護は失われない。HITL 確認も維持される。
  - 検出可能性: warning は `meta.warnings: string[]` と summary 末尾の `⚠️` ブロックに記録され、ユーザー・LLM の双方から確認できる。
- 一方で、`/spot/pairs` の取得が**成功**して仕様違反が検出された場合は、`validation_error` として確実にプレビューを停止する（warning ではない）。

### 確認フロー（HITL: Human-in-the-Loop）

取引操作（発注・キャンセル）は **2ステップ確認** が必須です:

```
1. preview_order      → 注文内容を表示 + 確認トークン発行
2. create_order       → 確認トークンを検証 → 実行
```

- 確認トークンは HMAC-SHA256 で生成（`BITBANK_API_SECRET` を鍵に使用）
- 有効期限: 60秒（`ORDER_CONFIRM_TTL_MS` で変更可能）
- パラメータ改ざんを検知（トークン生成時と実行時のパラメータが一致しない場合は拒否）
- キャンセルにも同様の確認フローを適用（`preview_cancel_order` / `preview_cancel_orders`）

#### content / structuredContent / `_meta` の役割と HITL の境界

MCP 仕様（SEP-1624 の整理）では `CallToolResult.content` と `structuredContent` の役割が次のように分かれている:

- **`content`** — 会話 UX 向けの主要出力。多くのホスト（Claude Desktop など）で LLM のコンテキストに直接渡るのはここ。
- **`structuredContent`** — 機械処理・UI ウィジェット向けの構造化データ。型安全・スキーマ検証用途。
- **`_meta`** — クライアント／ホストが付随情報を渡すための領域（MCP Apps の UI ヒドレーション等）。

ただし「`structuredContent` は LLM に渡らない」というのは**ホスト依存の挙動であり、仕様上の保証ではない**。実例:

| ホスト | `content` | `structuredContent` の扱い |
|---|---|---|
| Claude Desktop | 主に LLM 入力 | 表示／補助。基本は LLM の主入力ではない（仕様保証ではない） |
| Claude Code | 主に LLM 入力 | バージョンによっては LLM 入力に流す挙動が観測されている（`anthropics/claude-code#15412`） |
| VS Code | 補助 | **`structuredContent` を優先的にモデルに渡す** |
| Cursor / Windsurf | 主に LLM 入力 | 無視する実装が多い |
| OpenAI Apps SDK | 会話に出る | ウィジェット用途。`structuredContent` と `content` は会話トランスクリプトに出る前提。`_meta` はコンポーネントへ転送 |

このため本プロジェクトでは次の原則を採る:

1. **LLM が判断すべき情報は `content[0].text` に厚く載せる。** 件数・主要フィールド・warning・打ち切り状態・ユーザー確認が必要な旨は、`content` を読んだだけで判断できるようにする。`.claude/rules/tools.md` の「content テキストにデータを含める」も参照。
2. **`structuredContent` は UI / 機械処理 / 将来クライアント向けの補助データ**として扱う。「LLM 非可視」を安全境界とは**みなさない**。設計上 `structuredContent` を読むのは UI ウィジェット・Inspector・スクリプトと想定する。
3. **CRITICAL 情報（`BITBANK_API_KEY` / `BITBANK_API_SECRET` / `ACCESS-SIGNATURE` 等）は `content` / `structuredContent` / `_meta` のどこにも載せない。** `.claude/rules/sensitive-data.md` の CRITICAL 区分に従う。
4. **`confirmation_token`** は CRITICAL 寄りの「実行鍵」。後述の「`confirmation_token` の受け渡し」節に従い、`content[0].text` には載せず、ホスト UI / elicitation 経路を主流とする。

#### `confirmation_token` の受け渡し

`confirmation_token` は本来「ユーザーの最終確認を経たことの証拠」であり、LLM が独断で引用して `create_order` を呼べる文字列にしてはならない。実装は次の階層で扱う（設計判断の背景と SEP-2322 への移行計画は `docs/adr/0007-hitl-confirmation-token-delivery.md` を参照）:

1. **第一選択（elicitation 対応ホスト）** — `preview_order` ハンドラ内で `server.elicitInput` によりユーザー確認 → 同一ハンドラ内で `create_order` を呼び出して完結。**トークンはサーバープロセス内に閉じ、LLM/クライアントには返らない**。Claude Desktop / Claude Code のうち elicitation 対応版はこの経路。
2. **第二選択（SEP-1865 対応ホスト + `BITBANK_TRUST_HOST_APPROVAL=1` オプトイン）** — iframe (`_meta.ui.resourceUri`) に `confirmation_token` / `expires_at` を含む `structuredContent` を返し、iframe ボタン → `app.callServerTool` の経路で `create_order` を実行する。`structuredContent` は LLM にも見えうるため、「ホスト（Claude Desktop / claude-ai 等）のツール承認 UI を最終 gate として信頼する」という前提を受け入れたユーザーがオプトインで有効化する。詳細は `docs/adr/0007-hitl-confirmation-token-delivery.md`。
3. **フォールバック（上記いずれも非該当のホスト）** — `content` / `structuredContent` / `_meta` のいずれにも `confirmation_token` / `expires_at` を返さない。プレビュー内容だけを返し、「このホストでは取引実行に対応していない」旨を `content[0].text` に明記する。LLM が `create_order` / `cancel_order` / `cancel_orders` を直接呼んでも、トークン検証で拒否される。

なお `content[0].text` には常に以下を載せる（LLM のハルシネーション防止）:

- 注文／キャンセル対象の主要フィールド（pair / side / type / amount / 価格 / トリガー価格 / `position_side`）
- 上流／事前バリデーションの warning
- ユーザーの最終確認が必要であること

これにより、LLM が `structuredContent` をまったく見られないクライアント（Cursor / Windsurf 系）でも、ユーザー確認の必要性と概要を理解した上で対話を継続できる。

#### `BITBANK_TRUST_HOST_APPROVAL=1` オプトインモード

elicitation を advertise していないが SEP-1865 iframe をサポートするホスト（Claude Desktop / claude-ai 等、2026-05 時点の実装）で取引 UX を取り戻すための妥協モード。

有効化条件:
- 環境変数 `BITBANK_TRUST_HOST_APPROVAL=1` を MCP サーバープロセスに渡す
- クライアントが elicitation を advertise していない
- `withElicitedConfirmation` の caller が `trustHostFallback` を指定している（3 つの preview ツールはすべて指定済み）

このモードでは:
- `structuredContent.data.confirmation_token` / `expires_at` が返る
- iframe (`ui/order-confirm` / `ui/cancel-confirm`) がボタンを描画し、ユーザークリックで `app.callServerTool('create_order' | 'cancel_order' | 'cancel_orders', ...)` を呼ぶ
- `content[0].text` には「iframe ボタンを押してください」と明示

セキュリティ前提（これらを受け入れないなら有効化しない）:
- LLM が `structuredContent` 経由で token を見られる
- ホスト（Claude Desktop 等）のツール承認 UI が "Allow always" されていない
- LLM が `create_order` 等を直接呼ばないことを description 等で促す（強制力は無い）

長期的には MCP SEP-2322 (`InputRequiredResult` / `requestState`) に置き換えて撤去する。

#### 将来の代替案 / 移行計画

- **SEP-2322 (Multi Round-Trip Requests)** — 2026-07-28 release candidate で導入。`InputRequiredResult` + 不透明 `requestState` 文字列で「LLM 不可視のままサーバーがユーザー確認を取る」を仕様内で実現できる。`BITBANK_TRUST_HOST_APPROVAL` モードの構造的後継。TypeScript SDK 対応待ち。詳細は `docs/adr/0007-hitl-confirmation-token-delivery.md`
- **サーバー側 pending action store** — SEP-2322 が来る前の中間案。`preview_*` がサーバー内 Map に pending entry を作り、短い不透明 ID を返す。`create_order` 等は ID + 独立した同意シグナルを要求する。ただし SEP-1865 では「独立した同意シグナル」を仕様化していないので、現状では「ホスト承認 UI を信頼する」前提を回避できない
- **`_meta` 経由の UI 専用チャネル** — OpenAI Apps SDK 慣習。MCP 基本仕様としては「`_meta` は LLM 非可視」を保証しないため、これ単体で安全境界とはしない
- **elicitation 非対応ホストの明示的サポート縮退** — 「HITL 強制が必要なホストは elicitation か SEP-2322 のどちらかを要求する」とする方針

### 検証の責務分担（preview と create）

注文の事前検証は **`preview_order` を主責務** とする設計。`create_order` は HITL 確認 + bitbank 本 API の最終ガードを軸に、preview から create までの間に状態が変化し得る項目のみを軽量に再検証する。

| 検証項目 | `preview_order` | `create_order` |
|---|---|---|
| パラメータ型・必須項目（Zod・注文タイプ別必須項目） | ✓ | ✓（Zod のみ） |
| `/spot/pairs` ペア仕様（最小数量・桁数・停止フラグ） | ✓ | ✓（再検証） |
| トリガー価格 vs 現在価格（stop / stop_limit） | ✓ | ✓（再検証、ticker 1 回） |
| 確認トークン（HMAC + ワンショット + 有効期限） | —（発行） | ✓（検証） |
| bitbank 本 API の最終バリデーション | — | ✓（暗黙） |

- **preview**: 入力バリデーションをまとめて実施。違反があれば `validation_error` で即停止し、確認トークンを発行しない。LLM がトークンを使い回せないよう、ここで弾くのが第一線。
- **create**: 確認トークンの検証（HITL）が主目的。preview から発注までの間隔は最大 60 秒程度だが、その間に pair の状態（`stop_order` 等）や市場価格が変化する可能性があるため、`/spot/pairs` 仕様とトリガー価格のみ再検証する。トークンによってパラメータ改ざんは検出済みのため、純粋な入力依存の検証（正/負の数値チェック等）は再実施しない。
- `/spot/pairs` の取得が失敗した場合は preview と同じく warning に留めて発注を継続する（最終ガードは bitbank 本 API 側の同等のエラーで担保される）。
- 違反が検出された場合は `validation_error` で発注を停止する。このとき確認トークンは既にワンショット消費済みのため、ユーザーは preview からやり直す必要がある（再 preview で違反原因が表示される）。

### 監査ログ

- 取引操作は専用カテゴリ `trade_action` でログに記録
- チェーンハッシュ（SHA-256）でログの改ざんを検知可能
- `scripts/verify_log_integrity.ts` でチェーンハッシュの整合性を検証

### エラーハンドリング（クレデンシャル漏洩防止）

- 認証エラー（20001〜20005）は静的メッセージを返し、レスポンスボディをエコーしない
- Private API クライアント（`src/private/client.ts`）は `PrivateApiError` に分類し、bitbank の JSON 本文をそのままユーザー向けメッセージに載せない設計（認証・レート制限・HTTP 401/403 は固定文言）
- 予期しない例外のメッセージは `fail()` / `failFromError()` 経由で `Error.message` 等に依存するが、**現状コードベースでは「200 文字への一律切り詰め」は実装していない**（将来追加する場合は `lib/error.ts` または `failFromError` 側の集約が望ましい）
- HTTP 401/403 でも API キーを露出しない
- ログへのクレデンシャル混入防止テスト済み

## 対応ツール一覧

### 参照系（「参照」権限のみで使える、副作用なし）

| ツール | 説明 |
|---|---|
| `get_my_assets` | 保有資産一覧（JPY 評価額付き） |
| `get_my_trade_history` | 約定履歴（全ペア or 指定ペア） |
| `get_my_orders` | 注文一覧（アクティブ注文） |
| `get_order` | 注文照会（単一） |
| `get_orders_info` | 注文照会（複数） |
| `analyze_my_portfolio` | ポートフォリオ損益分析 |
| `get_my_deposit_withdrawal` | 入出金履歴 |
| `get_margin_status` | 信用取引ステータス（保証金・ロスカット率・新規建て可能額） |
| `get_margin_positions` | 信用建玉一覧（追証・不足金アラート付き） |
| `get_margin_trade_history` | 信用約定履歴（新規建て・決済、実現損益・利息を含む） |

### 取引系（「取引」権限が必要、2ステップ確認必須）

| ステップ 1 (Preview) | ステップ 2 (Execute) | 説明 |
|---|---|---|
| `preview_order` | `create_order` | 注文の発注（現物・信用） |
| `preview_cancel_order` | `cancel_order` | 注文キャンセル（単一） |
| `preview_cancel_orders` | `cancel_orders` | 注文キャンセル（一括、最大30件） |

### 対応注文タイプ

`preview_order` / `create_order` で発注できる `type` は以下の 4 種類のみです。

| `type` | 説明 | 必須パラメータ |
|---|---|---|
| `limit` | 指値注文 | `price` |
| `market` | 成行注文 | （なし） |
| `stop` | 逆指値注文（トリガー到達で成行発注） | `trigger_price` |
| `stop_limit` | 逆指値指値注文（トリガー到達で指値発注） | `trigger_price`, `price` |

bitbank 公式 REST API spec の `POST /v1/user/spot/order` は上記に加え `take_profit` / `stop_loss` / `losscut` も `type` として列挙していますが、本 MCP サーバーでは **意図的に未対応** としています。

| 未対応 type | 理由 |
|---|---|
| `take_profit` / `stop_loss` | 公式 docs に動作仕様が記載されていない（発動方向、`amount` 省略時の決済範囲、現物 vs 信用の適用可否がすべて未定義）。`amount` を省略可能な注文タイプであるため建玉の全量決済を引き起こす可能性があり、誤実装による意図しない決済リスクを避けるため除外。bitbank が公式ドキュメントで仕様を明示した時点で対応を再検討します。 |
| `losscut` | システム発動の強制決済タイプ。ユーザーが入力する注文タイプではありません。 |

これらの `type` を指定すると Zod バリデーションエラー（`validation_error`）で拒否されます。発注された既存の `take_profit` / `stop_loss` / `losscut` 注文を **照会**することは `get_order` / `get_my_orders` / `get_orders_info` で可能です（レスポンスの `type` は文字列として受け入れる）。

### 信用取引について

`preview_order` / `create_order` に `position_side`（`long` / `short`）を指定すると信用注文として扱われます。

| 操作 | side | position_side |
|---|---|---|
| ロング新規建て | `buy` | `long` |
| ロング決済 | `sell` | `long` |
| ショート新規建て | `sell` | `short` |
| ショート決済 | `buy` | `short` |

**注意事項**:
- 信用取引には bitbank での申込・審査が必要です（未審査の場合はエラーコード 50058）
- 損失が保証金を超える可能性があります
- 利息・手数料は決済時に徴収されます
- 建玉管理は平均法（加重平均）で行われます

### 手数料の取り扱い（3 カテゴリ）

手数料は **見積り（estimate）** と **実績（actual）** でソースが異なります。混同するとハルシネーションや
誤った発注見積りの原因になるため、以下の taxonomy で厳密に分けています（開発ルール: `.claude/rules/fees.md`）。

| | カテゴリ | 見積り（estimate）のソース | 実績（actual）のソース |
|---|---|---|---|
| **A** | 取引手数料 maker/taker | `GET /v1/spot/pairs` の `taker_fee_rate_quote` / `maker_fee_rate_quote` | `trade_history` の実額（`fee_amount_*` / `fee_occurred_amount_quote`） |
| **B** | 信用 手数料 / 利息 | `/spot/pairs` の `margin_{open,close}_{maker,taker}_fee_rate_quote` | `trade_history` の実額（`fee` / `interest`） |
| **C** | 入出金 / 出金手数料 | API 値パススルー（`withdrawal_fee` 等） | 同左 |

- **見積り（A / B）**は `preview_order` が `/spot/pairs` のレート（`lib/fees.ts` 経由）で算出します。
  - 信用（B）は `position_side` から **新規(open) / 決済(close)** を判定し、対応する `margin_*` レートを使います。
  - 信用レートが API 未提供（`null`）の場合は公称 taker で概算し、「信用手数料率が API 未提供のため概算」と明示します。
  - **利息（interest）は見積りには含めません**（決済時に確定するため）。実績は `get_margin_trade_history` の `interest` を参照してください。
- **実績**は `get_my_trade_history` / `get_margin_trade_history` / `analyze_my_portfolio` が
  約定履歴の実額（手数料・利息を別建て）で計上します。見積りレートでは上書きしません。
- **入出金手数料（C）**は API の返す値をそのまま出力します（A/B の見積りロジックは通しません）。

## 制限事項

- bitbank API のレート制限に従う（429 エラー時は自動リトライ）
- 注文の最小/最大数量・価格刻みは `/spot/pairs` の仕様に準拠（`preview_order` で事前検証。失敗時の挙動は「ペア仕様の事前バリデーション」節を参照）
- 信用取引のリアルタイム通知（ストリーム）は未対応

## トラブルシューティング

**Q. Private ツールが表示されない**
→ `BITBANK_API_KEY` と `BITBANK_API_SECRET` の両方が設定されているか確認。片方だけでは有効化されません。

**Q. 認証エラーが出る**
→ bitbank 設定画面で以下を確認してください:
- API キーの**有効期限**が切れていないか
- **権限**が用途に足りているか — 参照系ツール（`get_my_assets` 等）には「参照」、取引系ツール（`create_order` 等）には「参照」+「取引」が必要
- **IP 制限**を設定している場合、現在の IP からアクセスできるか

**Q. 確認トークンの有効期限が切れる**
→ デフォルト 60 秒です。`ORDER_CONFIRM_TTL_MS` 環境変数で調整できます（ミリ秒単位）。
