# Capability: onsite.issue.state

> **Type**: ADDED
> **Source**: proposal §「状态机」

## Purpose

每个问题有一个状态字段,UI 与 Claude 行为必须按状态机迁移规则联动;状态变更需落库、落 `problem.json`、写审计。

## Requirements

### REQ-3.1 四态定义

The system MUST treat each problem as being in exactly one of these four states:

| State | 语义 | 默认进入条件 |
|---|---|---|
| `pending_info` | 待补信息:三项必给信息缺一,或 third-bridge 分支未确认 | 新建时默认 |
| `analyzing` | 分析中:三项信息齐 + Claude 正在跑 | 用户点「开始分析」,或首次用户消息发送 |
| `blocked` | 阻塞:traceId 全目录扫描命中 0,或被用户/Claude 显式标记 | `grep <traceId> *` 全部 0 时由纪律钩子自动迁移 |
| `confirmed` | 已证实:Claude 输出了带原文引用的根因结论 + 用户未否认 | Claude 在根因卡片上点击「确认为已证实」 |

### REQ-3.2 状态机迁移合法性

The system MUST enforce the following allowed transitions; any other transition MUST be rejected with `409 Conflict` and an error body listing the attempted transition and the current state.

```
pending_info  → analyzing          (用户点击开始 / 发首条消息)
analyzing     → blocked            (纪律钩子命中 / 显式标记)
analyzing     → confirmed          (用户确认根因)
analyzing     → pending_info       (用户撤回,回到待补信息)
blocked       → analyzing          (用户补日志后重跑)
confirmed     → analyzing          (用户要求进一步分析)
*             → abandoned          (用户主动归档,仅在最终归档流程中)
```

#### Scenario: 非法迁移被拒

- **GIVEN** 问题当前状态 `confirmed`
- **WHEN** 调用 `PATCH /api/onsite/problems/:id { status: "pending_info" }`
- **THEN** 返回 `409 Conflict`,body 含 `{ from: "confirmed", to: "pending_info", allowed: [...] }`

### REQ-3.3 显式迁移需要 reason

Any `PATCH` that changes the status MUST require a non-empty `reason` field of at least 8 characters. Reason MUST be persisted to the `onsite_state_audit` table (one row per transition).

#### Scenario: 缺 reason 被拒

- **GIVEN** 状态 `analyzing`
- **WHEN** `PATCH { status: "blocked" }` (无 reason)
- **THEN** 返回 `400 Bad Request`,错误信息 `reason is required (min 8 chars)`

#### Scenario: 完整迁移,审计落库

- **GIVEN** 状态 `analyzing`
- **WHEN** `PATCH { status: "blocked", reason: "traceId a1b2c3 全目录 count=0,需现场补 externalweb 日志" }`
- **THEN** 返回 `200 OK`
- **AND** `onsite_problems.status` 变为 `blocked`
- **AND** `problem.json.status` 同步更新
- **AND** `onsite_state_audit` 新增一行 `{ from: "analyzing", to: "blocked", reason, actor: <user_id>, at: <ISO8601> }`

### REQ-3.4 UI 状态徽章与头部信息同步

The status badge in the sidebar AND the status chip in the chat head MUST always reflect `onsite_problems.status`. Any PATCH that changes status MUST trigger a WebSocket broadcast `problem:<id>:state-changed` to all clients viewing that problem; receiving clients MUST re-render the badge within 200ms.

#### Scenario: 状态变更广播,所有客户端同步

- **GIVEN** 客户端 A 与 B 同时在查看问题 P,状态均为 `analyzing`
- **WHEN** 客户端 A 触发 PATCH 改为 `blocked`
- **THEN** 客户端 B 在 1 秒内收到 `problem:P:state-changed` 事件
- **AND** B 的侧栏徽章变琥珀,B 的头部 chip 变琥珀
- **AND** A、B 看到的 `reason` 字段一致
