#!/usr/bin/env bash
# scripts/demo-onsite.sh
#
# 7 步端到端 demo:覆盖整个 Onsite Analysis 工作台的核心流程。
# 必须在 server 已启动(默认 http://localhost:3001)且已登录的环境下跑。
#
# 用法:
#   DEMO_TOKEN=<jwt> ./scripts/demo-onsite.sh           # 跑全 7 步
#   DEMO_TOKEN=<jwt> ./scripts/demo-onsite.sh --no-start # 不启服务(假设已起)
#
# 步骤:
#   1. (可选)启动 server 后台
#   2. 用 DEMO_TOKEN 验证 token(GET /api/user/me)
#   3. POST /api/onsite/problems 创建"中车长客"问题
#   4. POST /api/onsite/problems/:id/files 上传 2 个 zip
#   5. GET /api/onsite/problems 拉列表
#   6. PATCH ... { status: 'analyzing' } 切状态
#      6a. POST /:id/confirm-root-cause 含软化词 → 期望 422
#      6b. PATCH ... { status: 'confirmed' } 切到 confirmed
#   7. 退出
#
# 退出码:
#   0  7 步全通过
#   1  任一步失败
#   2  输入错误(缺 token / 缺 jq / 仓库根不对)

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

BASE_URL="${BASE_URL:-http://localhost:3001}"
NO_START="false"
SERVER_PID=""

usage() {
  cat <<EOF
Usage: $PROG_NAME [--no-start]

Environment:
  DEMO_TOKEN   必填。已登录的 JWT(Bearer token)。
  BASE_URL     server 地址,默认 http://localhost:3001
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-start) NO_START="true"; shift ;;
    -h|--help)  usage; exit 0 ;;
    --nonsense*) log_err "unknown flag: $1"; usage; exit 2 ;;
    -*) log_err "unknown flag: $1"; usage; exit 2 ;;
    *) log_err "unexpected positional arg: $1"; usage; exit 2 ;;
  esac
done

# --- 必须在仓库根目录 ---
if [[ ! -d "server" ]] || [[ ! -d "src" ]] || [[ ! -d ".git" ]]; then
  log_err "请在仓库根目录运行"
  exit 2
fi

# --- 依赖检查 ---
for dep in curl jq; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    log_err "$dep 不在 PATH 中"
    exit 2
  fi
done

# --- DEMO_TOKEN 必给 ---
if [[ -z "${DEMO_TOKEN:-}" ]]; then
  log_err "需要设置 DEMO_TOKEN 环境变量(已登录的 JWT)"
  log_err "获取方式:UI 登录后,DevTools Network 抓任一带 Authorization: Bearer ... 的请求"
  usage
  exit 2
fi

# --- 准备 fixture(2 个 zip) ---
FIXTURE_DIR="$(mktemp -d -t demo-onsite-fixtures-XXXXXX)"
trap 'rm -rf "$FIXTURE_DIR"; [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true' EXIT

FIXTURE_1="$FIXTURE_DIR/sample-1.zip"
FIXTURE_2="$FIXTURE_DIR/sample-2.zip"
log_info "造 2 个 zip fixture 在 $FIXTURE_DIR"
mkdir -p "$FIXTURE_DIR/src-1" "$FIXTURE_DIR/src-2"
printf 'app log line 1\n' > "$FIXTURE_DIR/src-1/app.log"
printf 'app log line 2\n' > "$FIXTURE_DIR/src-2/app.log"
(cd "$FIXTURE_DIR/src-1" && zip -qr "$FIXTURE_1" .)
(cd "$FIXTURE_DIR/src-2" && zip -qr "$FIXTURE_2" .)

# --- Step 1 (可选)启服务 ---
if [[ "$NO_START" != "true" ]]; then
  log_info "→ Step 1:启动 server (background)"
  npm run server:dev > "$FIXTURE_DIR/server.log" 2>&1 &
  SERVER_PID=$!
  log_info "server PID=$SERVER_PID,日志: $FIXTURE_DIR/server.log"
  # 等待 server ready(最多 30 秒)
  for i in {1..30}; do
    if curl -s "$BASE_URL/api/auth/status" >/dev/null 2>&1 || curl -s "$BASE_URL/api/projects" -o /dev/null >/dev/null 2>&1; then
      log_ok "server ready (after ${i}s)"
      break
    fi
    sleep 1
  done
else
  log_info "→ Step 1:跳过启服务(--no-start)"
fi

# --- Step 2:验证 token ---
log_info "→ Step 2:验证 token"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $DEMO_TOKEN" \
  "$BASE_URL/api/user/me" || echo "000")
if [[ "$HTTP_CODE" != "200" ]]; then
  log_err "token 验证失败,GET /api/user/me 返回 $HTTP_CODE"
  log_err "确认 DEMO_TOKEN 有效且未过期"
  exit 1
