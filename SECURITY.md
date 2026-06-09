# Security Policy

## サポート対象バージョン

`bitbank-lab-mcp` は最新の minor 系列のみをサポートします。
0.x の間は最新 patch のみがセキュリティ修正の対象です。

| Version | サポート |
|---------|----------|
| 最新の 0.x.y | ✅ |
| それ以前 | ❌ |

## 脆弱性の報告方法

本リポジトリは bitbank のバグバウンティプログラムの対象範囲外です。
bitbank のバグバウンティ scope は `bitbank.cc` / `app.bitbank.cc` / `api.bitbank.cc` のみが対象であり、本リポジトリで発見された脆弱性に対する報奨金の支払いはありません（詳細: [bitbank セキュリティについて](https://bitbank.cc/doc/security-about)）。

ただし、セキュリティに関するご指摘はコントリビューションとして歓迎します。**機微な内容（未公開の脆弱性など）は GitHub の "Private vulnerability reporting" をご利用ください。**

https://github.com/tjackiet/bitbank-lab-mcp/security/advisories/new から
非公開でご報告ください。

ご報告に含めていただきたい情報:

- 影響を受けるバージョン
- 再現手順（最小ケース）
- 想定される影響（資金影響の有無 / 鍵漏洩の可能性 / リモート実行の可否）
- PoC があれば添付

## スコープ

### 対象

- `src/` および `tools/` 配下のコード（公開された MCP サーバーで再現できる挙動）
- 公開済み npm パッケージ `bitbank-lab-mcp` の tarball 内容
- API 鍵の取り扱い（env、HMAC 署名）に関する欠陥
- 取引系ツールの 2 ステップ確認（`preview_*` → `create_order` / `cancel_order` / `cancel_orders` の `confirmation_token`）の bypass

### 対象外

- bitbank API 自体の脆弱性（[bitbank セキュリティについて](https://bitbank.cc/doc/security-about) に従ってご報告ください）
- ユーザーが手元で書いた skill / hook / plugin の挙動
- ソーシャルエンジニアリング / フィッシング

## 報告者への対応

- 受領後に CVE 採番が妥当な severity であれば GHSA を起票します
- 修正版リリース時に CHANGELOG / GHSA 上でクレジット表記します（希望者のみ）

## 現在の対策

- `npm audit` を CI で実行し、依存の既知脆弱性を継続的に検出
- Dependabot で依存を weekly 更新
- OIDC trusted publishing + `--provenance` で改ざん検出を可能化
- `files` allowlist で不要ファイル（`.env*` 等）を tarball から排除
- Private POST（注文・キャンセル系）はリトライ無効化で冪等性を保護（`src/private/client.ts` の `post()` が `retries: 0` を強制）
