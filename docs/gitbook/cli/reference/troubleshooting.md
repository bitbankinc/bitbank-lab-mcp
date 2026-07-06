---
description: bitbank CLI の初回セットアップで踏みやすいエラーと、その対処法をまとめたトラブルシューティング集です。
---

# トラブルシューティング

初回セットアップで遭遇しやすい事象と、その対処をまとめます。

## `bitbank: command not found`

CLI がグローバルインストールされていない、または `npm i -g` の後に PATH へ反映されていない可能性があります。`npm i -g bitbank-lab-cli` でインストールするか、クローン済みの環境では `npx tsx cli/index.ts ...` のフォールバック手順で代替できます（[クイックスタート](../getting-started/quickstart.md) を参照）。

## `BITBANK API credentials are not configured` 系のエラー

Private API / Trade コマンドは認証情報が必要です。`bitbank profile add` でプロファイルを登録するか、`BITBANK_API_KEY` / `BITBANK_API_SECRET` を環境変数に設定してください。詳しくは [API キーの設定](../getting-started/api-keys.md) を参照してください。

## Public コマンドで HTTP 403 / Forbidden

`ticker` や `candles` などの Public（API キー不要）コマンドで HTTP 403 が返る場合、原因は API キーではなく **IP / 地域 / ネットワーク制限**（VPN・データセンター IP・地域ブロック・WAF など）の可能性が高いです。この経路は鍵を使わないため、CLI も終了コードを `AUTH`(2) ではなく `GENERAL`(1) で返します。制限のない回線（自宅 ISP など）で再実行してください。

{% hint style="info" %}
Private / Trade コマンドの 403 は、従来どおり認証失敗（`AUTH`(2)）として扱われます。
{% endhint %}

## HTTP 429 / レートリミット

bitbank API のレートリミットに到達すると、CLI は終了コード 3（`RATE_LIMIT`）で終了します。しばらく待ってから再実行してください。エラーコードと終了コードのマッピングは [設定・環境変数](configuration.md#api-エラーコード) を参照してください。

## `npm test` が `vitest: not found` で落ちる

依存パッケージが入っていません。クローン直後は先に `npm ci` を実行してください。

## WebSocket が突然切れる / 再接続を繰り返す

`bitbank watch ticker` は切断時に指数バックオフで自動再接続し、無音検出で再接続フローに入ります。再接続の上限は `--max-retries`（既定 100）、無音検出のしきい値は `--idle-timeout`（既定 30 秒）で調整できます。上限に到達した場合は終了コード 5（`NETWORK`）を返します。

## plugin の Skills が出てこない

`/plugin install` の後に Skill がトリガーされない場合は、次の順で対処します。

1. **Claude Code を最新へ更新** — plugin 機能は新しめの本体が前提です（概ね v2.1 系以降）。
2. **完全に再起動** — `/reload-plugins` で済ませず、一度 Claude Code を終了してから起動し直します。
3. **キャッシュを消して再インストール** — `rm -rf ~/.claude/plugins/cache/<plugin>` してから入れ直します。

{% hint style="warning" %}
`/reload-plugins` の表示カウンタは、実際のロード数と一致しないことがあります。数字を当てにせず、実際に Skill を呼んで（例:「BTC の RSI を見て」）トリガーされるかで確認してください。
{% endhint %}

## それでも解決しないとき

バグ報告・機能リクエストは [GitHub Issues](https://github.com/bitbankinc/bitbank-lab-cli/issues) へお願いします。セキュリティ上の問題は公開 Issue にせず、リポジトリの [SECURITY.md](https://github.com/bitbankinc/bitbank-lab-cli/blob/main/SECURITY.md) のフロー（GitHub の Private vulnerability reporting）に従って非公開で報告してください。
