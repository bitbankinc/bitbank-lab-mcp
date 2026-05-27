# bitbank-lab-mcp

[![CI](https://github.com/tjackiet/bitbank-genesis-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/tjackiet/bitbank-genesis-mcp-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/bitbank-lab-mcp.svg)](https://www.npmjs.com/package/bitbank-lab-mcp)
[![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/tjackiet/bitbank-genesis-mcp-server?utm_source=oss&utm_medium=github&utm_campaign=tjackiet%2Fbitbank-genesis-mcp-server&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews)](https://coderabbit.ai)

> bitbank API のデータを使った暗号資産市場分析を、Claude / Cursor / Codex / Gemini CLI など各種 AI クライアントから簡単に実行できる MCP サーバーです。

## はじめにお読みください

- 本ツールは**開発段階（ベータ版）**です。利用は**自己責任**でお願いします。
- ご利用の前に必ず [⚠️ 免責事項](#免責事項) をお読みください。
- 本リポジトリは **bitbank バグバウンティプログラムの対象範囲外** です。

## 本 MCP サーバーについて

bitbank の公開 API から取得した価格・取引データを、指標計算・統合・可視化用データの整形まで行った上で LLM に渡します（必要に応じてサーバー側で SVG 描画も可能）。生データを渡すだけのサーバーとは異なり、各ツールの description に「いつ使うべきか」「他ツールとの使い分け」を明示しているため、LLM が自律的に適切なツールを選択できます。

姉妹プロジェクトとして、同じ bitbank API に対する真逆のアプローチを提供する **CLI** ([bitbank-cli-skills](https://github.com/tjackiet/bitbank-cli-skills)) もあります。

- **この MCP サーバー** はサーバー側で計算済みの結論を LLM に渡す
- **CLI** は生データを高速に取得し、LLM 自身に計算させる

指標のパラメータやロジックを完全にカスタマイズしたい場合は CLI 側を、すぐに使えるテクニカル分析・可視化を求める場合は MCP サーバー側を選んでください。

## 概要
bitbank の公開 API から価格・板情報・約定履歴・ローソク足データを取得し、以下の分析を実行できます。
→ 全ツールの一覧と使い分けは [docs/tools.md](docs/tools.md) を参照。

#### 取得できるデータ
- リアルタイム価格（ティッカー）
- 板情報（オーダーブック）
- 約定履歴（売買方向・時刻）
- ローソク足（1分足〜月足）

#### 実行できる分析
- テクニカル指標（SMA/RSI/ボリンジャーバンド/一目均衡表/MACD）
- フロー分析（買い/売りの勢い・CVD・スパイク検出）
- ボラティリティ分析（RV/ATR）
- 板の圧力分析（価格帯ごとの買い/売り圧力）
- パターン検出（ダブルトップ/ヘッドアンドショルダーズ等）
- 総合スコア判定（複数指標を統合した強弱判定）
  - 長期パターンの現在地関連検出（detect_patterns: requireCurrentInPattern/currentRelevanceDays）

#### 視覚化
- Claude.ai の Visualizer で描画するためのコンパクトな整形データを返すツール群
  - `prepare_chart_data`: ローソク足 + 指標の時系列データ（全指標は計算・シフト適用済み）
  - `prepare_depth_data`: 板の累積 volume 階段データ（[price, cumulativeVolume][] + mid / spread / band 集計）
- ファイル保存・Cursor 等の非 Visualizer 環境向けに SVG/PNG 形式のチャートも生成可能
  - `render_chart_svg` / `render_depth_svg` / `render_candle_pattern_diagram`
  - ※ クライアント側で描画可能な場合は `prepare_*` 系を優先。SVG 生成は LLM が自力で描けない環境のフォールバック。

## クイックスタート

### 前提条件
- **Node.js 22 以上**（24 推奨 — CI で検証済み。[公式サイト](https://nodejs.org/) からインストール。`node -v` で確認できます）
- npm（Node.js に同梱されています）
- 対応 OS: macOS / Linux / Windows（WSL 含む）

> 本プロジェクトは npm に [`bitbank-lab-mcp`](https://www.npmjs.com/package/bitbank-lab-mcp) として公開されています。**ソースコードのクローンは不要**です（開発したい方向けの手順は[末尾の開発者向けセクション](#開発者向けソースから起動)を参照）。

### 1. Claude Desktop に登録（最短・推奨）

Claude Desktop が最も多くの方が使う想定の MCP クライアントです。`~/Library/Application Support/Claude/claude_desktop_config.json` に設定を追加します。

設定方法は2通りあります。**まず方式A を試し、動かない場合に方式B をお試しください。**

#### 方式A：`npx` 経由（推奨）

Node.js のバージョンアップで設定を書き換える必要がないため、こちらを推奨します。nvm/volta などのバージョン管理ツールをお使いの方には特におすすめです。

**Public ツールのみ使う場合（API キー不要）**:

```json
{
  "mcpServers": {
    "bitbank-lab": {
      "command": "npx",
      "args": ["-y", "bitbank-lab-mcp"]
    }
  }
}
```

**Private ツールも使う場合（API キーあり）**:

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

API キーは [bitbank 設定画面](https://app.bitbank.cc/account/api) で発行してください。**必要最小限の権限のみ付与する**ことを強く推奨します（最小権限の原則）。

| やりたいこと | 必要な権限 |
|---|---|
| 資産確認・ポートフォリオ分析（読み取り専用） | **「参照」のみ** ← 最も安全、迷ったらこちら |
| 上記 + AI に発注・キャンセル操作も任せたい | 「参照」+「取引」 |

⚠️ **「出金」権限は絶対に有効化しないでください**。本 MCP サーバーは出金系ツールを実装していないため、この権限を付ける必要は一切ありません。漏洩時の資産流出を避けるためです。

**IP 制限**: bitbank 側で API キーに IP 制限を設定できる場合は、可能な限り設定を推奨します。詳細: [Private API ガイド](docs/private-api.md)。

#### 方式B：`npx` の絶対パスを指定（フォールバック）

方式A で「サーバーに接続できません」エラーが出る場合、Claude Desktop から `npx` コマンドが見つけられていない可能性があります。その場合は、`npx` の絶対パスを指定してください。

まずターミナルで自分の環境の `npx` パスを確認します：

```bash
which npx
```

出力例と対応するインストール方法：

| `which npx` の出力 | インストール方法 |
|---|---|
| `/opt/homebrew/bin/npx` | Homebrew（Apple Silicon Mac） |
| `/usr/local/bin/npx` | Homebrew（Intel Mac）または公式インストーラ |
| `/Users/XXX/.nvm/versions/node/vXX.XX.X/bin/npx` | nvm |
| `/Users/XXX/.volta/bin/npx` | volta |

`which npx` の結果を `command` に指定：

```json
{
  "mcpServers": {
    "bitbank-lab": {
      "command": "<which npx の出力>",
      "args": ["-y", "bitbank-lab-mcp"]
    }
  }
}
```

> ⚠️ **nvm/volta ユーザーへの注意**: この方式では Node.js をバージョンアップするたびに `command` のパスの書き換えが必要です（例: `v24.0.0` → `v24.1.0`）。アップデート後に `which npx` を再確認してください。

#### Windows の場合

Windows でも方式A の `npx` 経由がそのまま使えます：

```json
{
  "mcpServers": {
    "bitbank-lab": {
      "command": "npx",
      "args": ["-y", "bitbank-lab-mcp"]
    }
  }
}
```

設定ファイルの場所: `%APPDATA%\Claude\claude_desktop_config.json`

`npx` が見つからない場合は `where npx`（Windows 版の `which`）で絶対パスを確認して指定してください。

#### 表示名のカスタマイズ

Claude Desktop の UI に表示される名前は `claude_desktop_config.json` のキー名で決まります：

```json
{
  "mcpServers": {
    "ビットバンクMCP": {
      "command": "npx",
      "args": ["-y", "bitbank-lab-mcp"]
    }
  }
}
```

日本語名も使用可能です。

#### 共通の注意事項

- 追加後、Claude Desktop を `Cmd+Q`（Windows は完全終了）で再起動してください
- ⚠️ macOS で `claude_desktop_config.json` が見つからない場合は、ホームディレクトリ直下から開いてください

設定ファイルの場所：
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

### 2. Plugin として install（Claude Code / Cursor / Codex / Gemini CLI）

これらのクライアントには plugin manifest（`.claude-plugin/plugin.json` ほか 3 種）を同梱しています。各クライアントの `/plugin install`（または相当のコマンド）でこのリポジトリを指定するだけでセットアップが完了します。**API キー入力 UI を備えているのは Claude Code と Gemini CLI のみ** — Cursor / Codex はシェル環境変数で API キーを渡す方式です（後述）。

| クライアント | manifest | API キーの渡し方 |
|---|---|---|
| Claude Code | `.claude-plugin/plugin.json` | ✅ **GUI で入力**: `/plugin install` 直後に `userConfig` UI が表示され、OS キーチェーンに保管 |
| Gemini CLI | `gemini-extension.json` | ✅ **対話 prompt**: `settings` 配列で対話的に入力、`.env` に保管 |
| Cursor | `.cursor-plugin/plugin.json` | ⚙️ **シェル環境変数のみ**: `BITBANK_API_KEY` / `BITBANK_API_SECRET` を環境変数に設定（Cursor は plugin 経由の prompt 未対応） |
| Codex | `.codex-plugin/plugin.json` | ⚙️ **シェル環境変数のみ**: `BITBANK_API_KEY` / `BITBANK_API_SECRET` を環境変数に設定 |

> いずれの manifest も npm registry の [`bitbank-lab-mcp`](https://www.npmjs.com/package/bitbank-lab-mcp) を `npx -y` 経由で起動します。

**Claude Code の例**:

```bash
# 1. このリポジトリを marketplace として登録（初回のみ）
/plugin marketplace add tjackiet/bitbank-genesis-mcp-server

# 2. plugin を install
/plugin install bitbank-lab-mcp@bitbank-lab

# 3. plugin を有効化
/reload-plugins
```

`bitbank-lab` はこのリポが提供する marketplace 名（`.claude-plugin/marketplace.json` の `name` フィールド）、`bitbank-lab-mcp` は plugin 名です。

実行後、bitbank API key / API secret の入力 UI が表示されます。**Public ツールだけで使う場合は両方とも空欄で OK** — Private API ツールは API キーを入力したときだけ自動的に有効化されます。

> API キーを後から追加・変更したい場合は `/plugin` から該当 plugin の設定を開き、`api_key` / `api_secret` を更新してください。Claude Code では `sensitive: true` のため OS のキーチェーンに保管されます。

**Cursor / Codex の場合（環境変数経由）**:

`/plugin install` 実行後、シェルで以下のように環境変数を設定してから Cursor / Codex を起動してください（Public ツールだけ使う場合は不要）:

```bash
export BITBANK_API_KEY="your_api_key"
export BITBANK_API_SECRET="your_api_secret"
```

macOS / Linux では `~/.zshrc` や `~/.bashrc` に書いておくと永続化されます。Windows は環境変数の管理画面 or `setx` を使用してください。

### 3. その他の MCP クライアント（手動 `.json` 編集）

#### Cursor（`.cursor/mcp.json`）

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

API キーが不要な場合は `env` ブロックごと削除して OK。

#### Claude Code（CLI から登録する場合）

[セクション 2](#2-plugin-として-installclaude-code--cursor--codex--gemini-cli) の plugin install を推奨しますが、CLI から手動登録する場合は：

```bash
claude mcp add --transport stdio bitbank-lab -- npx -y bitbank-lab-mcp
```

#### Windsurf / その他の汎用 MCP クライアント

Cursor と同じ JSON 形式で登録できます。クライアント固有の設定ファイルパスについては各クライアントのドキュメントを参照してください。

### 4. 使ってみる
AI クライアントにそのまま話しかけます:
```
BTCの今の市場状況を分析して
ビットコインは買いと売りどちらが優勢？
直近 1 週間でテクニカル的に上向きの仮想通貨を 3 つ教えて
```

💡 **何を聞けばいいかわからない場合**: [用意されたプロンプト集](docs/prompts-table.md) をご覧ください。初心者向け（🔰）から中級者向けまで、9種類の分析プロンプトを用意しています。

🌅 **朝のルーティンに**: 「おはようレポート」で、寝ている間の相場変動をすばやくキャッチアップできます。


## Private API（取引機能）

API キーの有無でサーバーが公開する機能が自動的に切り替わります。

| 設定 | ツール数 | プロンプト数 | 使える機能 |
|------|---------|------------|-----------|
| キー未設定 | 31（Public のみ） | 9 | 価格取得・テクニカル分析・チャート生成・バックテスト |
| キー設定済み | 31 + 16 = **47** | 9 + 1 = **10** | 上記 + 資産確認・注文・ポートフォリオ分析 |

キー未設定時、Private ツール・プロンプトは MCP クライアントに一切表示されません（エラーではなく、そもそも登録されません）。公開データの取得・分析だけなら設定不要で、そのまま使えます。

### 環境変数の設定方法

**ターミナルから起動する場合:**
```bash
export BITBANK_API_KEY="your_api_key"
export BITBANK_API_SECRET="your_api_secret"
```

**Plugin install を使った場合** — `/plugin` から該当 plugin の設定を開き、`api_key` / `api_secret` を入力すれば完了です（手動編集は不要）。

**Claude Desktop で手動設定している場合** — `claude_desktop_config.json` の `env` に追加（[セクション 1](#1-claude-desktop-に登録最短推奨) で設定した方式A／方式B のいずれかに、以下のように `BITBANK_API_KEY` と `BITBANK_API_SECRET` を追加するだけです）:
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

API キーは [bitbank 設定画面](https://app.bitbank.cc/account/api) で発行してください。**必要最小限の権限のみ付与する**ことを強く推奨します（最小権限の原則）。

| やりたいこと | 必要な権限 |
|---|---|
| 資産確認・ポートフォリオ分析（読み取り専用） | **「参照」のみ** ← 最も安全、迷ったらこちら |
| 上記 + AI に発注・キャンセル操作も任せたい | 「参照」+「取引」 |

⚠️ **「出金」権限は絶対に有効化しないでください**。本 MCP サーバーは出金系ツールを実装していないため、この権限を付ける必要は一切ありません。漏洩時の資産流出を避けるためです。

**IP 制限**: bitbank 側で API キーに IP 制限を設定できる場合は、可能な限り設定を推奨します。

| カテゴリ | ツール | 説明 | 必要な権限 |
|---|---|---|---|
| 口座情報 | `get_my_assets` | 保有資産一覧 | 参照 |
| 注文照会 | `get_my_orders`, `get_order`, `get_orders_info` | 注文の照会 | 参照 |
| 約定履歴 | `get_my_trade_history` | 約定履歴の取得 | 参照 |
| ポートフォリオ | `analyze_my_portfolio` | 損益分析・パフォーマンス | 参照 |
| 入出金 | `get_my_deposit_withdrawal` | 入出金履歴 | 参照 |
| 信用取引 | `get_margin_status`, `get_margin_positions`, `get_margin_trade_history` | 証拠金・ポジション・約定履歴 | 参照 |
| 発注 | `preview_order` → `create_order` | 2ステップ確認付き発注 | 取引 |
| キャンセル | `preview_cancel_order` → `cancel_order` | 2ステップ確認付きキャンセル | 取引 |
| 一括キャンセル | `preview_cancel_orders` → `cancel_orders` | 2ステップ確認付き一括キャンセル | 取引 |

取引操作（発注・キャンセル）は **preview → execute の2ステップ確認**が必須です。preview ツールが発行する確認トークン（HMAC-SHA256、デフォルト60秒有効）なしでは実行できません。

詳細: [docs/private-api.md](docs/private-api.md)

## 使用例（会話の型）
- 「今、BTC は買いですか？」→ `analyze_market_signal`: 総合スコア + 寄与度・根拠
- 「直近で MACD クロスした銘柄は？」→ `detect_macd_cross`: スクリーニング結果
- 「ここ 30 日のボラ推移を見たい」→ `get_volatility_metrics` + `render_chart_svg`

## チャート表示（SVG）
- MCP クライアント（Claude）では、アーティファクトとして `data.svg` を表示するようにお願いしてください。
  - Claude で LLM がうまくアーティファクトを出力できない場合は、以下のプロンプトを加えるのがおすすめです。
    - 「identifier と title を追加して、アーティファクトとして表示して」 
  - 既定の描画は「ロウソク足のみ」。ボリンジャーバンド等のオーバーレイは明示指定時に追加されます（BBは `--bb-mode=default` 指定時に ±2σ がデフォルト）。

## 詳細ドキュメント
- プロンプト集（初心者〜中級者向け）: [docs/prompts-table.md](docs/prompts-table.md)
- ツール一覧と使い分け: [docs/tools.md](docs/tools.md)
- Private API ガイド: [docs/private-api.md](docs/private-api.md)
- 変更履歴: [CHANGELOG.md](CHANGELOG.md)
- 開発者向けガイド（型生成・CI など）: [CLAUDE.md](CLAUDE.md)
- 運用・監視（ログ集計／Docker起動 ほか）: [docs/ops.md](docs/ops.md)

## よくある質問（FAQ）
**Q. 何を聞けばいいかわからない** [プロンプト集](docs/prompts-table.md) を参照してください。初心者向け🔰から中級者向けまで9種類の分析プロンプトを用意しています。

**Q. Docker は必須？** いいえ。Node 18+ でローカル実行できます（最短は Claude Desktop 登録）。

**Q. API キーは必要？** 公開データの取得・分析には不要です。自分の資産確認や注文操作（Private API）を使う場合は [Private API ガイド](docs/private-api.md) を参照してください。

**Q. どのツールを使えばよい？** まず `analyze_market_signal` で全体を把握 → 必要に応じて各専門ツールへ。

**Q. 対応銘柄は固定？** 固定ではありません。上流の公開 API が返す銘柄に自動追随します（追加/廃止も自動反映）。参考: [bitbank 公開API仕様](https://github.com/bitbankinc/bitbank-api-docs/blob/master/public-api.md)

**Q. MCP Inspector でも試せる？** はい。次で実行できます（npm 公開版に対する動作確認）。
```bash
npx @modelcontextprotocol/inspector -- npx -y bitbank-lab-mcp
```
ソースコードから動かす場合は `npx @modelcontextprotocol/inspector -- tsx src/server.ts`（[開発者向け](#開発者向けソースから起動) を参照）。

## トラブルシューティング

| 症状 | 原因・対処 |
|------|-----------|
| Claude Desktop にツールが表示されない | `claude_desktop_config.json` の JSON 構文が壊れている / Claude Desktop を `Cmd+Q`（Windows は完全終了）で再起動していない |
| 「サーバーに接続できません」エラー（npx 方式） | Claude Desktop から `npx` が見つからない可能性。[方式B（npx 絶対パス）](#方式bnpx-の絶対パスを指定フォールバック)に切り替える |
| `spawn npx ENOENT` エラー | `which npx` の結果が異なるパスを指している。`command` を正しいパスに書き換える |
| Node.js アップデート後に MCP が動かなくなった | nvm/volta の場合、Node.js バージョンが変わると絶対パスも変わる。`which npx` を再確認して `command` を更新するか、方式A（`npx` 名指し）に切り替える |
| `Cannot find package 'tsx'` エラー | `bitbank-lab-mcp` の古い版（v0.1.0）でこの問題が発生。`npx -y bitbank-lab-mcp@latest` で最新版に更新するか、設定を再起動 |
| ツール実行時にタイムアウト | ネットワーク接続を確認 / [bitbank API の状態](https://status.bitbank.cc/)を確認 |
| Private API ツールが表示されない | `BITBANK_API_KEY` と `BITBANK_API_SECRET` の両方が設定されているか確認（→ [docs/private-api.md](docs/private-api.md)） |
| ログを確認したい | `env` に `"LOG_LEVEL": "debug"` を追加して再起動 |
| Plugin install で「Marketplace not found」 | `/plugin marketplace add tjackiet/bitbank-genesis-mcp-server` を先に実行してから `/plugin install bitbank-lab-mcp@bitbank-lab` |

---

## 開発者向け（ソースから起動）

このセクションは「自分で MCP サーバーをいじりたい」「PR を送りたい」という開発者向けです。**通常の利用者は[セクション 1](#1-claude-desktop-に登録最短推奨) の `npx -y bitbank-lab-mcp` 方式で OK** です（こちらは clone 不要）。

### セットアップ

```bash
git clone https://github.com/tjackiet/bitbank-genesis-mcp-server.git
cd bitbank-genesis-mcp-server
npm ci
```

`package-lock.json` 通りに依存をインストールするため、ローカル開発でも `npm install` ではなく `npm ci` を推奨します（CI も `npm ci` を使用）。

ビルドステップは不要です（tsx で TypeScript を直接実行します）。

### STDIO モード（既定 — Claude Desktop / Claude Code 向け）

ローカルの開発版を Claude Desktop から使いたい場合、`claude_desktop_config.json` に絶対パス指定で登録します：

```json
{
  "mcpServers": {
    "bitbank-dev": {
      "command": "npx",
      "args": ["tsx", "/ABS/PATH/to/src/server.ts"],
      "workingDirectory": "/ABS/PATH/to/project",
      "env": { "LOG_LEVEL": "debug", "NO_COLOR": "1" }
    }
  }
}
```

`/ABS/PATH/to/` を実際のクローン先パス（`pwd` で確認）に置き換えてください。**npm 公開版（`bitbank-lab`）と区別するため、サーバー名は `bitbank-dev` 等にしておくと両立できます**。

Inspector で動作確認する場合:
```bash
npx @modelcontextprotocol/inspector -- tsx src/server.ts
```

### HTTP モード（Web クライアント・開発検証向け）

HTTP transport は注文・キャンセル等の Private API ツールも提供しうるため、**必ず Bearer トークン認証と rate limit を経由**する。
`MCP_HTTP_TOKEN` を設定しないと起動を拒否する（stdio 経路は影響を受けない）。

```bash
# Bearer トークンを発行（例: openssl で 32 byte ランダム）
export MCP_HTTP_TOKEN="$(openssl rand -hex 32)"

# 環境変数を指定して HTTP サーバーを起動
MCP_ENABLE_HTTP=1 PORT=8787 tsx src/server.ts

# クライアントは Authorization: Bearer <token> を付ける必要がある
curl -X POST http://localhost:8787/mcp \
  -H "Authorization: Bearer $MCP_HTTP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# 別ターミナルから Inspector で接続
npx @modelcontextprotocol/inspector http://localhost:8787/mcp
# Inspector の UI で接続設定 → "Authentication" / "Headers" セクションに
# `Authorization: Bearer $MCP_HTTP_TOKEN` を追加してから接続する。
```

#### HTTP transport 用の環境変数

| 環境変数 | 必須 | デフォルト | 説明 |
|---|---|---|---|
| `MCP_ENABLE_HTTP` | – | `0` | `1` で HTTP transport を有効化 |
| `PORT` | HTTP 時必須 | – | HTTP listen ポート |
| `MCP_HTTP_TOKEN` | HTTP 時必須 | – | Bearer 認証トークン。未設定 / 空白のみなら起動拒否 |
| `RATE_LIMIT_WINDOW_MS` | – | `60000` | rate limit のウィンドウ (ms)。NaN / 0 以下はデフォルトに fallback |
| `RATE_LIMIT_MAX` | – | `60` | ウィンドウあたりの最大リクエスト数。NaN / 0 以下はデフォルトに fallback |
| `ALLOWED_HOSTS` | – | `127.0.0.1,localhost` (※1) | DNS rebinding 防御用の許可ホスト |
| `ALLOWED_ORIGINS` | – | (空) | CORS Origin の許可リスト |

※1 `MCP_ENABLE_HTTP=1` で `src/server.ts` を起動した場合のデフォルト。`tsx src/http.ts` を単独起動した場合のみデフォルトが `localhost,127.0.0.1,*.ngrok-free.dev` になる (ngrok 経由の検証用)。

不正な / 欠落した Authorization ヘッダは `401 { "error": "Unauthorized" }`、レート超過は `429 { "error": "Too many requests. ..." }` を返す。

> HTTP サーバは既定で無効です（STDIO 汚染を避けるため）。Docker での起動方法は [docs/ops.md](docs/ops.md#docker起動開発検証用) を参照してください。

### Windows でローカル開発する場合

`npx` が PATH 解決できない環境では、`node` の絶対パスと `tsx` の CLI を直接指定します：

```json
{
  "mcpServers": {
    "bitbank-dev": {
      "command": "node",
      "args": [
        "C:\\Users\\<USERNAME>\\bitbank-genesis-mcp-server\\node_modules\\tsx\\dist\\cli.mjs",
        "C:\\Users\\<USERNAME>\\bitbank-genesis-mcp-server\\src\\server.ts"
      ],
      "workingDirectory": "C:\\Users\\<USERNAME>\\bitbank-genesis-mcp-server",
      "env": { "LOG_LEVEL": "debug", "NO_COLOR": "1" }
    }
  }
}
```

### CI / 型生成 / リンター

開発時のコマンド一覧は [CLAUDE.md](CLAUDE.md) を参照してください（`npm test` / `npm run lint:fix` / `npm run gen:types` 等）。

## フィードバック・バグ報告

バグ報告や機能要望は [GitHub Issues](https://github.com/tjackiet/bitbank-genesis-mcp-server/issues) からお願いします。Issue テンプレートを用意していますので、用途に合ったものを選択してください。

## 免責事項

### 開発段階について

本ツールは開発段階（ベータ版）です。バグ、不具合、誤動作、または不正確な分析結果を含む可能性があります。

### AI エージェントによる処理結果について

本MCPサーバー / 本CLIツール が提供するデータを AIエージェント等が処理・生成した結果について、正確性、完全性、有用性、最新性を保証するものではありません。AI エージェント等による処理の結果、注文種別、価格、数量その他の取引条件が利用者の意図と異なる形で処理または実行される可能性があります。

### 金融商品取引法上の位置づけ

本MCPサーバーは情報提供のみを目的として提供されるものであり、投資助言・代理業、投資勧誘、その他金融商品取引法上の行為を目的とするものではありません。

### 外部サービスへの依拠

本MCPサーバーは外部API、LLM、第三者サービス等に依拠して提供するものであり、これらの仕様変更、停止、不具合等が生じた場合には、本MCPサーバーが正常に動作しない可能性があります。

### 安全対策の補助性

本MCPサーバーに実装されている最終注文確認機能、バリデーションその他の安全対策は、誤操作または誤発注等を防止するための補助機能であり、その完全な防止を保証するものではありません。

### 利用者の責任

利用者は、本MCPサーバーにより提供・生成された情報および注文内容等を自身で十分に確認の上、自己の判断と責任において本MCPサーバーを利用し、投資判断、注文実行および取引を行うものとします。

### 損害の免責

当社は、本MCPサーバーの利用もしくは利用不能、または本MCPサーバーにより提供・生成された情報、AI エージェント等による処理結果もしくは取引操作に基づく投資判断・注文・取引等に関連して生じたいかなる損害についても、当社の故意または重過失による場合を除き、一切責任を負いません。

### APIキー・認証情報の管理

APIキーおよび取引に必要なパスワード等は利用者自身の責任において適切に管理してください。チャット欄や公開リポジトリその他第三者が閲覧可能な環境等へ APIキーや取引パスワード等の認証情報等を入力・掲載しないよう十分ご注意ください。

利用者による認証情報等の管理不備、誤入力、漏えい、第三者利用等により生じたいかなる損害についても、当社の故意または重過失による場合を除き、当社は一切責任を負いません。