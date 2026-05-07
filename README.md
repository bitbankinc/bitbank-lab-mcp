# bitbank-lab-mcp

[![CI](https://github.com/tjackiet/bitbank-genesis-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/tjackiet/bitbank-genesis-mcp-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/bitbank-lab-mcp.svg)](https://www.npmjs.com/package/bitbank-lab-mcp)

> bitbank API のデータを使った暗号資産市場分析を、Claude（LLM）から簡単に実行できる MCP サーバーです。

> 📌 **位置付け**: 本リポジトリは **bitbank 公式版**（[`bitbankinc/bitbank-mcp-server`](https://github.com/bitbankinc/bitbank-mcp-server)）の **先行実験版**です。「ビットバンク botters lab」コミュニティ向けに、新機能を先行リリースしています。安定運用したい方は公式版の利用を推奨します。

## ⚠️ Disclaimer

本 MCP サーバーが提供するデータを AI エージェントが受け取り処理した結果は、必ずしも正確性・完全性を保証するものではありません。

提供される情報は情報提供のみを目的としており、投資助言・代理業に該当するものではありません。投資に関する判断はご自身の責任で行ってください。

## 本 MCP サーバーについて

bitbank の公開 API から取得した価格・取引データを、指標計算・統合・可視化用データの整形まで行った上で LLM に渡します（必要に応じてサーバー側で SVG 描画も可能）。生データを渡すだけのサーバーとは異なり、各ツールの description に「いつ使うべきか」「他ツールとの使い分け」を明示しているため、LLM が自律的に適切なツールを選択できます。

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
- **Node.js 18 以上**（22 推奨 — CI で検証済み。[公式サイト](https://nodejs.org/) からインストール。`node -v` で確認できます）
- npm（Node.js に同梱されています）
- Git（リポジトリの取得に使用）
- 対応 OS: macOS / Linux / Windows（WSL 含む）
- Docker: 任意（なくても動作します。[Docker 起動](docs/ops.md#docker起動開発検証用)も可）

### 1. インストール

```bash
git clone https://github.com/tjackiet/bitbank-genesis-mcp-server.git
cd bitbank-genesis-mcp-server
npm install
```
ビルドステップは不要です（tsx で TypeScript を直接実行します）。

### 2-A. Plugin として install（最短・推奨）

Claude Code / Cursor / Codex / Gemini CLI には plugin manifest（`.claude-plugin/plugin.json` ほか 3 種）を同梱しています。各クライアントの `/plugin install`（または相当のコマンド）でこのリポジトリを指定するだけでセットアップが完了します。**API キー入力 UI を備えているのは Claude Code と Gemini CLI のみ** — Cursor / Codex はシェル環境変数で API キーを渡す方式です（後述）。

| クライアント | manifest | API キーの渡し方 |
|---|---|---|
| Claude Code | `.claude-plugin/plugin.json` | ✅ **GUI で入力**: `/plugin install` 直後に `userConfig` UI が表示され、OS キーチェーンに保管 |
| Gemini CLI | `gemini-extension.json` | ✅ **対話 prompt**: `settings` 配列で対話的に入力、`.env` に保管 |
| Cursor | `.cursor-plugin/plugin.json` | ⚙️ **シェル環境変数のみ**: `BITBANK_API_KEY` / `BITBANK_API_SECRET` を環境変数に設定（Cursor は plugin 経由の prompt 未対応） |
| Codex | `.codex-plugin/plugin.json` | ⚙️ **シェル環境変数のみ**: `BITBANK_API_KEY` / `BITBANK_API_SECRET` を環境変数に設定 |

> いずれの manifest も npm registry の [`bitbank-lab-mcp`](https://www.npmjs.com/package/bitbank-lab-mcp) を `npx -y` 経由で起動します。Node.js さえあれば自動でインストールされ、ローカル clone 不要です。

**Claude Code の例**:

```bash
/plugin install tjackiet/bitbank-genesis-mcp-server
```

実行後、bitbank API key / API secret の入力 UI が表示されます。**Public ツールだけで使う場合は両方とも空欄で OK** — Private API ツールは API キーを入力したときだけ自動的に有効化されます。

> API キーを後から追加・変更したい場合は `/plugin` から該当 plugin の設定を開き、`api_key` / `api_secret` を更新してください。Claude Code では `sensitive: true` のため OS のキーチェーンに保管されます。

**Cursor / Codex の場合（環境変数経由）**:

`/plugin install` 実行後、シェルで以下のように環境変数を設定してから Cursor / Codex を起動してください（Public ツールだけ使う場合は不要）:

```bash
export BITBANK_API_KEY="your_api_key"
export BITBANK_API_SECRET="your_api_secret"
```

macOS / Linux では `~/.zshrc` や `~/.bashrc` に書いておくと永続化されます。Windows は環境変数の管理画面 or `setx` を使用してください。

### 2-B. Claude Desktop に登録（手動設定）

`~/Library/Application Support/Claude/claude_desktop_config.json` に設定を追加します。

設定方法は2通りあります。**まず方式Aを試し、動かない場合に方式Bをお試しください。**

#### 方式A：npx 経由（推奨）

Node.js のバージョンアップで設定を書き換える必要がないため、こちらを推奨します。nvm/volta などのバージョン管理ツールをお使いの方には特におすすめです。

```json
{
  "mcpServers": {
    "bitbank": {
      "command": "npx",
      "args": [
        "tsx",
        "/ABS/PATH/to/src/server.ts"
      ],
      "workingDirectory": "/ABS/PATH/to/project",
      "env": { "LOG_LEVEL": "info", "NO_COLOR": "1" }
    }
  }
}
```

#### 方式B：node の絶対パスを指定（フォールバック）

方式A で「サーバーに接続できません」エラーが出る場合、Claude Desktop から `npx` コマンドが見つけられていない可能性があります。その場合は、node の絶対パスを指定してください。

まずターミナルで自分の環境の node パスを確認します：

```bash
which node
```

出力例と対応するインストール方法：

| `which node` の出力 | インストール方法 |
|---|---|
| `/opt/homebrew/bin/node` | Homebrew（Apple Silicon Mac） |
| `/usr/local/bin/node` | Homebrew（Intel Mac）または公式インストーラ |
| `/Users/XXX/.nvm/versions/node/vXX.XX.X/bin/node` | nvm |
| `/Users/XXX/.volta/bin/node` | volta |

`which node` の結果を `command` に指定：

```json
{
  "mcpServers": {
    "bitbank": {
      "command": "<which node の出力>",
      "args": [
        "/ABS/PATH/to/node_modules/tsx/dist/cli.mjs",
        "/ABS/PATH/to/src/server.ts"
      ],
      "workingDirectory": "/ABS/PATH/to/project",
      "env": { "LOG_LEVEL": "info", "NO_COLOR": "1" }
    }
  }
}
```

> ⚠️ **nvm/volta ユーザーへの注意**: この方式では Node.js をバージョンアップするたびに `command` のパスの書き換えが必要です（例: `v22.22.2` → `v22.22.3`）。アップデート後に `which node` を再確認してください。

#### 共通の注意事項

- `/ABS/PATH/to/` を実際のプロジェクトの絶対パスに置き換えてください
- プロジェクトの絶対パスはクローンしたディレクトリで `pwd` を実行して確認できます
- ⚠️ macOS では Desktop フォルダに配置すると権限エラーが発生する場合があります（ホームディレクトリ直下を推奨）
- 追加後、Claude Desktop を `Cmd+Q`（Windows は完全終了）で再起動してください
- Docker は不要です（[Docker起動](docs/ops.md#docker起動開発検証用)もできます）
- Plugin install（[2-A](#2-a-plugin-として-install最短推奨)）を使えばこの手順は不要です

#### Windows の場合（ソースコードから）

```json
{
  "mcpServers": {
    "bitbank": {
      "command": "node",
      "args": [
        "C:\\Users\\<USERNAME>\\bitbank-genesis-mcp-server\\node_modules\\tsx\\dist\\cli.mjs",
        "C:\\Users\\<USERNAME>\\bitbank-genesis-mcp-server\\src\\server.ts"
      ],
      "workingDirectory": "C:\\Users\\<USERNAME>\\bitbank-genesis-mcp-server",
      "env": { "LOG_LEVEL": "info", "NO_COLOR": "1" }
    }
  }
}
```
`<USERNAME>` を自分のユーザー名に置き換えてください。

#### 表示名のカスタマイズ

Claude Desktop の UI に表示される名前は `claude_desktop_config.json` のキー名で決まります：
```json
{
  "mcpServers": {
    "ビットバンクMCP": {  // ← この名前がUIに表示される
      "command": "...",
      "args": ["..."]
    }
  }
}
```
日本語名も使用可能です。

設定ファイルの場所：
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

### 他の MCP クライアントで使う

Claude Desktop 以外の MCP クライアントでも、同様にソースコードから起動する設定で登録できます。`/ABS/PATH/to/` は実際のプロジェクトパスに置き換えてください。

#### Claude Code

```bash
claude mcp add --transport stdio bitbank -- npx tsx /ABS/PATH/to/src/server.ts
```

#### Cursor（`.cursor/mcp.json`）

```json
{
  "mcpServers": {
    "bitbank": {
      "command": "npx",
      "args": ["tsx", "/ABS/PATH/to/src/server.ts"],
      "workingDirectory": "/ABS/PATH/to/project",
      "env": { "LOG_LEVEL": "info" }
    }
  }
}
```

#### Windsurf / 汎用 MCP クライアント

Cursor と同じ設定を使用してください。

> npm 公開済み (`bitbank-lab-mcp`) のため、`command: "npx", args: ["-y", "bitbank-lab-mcp"]` でも利用できます。`/ABS/PATH/to/` を書く必要がなく、Node.js のバージョン管理ツール（nvm/volta）にも追随します。

### 3. 使ってみる
Claude にそのまま話しかけます:
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
| キー未設定 | 29（Public のみ） | 9 | 価格取得・テクニカル分析・チャート生成・バックテスト |
| キー設定済み | 29 + 16 = **45** | 9 + 1 = **10** | 上記 + 資産確認・注文・ポートフォリオ分析 |

キー未設定時、Private ツール・プロンプトは MCP クライアントに一切表示されません（エラーではなく、そもそも登録されません）。公開データの取得・分析だけなら設定不要で、そのまま使えます。

### 環境変数の設定方法

**ターミナルから起動する場合:**
```bash
export BITBANK_API_KEY="your_api_key"
export BITBANK_API_SECRET="your_api_secret"
```

**Plugin install を使った場合** — `/plugin` から該当 plugin の設定を開き、`api_key` / `api_secret` を入力すれば完了です（手動編集は不要）。

**Claude Desktop で手動設定している場合** — `claude_desktop_config.json` の `env` に追加（[ステップ 2-B](#2-b-claude-desktop-に登録手動設定) で設定した方式A／方式B のいずれかに、以下のように `BITBANK_API_KEY` と `BITBANK_API_SECRET` を追加するだけです）:
```json
{
  "mcpServers": {
    "bitbank": {
      "command": "npx",
      "args": ["tsx", "/ABS/PATH/to/src/server.ts"],
      "workingDirectory": "/ABS/PATH/to/project",
      "env": {
        "BITBANK_API_KEY": "your_api_key",
        "BITBANK_API_SECRET": "your_api_secret",
        "LOG_LEVEL": "info",
        "NO_COLOR": "1"
      }
    }
  }
}
```

API キーは [bitbank 設定画面](https://app.bitbank.cc/account/api) で発行できます（「参照」+「取引」権限、出金権限は不要）。

| カテゴリ | ツール | 説明 |
|---|---|---|
| 口座情報 | `get_my_assets` | 保有資産一覧 |
| 注文照会 | `get_my_orders`, `get_order`, `get_orders_info` | 注文の照会 |
| 約定履歴 | `get_my_trade_history` | 約定履歴の取得 |
| ポートフォリオ | `analyze_my_portfolio` | 損益分析・パフォーマンス |
| 入出金 | `get_my_deposit_withdrawal` | 入出金履歴 |
| 発注 | `preview_order` → `create_order` | 2ステップ確認付き発注 |
| キャンセル | `preview_cancel_order` → `cancel_order` | 2ステップ確認付きキャンセル |
| 一括キャンセル | `preview_cancel_orders` → `cancel_orders` | 2ステップ確認付き一括キャンセル |
| 信用取引 | `get_margin_status`, `get_margin_positions`, `get_margin_trade_history` | 証拠金・ポジション・約定履歴 |

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

**Q. MCP Inspector でも試せる？** はい。開発時は次で実行できます。
```bash
npx @modelcontextprotocol/inspector -- tsx src/server.ts
```

## トラブルシューティング

| 症状 | 原因・対処 |
|------|-----------|
| Claude Desktop にツールが表示されない | `claude_desktop_config.json` のパスが間違っている / Claude Desktop を `Cmd+Q`（Windows は完全終了）で再起動していない |
| 「サーバーに接続できません」エラー（npx方式） | Claude Desktop から `npx` が見つからない可能性。方式B（node絶対パス）に切り替える |
| `spawn /usr/local/bin/node ENOENT` エラー | `which node` の結果が異なるパス（例: `/opt/homebrew/bin/node`）を指している。`command` を正しいパスに書き換える |
| Node.jsアップデート後にMCPが動かなくなった | nvm/volta の場合、Node.jsバージョンが変わると絶対パスも変わる。`which node` を再確認して `command` を更新するか、方式A（npx）に切り替える |
| ツール実行時にタイムアウト | ネットワーク接続を確認 / [bitbank API の状態](https://status.bitbank.cc/)を確認 |
| Private API ツールが表示されない | `BITBANK_API_KEY` と `BITBANK_API_SECRET` の両方が設定されているか確認（→ [docs/private-api.md](docs/private-api.md)） |
| ログを確認したい | `LOG_LEVEL=debug` に設定して再起動 / `npm run stat` でログ統計を表示 |
| macOS で権限エラー | Desktop フォルダへの配置を避け、ホームディレクトリ直下に配置 |

---

## 起動方法

### STDIO モード（既定 — Claude Desktop 向け）

Claude Desktop の `claude_desktop_config.json` に登録すると、STDIO モードで自動起動します（[ステップ 2](#2-claude-desktop-に登録最短) 参照）。

手動で起動する場合:
```bash
npx @modelcontextprotocol/inspector -- tsx src/server.ts
```

### HTTP モード（Web クライアント・開発検証向け）

```bash
# 環境変数を指定して HTTP サーバーを起動
MCP_ENABLE_HTTP=1 PORT=8787 tsx src/server.ts

# 別ターミナルから Inspector で接続
npx @modelcontextprotocol/inspector http://localhost:8787/mcp
```

> HTTP サーバは既定で無効です（STDIO 汚染を避けるため）。Docker での起動方法は [docs/ops.md](docs/ops.md#docker起動開発検証用) を参照してください。

## フィードバック・バグ報告

バグ報告や機能要望は [GitHub Issues](https://github.com/tjackiet/bitbank-genesis-mcp-server/issues) からお願いします。Issue テンプレートを用意していますので、用途に合ったものを選択してください。