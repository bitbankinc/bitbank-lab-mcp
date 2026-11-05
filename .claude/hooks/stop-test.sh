#!/usr/bin/env bash
set -euo pipefail

# Stop Hook: テスト自動実行 + 完了条件チェックリスト検証
# 1. completion-checklist があれば検証（checklist-verify.sh）
# 2. .ts/.tsx の変更があればテスト実行
#
# 最適化:
#   - compact 起因の Stop は SessionStart matcher で除外済み（hook 自体が発火しない）
#   - 60 秒以内の再実行はスロットリングでスキップ

# ── スロットリング（60 秒） ──
STOP_STAMP="/tmp/.claude-stop-hook-last-run"
STOP_THROTTLE_SEC=60

if [ -f "$STOP_STAMP" ]; then
  last_run="$(cat "$STOP_STAMP" 2>/dev/null || echo 0)"
  now="$(date +%s)"
  if [ $(( now - last_run )) -lt "$STOP_THROTTLE_SEC" ]; then
    exit 0
  fi
fi
date +%s > "$STOP_STAMP"

diag=""

# ── 1. Completion Checklist 検証 ──
CHECKLIST_HOOK="$(dirname "$0")/checklist-verify.sh"
if [ -f ".claude/completion-checklist" ] && [ -x "$CHECKLIST_HOOK" ]; then
  checklist_out="$(bash "$CHECKLIST_HOOK" 2>&1)" || true
  if [ -n "$checklist_out" ]; then
    # checklist-verify.sh が JSON を出力した場合はフィードバック内容を抽出
    checklist_msg="$(echo "$checklist_out" | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null || true)"
    if [ -n "$checklist_msg" ]; then
      diag="$checklist_msg"
    fi
  fi
fi

# ── 2. テスト自動実行（.ts/.tsx の変更がある場合のみ） ──
changed="$(git diff --name-only HEAD 2>/dev/null || true)"
staged="$(git diff --cached --name-only 2>/dev/null || true)"
untracked="$(git ls-files --others --exclude-standard 2>/dev/null || true)"

all_changes="$(printf '%s\n%s\n%s' "$changed" "$staged" "$untracked" | sort -u | grep -v '^$' || true)"

if echo "$all_changes" | grep -qE '\.(ts|tsx)$'; then
  # テスト実行（tail で出力を抑制しつつ結果を表示）
  test_out="$(npx --no-install vitest run --reporter=verbose 2>&1 | tail -20)" || true

  # 失敗があればフィードバック
  if echo "$test_out" | grep -qE 'Tests\s+.*failed'; then
    diag="${diag:+${diag}
}[TestFailure] テストが失敗しています。修正してください:
$test_out"
  fi
fi

# ── 診断結果を出力 ──
if [ -n "$diag" ]; then
  jq -Rn --arg msg "$diag" '{
    continue: false,
    stopReason: $msg
  }'
fi
