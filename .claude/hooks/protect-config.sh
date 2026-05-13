#!/usr/bin/env bash
set -euo pipefail
# Purpose: Prevent accidental edits to protected config files (biome.json,
# tsconfig.json, etc). If code has lint/type errors, fix the code — not the config.

input="$(cat)"
tool_name="$(jq -r '.tool_name // empty' <<< "$input")"

# 保護対象の設定ファイル
PROTECTED="biome.json tsconfig.json lefthook.yml .claude/settings.json package.json .github/workflows/ci.yml"

# --- Write/Edit/MultiEdit: file_path ベースのチェック ---
if [[ "$tool_name" != "Bash" ]]; then
  file="$(jq -r '.tool_input.file_path // .tool_input.path // empty' <<< "$input")"
  for p in $PROTECTED; do
    case "$file" in
      *"$p"*)
        echo "BLOCKED: $file is a protected config file. Fix the code, not the linter/compiler config." >&2
        exit 2
        ;;
    esac
  done
  exit 0
fi

# --- Bash: コマンドに保護ファイル名 AND 書き込みパターンが含まれるかチェック ---
cmd="$(jq -r '.tool_input.command // empty' <<< "$input")"

# 書き込みパターン（リダイレクト・cp・mv・rm・tee・sed -i・install）
WRITE_RE='(^|[[:space:]])(cp|mv|rm|tee|install)([[:space:]]|$)|sed[[:space:]]+-i|(^|[^&])[0-9]*>[^&]'

for p in $PROTECTED; do
  case "$cmd" in
    *"$p"*)
      if echo "$cmd" | grep -qE "$WRITE_RE"; then
        echo "BLOCKED: Bash command targets protected config file '$p'. Fix the code, not the linter/compiler config." >&2
        exit 2
      fi
      ;;
  esac
done
