#!/usr/bin/env bash
set -euo pipefail

# checklist-verify.sh — completion-checklist の各チェックを実行
#
# .claude/completion-checklist が存在する場合のみ動作。
# 全チェック通過で checklist を自動削除し、失敗があれば
# additionalContext としてフィードバックする。
#
# フォーマット（1行1チェック）:
#   file_exists <path>            — ファイルが存在すること
#   file_not_empty <path>         — ファイルが空でないこと
#   no_type_errors                — tsc --noEmit でエラーが 0
#   test_passes [filter]          — vitest run が成功（filter はオプション）
#   grep_in <pattern> <path>      — ファイル内にパターンが存在
#   grep_not_in <pattern> <path>  — ファイル内にパターンが存在しない
#   cmd <command...>              — 任意コマンドの exit 0 を検証
#   # ...                         — コメント（無視）

CHECKLIST=".claude/completion-checklist"

# チェックリストが無ければ即終了（正常）
if [ ! -f "$CHECKLIST" ]; then
  exit 0
fi

failures=""
line_num=0

while IFS= read -r line || [ -n "$line" ]; do
  line_num=$((line_num + 1))

  # 空行・コメント行をスキップ
  trimmed="$(echo "$line" | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')"
  if [ -z "$trimmed" ] || [ "${trimmed#\#}" != "$trimmed" ]; then
    continue
  fi

  # インラインコメントを除去（ # 以降）
  check="$(echo "$trimmed" | sed 's/[[:space:]]*#.*$//')"
  check_type="$(echo "$check" | awk '{print $1}')"
  args="$(echo "$check" | sed "s/^${check_type}[[:space:]]*//")"

  result=0
  case "$check_type" in
    file_exists)
      [ -f "$args" ] || result=1
      ;;
    file_not_empty)
      [ -s "$args" ] || result=1
      ;;
    no_type_errors)
      npx --no-install tsc --noEmit -p tsconfig.json >/dev/null 2>&1 || result=1
      ;;
    test_passes)
      if [ -n "$args" ]; then
        npx --no-install vitest run "$args" >/dev/null 2>&1 || result=1
      else
        npx --no-install vitest run >/dev/null 2>&1 || result=1
      fi
      ;;
    grep_in)
      pattern="$(echo "$args" | awk '{print $1}')"
      filepath="$(echo "$args" | awk '{print $2}')"
      if [ -z "$pattern" ] || [ -z "$filepath" ]; then
        result=1
      else
        grep -q "$pattern" "$filepath" 2>/dev/null || result=1
      fi
      ;;
    grep_not_in)
      pattern="$(echo "$args" | awk '{print $1}')"
      filepath="$(echo "$args" | awk '{print $2}')"
      if [ -z "$pattern" ] || [ -z "$filepath" ]; then
        result=1
      else
        ! grep -q "$pattern" "$filepath" 2>/dev/null || result=1
      fi
      ;;
    cmd)
      eval "$args" >/dev/null 2>&1 || result=1
      ;;
    *)
      failures="${failures}\nL${line_num}: 不明なチェックタイプ '${check_type}'"
      continue
      ;;
  esac

  if [ "$result" -ne 0 ]; then
    failures="${failures}\nL${line_num}: FAIL — ${check}"
  fi
done < "$CHECKLIST"

if [ -n "$failures" ]; then
  jq -Rn --arg msg "[CompletionChecklist] 未達の完了条件があります:${failures}\n\nチェックリスト: ${CHECKLIST}" '{
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext: $msg
    }
  }'
else
  # 全チェック通過 → チェックリストを自動削除
  rm -f "$CHECKLIST"
fi
