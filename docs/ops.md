## Operations (Logging, Stats & Release)

---

### Release (CD)

#### 概要

`v*` タグの push で自動リリースパイプラインが起動します。

```
git tag v0.5.0 && git push origin v0.5.0
```

| ステップ | 内容 |
|---|---|
| 1. CI gate | lint / typecheck / test をタグ時点のコードで再実行 |
| 2. npm publish | [`bitbank-lab-mcp`](https://www.npmjs.com/package/bitbank-lab-mcp) を npm に公開 |
| 3. Docker push | `ghcr.io/tjackiet/bitbank-genesis-mcp-server` に push |
| 4. GitHub Release | changelog 自動生成でリリース作成 |

#### Pre-release

`v0.5.0-beta.1` のようなタグは pre-release として扱われます。

- npm: `beta` dist-tag で publish（`npm install bitbank-lab-mcp@beta`）
- Docker: `beta` タグ付与
- GitHub Release: `prerelease: true`

#### 手動実行

GitHub Actions の **Run workflow** から `workflow_dispatch` でタグを指定して手動実行も可能です。

#### 必要な GitHub Secrets

| Secret | 用途 | 設定方法 |
|---|---|---|
| `NPM_TOKEN` | npm publish 認証 | npmjs.com → Access Tokens → Automation token を生成し、repo Settings → Secrets → Actions に追加 |
| `GITHUB_TOKEN` | GHCR push / Release 作成 | 自動付与（設定不要） |

---

### JSONL Logs
- 実行ログは `./logs/YYYY-MM-DD.jsonl` に出力されます（`lib/logger.ts`）。

### 集計
```bash
npm run stat           # 全期間
npm run stat -- --last 24h
```

### CI / Cron 例
```cron
0 9 * * * cd /path/to/bitbank-genesis-mcp-server && /usr/bin/npm run stat --silent -- --last 24h >> reports/$(date +\%F).log 2>&1
```


### Docker起動（開発・検証用）

最小の検証用途で Docker を使う場合の例です。Node 18+ があれば Docker は必須ではありません。

```bash
# ビルド
docker build -t bitbank-mcp .

# MCP Inspector からSTDIOで起動（推奨: 余計な出力を抑制）
npx @modelcontextprotocol/inspector docker run -i --rm \
  -e NO_COLOR=1 -e LOG_LEVEL=info \
  bitbank-mcp
```

ログ永続化（任意）:

```bash
docker run -it --rm \
  -v $(pwd)/logs:/app/logs \
  -e NO_COLOR=1 -e LOG_LEVEL=info \
  bitbank-mcp
```


