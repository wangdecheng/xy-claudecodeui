# dev.sh — 前后端开发服务一键管理

> `scripts/dev.sh` 使用说明。一条命令完成"停旧进程 → 启动前后端 → 检测就绪"，端口被占时自动清理。

## 是什么

`scripts/dev.sh` 是本项目的开发服务管理脚本，封装后端（Express + WebSocket）与前端（vite）的启停逻辑：

- **端口占用自动清理**：启动前若端口被占，先 SIGTERM、等待 10 秒、仍不退则 SIGKILL，杜绝僵尸进程占端口。
- **vite 后台不退出**：前端以 `CI=true` 启动，跳过 stdin 交互监听，避免后台运行时因 stdin EOF 静默退出（详见 Q2）。
- **就绪检测**：启动后轮询端口，30 秒内未就绪则报错并提示日志路径。
- **后台持久化**：`nohup` 脱离终端，脚本退出后服务继续运行。

## 前置条件

- Node.js（版本见 `.nvmrc`）
- 已执行 `npm install`（`node_modules` 完整）
- 项目根存在 `.env`（端口从中读取，缺失用默认值）

## 快速开始

```bash
# 一键重启（默认：先停后启）
./scripts/dev.sh
```

启动成功输出示例：

```
🔄 重启服务...
🛑 停止服务...
  端口 3001 空闲
  端口 5173 空闲

▶ 启动后端（端口 3001）...
  后端 PID: 95976  日志: .../logs/server.log
▶ 启动前端（端口 5173）...
  前端 PID: 95977  日志: .../logs/client.log
⏳ 等待端口就绪...
  ✅ 后端 就绪（端口 3001，耗时 3s）
  ✅ 前端 就绪（端口 5173，耗时 0s）

═══════════════════════════════════════════════════════
  后端: ✅ 运行中（端口 3001）
  前端: ✅ 运行中（端口 5173）
  访问: http://localhost:5173
       http://172.36.108.149:5173
═══════════════════════════════════════════════════════
```

## 子命令

| 命令 | 作用 |
|------|------|
| `./scripts/dev.sh` | 重启（默认，等价 `restart`）：先停后启 |
| `./scripts/dev.sh restart` | 同上；端口被占时自动杀旧进程再启 |
| `./scripts/dev.sh start` | 仅启动；端口被占会报错并提示用 `restart` |
| `./scripts/dev.sh stop` | 仅停止，杀掉 3001 / 5173 监听进程 |
| `./scripts/dev.sh status` | 查看运行状态与访问地址（不启停） |

## 端口配置

端口从 `.env` 读取，可用环境变量覆盖。优先级：**环境变量 > `.env` > 默认值**。

| 配置项 | `.env` 键 | 默认值 | 服务 |
|--------|-----------|--------|------|
| 后端端口 | `SERVER_PORT` | 3001 | Express API + WebSocket |
| 前端端口 | `VITE_PORT` | 5173 | vite dev server |

临时换端口：

```bash
VITE_PORT=5180 ./scripts/dev.sh
```

## 访问地址

前端 host 在 `vite.config.js` 配为 `0.0.0.0`，局域网可达：

- 本机：`http://localhost:5173`
- 局域网：`http://<本机IP>:5173`（如 `http://172.36.108.149:5173`）

前端路由直接拼到端口后，如 `/onsite` → `http://172.36.108.149:5173/onsite`。

vite proxy 自动转发以下路径到后端 3001：`/api`、`/ws`、`/onsite/ws`、`/shell`、`/plugin-ws`。

## 日志

| 服务 | 日志文件 |
|------|----------|
| 后端 | `logs/server.log` |
| 前端 | `logs/client.log` |

`logs/` 已被 `.gitignore` 忽略，不会提交。实时查看：

```bash
tail -f logs/server.log
tail -f logs/client.log
```

## 常见问题

### Q1: 不用脚本，手动启动怎么写？

```bash
mkdir -p logs
# 后端（Express，不监听 stdin，可直接后台）
nohup npm run server:dev > logs/server.log 2>&1 &
# 前端（必须 CI=true，否则后台静默退出，见 Q2）
CI=true nohup npm run client > logs/client.log 2>&1 &
```

### Q2: 为什么手动 `npm run client` 后台跑会静默退出？

vite dev server 监听 stdin 做交互（按 `r` 重启、`q` 退出等）。后台运行时 stdin 是 EOF，vite 收到 EOF 后正常退出（exit 0、零报错、端口不监听），极易误判为"启动失败"。`CI=true` 让 vite 跳过 stdin 监听，根治此问题。脚本已默认带 `CI=true`。

### Q3: 端口被占怎么办？

直接 `./scripts/dev.sh restart`，会自动杀掉占用 3001 / 5173 的进程。也可先 `./scripts/dev.sh stop` 再 `start`。

### Q4: 局域网其他机器访问不了？

1. 确认本机 IP：`ifconfig | grep 'inet ' | grep -v 127.0.0.1`
2. 确认 5173 已监听且绑 `0.0.0.0`：`lsof -nP -iTCP:5173 -sTCP:LISTEN`（应显示 `*:5173`）
3. 确认防火墙未拦截 5173（macOS：系统设置 → 网络 → 防火墙）

### Q5: 服务怎么彻底停掉？

```bash
./scripts/dev.sh stop
```

## 实现要点

- `kill_port`：SIGTERM → 等 10s → SIGKILL，分级清理，避免强杀丢数据。
- `wait_port`：轮询 `lsof`，30s 超时报错并提示对应日志路径。
- 脚本开头 `export LC_ALL=C`：规避 macOS bash 3.2 在 UTF-8 locale 下把中文全角标点（`）`、`，`）的字节误纳入变量名、触发 `set -u` 报 `unbound variable` 的问题。
- `nohup ... &`：脱离终端，脚本退出后服务继续运行；停止依赖 `stop` / `restart` 按端口杀。
