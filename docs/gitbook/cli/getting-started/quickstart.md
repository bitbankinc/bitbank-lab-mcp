---
description: bitbank CLI の最初の一歩。インストールから、認証なしでの市況取得・出力切替・自然言語操作・仮想売買までをまとめて体験します。
---

# クイックスタート

bitbank CLI をインストールし、認証不要の Public コマンドで市況を取得するところまでを最短で体験します。API キーは不要です。

## 前提

bitbank CLI は **Node.js 20 以上**で動作します（Linux / macOS / Windows 対応）。まだ入れていない場合は [Node.js 公式サイト](https://nodejs.org/) から LTS 版をインストールしてください。`node -v` で `v20.x` 以上が表示されれば OK です。

## 1. インストール

用途に応じて 3 つの方法があります。コマンドを叩くだけなら **A**、まず試すだけなら **B**、Skill を編集・開発したいなら **C** を選んでください。

{% tabs %}
{% tab title="A. npm でインストール（推奨）" %}
```bash
npm i -g bitbank-lab-cli
```

どのディレクトリからでも `bitbank` コマンドが使えます。アンインストールは `npm uninstall -g bitbank-lab-cli` です。
{% endtab %}

{% tab title="B. インストールせず試す" %}
```bash
npx -y bitbank-lab-cli ticker btc_jpy
```

初回はパッケージのダウンロードが走るため、少し時間がかかります。
{% endtab %}

{% tab title="C. クローンして開発" %}
Skill を編集・カスタマイズしたい場合や CLI 開発に参加したい場合は、リポジトリをクローンして `./install.sh` を実行します（内部で `npm ci` と `npm link` を行います）。

```bash
git clone https://github.com/bitbankinc/bitbank-lab-cli.git
cd bitbank-lab-cli
./install.sh
```
{% endtab %}
{% endtabs %}

{% hint style="info" %}
`bitbank` コマンドが PATH に通らない環境（クローンしたが `./install.sh` を使っていない等）では、`npx tsx cli/index.ts ...`（Private API は `npx tsx --env-file=.env cli/index.ts ...`）で代替できます。`npm run cli -- ...` / `npm run cli:env -- ...` のエイリアスも使えます。本ドキュメントのコマンド例は `bitbank` が PATH にある前提です。
{% endhint %}

## 2. 市況を取得する（動作確認）

認証不要の Public コマンドで動作確認します。

```bash
# 単一ペアのティッカー
bitbank ticker btc_jpy

# ローソク足（OHLCV）を見やすいテーブルで
bitbank candles btc_jpy --type=1day --format=table

# 全 JPY ペアのティッカーを一括取得
bitbank tickers-jpy
```

価格やローソク足が表示されれば成功です。ペアは `btc_jpy` のように `<base>_<quote>` 形式で指定します。利用可能なペアは `bitbank pairs` で確認できます。

## 3. 出力フォーマットを切り替える

すべてのコマンドで `--format` が使えます。デフォルトは `json` です。

```bash
bitbank ticker btc_jpy --format=json   # デフォルト（プログラム向け）
bitbank ticker btc_jpy --format=table  # 人が読みやすいテーブル
bitbank ticker btc_jpy --format=csv    # パイプ・インポート向け
```

```bash
# jq で last（最終取引価格）だけ抜き出す
bitbank ticker btc_jpy | jq '.last'

# 日足を CSV に保存
bitbank candles btc_jpy --type=1day --format=csv > btc_daily.csv
```

{% hint style="info" %}
スクリプトや Agent Skill から読む場合は `--format=json --machine` を併用すると、`{ success, data, meta }` の envelope が得られ、データ完全性のメタ情報まで取れます。詳しくは [基本的な使い方](../guides/usage.md) を参照してください。
{% endhint %}

## 4. 自然言語で操作する（Agent Skills）

Claude Code / Cursor でこのリポジトリを開くと、Agent Skills が自動で有効になります。自然言語でリクエストすれば、Skill が必要な CLI コマンドを組み立てて実行します。

```text
「BTC の RSI を見て」
「ポートフォリオの状況を見せて」
「SMA クロス戦略をバックテストして」
```

搭載している Skill の一覧は [Agent Skills](../guides/skills.md) を参照してください。

## 5. 仮想資金で売買を練習する（Paper）

実際の資金を動かす前に、**仮想資金 × ライブ価格**で売買を練習できます。Paper は public ticker のみを叩き、実際の口座やトレード API には一切触れません。API キーも不要です。

```bash
bitbank paper init --jpy=1000000                                                   # 仮想口座を初期化
bitbank paper create-order --pair=btc_jpy --side=buy --type=market --amount=0.001  # 成行で買い
bitbank paper assets                                                               # 仮想残高
bitbank paper pnl                                                                  # 損益サマリ
```

## 次のステップ

* 口座情報の取得や実際の取引を行うには → [API キーの設定](api-keys.md)
* CLI の呼び出し方や出力の扱いを深く知るには → [基本的な使い方](../guides/usage.md)
* 全コマンドを一覧で見るには → [コマンド一覧](../guides/commands.md)
* 取引の安全ガードを理解するには → [取引と安全ガード](../guides/trading.md)
