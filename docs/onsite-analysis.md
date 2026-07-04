# Onsite Analysis Workbench

> 客户现场问题分析工作台 — 把 `~/work/customer-onsite-analysis/` 下的终端工作流搬到 xy-claudecodeui 的 Web UI。

## 是什么

Onsite Analysis 是 xy-claudecodeui 内置的一个**垂直工作台**(`/onsite/*` 路由),用于客户现场问题排查。它和现有的 Chat / Shell / File / Git / MCP 并列,但约束更严:

- 强制三项必给信息(客户 / 迭代 / 数据库)
- Claude 的 `cwd` 永远锁定到问题目录,不允许改
- Provider 锁为 `Claude Code`,其他 Provider 在 onsite 路由下不可见
- traceId 0 命中 → 自动 `blocked` 态,UI 头徽章变琥珀
- 软化词("可能是/也许是/似乎")被实时高亮 + 落审计
- 写原日志路径被双层防护(SDK disallowedTools + middleware 软审计)

底层复用 `claude-sdk.js` 的 query/canUseTool 流,所以和 Chat 走的是同一套 Claude Agent SDK。

## 快速开始

启动主应用后:

```bash
npm run dev   # 同启 server:dev + vite client
```

打开 `http://localhost:5173/onsite`(或生产模式 `http://localhost:3001/onsite`)。

入口路径:

- **侧栏 → Onsite Analysis** 或 直接访问 `/onsite`
- 主页面:问题列表侧栏(左)+ 新建向导(`+` 按钮)+ 对话流(主区)
- 顶栏永久显示 `cwd + 状态徽章 + WS 连接状态 + 纪律计数`

新建问题步骤:点 `+` → 选客户(下拉由 `config/customer-analysis.json` 驱动,不允许手输)→ 选迭代 → 填数据库 → 提交。提交后即可上传 zip,服务端按"一包一目录"解压到 `unpacked-1/ unpacked-2/ ...`,然后 Claude 会在该问题目录的 `cwd` 下开始工作。

## 与终端工作流的关系

**不替代** `~/work/customer-onsite-analysis/CLAUDE.md` 那套终端守则 — 那是给终端 agent 用的工作守则,本次变更**不动**它。Onsite 只是给同一个工作流多一个 UI 入口。

磁盘是 source of truth:每个问题对应一个 `~/work/customer-onsite-analysis/YYYYMMDD-<客户>/` 目录,里面有 `problem.json` 元数据 + `unpacked-N/` 解压产物 + `analysis/` 分析产物。Web 端的所有修改最终都落回到这个目录。DB(`~/.cloudcli/auth.db`)只存索引/审计/会话行,出问题以磁盘为准。

跨问题聚合、远程协作、自动化巡检 — **都不在范围内**,走终端或后续 batch。

## 纪律护栏(3 层)

| 层 | 机制 | 文件 |
|---|---|---|
| 1. 软化词高亮 | middleware 包 ws.send,命中"可能是/也许是/似乎/... → 入审计 + envelope flag | `server/modules/onsite-analysis/discipline/discipline-softening.middleware.ts` |
| 2. traceId 0 命中 → blocked | 主信号(AI 文本含"未找到/0 结果")+ 强信号(tool_result 中 grep ... 0 行)→ StateMachine 切 `blocked` | `server/modules/onsite-analysis/discipline/discipline-trace-id.middleware.ts` |
| 3. 写原日志双层防护 | 硬层:SDK `disallowedTools` 黑名单(7×7 glob × 写动作);软层:middleware 检测 tool_result 中 `rm / tee / sed -i / >` + `*.log / problem.json` | `server/modules/onsite-analysis/discipline/discipline-write-protection.middleware.ts` + `onsite-path-blacklist.service.ts` |

## 已知限制

- **移动端**:UI 复用主应用响应式,但新建向导在窄屏下可能挤压(后续 batch 优化)
- **会话持久化**:`GET /api/onsite/problems/:id/messages` 端点(server ring buffer,500 条)让刷新页面能回看会话;但**进程重启即丢** — 重要结论请落到 `analysis/` 子目录或 problem.json
- **30s 退避**:WS 断线后客户端用 30s 指数退避重连,见 `src/contexts/OnsiteWebSocketContext.tsx`
- **Provider 锁定**:onsite 路由下 provider 切换器只显示 `Claude Code`;其他 Provider(Cursor / Codex / Gemini / OpenCode)的入口保持现状
- **客户/迭代下拉**:必须由 `config/customer-analysis.json` 驱动;`scripts/validate-no-hardcoded-customers.sh` 在 CI 拦截硬编码

## 验证记录

完整 11 条成功标准 + 验收证据见 [`docs/onsite-analysis-acceptance.md`](./onsite-analysis-acceptance.md)。

## 相关文档

- 设计 spec:`changes/customer-onsite-analysis-ui/{proposal,design,tasks}.md`
- API 端点:`server/modules/onsite-analysis/onsite.routes.ts`
- WS 协议:`server/modules/websocket/services/onsite-websocket.service.ts` + `shared/onsite-types.ts`
- 静态扫描:`scripts/validate-no-hardcoded-customers.sh`
- Demo 端到端:`scripts/demo-onsite.sh`