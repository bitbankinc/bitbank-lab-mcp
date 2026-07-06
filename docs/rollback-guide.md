# ロールバック手順ガイド

本プロジェクトのリリースとロールバックに関する運用手順書。

---

## 前提: リリースの仕組み

`v*` タグを push すると `.github/workflows/release.yml` が以下を自動実行する:

1. CI チェック（lint / typecheck / test）
2. npm publish（`bitbank-lab-mcp`）
3. Docker イメージを GHCR に push
4. GitHub Release を作成（リリースノート自動生成）

---

## 1. リリース手順（通常）

```bash
# 1. main ブランチで最新を取得
git checkout main && git pull origin main

# 2. CHANGELOG.md を更新（[Unreleased] → [x.y.z] - YYYY-MM-DD）

# 3. タグを打って push
git tag v0.1.0
git push origin v0.1.0
# → release.yml が自動で npm publish + Docker push + GitHub Release
```

### プレリリース

```bash
git tag v0.2.0-beta.1
git push origin v0.2.0-beta.1
# → npm dist-tag は "beta"、GitHub Release は prerelease フラグ付き
```

---

## 2. ロールバック手順

### 2a. npm パッケージのロールバック

```bash
# 現在の latest タグを確認
npm dist-tag ls bitbank-lab-mcp

# latest タグを旧バージョンに付け替える
npm dist-tag add bitbank-lab-mcp@<旧バージョン> latest

# 例: v0.2.0 に問題があり v0.1.0 に戻す
npm dist-tag add bitbank-lab-mcp@0.1.0 latest
```

これにより `npm install bitbank-lab-mcp` で旧バージョンがインストールされる。
問題のあるバージョンのコード自体は npm 上に残るが、明示的に指定しない限りインストールされない。

#### 問題バージョンに非推奨マークを付ける場合

```bash
npm deprecate bitbank-lab-mcp@0.2.0 "セキュリティ問題あり。0.1.0 を使用してください"
```

#### npm unpublish（最終手段）

```bash
# 公開から 72 時間以内のみ可能
npm unpublish bitbank-lab-mcp@0.2.0
```

> **注意**: unpublish は他のプロジェクトが依存している場合に破壊的。
> 通常は `deprecate` + dist-tag 付け替えで十分。

### 2b. Docker イメージのロールバック

```bash
# latest タグを旧バージョンのイメージに付け替える
docker pull ghcr.io/tjackiet/bitbank-lab-mcp:0.1.0
docker tag  ghcr.io/tjackiet/bitbank-lab-mcp:0.1.0 \
            ghcr.io/tjackiet/bitbank-lab-mcp:latest
docker push ghcr.io/tjackiet/bitbank-lab-mcp:latest
```

または、利用者側でバージョン指定に切り替える:

```bash
# docker-compose.yml 等で
image: ghcr.io/tjackiet/bitbank-lab-mcp:0.1.0
```

### 2c. Git リポジトリ上のロールバック

問題タグを削除する必要は基本的にない。
修正版を新しいパッチバージョンとしてリリースする。

```bash
# 旧バージョンのコードで修正ブランチを作る
git checkout -b hotfix/rollback-v0.2.0 v0.1.0

# 修正を加えてコミット・PR・マージ後
git tag v0.2.1
git push origin v0.2.1
# → 自動で修正版がリリースされる
```

### 2d. GitHub Release の対応

問題のあるリリースを削除する必要はない。
GitHub Release を編集して警告を追記する:

> ⚠️ このバージョンには問題があります。v0.2.1 以降を使用してください。

---

## 3. 判断フローチャート

```
問題のあるバージョンをリリースしてしまった
│
├─ セキュリティ上の緊急度が高い？
│   ├─ YES → npm deprecate + dist-tag 付替え + Docker latest 付替え
│   │         → hotfix ブランチで修正 → 新パッチリリース
│   └─ NO  → hotfix ブランチで修正 → 新パッチリリース
│             （旧バージョンはそのまま残す）
│
└─ npm unpublish が必要？
    └─ 認証情報やシークレットの漏洩時のみ検討（72 時間以内）
```

---

## 4. 初回リリース前チェックリスト

- [ ] npmjs.com の `bitbank-lab-mcp` で Trusted Publisher（OIDC）が登録されているか（`release.yml` の `npm-publish` job / environment `production`）。publish 認証はこれで行うため `NPM_TOKEN` シークレットは不要
- [ ] GHCR への push 権限があるか（`GITHUB_TOKEN` は自動提供）
- [ ] CHANGELOG.md に初回リリース内容を記載したか
