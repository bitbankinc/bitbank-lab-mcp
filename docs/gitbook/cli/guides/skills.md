---
description: bitbank CLI に同梱される Agent Skills の一覧。自然言語で CLI を操作するための「モデルへの指示書」を、分析系・取引系・ユーティリティ・Recipe のカテゴリ別に紹介します。
---

# Agent Skills

**Agent Skills** は、自然言語で CLI を操作するための「モデルへの指示書」です。Claude Code / Cursor でこのリポジトリを開くと自動でトリガーされ、Skill が必要な CLI コマンドを組み立てて分析・取引を実行します（Cursor は `.claude/skills/` を互換で読みます）。

{% hint style="info" %}
Skill には分析ロジックの「コード」は含まれません。あくまでモデルへの手順書であり、実際の計算はモデルが CLI の出力を使って行います。だからこそ、指標のパラメータやロジックを自分好みに編集・追加できます。
{% endhint %}

合計 12 本を同梱しています。あくまでサンプルなので、ご自身の用途に合わせて追加・編集してください。

## 分析系（7 本）

| Skill | 説明 | 代表トリガー |
|---|---|---|
| `indicator-analysis` | SMA / RSI / MACD / ボリンジャーバンド等の現在値を計算し、トレンド・売買シグナルを読む | 「BTC の RSI を見て」「今買い時？」 |
| `volatility-profile` | 単一銘柄のリスク特性（歪度・尖度・ファットテール倍率・時間帯別出来高・√T 比） | 「BTC のボラどう？」「ストップ幅どう決める？」 |
| `correlation-analysis` | 銘柄間の Pearson / Spearman 相関、β、ローリング相関、環境別相関、ラグ相関 | 「BTC-ETH の相関は？」「分散投資効果はある？」 |
| `data-verification` | ローソク足データの品質検証（欠損足・OHLCV 整合性・異常値・重複）。明示依頼時のみ起動 | 「データ検証して」「欠損ないか確認して」 |
| `signal-explorer` | シグナル候補の予測力を将来リターン相関・Z-score・ラグ相関・リーク検証から評価 | 「RSI、本当に効く？」「この指標に予測力ある？」 |
| `backtest` | コスト・サイジング・複利込みで戦略の PnL・勝率・ドローダウンを算出 | 「SMA クロス戦略をバックテストして」「勝率どのくらい？」 |
| `portfolio` | 保有資産の構成・JPY 建て評価額・含み損益 | 「ポートフォリオの状況を見せて」「含み益ある？」 |

{% hint style="info" %}
似て非なる 3 つの役割に注意してください。指標の**現在値**を見るのは `indicator-analysis`、指標の**予測力**を測るのは `signal-explorer`、コスト込みで**戦略を評価**するのは `backtest` です。
{% endhint %}

## 取引系（1 本）

| Skill | 説明 | 代表トリガー |
|---|---|---|
| `paper-trade` | 仮想資金 × ライブ価格でのペーパートレード。実 API は public ticker のみ | 「BTC を仮想で 0.01 買って」「ペーパー口座の残高見て」 |

## ユーティリティ（2 本）

| Skill | 説明 | 代表トリガー |
|---|---|---|
| `profile-management` | `profiles.json` の CRUD（複数 API キーの切替） | 「API キー追加して」「default profile 切り替えて」 |
| `watch-live` | WebSocket public stream で ticker をリアルタイム watch（要 `--duration` / `--count`） | 「ticker をライブで見たい」「リアルタイム価格監視」 |

## Recipe（2 本）

複数の Skill を順に呼び出して一連のワークフローにまとめたものを **Recipe** と呼びます。Recipe 自体は計算をせず、各ステップで対応する Skill を呼び、最後に総合判断を提示します（最終判断は人間が下す前提）。

| Recipe | 構成 Skill | 代表トリガー |
|---|---|---|
| `recipe-pre-trade-check` | `portfolio` → `volatility-profile` → `data-verification` → `indicator-analysis` | 「買う前にチェックして」「エントリーしていい？」 |
| `recipe-portfolio-review` | `portfolio` → `correlation-analysis` → `volatility-profile` | 「ポートフォリオを見直したい」「分散効いてる？」 |

Recipe の詳しい使い分けは [レシピ集](recipes.md) を参照してください。

## トリガーの仕組みと有効化

* **Claude Code / Cursor** — リポジトリを開くだけで自動有効化されます。追加設定は不要です。
* **plugin としてインストール** — 各エージェントの plugin システムからも導入できます。Claude Code なら `/plugin marketplace add bitbankinc/bitbank-lab-cli` → `/plugin install bitbank-lab-cli@bitbank-lab-cli` の流れです（`/plugin install` は `<plugin-name>@<marketplace-name>` 指定が必要）。
* **その他のエージェント** — Codex CLI / Gemini CLI などは [基本的な使い方](usage.md) の配置先にコピーすると自動トリガーできます。

{% hint style="warning" %}
plugin の `/plugin install` は**ローカル版 Claude Code CLI（ターミナル）**で使う slash command です。Web 版（claude.ai/code）のクラウドサンドボックスでは `bitbank` CLI を永続的に PATH へ通せないため、Skill が CLI を呼べません。ローカル環境で使ってください。
{% endhint %}

## 独自 Skill を追加する

`skills/<name>/SKILL.md` を作成するだけで独自 Skill を追加できます。詳しい手順とテンプレートは、リポジトリの [カスタマイズガイド](https://github.com/bitbankinc/bitbank-lab-cli/blob/main/docs/customization-guide.md) を参照してください。
