# docs/ 索引

初めて読む人向けの地図。まず [リポジトリ直下の README](../README.md)（利用者向け）→ [development.md](development.md)（ソースから起動）の順で読めば足りる。

## 利用者向け

| ファイル | 内容 |
|---|---|
| [tools.md](tools.md) | 全 MCP ツールのカタログ |
| [prompts-table.md](prompts-table.md) | プロンプト集（何を聞けばよいか） |
| [private-api.md](private-api.md) | 口座系ツールのガイド（API キー・発注確認） |

## 開発・運用向け

| ファイル | 内容 |
|---|---|
| [development.md](development.md) | ソースから起動・よくある変更の手順 |
| [adr/](adr/) | 設計判断の記録（Result パターン、Zod 単一ソース、確認トークン等） |
| [internal/](internal/) | 実測ベースの内部仕様（candle の TZ、約定アーカイブ、view 語彙） |
| [prompts-design.md](prompts-design.md) | MCP Prompts の設計方針 |
| [ops.md](ops.md) | ログ・統計・リリース（CD） |
| [rollback-guide.md](rollback-guide.md) | リリースのロールバック手順 |
| [gitbook/](gitbook/) | 公開ドキュメントサイトの原稿（.gitbook.yaml から参照） |

## 過去の作業記録・運用雛形（初見では読まなくてよい）

時点依存の引き継ぎメモや、精度点検の運用で使うチェックリスト・ログ雛形。歴史的経緯を調べるとき以外は開かなくてよい。

| ファイル | 内容 |
|---|---|
| [private-api-handoff.md](private-api-handoff.md) / [private-api-p3-handoff.md](private-api-p3-handoff.md) | Private API 精度点検の引き継ぎメモ |
| [market-data-accuracy-checklist.md](market-data-accuracy-checklist.md) / [private-api-accuracy-checklist.md](private-api-accuracy-checklist.md) | 精度スポットチェックの手順書 |
| [market-data-accuracy-log.example.md](market-data-accuracy-log.example.md) / [private-api-accuracy-log.example.md](private-api-accuracy-log.example.md) | 点検ログの雛形（実ログはローカル専用で git 対象外） |
| [private-api-spot-check-prompts.md](private-api-spot-check-prompts.md) | 点検用プロンプト集 |
| [claude-code-request-analyze-indicators-macd-content.md](claude-code-request-analyze-indicators-macd-content.md) | 過去の調査依頼メモ |

`*.local.md` / `*.local.bak` はローカル専用（git 対象外）。
