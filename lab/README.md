# lab/ — 研究用の起動口

**研究・検証専用。** private API の接続先を、同じマシンに立てたモックや中継（要求を受けて取引 API 側へ渡す
プロキシ）へ差し替えてから MCP サーバーを起動する。判断の経緯は [ADR-0008](../docs/adr/0008-private-api-origin-lab-entry.md)。

- `lab/` は npm の配布物にも Docker イメージにも入らない。`npx bitbank-lab-mcp` では使えない。
  リポジトリを checkout して起動する（再現のため、タグか commit SHA を固定する）
- 環境変数・`.env`・設定ファイルからは接続先を変えられない。変わるのはこの起動口を使ったときだけ

## 何が差し替わるか

| 通信 | 接続先 |
|---|---|
| private API（`/v1/user/…`。資産・注文・取消・履歴など） | **`--private-api-origin` で指定した origin** |
| 公開 API（`https://public.bitbank.cc`。ticker・板・ローソク足など） | 本番のまま |
| ペア情報（`https://api.bitbank.cc/v1/spot/pairs`。認証不要） | 本番のまま（取れなくても preview / create は警告を出して続行する） |
| 上記以外で `https://api.bitbank.cc` へ向かう要求 | **止める**（既定のクライアントを迂回した要求。差し替え先の迂回にあたる） |

## 指定できる origin

ループバックの http(s) origin だけ。`http://127.0.0.1:14000` のように **scheme・ホスト・ポートだけ**を書く。

- ホストは `127.0.0.1` / `[::1]` / `localhost` のいずれか（`localhost` は hosts ファイルに依存するので `127.0.0.1` を勧める）
- パス・末尾の `/`・クエリ・userinfo は付けられない。GET の署名は「パス + クエリ」に対して作られるため、
  パスの接頭辞を付けると署名したパスと送るパスがずれる。中継は受け取ったパスをそのまま転送する前提
- 不正な値・未指定・キー未設定のときは、サーバーを起動せずに終了コード 2 で終わる。本番の接続先へは戻さない
- 差し替え先がリダイレクトを返しても従わない（要求は失敗する）。中継は転送先を返すのではなく、自分で取引 API 側へ渡す

## 起動のしかた

```bash
BITBANK_MOCK_API_KEY=dummy BITBANK_MOCK_API_SECRET=dummy npm run dev  # モック側。検証するときだけ。モックの checkout で
npm ci
BITBANK_API_KEY=dummy BITBANK_API_SECRET=dummy \
  node_modules/.bin/tsx lab/start.ts --private-api-origin=http://127.0.0.1:14000
```

1 行目はモック（bitbank-lab-mock）の起動で、モックの checkout から別の端末で動かす（このリポジトリにも `npm run dev`
があるので取り違えない）。認証ヘッダを検証させるときだけ要り、キーとシークレットは MCP 側と同じ値にする（下の「注意」節）。

Claude Desktop などのホスト設定の例（パスは絶対パスにする。ホストが起動するときの cwd は `/` になりうる）:

```json
{
  "mcpServers": {
    "bitbank-lab": {
      "command": "/abs/path/to/bitbank-lab-mcp/node_modules/.bin/tsx",
      "args": [
        "/abs/path/to/bitbank-lab-mcp/lab/start.ts",
        "--private-api-origin=http://127.0.0.1:14000"
      ],
      "env": {
        "BITBANK_API_KEY": "dummy",
        "BITBANK_API_SECRET": "dummy",
        "LOG_LEVEL": "info",
        "NO_COLOR": "1"
      }
    }
  }
}
```

起動すると stderr に接続先が出る（stdout は MCP のプロトコルが使うので何も出さない）。
`logs/YYYY-MM-DD.jsonl` にも `private_api_origin_override` として残る。

## 確認（preview → 実行）の扱い

MCP の確認の仕組み（[ADR-0007](../docs/adr/0007-hitl-confirmation-token-delivery.md)）は、既存の利用者に
影響を出さないため変えない。

