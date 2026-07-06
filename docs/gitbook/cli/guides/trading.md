---
description: bitbank CLI の取引コマンドと安全ガード。ドライランがデフォルトの仕組み、--execute と --confirm の二段確認、POST 非冪等の注意、仮想資金での練習方法を説明します。
---

# 取引と安全ガード

実際の資金を動かす Trade コマンドには、誤操作を防ぐための安全ガードが何重にもかかっています。本ページでは、その仕組みと、本番の前に必ず通ってほしい「仮想資金での練習（Paper）」を説明します。

{% hint style="danger" %}
取引は自己責任です。本ツールの安全機構は誤発注を**減らす補助**であり、完全に防ぐものではありません。実際の注文を出す前に、必ず [免責事項](../reference/disclaimer.md) を読んでください。
{% endhint %}

## ステップ 1：まずは Paper で練習する

`bitbank paper <subcommand>` は、**仮想資金 × ライブ価格**のシミュレーションです。実 API は public ticker のみを叩き、private / trade エンドポイントには一切触れません。API キーも不要です。状態は `~/.bitbank/paper-state.json`（または `$XDG_DATA_HOME/bitbank/paper-state.json`）にローカル保存されます。

```bash
bitbank paper init --jpy=1000000                                                   # 仮想口座を初期化
bitbank paper create-order --pair=btc_jpy --side=buy --type=market --amount=0.001  # 成行で買い
bitbank paper create-order --pair=btc_jpy --side=buy --type=limit --price=10000000 --amount=0.001  # 指値
bitbank paper tick                                                                 # 指値の fill を解決
bitbank paper assets                                                               # 仮想残高（available / locked / total）
bitbank paper pnl --pair=btc_jpy                                                   # 損益サマリ
```

指値の挙動は次のとおりです。

* GTC のみ（部分約定なし）。前回 tick 以降の 1m 足を時系列で走査し、**約定するかどうか**だけを足の high/low で判定します（買いは `low <= price`、売りは `high >= price`）。約定が成立したときの**約定価格は指値そのもの**として記録されます（スリッページなし）。
* `paper assets` / `paper trade-history` / `paper active-orders` / `paper create-order` を呼ぶと、裏で lazy tick が走り、未解決の fill を解消してから結果を返します。明示的に解決したいときは `paper tick` を直接実行します。
* 指値発注時は `price * amount + fee` 相当を JPY（買い）または `amount` を base 通貨（売り）でロック扱いにします。手数料は bitbank 公称テイカー手数料（0.12%）。
* `paper reset` は state の誤削除を防ぐため `--confirm` 必須です。

## ステップ 2：Trade コマンドのドライラン

Trade コマンドは `bitbank trade <subcommand>` の形で呼び出します。**`--execute` を付けない限り API を叩きません**（これがドライラン）。本番と同じ引数を渡して、送信予定の内容（エンドポイント・ボディ）を目視で確認するための段階です。

```bash
# --execute なし → ドライラン（API は叩かない）
bitbank trade create-order --pair=btc_jpy --side=buy --type=limit --price=9000000 --amount=0.001
```

出力には送信予定のボディと、本番実行に必要な完成形コマンド（`--execute` と `--confirm=<phrase>` 付き）が表示されます。ボディが意図どおりかを 1 行ずつ確認してください。

## ステップ 3：本番実行（二段確認）

実際に POST を送るには、`--execute` に加えて、コマンドごとの**固定フレーズ**を `--confirm=<phrase>` で渡す必要があります。これが二段確認です。LLM・スクリプト・誤コピーから confirm なしで実注文が発火するリスクを下げます。

```bash
bitbank trade create-order \
  --pair=btc_jpy --side=buy --type=limit --price=9000000 --amount=0.001 \
  --execute --confirm=I-UNDERSTAND-CREATE-ORDER
```

### 挙動マトリクス

| `--execute` | `--confirm=<correct>` | 結果 |
|:-:|:-:|---|
| なし | -（任意） | ドライラン |
| あり | なし | error（API を叩かない） |
| あり | 不一致 | error（API を叩かない） |
| あり | 一致 | 実 POST |

### コマンド別の confirm フレーズ

| コマンド | フレーズ |
|---|---|
| `trade create-order` | `I-UNDERSTAND-CREATE-ORDER` |
| `trade cancel-order` | `I-UNDERSTAND-CANCEL-ORDER` |
| `trade cancel-orders` | `I-UNDERSTAND-CANCEL-ORDERS` |
| `trade confirm-deposits` | `I-UNDERSTAND-CONFIRM-DEPOSITS` |
| `trade confirm-deposits-all` | `I-UNDERSTAND-CONFIRM-DEPOSITS-ALL` |

confirm フレーズは secret ではなく、shell 履歴に残ることを許容したフラグ値です。

## POST は非冪等：失敗時は再送前に必ず実状態を確認

{% hint style="danger" %}
bitbank API は `Idempotency-Key` 相当のヘッダを受け付けません。POST はサーバ側で副作用が発生し得るため、CLI は Trade コマンドの POST を**自動再送しません**（タイムアウト・5xx・`ECONNRESET` 等でも再送しない）。

つまり CLI が「失敗」を返しても、注文や出金が実際には通っている可能性があります（silent success）。タイムアウトや 5xx を受け取ったら、再実行する**前に**必ず次で実際の状態を確認してください。
{% endhint %}

```bash
bitbank active-orders --pair=btc_jpy   # 注文が通っていないか
bitbank trade-history --pair=btc_jpy   # 約定していないか
bitbank assets                          # 残高が動いていないか
```

## bot で 24/7 運用する場合

read-only profile → paper → dry-run → 本番という段階フローを [レシピ集](recipes.md#bot-運用の段階フロー) と、リポジトリの [botter 運用 Runbook](https://github.com/bitbankinc/bitbank-lab-cli/blob/main/docs/botter-runbook.md) にまとめています。監視には読み取り専用キー、取引には取引用キーを別プロファイルにして、誤爆の被害を局所化してください（[API キーの設定](../getting-started/api-keys.md) を参照）。
