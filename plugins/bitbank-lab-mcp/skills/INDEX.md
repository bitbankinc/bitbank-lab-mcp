# Skills カタログ

bitbank-lab-mcp に同梱する Agent Skill の索引。
各 skill は `skills/<name>/SKILL.md` を起点に、必要に応じて `references/` 配下に
詳細ガイドを置く。横断で参照するドキュメントは `_shared/references/` に集約する。

## 分類

- **Primitive Skill** — 単一責務。単独で完結する。
- **Recipe Skill** — 複数の skill / ツールを束ねた複合ワークフロー。
  名前を `recipe-` プレフィックスで揃える。

## 一覧

### Onboarding

| Skill | 概要 | 代表的なユーザー発話 |
|---|---|---|
| [`investment-onboarding`](./investment-onboarding/SKILL.md) | リスク許容度・運用スタイル・戦術を最小限の問い（最大 3 問）で絞り込み、該当する戦術ガイドと MCP ツールへ誘導する。 | 「何から始めればいい？」「どう運用すれば？」「bitbank で運用したい」 |

<!--
今後追加する際のカテゴリ案（CLI 側 INDEX.md と揃える）:

- Market Read — リアルタイム市況読解
- Risk & Statistics — ボラ・相関などの統計
- Signal & Strategy — シグナル探索・バックテスト
- Portfolio — 保有資産の評価
- Operations — データ品質・プロファイル管理・ペーパートレード
- Recipes — 複合ワークフロー（`recipe-*`）
-->

## 共通リファレンス

複数 skill から参照される共通ドキュメントは [`_shared/references/`](./_shared/references/) に置く。