### 起動口は確認を外さない

- 確認（preview → 実行の 2 段階確認）はこれまでどおり効く。差し替えは確認を外さない。
  発注・取消（`create_order` / `cancel_order` / `cancel_orders`）は、`preview_*` から始まる確認を経たときだけ実行される。
  起動口に確認を外すオプションは無い（入れない理由は [ADR-0008](../docs/adr/0008-private-api-origin-lab-entry.md)「却下した案」）
- 確認に応えなければ発注されない。elicitation に対応していないクライアントからは実行できず、preview の内容だけが返る
  （ADR-0007 の MCP Apps の確認カードは別の経路で、運用者のオプトインと MCP Apps の UI を宣言したホストの両方が要り、
  こちらもカードでの確認を経る。[`docs/private-api.md`](../docs/private-api.md)「`confirmation_token` の受け渡し」節）

### 人が居ない状態で流すとき

- シナリオや検証スクリプトで流すときは、クライアント側が elicitation を宣言し、確認要求に自動で応える。
  2026-10-01 の通し確認（モック `e60aac9`・MCP `66d9a69`。認証あり・なしとも 12/12 OK）もこの形で流した
- これは起動口を使う側の決め事で、MCP に「確認を飛ばす」機能があるわけではない
- 応答の具体的な組み立て方はここに書かない（確認を通す手順書を残さない。`src/private/elicitation.ts` の
  拒否メッセージと同じ方針）
- 確認に自動で応えるクライアントは、差し替え先に向けたこの起動口でだけ使う。既定の起動（`npx bitbank-lab-mcp` や
  プラグイン）に繋ぐと、注文を誰も見ないまま本番へ発注される

### MCP の確認は差し替え先に届かない

- 差し替え先（モックや中継）が受け取るのは bitbank の REST 要求そのもの（パス・本文・`ACCESS-*` ヘッダ）で、
  確認を経たかどうかの情報は含まれない
- 人が応えても自動で応えても、差し替え先から見れば同じ要求になる。差し替え先で人間の確認を使いたいなら、
  MCP とは別の経路で受け取る

## 注意

- **モックに向けるときはダミーのキーを使う。** 検証の有無に関わらず、本物のキーを向けない。
  [bitbank-lab-mock](https://github.com/tjackiet/bitbank-lab-mock) が認証ヘッダを検証するかは、モックの起動のしかたで決まる
  （モックの `docs/fidelity.md`「認証」節）
  - **既定では検証しない。** どんなキーでも通る
  - **`BITBANK_MOCK_API_KEY` と `BITBANK_MOCK_API_SECRET` を両方設定して起動したときだけ検証する。** 効いていれば
    モックの起動の行に `auth=on` が出る（付かなければ検証していない）。片方だけだとモックは起動しない
  - 検証させるときは、MCP の `BITBANK_API_KEY` / `BITBANK_API_SECRET` を、それぞれモックの `BITBANK_MOCK_API_KEY` /
    `BITBANK_MOCK_API_SECRET` と同じ値にする（「起動のしかた」の例ではどれも `dummy`）。違うと private API の要求が
    断られ、MCP にはシークレットが違えば「署名が無効です」、キーが違えば「API キーが無効です」と表示される
- モックが実装していないエンドポイント（信用・入出金など）は、モックが `20003` を返し、MCP では
  「API キーが見つかりません」と表示される（モックの `docs/fidelity.md`「封筒に包まれない応答」節）。キーの問題ではない
- 差し替え先が返す応答（残高・注文の状態）は、本物の bitbank の応答として扱われる
- 署名は ACCESS-TIME-WINDOW 方式（既定 5 秒）で、要求ごとに一意な値を含まない。差し替え先が受け取った要求を
  そのまま本番へ転送する構成では、転送は時間窓の内に 1 回だけにする（再送すると二重発注になりうる）
