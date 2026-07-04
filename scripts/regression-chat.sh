#!/usr/bin/env bash
# scripts/regression-chat.sh — chat 路径回归基线(本变更前置,影响所有 Batch)
#
# 用法(从仓库根目录跑):
#   ./scripts/regression-chat.sh           # 跑真测试,写 chat-regression-baseline.txt
#   ./scripts/regression-chat.sh --dry-run # 打印基线格式(全 0),不跑测试
#   ./scripts/regression-chat.sh -h        # 帮助
#
# 输出:
#   写 chat-regression-baseline.txt(5 个空格分隔字段):
#     <commit_sha> <ISO_date> <pass_count> <fail_count> <elapsed_ms>
#   stdout 也打印同一行(便于人类阅读)
#
# 退出码:
#   0  所有测试通过
#   1  有失败 / 输入错误 / 缺依赖(node/tsx)
#
# 与回归门禁的关系(Batch 5.5):
#   跑本脚本两次(变更前后),diff 两次输出,pass/fail 数必须一致。
#
# 实现要点:
#   - 必须从仓库根目录跑(server/**/*.test.{ts,js} globs 才有效)
#   - 使用 tsx --test 而非裸 node --test,以支持 @/ 路径别名(server/tsconfig.json)
#   - --dry-run 模式:即使 chat-regression-baseline.txt 已存在,优先读取(用于重基线协议)

set -euo pipefail

PROG_NAME="$(basename "$0")"
readonly PROG_NAME

# --- 颜色输出辅助(若 stdout 是 TTY) ---
if [[ -t 1 ]]; then
  C_RESET='\033[0m'
  C_RED='\033[31m'
  C_GREEN='\033[32m'
  C_YELLOW='\033[33m'
  C_BLUE='\033[34m'
else
  C_RESET='' C_RED='' C_GREEN='' C_YELLOW='' C_BLUE=''
fi

log_info()  { printf "${C_BLUE}[%s]${C_RESET} %s\n" "$PROG_NAME" "$*"; }
log_ok()    { printf "${C_GREEN}[%s]${C_RESET} %s\n" "$PROG_NAME" "$*"; }
log_warn()  { printf "${C_YELLOW}[%s]${C_RESET} %s\n" "$PROG_NAME" "$*"; }
log_err()   { printf "${C_RED}[%s]${C_RESET} %s\n" "$PROG_NAME" "$*" >&2; }

usage() {
  cat <<EOF
Usage: $PROG_NAME [--dry-run] [-h|--help]

Options:
  --dry-run     只打印基线格式(全 0 值),不跑测试,也不写 baseline 文件
  -h, --help    显示本帮助

Environment:
  REGRESSION_BASELINE_FILE   自定义输出路径(默认 ./chat-regression-baseline.txt)

行为:
  跑 'tsx --test --tsconfig server/tsconfig.json "server/**/*.test.{ts,js}" "server/*.test.{ts,js}"'
  提取 pass / fail 计数与耗时,写一行到 baseline 文件(5 个空格分隔字段)。
  退出码 0 当且仅当全部 pass。

必须从仓库根目录跑(server globs 才有效)。
EOF
}

# --- 参数解析 ---
DRY_RUN="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)   DRY_RUN="true"; shift ;;
    -h|--help)   usage; exit 0 ;;
    --nonsense*) log_err "unknown flag: $1"; usage; exit 2 ;;
    -*)          log_err "unknown flag: $1"; usage; exit 2 ;;
    *)           log_err "unexpected positional arg: $1"; usage; exit 2 ;;
  esac
done

# --- 必须在仓库根目录 ---
if [[ ! -d "server" ]] || [[ ! -f "server/tsconfig.json" ]] || [[ ! -d ".git" ]]; then
  log_err "请在仓库根目录运行(需要 server/、server/tsconfig.json、.git/)"
  exit 1
fi

BASELINE_FILE="${REGRESSION_BASELINE_FILE:-chat-regression-baseline.txt}"
readonly BASELINE_FILE
readonly DRY_RUN

# --- dry-run 模式 ---
if [[ "$DRY_RUN" == "true" ]]; then
  if [[ -f "$BASELINE_FILE" ]]; then
    # 重基线协议:已存在的 baseline 直接打印(只打印内容到 stdout)
    cat "$BASELINE_FILE"
    exit 0
  fi

  # 计算 dummy 值(全 0)
  COMMIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo "0000000000000000000000000000000000000000")"
  ISO_DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  LINE="${COMMIT_SHA} ${ISO_DATE} 0 0 0"
  echo "$LINE"
  exit 0