fi
log_ok "token 有效"

# --- Step 3:创建问题 ---
log_info "→ Step 3:POST /api/onsite/problems"
CREATE_RES=$(curl -s -X POST "$BASE_URL/api/onsite/problems" \
  -H "Authorization: Bearer $DEMO_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"customer":"中车长客（zcck）","third_bridge_branch":"zcck","iteration":"master_5.2_3.2","database":"mysql","files":[]}')
PROBLEM_ID=$(echo "$CREATE_RES" | jq -r '.id // empty')
if [[ -z "$PROBLEM_ID" ]]; then
  log_err "创建问题失败,响应: $CREATE_RES"
  exit 1
fi
log_ok "创建问题 $PROBLEM_ID"

# --- Step 4:上传 2 个 zip ---
log_info "→ Step 4:POST /api/onsite/problems/$PROBLEM_ID/files"
UPLOAD_HTTP=$(curl -s -o "$FIXTURE_DIR/upload.json" -w "%{http_code}" \
  -X POST "$BASE_URL/api/onsite/problems/$PROBLEM_ID/files" \
  -H "Authorization: Bearer $DEMO_TOKEN" \
  -F "files=@$FIXTURE_1" \
  -F "files=@$FIXTURE_2")
if [[ "$UPLOAD_HTTP" != "207" ]]; then
  log_warn "上传返回 $UPLOAD_HTTP(期望 207)。响应: $(cat "$FIXTURE_DIR/upload.json")"
fi
UPLOAD_OK=$(jq '[.results[] | select(.ok == true)] | length' "$FIXTURE_DIR/upload.json" 2>/dev/null || echo 0)
if [[ "$UPLOAD_OK" != "2" ]]; then
  log_err "上传成功条数 $UPLOAD_OK(期望 2)"
  cat "$FIXTURE_DIR/upload.json"
  exit 1
fi
log_ok "上传 2 个 zip 成功(207 multi-status)"

# --- Step 5:拉列表 ---
log_info "→ Step 5:GET /api/onsite/problems"
LIST_RES=$(curl -s -H "Authorization: Bearer $DEMO_TOKEN" "$BASE_URL/api/onsite/problems")
LIST_COUNT=$(echo "$LIST_RES" | jq -r '.problems | length')
log_ok "列表返回 $LIST_COUNT 条"

# --- Step 6:切到 analyzing ---
log_info "→ Step 6:PATCH status=analyzing"
ANALYZING_HTTP=$(curl -s -o "$FIXTURE_DIR/analyzing.json" -w "%{http_code}" \
  -X PATCH "$BASE_URL/api/onsite/problems/$PROBLEM_ID" \
  -H "Authorization: Bearer $DEMO_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"status":"analyzing","reason":"开始排查现场日志"}')
if [[ "$ANALYZING_HTTP" != "200" ]]; then
  log_err "切到 analyzing 失败,HTTP $ANALYZING_HTTP"
  cat "$FIXTURE_DIR/analyzing.json"
  exit 1
fi
log_ok "切到 analyzing 成功"

# --- Step 6a:软化词阻断(期望 422) ---
log_info "→ Step 6a:confirm-root-cause 含软化词 → 期望 422"
BLOCKED_HTTP=$(curl -s -o "$FIXTURE_DIR/blocked.json" -w "%{http_code}" \
  -X POST "$BASE_URL/api/onsite/problems/$PROBLEM_ID/confirm-root-cause" \
  -H "Authorization: Bearer $DEMO_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"root_cause_text":"可能是 xx 引起的","reason":"试图提交软化根因"}')
if [[ "$BLOCKED_HTTP" != "422" ]]; then
  log_err "软化词应 422,拿到 $BLOCKED_HTTP"
  cat "$FIXTURE_DIR/blocked.json"
  exit 1
fi
log_ok "✓ 软化词阻断 422(符合预期): $(cat "$FIXTURE_DIR/blocked.json")"

# --- Step 6b:切到 confirmed(用非软化词) ---
log_info "→ Step 6b:PATCH status=confirmed"
CONFIRMED_HTTP=$(curl -s -o "$FIXTURE_DIR/confirmed.json" -w "%{http_code}" \
  -X PATCH "$BASE_URL/api/onsite/problems/$PROBLEM_ID" \
  -H "Authorization: Bearer $DEMO_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"status":"confirmed","reason":"已证实根因,提交工单"}')
if [[ "$CONFIRMED_HTTP" != "200" ]]; then
  log_err "切到 confirmed 失败,HTTP $CONFIRMED_HTTP"
  cat "$FIXTURE_DIR/confirmed.json"
  exit 1
fi
log_ok "切到 confirmed 成功"

# --- Step 7:完成 ---
echo ""
log_ok "=== demo 7 步全跑通(problem=$PROBLEM_ID) ==="
exit 0