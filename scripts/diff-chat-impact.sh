#!/usr/bin/env bash
# scripts/diff-chat-impact.sh — chat 路径文件 diff 检测(防 C-3 + 落地 PR 描述规范)
#
# 用法(从仓库根目录跑):
#   BASE_SHA=<merge-base-ish> HEAD_SHA=<head> ./scripts/diff-chat-impact.sh
#   ./scripts/diff-chat-impact.sh <BASE_SHA> <HEAD_SHA>     # 也接受位置参数
#
# 退出码:
#   0  chat 关键路径文件均无改动
#   1  任一关键文件被改 + 输出风险提示
#   2  输入错误(缺 BASE_SHA / HEAD_SHA 等)
#
# 关键路径(以 git track 为准;新增未 track 文件也能列出):
#   - server/claude-sdk.js
#   - server/modules/websocket/services/chat-run-registry.service.ts
#   - server/modules/websocket/services/chat-websocket.service.ts
#   - server/modules/database/repositories/sessions*.ts
#
# 与回归门禁的关系(Batch 5.5):
#   diff-chat-impact.sh + regression-chat.sh 组合使用,前者挡文件层,
#   后者挡行为层。本变更只动以下两个文件:
#     chat-run-registry.service.ts 加 kind 参数(允许,需 e2e 验证)
#     sessions 表加列(允许,需 chat e2e 跑通)
#   所以脚本**报告**即可,真正的"是否阻塞"由 reviewer 在 PR 描述里写明。

set -euo pipefail

PROG_NAME="$(basename "$0")"
readonly PROG_NAME

if [[ -t 1 ]]; then
  C_RESET='\033[0m'
  C_RED='\033[31m'
  C_GREEN='\033[32m'
  C_YELLOW='\033[33m'
  C_BLUE='\033[34m'
else
  C_RESET='' C_RED='' C_GREEN='' C_YELLOW='' C_BLUE=''
fi
log_info() { printf "${C_BLUE}[%s]${C_RESET} %s\n" "$PROG_NAME" "$*"; }
log_ok()   { printf "${C_GREEN}[%s]${C_RESET} %s\n" "$PROG_NAME" "$*"; }
log_warn() { printf "${C_YELLOW}[%s]${C_RESET} %s\n" "$PROG_NAME" "$*"; }
log_err()  { printf "${C_RED}[%s]${C_RESET} %s\n" "$PROG_NAME" "$*" >&2; }

usage() {
  cat <<EOF
Usage: $PROG_NAME [<BASE_SHA> <HEAD_SHA>]

Arguments:
  BASE_SHA   起始 commit SHA(或 env BASE_SHA)
  HEAD_SHA   终止 commit SHA(或 env HEAD_SHA)

Environment:
  BASE_SHA / HEAD_SHA  起始/终止 commit SHA(若未传位置参数)
  GIT_DIFF_AGAINST     设为 WORKTREE 时,与工作区未提交改动比较(BASE 与 HEAD 都视为 HEAD)

行为:
  比对 BASE..HEAD(默认)的 git diff,找出 chat 关键路径文件是否被改。
  若有改动,exit 1 + 列出文件 + 改了多少行;否则 exit 0。
EOF
}

# --- 参数解析 ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)  usage; exit 0 ;;
    --nonsense*) log_err "unknown flag: $1"; usage; exit 2 ;;
    -*)          log_err "unknown flag: $1"; usage; exit 2 ;;
    *)           break ;;   # 剩位置参数走下面赋值
  esac
done