fi

# --- 真跑测试 ---
log_info "开始 chat 路径回归(从仓库根)"
log_info "baseline 文件: ${BASELINE_FILE}"

# 检查依赖
if ! command -v node >/dev/null 2>&1; then
  log_err "node 不在 PATH 中"
  exit 1
fi

# tsx 在 node_modules/.bin 里
if [[ -x "node_modules/.bin/tsx" ]]; then
  TSX=("node_modules/.bin/tsx")
elif command -v tsx >/dev/null 2>&1; then
  TSX=("tsx")
elif command -v npx >/dev/null 2>&1; then
  TSX=("npx" "--yes" "tsx")
else
  log_err "tsx 不可用(尝试 npm i -D tsx 或 npm ci)"
  exit 1
fi

now_ms() {
  # Cross-platform millisecond timestamp:
  #  - GNU date: date +%s%3N (Linux)
  #  - macOS:    use python3 fallback(busybox / BSD date 不支持 %3N)
  local val
  val="$(date +%s%3N 2>/dev/null || true)"
  if [[ "$val" == *N* || -z "$val" ]]; then
    if command -v python3 >/dev/null 2>&1; then
      val="$(python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || echo "")"
    fi
  fi
  if [[ -z "$val" || "$val" == *N* ]]; then
    # Last resort:seconds × 1000
    val="$(($(date +%s) * 1000))"
  fi
  echo "$val"
}

# 跑测试,允许失败但需捕获输出
log_info "跑 tsx --test(可能耗时数秒到数十秒)..."
TMP_OUT="$(mktemp -t regression-chat-XXXXXX.log)"
START_MS="$(now_ms)"
set +e
"${TSX[@]}" --test --tsconfig server/tsconfig.json \
  "server/**/*.test.{ts,js}" \
  "server/*.test.{ts,js}" \
  2>&1 | tee "$TMP_OUT"
TEST_EXIT=${PIPESTATUS[0]}
set -e

END_MS="$(now_ms)"
ELAPSED_MS=$((END_MS - START_MS))

# 解析全局汇总行(取最后一次出现,避免被 individual test 文件的同名行干扰)
# node --test TAP 输出对每个 test 文件都打印一遍:
#   ℹ tests N
#   ℹ pass N
#   ℹ fail N
# 然后在最末尾打印一份全局汇总(同样是 `ℹ pass N` 等行)。
# 先前的 awk 实现 `END { print sum+0 }` 把所有行相加,多文件时会双倍计数。
# 改为 `tail -n1`:只取最后一次出现的全局汇总。
PASS_COUNT="$(grep -E '^ℹ +pass' "$TMP_OUT" | tail -n1 | awk '{ gsub(/[^0-9]/, "", $NF); print $NF+0 }')"
TESTS_COUNT="$(grep -E '^ℹ +tests' "$TMP_OUT" | tail -n1 | awk '{ gsub(/[^0-9]/, "", $NF); print $NF+0 }')"
FAIL_COUNT="$(grep -E '^ℹ +fail' "$TMP_OUT" | tail -n1 | awk '{ gsub(/[^0-9]/, "", $NF); print $NF+0 }')"

# 兜底:若断言失败,我们认为运行整个失败
if [[ $TEST_EXIT -ne 0 ]]; then
  log_warn "测试进程返回非零(exit=$TEST_EXIT)"
fi

# 安全值
: "${PASS_COUNT:=0}"
: "${FAIL_COUNT:=0}"
: "${TESTS_COUNT:=0}"

COMMIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo "unknown")"
ISO_DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

LINE="${COMMIT_SHA} ${ISO_DATE} ${PASS_COUNT} ${FAIL_COUNT} ${ELAPSED_MS}"
echo "$LINE"
echo "$LINE" > "$BASELINE_FILE"

# 清理
rm -f "$TMP_OUT"

# 退出码:FAIL_COUNT > 0 或 TEST_EXIT != 0 → 1
if [[ "$FAIL_COUNT" -gt 0 ]] || [[ $TEST_EXIT -ne 0 ]] || [[ "$TESTS_COUNT" -eq 0 ]]; then
  log_err "❌ chat 路径回归失败: ${FAIL_COUNT} failed / ${PASS_COUNT} passed / total=${TESTS_COUNT}"
  exit 1
fi

log_ok "✅ chat 路径回归通过: ${PASS_COUNT} passed (baseline written to ${BASELINE_FILE})"
exit 0
