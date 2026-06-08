---
description: bitbank-lab-mcp のよくある質問
---

# よくある質問（FAQ）

## Q. 何を聞けばいいかわからない

[プロンプト集](../guides/prompts.md) を参照してください。初級（🔰）から中級者向けまで用意しています。まずは「BTC の今の市場状況を分析して」と話しかけるのがおすすめです。

## Q. Docker は必須？

いいえ。Node.js 22 以上でローカル実行できます。最短は Claude Desktop への登録です（[クイックスタート](../getting-started/quickstart.md)）。

## Q. API キーは必要？

公開データの取得・分析には不要です。自分の資産確認や注文操作（Private API）を使う場合のみ必要です（[Private API](../private-api/setup.md)）。

## Q. どのツールを使えばよい？

ツールを選ぶ必要はありません。「BTC の今の市場状況を分析して」のように自然文で尋ねれば、AI が適切なツールを自動的に選びます。できることの全体像は [MCP サーバーでできること](../guides/tools.md) を参照してください。

## Q. 対応銘柄は固定？

固定ではありません。上流の公開 API が返す銘柄に自動追随します（追加・廃止も自動反映）。

## Q. MCP Inspector でも試せる？

はい。npm 公開版に対して次で動作確認できます。

```bash
npx @modelcontextprotocol/inspector -- npx -y bitbank-lab-mcp
```

## Q. うまく動かない

[トラブルシューティング](../getting-started/troubleshooting.md) を参照してください。`npx` が見つからない場合の対処などをまとめています。
