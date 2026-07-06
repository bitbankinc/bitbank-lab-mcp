---
description: bitbank CLI についてよくある質問。CLI と MCP の使い分け、API キーの要否、取引の安全性、対応環境、カスタマイズ可否などをまとめます。
---

# FAQ

## CLI と MCP、どちらを使えばいいですか？

「指標のパラメータやロジックを自分で組み立てたい」なら **CLI**、「すぐ使える計算済みの結論がほしい」なら **MCP** が向いています。CLI は生データを渡して LLM に計算させ、MCP はサーバー側で計算した結論を返します。詳しい比較は [はじめに](../../README.md) の「どちらが自分に向いている？」を参照してください。

## API キーは必須ですか？

いいえ。ticker・candles などの **Public コマンド**と、仮想資金の **Paper コマンド**は API キー不要で使えます。口座情報の読み取り（Private）と資金操作（Trade）だけ API キーが必要です。

## 取引コマンドは本当に資金を動かしますか？安全ですか？

Trade コマンドは資金を動かしますが、安全ガードが二重にかかっています。`--execute` を付けない限り API を叩かず（ドライラン）、さらに `--execute` 単独でも POST には到達せず、コマンドごとの固定フレーズを `--confirm=<phrase>` で渡す二段確認が必須です。仕組みは [取引と安全ガード](../guides/trading.md) を参照してください。

{% hint style="info" %}
実際の取引の前に、まずは [Paper（ペーパートレード）](../guides/trading.md) で仮想資金の練習をするのがおすすめです。Paper は実 API を叩かず、API キーも不要です。
{% endhint %}

## どのエージェントで使えますか？

Claude Code / Cursor はリポジトリを開くだけで Skill が自動トリガーされます。Codex CLI / Gemini CLI などは、各エージェントが見るパスに Skill を配置すると自動トリガーできます。配置しなくても、`AGENTS.md` を読ませれば CLI 自体は呼び出せます。詳しくは [基本的な使い方](../guides/usage.md) を参照してください。

## Skill をカスタマイズできますか？

できます。Skill はコードではなく「モデルへの指示書」なので、指標のパラメータやデフォルト戦略を編集したり、独自 Skill を追加したりできます。`skills/<name>/SKILL.md` を作るだけで新しい Skill を追加できます。手順はリポジトリの [カスタマイズガイド](https://github.com/bitbankinc/bitbank-lab-cli/blob/main/docs/customization-guide.md) を参照してください。

## 対応している OS と Node.js のバージョンは？

Node.js **20 以上**で動作し、Linux / macOS / Windows に対応しています。

## Web 版（claude.ai/code）で plugin は使えますか？

`/plugin install` はローカル版 Claude Code CLI（ターミナル）向けの slash command です。Web 版のクラウドサンドボックスは一時的で `bitbank` CLI を永続的に PATH へ通せないため、Skill が CLI を呼べません。ローカル環境で使ってください。

## ペーパートレードは実際の注文を出しますか？

出しません。Paper コマンドは public ticker のみを叩き、private / trade エンドポイントには一切触れません。状態はローカルの `paper-state.json` に保存されるだけで、実際の口座には影響しません。

## このツールは投資助言ですか？

いいえ。本ツールは情報提供のみを目的としており、投資助言・勧誘ではありません。詳しくは [免責事項](disclaimer.md) を必ずお読みください。
