# コントリビューションガイド

## 秘密情報の誤コミット防止（gitleaks）

pre-commit フック（lefthook）が、ステージ済みの**内容**を gitleaks で走査する。
CI の Security Audit と同じルールセットで、鍵がリポジトリに入る前に commit を止める。

**gitleaks のインストールが必須。** 未導入だと pre-commit が失敗する（黙ってスキップはしない）:

```bash
brew install gitleaks          # macOS
# その他: https://github.com/gitleaks/gitleaks#installing
gitleaks version
```

- **誤検知だった場合**: 実鍵でないことを確認したうえで、行末に `gitleaks:allow` を付けるか、
  `.gitleaksignore` に fingerprint と理由コメントを追加する。
- **一時的に回避する場合**: `LEFTHOOK_SKIP_GITLEAKS=1 git commit ...`。回避した理由を PR に必ず明記すること。

### なぜ pre-commit で止める必要があるか

CI の gitleaks（`.github/workflows/security.yml`）は push 後にしか走らない。その時点で
コードは既に GitHub に到達し、CodeRabbit などリポジトリ全体を参照するレビューツールにも
渡っている。CI は最後の網であって、送信を防ぐ位置にはいない。commit 時点で止めるのが本命の防御。

## 依存パッケージのクールダウン運用

### 方針

公開直後の npm パッケージバージョンは自動的にインストールしない。過去のサプライチェーン攻撃事例
（2026-03 の axios 侵害事件など）を踏まえ、コミュニティ・自動セキュリティツールによる検出・報告の
時間的猶予を確保する。

### 設定の全体像

| レイヤ | 設定 | 守る対象 |
|---|---|---|
| ローカル / CI の `npm install`・`npm update` | `.npmrc` の `min-release-age=7` | 新しい依存を**解決して lockfile に書き込む**瞬間 |
| Dependabot の version update | `.github/dependabot.yml` の `cooldown` | Dependabot が出す定常アップデート PR |

新しいバージョンが公開されてから **7 日**経過するまで、解決・提案の対象外になる。運用しながら必要に
応じて調整する（例: 3 日 / 14 日）。

### 注意点（重要）

- **`min-release-age` は npm 11.10.0 以上が必要。** Node 22 同梱の npm（10.x）では**黙って無視され、
  「効いていないのに通る」**状態になる。ローカル開発では npm を上げておくこと:

  ```bash
  npm install -g npm@^11.10
  npm --version   # 11.10.0 以上を確認
  ```

- **`npm config get min-release-age` が `null` を返すことがある。** npm 11.10+ は内部で `before`（絶対日付）に
  変換するため、設定が効いていても表示は `null` になりうる。実効値は `npm config get before` で確認する。
- **`npm ci` は対象外。** lockfile 厳密インストールのため、クールダウンは効かない（CI は影響を受けない）。
  守りどころは「依存を**追加・更新**して lockfile を書き換える瞬間」であり、ここは `npm install` /
  `npm update` を使うローカル開発と Dependabot が該当する。
- **security update（CVE 対応）はクールダウン対象外。** 脆弱性パッチは早く当てるべきなので、Dependabot
  は cooldown を無視して即時 PR を出す（設計どおり）。

### 緊急パッチが必要な場合

セキュリティ修正など 7 日待てない場合は、いずれかで対応する:

- `.npmrc` を一時的に書き換える PR を出す（マージ前にレビュー必須）
- バージョンを明示指定してインストールする（必要に応じて `--ignore-scripts` を併用し、悪意ある
  インストールスクリプトの実行を抑止する）

いずれの場合も、**PR description に「なぜ通常のクールダウンを待たないか」を明記**すること。
