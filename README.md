# bitbank-lab-mcp

[![CI](https://github.com/bitbankinc/bitbank-lab-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/bitbankinc/bitbank-lab-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/bitbank-lab-mcp.svg)](https://www.npmjs.com/package/bitbank-lab-mcp)
[![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/tjackiet/bitbank-lab-mcp?utm_source=oss&utm_medium=github&utm_campaign=tjackiet%2Fbitbank-lab-mcp&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews)](https://coderabbit.ai)

> bitbank API のデータで暗号資産の市場分析をする MCP サーバーです。Claude / Cursor / Codex / Antigravity CLI などから使えます。

## はじめにお読みください

- 本ツールは**開発段階（ベータ版）**です。利用は**自己責任**でお願いします。
- ご利用の前に必ず [⚠️ 免責事項](#免責事項) をお読みください。
- 本リポジトリは **bitbank バグバウンティプログラムの対象範囲外** です。

## できること

- **データ**：ティッカー・板・約定履歴・ローソク足（1 分足〜月足）
- **分析**：テクニカル指標（SMA / RSI / ボリンジャーバンド / 一目均衡表 / MACD）・フロー・ボラティリティ・板の圧力・パターン検出・総合スコア
- **可視化**：Claude.ai の Visualizer 向けデータ（`prepare_chart_data` ほか）、SVG / PNG（`render_chart_svg` ほか）
- **口座（API キーが必要）**：資産・注文・約定・入出金・信用・損益の分析、確認つきの発注・取消

指標の計算までサーバーで行い、結果を LLM に渡します。生データを LLM に計算させたいときは、姉妹プロジェクトの [bitbank-lab-cli](https://github.com/bitbankinc/bitbank-lab-cli) を使ってください。ツールの一覧は [docs/tools.md](docs/tools.md)。

## クイックスタート

Node.js 22 以上（24 推奨）が必要です。npm の [`bitbank-lab-mcp`](https://www.npmjs.com/package/bitbank-lab-mcp) を `npx` で起動するので、clone は要りません。

### 1. Claude Desktop に登録

設定ファイルに追加し、Claude Desktop を再起動します（macOS は `Cmd+Q`、Windows は完全終了）。

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

**A. 公開データだけ（API キー不要）**

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

**B. 口座の参照（API キーが必要。発注はできない）**

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

**C. 発注・取消まで（API キーが必要）**

B に `BITBANK_MCP_APPS_EXECUTE=1` を足すと、確認カードのボタンで発注・取消できます（既定は無効）。

```json
{
  "mcpServers": {
    "bitbank-lab": {
      "command": "npx",
      "args": ["-y", "bitbank-lab-mcp"],
      "env": {
        "BITBANK_API_KEY": "your_api_key",
        "BITBANK_API_SECRET": "your_api_secret",
        "BITBANK_MCP_APPS_EXECUTE": "1"
      }
    }
  }
}
```

<details>
<summary><b>⚠️ <code>BITBANK_MCP_APPS_EXECUTE=1</code> を設定する前に読んでください</b></summary>

確認トークンを、ツール結果の `_meta` と、一覧に出さないリソース `bitbank-confirmation://{app}` に載せてカードへ渡します。安全性は「**ホストが `_meta` をモデルに渡さず、MCP リソースもモデルに読ませない**」ことに依存します。

* **仕様上の保証ではありません**（MCP Apps 仕様の "Best Practices" の記述で、MUST / SHOULD ではない）
* **ホストの更新で前提が崩れても、サーバーは検知できません**
* 確認の状態（トークンと注文内容）を `~/.bitbank-lab-mcp/confirm` に置きます。**ファイルを読める AI エージェントには、このフォルダを許可しないでください**
* Windows では、Claude Desktop のボタンが出ない見込みです（未確認）

トークンが漏れた場合の被害は、**直前にプレビューした注文 1 件（一括取消なら 1 セット）が、期限（既定 60 秒、最長 5 分）内に 1 回実行されること**に限られます。金額・数量・ペア・方向は変えられません。詳細は [ADR-0007](docs/adr/0007-hitl-confirmation-token-delivery.md)。

</details>

API キーの権限は「[API キー](#api-キー)」を参照してください（**「出金」は付けない**）。

### 2. ほかのクライアント

- **Claude Code**：`claude mcp add --transport stdio bitbank-lab -- npx -y bitbank-lab-mcp`
- **Cursor**（`.cursor/mcp.json`）・**Windsurf** など：上と同じ JSON で登録します。

### 3. Plugin として入れる（同梱 Skill も使う）

Claude Code では、同梱の Skill（`investment-onboarding` など）も一緒に入ります。Claude Desktop は plugin に未対応です。

```bash
/plugin marketplace add bitbankinc/bitbank-lab-mcp
/plugin install bitbank-lab-mcp@bitbank-lab
/reload-plugins
```

API キーは install 後の画面で入力します（公開データだけなら空欄で OK）。Cursor・Codex・Antigravity CLI 向けの manifest もあります（Cursor・Codex は環境変数でキーを渡します）。

### 4. 使ってみる

```
BTCの今の市場状況を分析して
ビットコインは買いと売りどちらが優勢？
直近 1 週間でテクニカル的に上向きの仮想通貨を 3 つ教えて
```

何を聞けばよいか迷ったら、[プロンプト集](docs/prompts-table.md) を見てください。

## API キー

キーを設定すると、口座のツールとプロンプトが使えるようになります（未設定なら表示されません）。

[bitbank の設定画面](https://app.bitbank.cc/account/api) で発行し、必要な権限だけを付けてください。可能なら IP 制限も設定してください。

| 使い方 | 権限 |
|---|---|
| 資産・注文・損益を見るだけ | 「参照」 |
| 発注・取消もする | 「参照」+「取引」 |

⚠️ **「出金」権限は付けないでください**。出金のツールはありません。

キーの渡し方：Claude Desktop は設定の `env`（上の B / C）、Claude Code の plugin は install 後の画面、それ以外は環境変数 `BITBANK_API_KEY` / `BITBANK_API_SECRET`。

### 発注・取消の確認

発注・取消は、プレビューのあとにユーザーの確認が要ります。確認トークンなしで `create_order` などを呼んでも拒否されます。

| クライアント | 実行のしかた |
|---|---|
| elicitation 対応 | 確認ダイアログ（追加の設定なし） |
| MCP Apps UI 対応（Claude Desktop など） | `BITBANK_MCP_APPS_EXECUTE=1` のときだけ、確認カードのボタン |
| どちらも非対応 | プレビューだけ（実行は bitbank のアプリ・ウェブで） |

詳細は [Private API ガイド](docs/private-api.md)。

## 困ったとき

- **「サーバーに接続できません」・`spawn npx ENOENT`**：Claude Desktop が `npx` を見つけられていません。`which npx`（Windows は `where.exe npx`）の出力を `command` に書きます。nvm / volta では、Node.js を更新するとこのパスが変わります。
- **ツールが表示されない**：JSON の構文と再起動を確認します。`mcpServers` のキー（サーバー名）は英数字にしてください（日本語だとツールが見つからないことがあります）。
- **口座のツールが表示されない**：`BITBANK_API_KEY` と `BITBANK_API_SECRET` の両方を設定しているか確認します。
- **タイムアウトする**：ネットワークと [bitbank API の状態](https://status.bitbank.cc/) を確認します。
- **`Cannot find package 'tsx'`**：古い版（v0.1.0）の問題です。`npx -y bitbank-lab-mcp@latest` にします。
- **チャートが表示されない**：「identifier と title を追加して、アーティファクトとして表示して」と頼んでください。
- **当日の約定データが少ない**：bitbank の仕様です。日ごとの約定履歴は UTC の 1 日が終わってから（日本時間 9:00 以降）公開されるので、当日分は直近の約 60 件しか取れません（結果に warning が出ます）。公開済みの期間は、`get_flow_metrics` / `analyze_volume_profile` の `since` / `until`（最大 7 日）で全件を集計できます。
- **ログを見たい**：`env` に `"LOG_LEVEL": "debug"` を足して再起動します。
- **MCP Inspector で試したい**：`npx @modelcontextprotocol/inspector -- npx -y bitbank-lab-mcp`

## ドキュメント

- [プロンプト集](docs/prompts-table.md)
- [ツール一覧](docs/tools.md)
- [Private API ガイド](docs/private-api.md)
- [変更履歴](CHANGELOG.md)
- [開発者向け（ソースから起動）](docs/development.md) / [開発コマンド](CLAUDE.md)
- [運用・監視](docs/ops.md)

バグ報告や要望は [GitHub Issues](https://github.com/bitbankinc/bitbank-lab-mcp/issues) へ。

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
