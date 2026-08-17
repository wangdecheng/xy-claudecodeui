#!/usr/bin/env sh
# 一键管理前后端开发服务（后端 Express + 前端 vite）
#
# 用法:
#   ./scripts/dev.sh            # 重启前后端（默认，先停后启）
#   ./scripts/dev.sh restart    # 同上
#   ./scripts/dev.sh start      # 仅启动（端口被占会报错）
#   ./scripts/dev.sh stop       # 停止
#   ./scripts/dev.sh status     # 查看运行状态与访问地址
#   ./scripts/dev.sh logs       # 跟踪前后端日志（Ctrl-C 退出）
#
# 说明:
#   - 后端: npm run server:dev（tsx, 端口 SERVER_PORT 默认 3001）
#   - 前端: CI=true npm run client（vite, 端口 VITE_PORT 默认 5173）
#     CI=true 让 vite 跳过 stdin 交互监听，避免后台运行时因 stdin EOF 静默退出
#   - 前端 host 已在 vite.config.js 配为 0.0.0.0，局域网可经本机 IP 访问
#   - 日志输出到 logs/server.log、logs/client.log（已被 .gitignore 忽略）
#   - LC_ALL=C 避免 bash 3.2 在 UTF-8 locale 下把全角标点字节误纳入变量名
#
# 就绪判定用 HTTP 健康检查而非「端口在监听」:
#   后端崩溃时前端 vite 仍然活着，页面能打开、只有登录失败（显示 "Login failed"）。
#   只看端口会把这种半死状态报成「服务正常」，所以后端必须实际响应 /api/auth/status。
set -eu
export LC_ALL=C

# ---------- 定位项目根目录 ----------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# ---------- 从 .env 读取端口 ----------
# 优先用环境变量，其次 .env，最后默认值
get_env() {
  key="$1"
  default="$2"
  val="$(grep -E "^${key}=" .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' \r' || true)"
  if [ -n "$val" ]; then echo "$val"; else echo "$default"; fi
}
SERVER_PORT="${SERVER_PORT:-$(get_env SERVER_PORT 3001)}"
VITE_PORT="${VITE_PORT:-$(get_env VITE_PORT 5173)}"

LOG_DIR="$PROJECT_ROOT/logs"
mkdir -p "$LOG_DIR"
SERVER_LOG="$LOG_DIR/server.log"
CLIENT_LOG="$LOG_DIR/client.log"

SERVER_HEALTH_URL="http://127.0.0.1:${SERVER_PORT}/api/auth/status"
CLIENT_HEALTH_URL="http://127.0.0.1:${VITE_PORT}/"

# ---------- 工具函数 ----------
# 杀掉占用指定端口的进程：先 SIGTERM，等待最多 10 秒，仍存活则 SIGKILL
kill_port() {
  port="$1"
  pids="$(lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    echo "  端口 ${port} 空闲"
    return 0
  fi
  echo "  端口 ${port} 被 PID(${pids}) 占用，正在停止..."
  echo "$pids" | xargs kill 2>/dev/null || true
  timeout=10
  while [ "$timeout" -gt 0 ]; do
    remaining="$(lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true)"
    [ -z "$remaining" ] && { echo "  端口 ${port} 已释放"; return 0; }
    sleep 1
    timeout=$((timeout - 1))
  done
  remaining="$(lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$remaining" ]; then
    echo "  SIGTERM 未生效，强制 kill -9: ${remaining}"
    echo "$remaining" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
  echo "  端口 ${port} 已释放"
}

# 单次健康探测：HTTP 有响应即算活着（2xx/3xx/4xx 都行，只要不是连不上）
probe() {
  curl -s -o /dev/null --max-time 2 "$1" >/dev/null 2>&1
}

# 等待服务真正能响应 HTTP，超时则打印日志尾部并返回 1
wait_health() {
  url="$1"
  name="$2"
  timeout="${3:-40}"
  log="${4:-}"
  elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    if probe "$url"; then
      echo "  ✅ ${name} 就绪（耗时 ${elapsed}s）"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "  ❌ ${name} 在 ${timeout}s 内未就绪"
  if [ -n "$log" ] && [ -f "$log" ]; then
    echo "  ── ${log} 末尾 25 行 ──────────────────────"
    tail -n 25 "$log" | sed 's/^/  │ /'
    echo "  ─────────────────────────────────────────"
  fi
  return 1
}

# 端口被占则报错退出（用于 start 子命令）
assert_port_free() {
  port="$1"
  if lsof -tiTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "  ❌ 端口 ${port} 已被占用，请改用: $0 restart"
    return 1
  fi
}

