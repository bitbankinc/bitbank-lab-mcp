#!/usr/bin/env bash
set -euo pipefail

# Purpose: Auto-fix formatting/lint issues after .ts file edits, then collect
# remaining diagnostics (oxlint, tsc, banned patterns) as feedback for the AI.
#
# Phase 3 (tsc) 最適化:
#   - --incremental + tsBuildInfoFile で 2 回目以降を高速化 (~6s → ~1.5s)
#   - 前回成功から 30 秒以内はスキップ（連続編集時のオーバーヘッド削減）
#   - Lefthook pre-commit が最終的な型チェックのゲートキーパーとなる
input="$(cat)"
file="$(jq -r '.tool_input.file_path // .tool_input.path // empty' <<< "$input")"

# .ts/.tsx 以外は無視
case "$file" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

# ファイルが存在しない場合は無視（削除操作等）
[ -f "$file" ] || exit 0

diag=""

# npx は --no-install で使う。node_modules が無いと npm 上の同名の別パッケージ（`biome` 等）を取得して実行してしまうため。

# Phase 1: サイレント自動修正
npx --no-install biome format --write "$file" >/dev/null 2>&1 || true
npx --no-install oxlint --fix "$file" >/dev/null 2>&1 || true

# Phase 2: 残った lint 違反を収集
lint_out="$(npx --no-install oxlint "$file" 2>&1 | head -30)" || true
if echo "$lint_out" | grep -qE 'Found [1-9][0-9]* (warning|error)'; then
  diag="[Oxlint] $lint_out"
fi

# Phase 3: 型チェック（incremental + スロットリング）
TSC_STAMP="/tmp/.claude-tsc-last-ok"
TSC_BUILDINFO="/tmp/.claude-tsc-buildinfo"
TSC_THROTTLE_SEC=30

run_tsc=true
if [ -f "$TSC_STAMP" ]; then
  last_ok="$(cat "$TSC_STAMP" 2>/dev/null || echo 0)"
  now="$(date +%s)"
  elapsed=$(( now - last_ok ))
  if [ "$elapsed" -lt "$TSC_THROTTLE_SEC" ]; then
    run_tsc=false
  fi
fi

if [ "$run_tsc" = true ]; then
  tsc_out="$(npx --no-install tsc --noEmit --incremental --tsBuildInfoFile "$TSC_BUILDINFO" -p tsconfig.json 2>&1 | grep -F "$file" | head -10)" || true
  if [ -n "$tsc_out" ]; then
    diag="${diag:+${diag}
}[TypeScript] $tsc_out"
  else
    # 対象ファイルにエラーなし → タイムスタンプ更新
    date +%s > "$TSC_STAMP"
  fi
fi

# Phase 4: banned patterns チェック
if grep -n 'new Date' "$file" | grep -v '\.test\.ts' | grep -v '// *allow-date' > /dev/null 2>&1; then
  banned="$(grep -n 'new Date' "$file" | head -5)"
  diag="${diag:+${diag}
}[BannedPattern] 'new Date' is banned. Use dayjs from lib/datetime.ts instead:
$banned"
fi

# Phase 4: 取引手数料の単一ソース強制（見積り手数料は lib/fees.ts 経由必須）
#   - 手数料定数 0.0012 のハードコード
#   - *_fee_rate_quote を Number()/parseFloat() で直接 parse、または || で処理する記述
#   除外: lib/fees.ts 本体・tests/ 配下・行末 // allow-fee コメント
FEE_PATTERN='0\.0012|(Number|parseFloat)\([^)]*_fee_rate_quote|_fee_rate_quote.*\|\|'
case "$file" in
  */lib/fees.ts|*/tests/*) ;;
  *)
    if grep -nE "$FEE_PATTERN" "$file" | grep -v '// *allow-fee' > /dev/null 2>&1; then
      banned_fee="$(grep -nE "$FEE_PATTERN" "$file" | grep -v '// *allow-fee' | head -5)"
      diag="${diag:+${diag}
}[BannedPattern] 取引手数料の定数/直接 parse is banned. 見積り手数料は lib/fees.ts (resolveFeeRate / estimateOrderFee) 経由で解決してください (例外行末に // allow-fee):
$banned_fee"
    fi
    ;;
esac

# additionalContext として注入
if [ -n "$diag" ]; then
  jq -Rn --arg msg "$diag" '{
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: $msg
    }
  }'
fi
