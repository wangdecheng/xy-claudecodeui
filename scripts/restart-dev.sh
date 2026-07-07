#!/usr/bin/env sh
set -eu

SERVER_PORT=3001
VITE_PORT=5173

kill_port() {
  port="$1"
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"

  if [ -z "$pids" ]; then
    echo "Port $port is free."
    return 0
  fi

  echo "Port $port is in use by PID(s): $pids"
  echo "$pids" | xargs kill 2>/dev/null || true

  timeout=10
  while [ "$timeout" -gt 0 ]; do
    remaining="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -z "$remaining" ]; then
      echo "Port $port released."
      return 0
    fi
    sleep 1
    timeout=$((timeout - 1))
  done

  remaining="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$remaining" ]; then
    echo "Force killing PID(s) on port $port: $remaining"
    echo "$remaining" | xargs kill -9 2>/dev/null || true
  fi
}

kill_port "$SERVER_PORT"
kill_port "$VITE_PORT"

echo "Starting dev server on backend port $SERVER_PORT and frontend port $VITE_PORT..."
env SERVER_PORT="$SERVER_PORT" VITE_PORT="$VITE_PORT" npm run dev