if [[ $# -ge 2 ]]; then
  BASE_SHA="${1:-}"
  HEAD_SHA="${2:-}"
elif [[ $# -eq 1 ]]; then
  log_err "需要同时指定 BASE_SHA 和 HEAD_SHA(或都用环境变量)"
  usage
  exit 2
fi

BASE_SHA="${BASE_SHA:-}"
HEAD_SHA="${HEAD_SHA:-}"

# 兜底:GitHub Actions 自动提供 GITHUB_BASE_REF / GITHUB_SHA,但简单起见不强依赖
if [[ -z "$BASE_SHA" || -z "$HEAD_SHA" ]]; then
  log_err "缺 BASE_SHA 或 HEAD_SHA(env 或位置参数均可)"
  log_err "  BASE_SHA='${BASE_SHA}'  HEAD_SHA='${HEAD_SHA}'"
  usage
  exit 2
fi

# --- 必须从仓库根 ---
if [[ ! -d "server" ]] || [[ ! -d ".git" ]]; then
  log_err "请在仓库根目录运行"
  exit 1
fi

# --- git diff 范围 ---
GIT_DIFF_AGAINST="${GIT_DIFF_AGAINST:-}"
if [[ "$GIT_DIFF_AGAINST" == "WORKTREE" ]]; then
  # 与工作区脏改比较(用于本地发 PR 前自检)
  DIFF_CMD=(git diff --name-only HEAD)
elif [[ "$BASE_SHA" == "$HEAD_SHA" ]]; then
  # 同 commit → 必然零 diff,但允许 WORKTREE 叠加
  DIFF_CMD=(git diff --name-only HEAD)
else
  DIFF_CMD=(git diff --name-only "${BASE_SHA}".."${HEAD_SHA}")
fi

CHANGED="$("${DIFF_CMD[@]}" 2>/dev/null || true)"
# 也合并 staged 和 untracked(新文件)
if [[ "$GIT_DIFF_AGAINST" == "WORKTREE" ]]; then
  UNTRACKED="$(git ls-files --others --exclude-standard 2>/dev/null || true)"
  CHANGED="$(printf '%s\n%s\n' "$CHANGED" "$UNTRACKED" | grep -v '^$' || true)"
fi

if [[ -z "$CHANGED" ]]; then
  log_ok "零改动(base='${BASE_SHA}' head='${HEAD_SHA}'),chat 路径未受影响"
  exit 0
fi

# --- 关键文件列表 ---
# 使用 bash 数组 + glob 模式;展开为绝对路径前缀匹配
CRITICAL_PATTERNS=(
  "server/claude-sdk.js"
  "server/modules/websocket/services/chat-run-registry.service.ts"
  "server/modules/websocket/services/chat-websocket.service.ts"
  "server/modules/database/repositories/sessions"
)

is_critical() {
  local f="$1"
  for p in "${CRITICAL_PATTERNS[@]}"; do
    # glob 匹配:精确匹配或前缀匹配(p 不含 / 时也允许 * 扩展)
    if [[ "$f" == "$p" ]]; then
      return 0
    fi
    # sessions*.ts → sessions prefix
    if [[ "$p" == *"*" ]]; then
      # shell glob
      # shellcheck disable=SC2053
      [[ "$f" == $p ]] && return 0
    else
      # sessions 是目录前缀:任何 server/.../sessions*.ts 也算
      case "$f" in
        "${p}"*.ts|${p}*.js) return 0 ;;
      esac
    fi
  done
  return 1
}

# 收集受影响的文件及其行数
HITS_FILE="$(mktemp -t diff-chat-XXXXXX.hits)"
trap 'rm -f "$HITS_FILE"' EXIT

while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if is_critical "$f"; then
    # 计算 diff 行数(对 untracked 特殊处理)
    if [[ "$GIT_DIFF_AGAINST" == "WORKTREE" ]] && ! git ls-files "$f" >/dev/null 2>&1; then
      # untracked 文件:取 wc -l
      if [[ -f "$f" ]]; then
        added="$(wc -l < "$f" | tr -d ' ')"
        printf '%s\t+%s\t%s\n' "$f" "$added" "(untracked)" >> "$HITS_FILE"
      fi
    else
      # 标准 diff 统计
      # shellcheck disable=SC2086
      stats="$(git diff --numstat ${BASE_SHA}..${HEAD_SHA} -- "$f" 2>/dev/null || git diff --numstat HEAD -- "$f" 2>/dev/null || true)"
      added="$(echo "$stats" | awk '{ gsub(/[^0-9]/, "", $1); print $1 }')"
      removed="$(echo "$stats" | awk '{ gsub(/[^0-9]/, "", $2); print $2 }')"
      : "${added:=0}"; : "${removed:=0}"
      printf '%s\t+%s/-%s\t%s\n' "$f" "$added" "$removed" "${GIT_DIFF_AGAINST:-RANGE}" >> "$HITS_FILE"
    fi
  fi
done <<< "$CHANGED"

if [[ ! -s "$HITS_FILE" ]]; then
  log_ok "chat 关键路径无 diff(共 $(echo "$CHANGED" | wc -l | tr -d ' ') 个文件被改,但不在 chat 关键列表)"
  exit 0
fi

# --- 命中,报告并 exit 1 ---
log_warn "⚠️  chat 路径有改动,需在 PR 描述里贴 chat-regression-baseline.txt 对比结果"
echo
echo "以下是受影响的 chat 关键路径文件(改动大小 = +/-行):"
echo "------------------------------------------------------------"
cat "$HITS_FILE" | column -t -s $'\t' 2>/dev/null || cat "$HITS_FILE"
echo "------------------------------------------------------------"
echo
echo "建议(来自 design.md D-7.1 / tasks.md §Batch 5.5):"
echo "  - 解释为何必须改 chat 路径(例如:Batch 2 schema 加列 必须)"
echo "  - 在 PR 描述贴 baseline 对比:'此次 baseline vs 上次 baseline'"
echo "  - 跑一次 chat 端到端验证(开 chat session 发一条消息 + 回放)"
echo
exit 1
