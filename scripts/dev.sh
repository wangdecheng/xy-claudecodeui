#!/usr/bin/env sh
# 一键管理前后端开发服务（后端 Express + 前端 vite）
#
# 用法:
#   ./scripts/dev.sh            # 重启前后端（默认，先停后启）
#   ./scripts/dev.sh restart    # 同上
#   ./scripts/dev.sh start      # 仅启动（端口被占会报错）
#   ./scripts/dev.sh stop       # 停止
#   ./scripts/dev.sh status     # 查看运行状态与访问地址
#
# 说明:
#   - 后端: npm run server:dev（tsx, 端口 SERVER_PORT 默认 3001）
#   - 前端: CI=true npm run client（vite, 端口 VITE_PORT 默认 5173）
#     CI=true 让 vite 跳过 stdin 交互监听，避免后台运行时因 stdin EOF 静默退出
#   - 前端 host 已在 vite.config.js 配为 0.0.0.0，局域网可经本机 IP 访问
#   - 日志输出到 logs/server.log、logs/client.log（已被 .gitignore 忽略）
#   - LC_ALL=C 避免 bash 3.2 在 UTF-8 locale 下把全角标点字节误纳入变量名
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

# 等待端口就绪，超时则报错（第4个参数为日志路径，超时时提示）
wait_port() {
  port="$1"
  name="$2"
  timeout="${3:-30}"
  log="${4:-}"
  elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    if lsof -tiTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "  ✅ ${name} 就绪（端口 ${port}，耗时 ${elapsed}s）"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "  ❌ ${name} 在 ${timeout}s 内未就绪（端口 ${port}）"
  [ -n "$log" ] && echo "     查看日志: ${log}"
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
  start_server
  start_client
  echo "⏳ 等待端口就绪..."
  wait_port "$SERVER_PORT" "后端" 30 "$SERVER_LOG" || true
  wait_port "$VITE_PORT" "前端" 30 "$CLIENT_LOG" || true
  print_status
}

cmd_restart() {
  echo "🔄 重启服务..."
  cmd_stop
  echo ""
  start_server
  start_client
  echo "⏳ 等待端口就绪..."
  wait_port "$SERVER_PORT" "后端" 30 "$SERVER_LOG" || true
  wait_port "$VITE_PORT" "前端" 30 "$CLIENT_LOG" || true
  print_status
}

print_status() {
  echo ""
  echo "═══════════════════════════════════════════════════════"
  if lsof -tiTCP:"$SERVER_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "  后端: ✅ 运行中（端口 ${SERVER_PORT}）"
  else
    echo "  后端: ❌ 未运行（端口 ${SERVER_PORT}）"
  fi
  if lsof -tiTCP:"$VITE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    ip="$(lan_ip)"
    echo "  前端: ✅ 运行中（端口 ${VITE_PORT}）"
    echo "  访问: http://localhost:${VITE_PORT}"
    [ -n "$ip" ] && echo "       http://${ip}:${VITE_PORT}"
  else
    echo "  前端: ❌ 未运行（端口 ${VITE_PORT}）"
  fi
  echo "  后端日志: ${SERVER_LOG}"
  echo "  前端日志: ${CLIENT_LOG}"
  echo "═══════════════════════════════════════════════════════"
}

cmd_status() {
  echo "📊 服务状态:"
  print_status
}

# ---------- 入口 ----------
action="${1:-restart}"
case "$action" in
  restart) cmd_restart ;;
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  status)  cmd_status ;;
  *)
    echo "用法: $0 [restart|start|stop|status]  （默认 restart）"
    exit 1
    ;;
esac
