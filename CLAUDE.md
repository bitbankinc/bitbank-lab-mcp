# CLAUDE.md

## コマンド

```bash
npm test                    # unit / integration（vitest）。tests/e2e/** は除外
npm run test:e2e            # stdio サブプロセス E2E（手動 / nightly。PR では走らせない）
npm run lint:fix            # Oxlint で自動修正
npm run format              # Biome でフォーマット
npm run gen:types           # Zod スキーマから型定義を生成
npm run typecheck           # tsc --noEmit
```

## コード品質

- リンター（Biome / Oxlint）・pre-commit hook・banned-patterns が検出するルールに従う。
  警告やエラーが出たら無視・回避せず修正する。
- 独自の可視化コード生成は禁止 → `.claude/rules/charting.md`

## アーキテクチャ

- スキーマ変更は `src/schema/` 配下の Zod 定義を単一ソースとする（`src/schemas.ts` は re-export）
- 全ツールは `Result<T, M>` パターン（`ok()` / `fail()`）で返す
- `lib/` に共通ユーティリティがある処理は、外部ライブラリの直接利用や自前実装をせず `lib/` を使う
- 対応ペアは JPY 建てのみ（表示層が円前提）。非 JPY 建て対応は別途、表示層の quote 通貨移行が前提（`lib/validate.ts` の `ALLOWED_PAIRS`、ガードは `tests/lib/validate.test.ts`）。

## リポジトリルール

- `main` ブランチ保護。PR 経由でマージ。
- `AGENTS.md` は `CLAUDE.md` への symlink。
