#!/usr/bin/env bash
# scripts/add-customer.sh
#
# 一键在 config/customer-analysis.json 的 customers 数组尾部追加新客户。
#
# 用法(从仓库根目录跑):
#   ./scripts/add-customer.sh "<label>" <branch>           # 追加一条,branch 必填
#   ./scripts/add-customer.sh --label "<label>" --branch <branch>
#   ./scripts/add-customer.sh -h | --help
#
# 行为:
#   1. 参数校验(label 非空;branch 必须匹配 schema 的 ^[A-Za-z0-9_][A-Za-z0-9_.-]*$
#      或者显式传 null 表示无分支)
#   2. 去重校验:同 label 已存在则 exit 2
#   3. 自动备份原文件为 .bak(同目录,git 会忽略)
#   4. 用 jq 把新条目 append 到 customers 末尾,保留首项"其他问题"
#   5. JSON 自检(jq 解析失败则回滚到 .bak)
#   6. 打印提示:测试里若硬编码了 customers.length(目前 config.service.test.ts:40),
#      需要同步 +1;以及跑 ./scripts/validate-no-hardcoded-customers.sh 兜底校验
#
# 退出码:
#   0  成功
#   1  运行时错误(jq 缺失 / 仓库结构不对)
#   2  参数错误(label 空 / branch 不匹配 schema / label 已存在)

set -euo pipefail

PROG_NAME="$(basename "$0")"
readonly PROG_NAME

# ---------- 颜色(只在 TTY 输出) ----------
if [[ -t 1 ]]; then
  C_RESET='\033[0m'; C_RED='\033[31m'; C_GREEN='\033[32m'; C_YELLOW='\033[33m'; C_BLUE='\033[34m'
else
  C_RESET=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''
fi
log_info() { printf "${C_BLUE}[%s]${C_RESET} %s\n" "$PROG_NAME" "$*"; }
log_ok()   { printf "${C_GREEN}[%s]${C_RESET} %s\n" "$PROG_NAME" "$*"; }
log_warn() { printf "${C_YELLOW}[%s]${C_RESET} %s\n" "$PROG_NAME" "$*"; }
log_err()  { printf "${C_RED}[%s]${C_RESET} %s\n" "$PROG_NAME" "$*" >&2; }

# ---------- 帮助 ----------
usage() {
  cat <<EOF
Usage:
  $PROG_NAME "<label>" <branch>
  $PROG_NAME --label "<label>" --branch <branch>
  $PROG_NAME -h | --help

参数:
  <label>     客户显示名(中文/英文均可)。schema 要求非空字符串。
  <branch>    关联的 Git 分支或标识符,匹配 ^[A-Za-z0-9_][A-Za-z0-9_.-]*\$
              或字面量 null(用于无分支的特殊条目,但本脚本主要用于常规分支,
              首项"其他问题"已有,不需要再加 null)。

示例:
  $PROG_NAME "招商银行" zs_401425
  $PROG_NAME --label "新客户" --branch new-customer-branch

附:跑完后请检查
  - server/modules/onsite-analysis/tests/config.service.test.ts 里若硬编码了
    customers.length,需要同步 +1(当前硬编码为 16,每加一条 +1)
  - ./scripts/validate-no-hardcoded-customers.sh 仍应 0 violations
EOF
}

# ---------- 参数解析 ----------
LABEL=""
BRANCH=""

if [[ $# -eq 2 && "$1" != -* && "$2" != -* ]]; then
  LABEL="$1"; BRANCH="$2"
elif [[ $# -gt 0 ]]; then
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help) usage; exit 0 ;;
      --label)   LABEL="$2"; shift 2 ;;
      --branch)  BRANCH="$2"; shift 2 ;;
      --nonsense*) log_err "unknown flag: $1"; usage; exit 2 ;;
      -*)        log_err "unknown flag: $1"; usage; exit 2 ;;
      *)         log_err "unexpected positional arg: $1"; usage; exit 2 ;;
    esac
  done
else
  usage; exit 2
fi

# ---------- 仓库根 / 依赖校验 ----------
if [[ ! -d "server" ]] || [[ ! -f "config/customer-analysis.json" ]] || [[ ! -d ".git" ]]; then
  log_err "请在仓库根目录运行(需要 server/、config/customer-analysis.json、.git/)"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  log_err "jq 不在 PATH 中"
  exit 1
fi

CONFIG_FILE="config/customer-analysis.json"

# ---------- label 校验 ----------
if [[ -z "$LABEL" ]]; then
  log_err "label 不能为空"
  exit 2
fi

# ---------- branch 校验 ----------
# schema 允许的形态:null(不接本脚本路径,首项已有)或匹配 ^[A-Za-z0-9_][A-Za-z0-9_.-]*$
if [[ "$BRANCH" != "null" ]]; then
  if ! [[ "$BRANCH" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]]; then
    log_err "branch '$BRANCH' 不匹配 schema 模式 ^[A-Za-z0-9_][A-Za-z0-9_.-]*\$"
    log_err "允许的字符:字母 / 数字 / 下划线 / 点 / 中划线,首字符必须是字母数字下划线"
    exit 2
  fi
fi

# ---------- 去重校验 ----------
EXISTING_LABELS=$(jq -r '.customers[].label' "$CONFIG_FILE" 2>/dev/null || true)
if [[ -z "$EXISTING_LABELS" ]]; then
  log_err "无法读取 $CONFIG_FILE 或 customers 为空"
  exit 1
fi
if echo "$EXISTING_LABELS" | grep -Fxq -- "$LABEL"; then
  log_err "label '$LABEL' 已存在于 customers 列表,无需重复添加"
  exit 2
fi

# ---------- 备份 ----------
BACKUP="${CONFIG_FILE}.bak"
cp "$CONFIG_FILE" "$BACKUP"
trap '[[ -f "$BACKUP" ]] && rm -f "$BACKUP"' EXIT

# ---------- 追加 ----------
log_info "追加客户: label='$LABEL' branch='$BRANCH'"

if ! jq --arg label "$LABEL" --arg branch "$BRANCH" \
     '.customers += [{label: $label, branch: $branch}]' \
     "$CONFIG_FILE" > "${CONFIG_FILE}.tmp"; then
  log_err "jq 修改失败,未改动原文件"
  exit 1
fi

# ---------- JSON 自检 + 原子替换 ----------
if ! jq empty "${CONFIG_FILE}.tmp" 2>/dev/null; then
  log_err "jq 输出不是合法 JSON,回滚"
  rm -f "${CONFIG_FILE}.tmp"
  exit 1
fi

mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
rm -f "$BACKUP"
trap - EXIT

# ---------- 结果 ----------
NEW_COUNT=$(jq '.customers | length' "$CONFIG_FILE")
log_ok "✓ 追加成功,当前 customers 共 $NEW_COUNT 条"
log_warn "后续:"
log_warn "  1) 检查 server/modules/onsite-analysis/tests/config.service.test.ts"
log_warn "     若硬编码了 customers.length,需同步 +1(当前 16)"
log_warn "  2) 跑 ./scripts/validate-no-hardcoded-customers.sh 兜底校验"
log_warn "  3) git diff $CONFIG_FILE 复核变更"
