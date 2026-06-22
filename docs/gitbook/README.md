---
description: bitbank の市場データ取引機能を生成AIから扱う MCPサーバーと CLI のドキュメントです。
---

# はじめに

本ツールは開発段階（ベータ版）です。利用は自己責任でお願いします。  
ご利用の前に必ず ⚠️ 免責事項 をお読みください。

## 概要

bitbank の公開 API を基盤として、AI が市場データや取引機能を利用できるようにするためのツールです。

#### **MCPサーバー**

* 暗号資産トレード初〜中級者の方におすすめ
* データの取得、シンプルな指標分析、可視化、取引実行が可能
* Tools でカバーされている範囲であれば、サーバー側で計算済みの分析結果を返します
  * Skills で応用的なカスタマイズをすることも可能です
* MCPクライアントとして優れた Claude Desktop の利用を推奨します

#### **CLI**

* 暗号資産トレード中〜上級者、または開発者の方におすすめ
* コマンドライン（CLI）と Skills を組み合わせて、指標やロジックを自由に設計可能
* 生データを LLM に渡して、分析ロジックは LLM 側の計算に任せる設計です
* Claude Code / Cursor / Codex 等での利用を推奨します

[![npm](https://img.shields.io/npm/v/bitbank-lab-mcp.svg)](https://www.npmjs.com/package/bitbank-lab-mcp) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE/)

{% hint style="info" %}
bitbank API 自体の仕様は [bitbank API ドキュメント](https://github.com/bitbankinc/bitbank-api-docs)を参照してください。
{% endhint %}

### 注意事項

{% hint style="warning" %}
本ドキュメントが扱うツールが提供するデータをAIエージェントが処理した結果は、必ずしも正確性・完全性を保証するものではありません。提供される情報は情報提供のみを目的としており、投資助言・代理業に該当するものではありません。投資判断はご自身の責任で行ってください。
{% endhint %}
