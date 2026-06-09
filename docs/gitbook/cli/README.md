---
description: >-
  bitbank CLI は生の市場データを高速に取得し、計算は LLM 自身に行わせる薄い API
  アクセス層です。指標のパラメータもロジックも完全に自分で組み立てたい人に向いています。
---

# はじめに

**bitbank CLI** は、bitbank 暗号資産取引所の API を叩くための薄いコマンドラインツールです。ticker・ローソク足・板情報といった**生の市場データを高速に取得・整形すること**に徹し、指標計算やトレード判断のロジックは一切持ちません。計算は CLI を呼び出す LLM（AI エージェント）側に委ねます。

{% hint style="warning" %}
本ツールは**開発段階（ベータ版）**です。ご利用は**自己責任**でお願いします。実際の資金を動かす前に、必ず [免責事項](reference/disclaimer.md) をお読みください。本リポジトリは bitbank バグバウンティプログラムの対象範囲外です。
{% endhint %}

## bitbank CLI とは

このプロジェクトは **CLI** と **Agent Skills** の 2 層構成です。

* **bitbank CLI** — bitbank API を叩く薄いアクセス層。Public（マーケットデータ）/ Private（口座読み取り）/ Trade（資金操作）/ Paper（仮想資金の練習）/ Profile（API キー切替）の各カテゴリを提供します。
* **Agent Skills** — 自然言語で CLI を操作するための「モデルへの指示書」。Claude Code / Cursor などでリポジトリを開くと自動でトリガーされ、必要な CLI コマンドを組み立てて実行します。

```bash
bitbank ticker btc_jpy
bitbank candles btc_jpy --type=1day --format=table
```

```text
「BTC の RSI を見て」              → indicator-analysis
「ポートフォリオの状況を見せて」     → portfolio
「BTC を仮想で 0.01 買って」        → paper-trade
```

## 設計思想：計算は LLM に任せる

CLI は **bitbank API への薄いアクセス層**であり、分析ロジックを一切持ちません。生の OHLCV データを高速に渡すので、指標のパラメータもロジックも**完全にカスタマイズ可能**です。固定実装では対応できない「自分だけの指標」を、モデルに計算させながら作り込めます。

{% hint style="info" %}
**指標のパラメータやロジックを自分で組み立てたい人**に向いた設計です。「サーバー側で計算済みの結論」がほしい場合は、姉妹プロジェクトの MCP サーバーが適しています（次節参照）。
{% endhint %}

## MCP との違い

bitbank には、同じ API に対して**真逆のアプローチ**をとる 2 つのプロジェクトがあります。**bitbank CLI** は生データを高速に渡し、計算は LLM 自身に任せます（指標のパラメータ・ロジックを完全に自作できる）。**MCP サーバー** はサーバー側で計算済みの結論を返します。

どちらが自分に向いているかの詳しい比較は、[はじめに](../README.md) の「MCP サーバーと CLI — どちらが自分に向いている？」を参照してください。

## 対象読者

このドキュメントは、**bitbank で取引した経験はあるが、CLI や AI エージェント連携は初めて**という方を想定しています。コマンドラインや AI エージェントの専門知識は前提にしていません。順を追って読めば、市況の取得から仮想資金での売買練習までたどり着けます。

* **使うだけ**（コマンドを叩いて市況を取りたい）→ [インストール](getting-started/install.md) → [クイックスタート](getting-started/quickstart.md) → [コマンド一覧](guides/commands.md)
* **自然言語で操作したい**（Skill を活用・カスタマイズ）→ [Agent Skills](guides/skills.md) / [レシピ集](guides/recipes.md)
* **取引や bot 検証をしたい**（仮想資金 → 本番）→ [API キーの設定](getting-started/api-keys.md) → [取引と安全ガード](guides/trading.md)

## このドキュメントの歩き方

1. まず [インストール](getting-started/install.md) で `bitbank` コマンドを使えるようにします。
2. [クイックスタート](getting-started/quickstart.md) で最初の 1 コマンドを叩いて動作確認します。
3. 口座情報や取引を扱う場合は [API キーの設定](getting-started/api-keys.md) に進みます。
4. あとは [基本的な使い方](guides/usage.md) と [コマンド一覧](guides/commands.md) を辞書的に参照してください。

困ったときは [トラブルシューティング](reference/troubleshooting.md) と [FAQ](reference/faq.md) を用意しています。
