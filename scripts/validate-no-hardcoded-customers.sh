#!/usr/bin/env bash
# scripts/validate-no-hardcoded-customers.sh
#
# 静态扫描硬编码的客户/迭代字面量 + 关键提示短语。
# 来源真相:config/customer-analysis.json — UI 下拉必须由它驱动,不允许源码里手写。
#
# 用法(从仓库根目录跑):
#   ./scripts/validate-no-hardcoded-customers.sh        # 跑扫描
#   ./scripts/validate-no-hardcoded-customers.sh -h     # 帮助
#
# 退出码:
#   0  没有命中,扫描通过
#   1  有命中(违规),列出文件:行
#   2  输入错误(缺依赖 jq / 仓库结构不对)
#
# 扫描范围:src/  server/  design-prototypes/onsite-analysis/
# 白名单:config/customer-analysis.json,config/json-schemas,test/spec/fixture,
#        README/CLAUDE/md 文件,以及显式 exclusion 行内注释

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
Usage: $PROG_NAME

行为:
  1. 扫 src/  server/  design-prototypes/onsite-analysis/ 三处
  2. 抓 config/customer-analysis.json 的 customers[].label + iterations[] 字面量
  3. 抓提示短语(手动输入/请输入客户/请输入迭代/自定义)
  4. grep 命中即 exit 1,列出文件:行

白名单(命中后会被过滤掉):
  - config/customer-analysis.json(本就是真相源)
  - config/json-schemas/*
  - test|spec|fixture|README|CLAUDE|*.md 文件
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --nonsense*) log_err "unknown flag: $1"; usage; exit 2 ;;
    -*) log_err "unknown flag: $1"; usage; exit 2 ;;
    *) log_err "unexpected positional arg: $1"; usage; exit 2 ;;
  esac
done

# --- 必须在仓库根目录 ---
if [[ ! -d "server" ]] || [[ ! -d "src" ]] || [[ ! -f "config/customer-analysis.json" ]] || [[ ! -d ".git" ]]; then
  log_err "请在仓库根目录运行(需要 src/、server/、config/customer-analysis.json、.git/)"
  exit 2
fi

# --- 依赖:jq ---
if ! command -v jq >/dev/null 2>&1; then
  log_err "jq 不在 PATH 中"
  exit 2
fi

# --- 扫的目录列表 ---
SCAN_DIRS=(src server design-prototypes/onsite-analysis)
# 白名单关键词:出现这些关键词的文件视为合法
EXCLUDE_KEYWORDS_REGEX='(test|spec|fixture|README|CLAUDE|\.md|/config/customer-analysis\.json|/config/json-schemas/|locales/)'
# 注释行过滤:源码注释里允许出现字面量(如 doc 注释里举例 "山西公安"),
# 真正的硬编码必须出现在实际执行的代码行。
# 规则:含 "//" "* " "/*" "#" 开头或位置在行首的行视为注释,过滤掉。
COMMENT_LINE_REGEX='(^[^:]*:[0-9]+:[[:space:]]*(\*|//|/\*|#)|^[^\t :]+:[0-9]+:.*(//|/\*))'

# --- 抓 customers / iterations ---
log_info "读 config/customer-analysis.json ..."
CUSTOMERS=$(jq -r '.customers[].label // empty' config/customer-analysis.json 2>/dev/null || true)
ITERATIONS=$(jq -r '.iterations[] // empty' config/customer-analysis.json 2>/dev/null || true)

if [[ -z "$CUSTOMERS" && -z "$ITERATIONS" ]]; then
  log_err "config/customer-analysis.json 解析为空或格式错误"
  exit 2
fi

# --- 关键提示短语(源码里出现即违规) ---
HINT_PATTERNS='(手动输入|请输入客户|请输入迭代|自定义)'

VIOLATIONS=0
HITS_FILE="$(mktemp -t validate-no-hardcoded-XXXXXX.hits)"
trap 'rm -f "$HITS_FILE"' EXIT

scan_hint() {
  local dir="$1"
  local hits
  hits="$(grep -rnE "$HINT_PATTERNS" "$dir" 2>/dev/null \
    | grep -vE "$EXCLUDE_KEYWORDS_REGEX" \
    | grep -vE "$COMMENT_LINE_REGEX" \
    | grep -vE '(node_modules|/dist/)' || true)"
  if [[ -n "$hits" ]]; then
    log_err "硬编码提示短语命中 ($dir):"
    echo "$hits" | sed 's/^/  /'
    VIOLATIONS=$((VIOLATIONS + 1))
    echo "$hits" >> "$HITS_FILE"
  fi
}

scan_literal() {
  local dir="$1"
  local literal="$2"
  # 转义 grep -F 用的特殊字符(只处理 [] — 我们用 -F 不需要正则转义,但需要
  # 防止 literal 中的 '-' 被 grep 当 flag)。用 -- 分隔。
  local hits
  hits="$(grep -rnF -- "$literal" "$dir" 2>/dev/null \
    | grep -vE "$EXCLUDE_KEYWORDS_REGEX" \
    | grep -vE "$COMMENT_LINE_REGEX" \
    | grep -vE '(node_modules|/dist/)' || true)"
  if [[ -n "$hits" ]]; then
    log_warn "字面量 '$literal' 出现在 $dir:"
    echo "$hits" | sed 's/^/  /'
    VIOLATIONS=$((VIOLATIONS + 1))
    echo "$hits" >> "$HITS_FILE"
  fi
}

for dir in "${SCAN_DIRS[@]}"; do
  if [[ ! -d "$dir" ]]; then
    log_info "跳过不存在目录: $dir"
    continue
  fi
  scan_hint "$dir"
done

for literal in $CUSTOMERS $ITERATIONS; do
  for dir in "${SCAN_DIRS[@]}"; do
    if [[ ! -d "$dir" ]]; then continue; fi
    scan_literal "$dir" "$literal"
  done
done

echo ""
if [[ $VIOLATIONS -gt 0 ]]; then
  log_err "❌ 共 $VIOLATIONS 处违规。请走配置驱动而不是硬编码。"
  echo "命中详情写在 $HITS_FILE"
  exit 1
fi

log_ok "✓ validate-no-hardcoded-customers 0 violations"
exit 0