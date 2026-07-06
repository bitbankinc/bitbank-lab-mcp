---
description: 複数の Skill を束ねた Recipe の使い方と、現状把握から戦略評価までの投資ワークフローの流れを紹介します。
---

# レシピ集

**Recipe** は、複数の Skill を順に呼び出して一連のワークフローにまとめたものです。毎回手で個別の Skill をたどる代わりに、代表的な組み合わせを一気通貫で実行できます。

{% hint style="info" %}
Recipe 自体は計算をしません。各ステップで対応する Skill を順に呼び、最後に Recipe 用の総合判断を提示します。矛盾があれば「判断保留」として根拠を示します。**最終的な判断は人間が下す**前提です。
{% endhint %}

## 同梱されている Recipe

### recipe-pre-trade-check

ある銘柄を「買う前に最低限これだけは見る」を一気通貫で実行します。`portfolio` → `volatility-profile` → `data-verification` → `indicator-analysis` を順に呼び、総合判断（GO / WAIT / NO-GO）を提示します。

```text
「買う前にざっと見て」
「pre-trade check して」
「ETH エントリーしていい？」
```

### recipe-portfolio-review

保有ポートフォリオの「総点検」を一気通貫で実行します。`portfolio` → `correlation-analysis` → `volatility-profile` を順に呼び、総合判断（健全 / 注意 / 要見直し）を提示します。

```text
「ポートフォリオを見直したい」
「分散効いてる？」
「リバランス必要？」
```

{% hint style="info" %}
「買う前にざっと見て」「ポートフォリオを見直したい」のように**全体を束ねたい発話**では Recipe が、「RSI 見て」「ボラどう？」のような**個別の発話**では単一 Skill が起動します。
{% endhint %}

## 投資ワークフローでの活用

Recipe の背後にあるのは、「現状把握 → 環境分析 → 仮説検証 → 戦略評価 → モニタリング」という流れです。個別の Skill をこの順で使い分けるのがおすすめです。

1. **現状把握** — `portfolio` で保有資産と損益を確認。
2. **環境分析** — `volatility-profile`（リスクは過熱気味か）/ `correlation-analysis`（分散は効いているか）。
3. **個別銘柄チェック** — `data-verification`（データの健全性、任意）→ `indicator-analysis`（RSI・MACD・BB で現在地）。
4. **仮説検証** — `signal-explorer` で気になった指標の**予測力**を統計的に評価。
5. **戦略評価** — `backtest` で採用候補の戦略を過去データでシミュレーション。
6. **実行〜モニタリング** — 実行後は再び `portfolio` で追跡。値動きを張り付いて見たいときは `watch-live`。

`recipe-pre-trade-check` は上記の「環境分析〜個別銘柄チェック」を、`recipe-portfolio-review` は「現状把握〜環境分析」を束ねたものにあたります。

## bot 運用の段階フロー

実際の資金で 24/7 取引を回す前に通すべき手順は、**read-only → paper → dry-run → 本番**の段階フローとして整理されています。各段階には「次へ進む条件」があり、影響範囲を一段ずつ広げます。詳しくはリポジトリの [botter 運用 Runbook](https://github.com/bitbankinc/bitbank-lab-cli/blob/main/docs/botter-runbook.md) を参照してください。取引の安全ガードそのものは [取引と安全ガード](trading.md) にまとめています。