# 启动前预检：原生模块能否在当前 node 下加载。
# node 大版本升级后 better-sqlite3 等编译产物 ABI 会失配（ERR_DLOPEN_FAILED），
# 后端会在打开 auth.db 时秒退，症状只表现为「登录失败」，极难联想到 node 版本。
preflight() {
  if node -e "require('better-sqlite3'); require('bcrypt')" >/dev/null 2>&1; then
    return 0
  fi
  echo "  ❌ 原生模块加载失败（node $(node -v)）"
  echo "  ── 详细错误 ─────────────────────────────"
  node -e "require('better-sqlite3'); require('bcrypt')" 2>&1 | head -n 12 | sed 's/^/  │ /'
  echo "  ─────────────────────────────────────────"
  echo "  多为 node 大版本升级后 ABI 失配。依次尝试:"
  echo "    1) npm rebuild better-sqlite3 bcrypt"
  echo "    2) 若编译报错，说明该包不支持当前 node，需升级依赖版本"
  echo "    3) 或临时换回旧 node: nvm use 24"
  return 1
}

# 获取本机局域网 IP（用于显示访问地址）
lan_ip() {
  ifconfig 2>/dev/null | grep 'inet ' | grep -v '127.0.0.1' \
    | awk '{print $2}' | grep -E '^(172|192\.168|10)\.' | head -1 || true
}

# ---------- 启动 ----------
start_server() {
  echo "▶ 启动后端（端口 ${SERVER_PORT}）..."
  nohup npm run server:dev > "$SERVER_LOG" 2>&1 &
  echo "  后端 PID: $!  日志: ${SERVER_LOG}"
}

start_client() {
  echo "▶ 启动前端（端口 ${VITE_PORT}）..."
  CI=true nohup npm run client > "$CLIENT_LOG" 2>&1 &
  echo "  前端 PID: $!  日志: ${CLIENT_LOG}"
}

# 启动两端并等待就绪；任一未就绪则返回 1（供调用方决定退出码）
start_and_wait() {
  start_server
  start_client
  echo "⏳ 等待服务就绪..."
  rc=0
  wait_health "$SERVER_HEALTH_URL" "后端" 40 "$SERVER_LOG" || rc=1
  wait_health "$CLIENT_HEALTH_URL" "前端" 40 "$CLIENT_LOG" || rc=1
  return "$rc"
}

# ---------- 子命令 ----------
cmd_stop() {
  echo "🛑 停止服务..."
  kill_port "$SERVER_PORT"
  kill_port "$VITE_PORT"
}

cmd_start() {
  echo "🚀 启动服务..."
  assert_port_free "$SERVER_PORT" || return 1
  assert_port_free "$VITE_PORT" || return 1
  preflight || return 1
  rc=0
  start_and_wait || rc=1
  print_status || true
  return "$rc"
}

cmd_restart() {
  echo "🔄 重启服务..."
  cmd_stop
  echo ""
  preflight || return 1
  rc=0
  start_and_wait || rc=1
  print_status || true
  return "$rc"
}

print_status() {
  server_ok=0
  client_ok=0
  probe "$SERVER_HEALTH_URL" && server_ok=1
  probe "$CLIENT_HEALTH_URL" && client_ok=1

  echo ""
  echo "═══════════════════════════════════════════════════════"
  if [ "$server_ok" -eq 1 ]; then
    echo "  后端: ✅ 运行中（端口 ${SERVER_PORT}）"
  elif lsof -tiTCP:"$SERVER_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "  后端: ⚠️  端口 ${SERVER_PORT} 在监听但不响应 HTTP"
  else
    echo "  后端: ❌ 未运行（端口 ${SERVER_PORT}）"
  fi

  if [ "$client_ok" -eq 1 ]; then
    ip="$(lan_ip)"
    echo "  前端: ✅ 运行中（端口 ${VITE_PORT}）"
    echo "  访问: http://localhost:${VITE_PORT}"
    [ -n "$ip" ] && echo "       http://${ip}:${VITE_PORT}"
  else
    echo "  前端: ❌ 未运行（端口 ${VITE_PORT}）"
  fi

  # 后端挂、前端活 = 页面能打开但登录必失败，必须显式点破，别让人以为服务是好的
  if [ "$client_ok" -eq 1 ] && [ "$server_ok" -eq 0 ]; then
    echo "───────────────────────────────────────────────────────"
    echo "  ⚠️  页面能打开，但登录会失败（显示 \"Login failed\"）"
    echo "     原因是后端不可达，排查: tail -n 50 ${SERVER_LOG}"
  fi

  echo "  后端日志: ${SERVER_LOG}"
  echo "  前端日志: ${CLIENT_LOG}"
  echo "═══════════════════════════════════════════════════════"

  [ "$server_ok" -eq 1 ] && [ "$client_ok" -eq 1 ]
}

cmd_status() {
  echo "📊 服务状态:"
  print_status
}

cmd_logs() {
  echo "📜 跟踪日志（Ctrl-C 退出）: ${SERVER_LOG} ${CLIENT_LOG}"
  tail -n 30 -f "$SERVER_LOG" "$CLIENT_LOG"
}

# ---------- 入口 ----------
action="${1:-restart}"
case "$action" in
  restart) cmd_restart ;;
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  *)
    echo "用法: $0 [restart|start|stop|status|logs]  （默认 restart）"
    exit 1
    ;;
esac
