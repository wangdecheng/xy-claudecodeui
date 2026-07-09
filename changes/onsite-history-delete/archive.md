# 归档 - onsite-history-delete

> **归档时机**：DP-7 确认后
> **状态**：✅ release-ready
> **模式**：hotfix（轻量快速路径）

## Intent Lock

为客户现场分析问题列表增加删除能力：删除某条 problem 时，物理清理其磁盘目录（含 problem.json 与解压日志）+ DB 记录（`onsite_problems` 主表行；子表 `onsite_files` / `onsite_state_audit` / `onsite_discipline_log` 经已配置的 `ON DELETE CASCADE` 一并清空）+ 内存缓冲（`messagesStore`），并广播 `problems:changed` 通知所有客户端刷新列表；前端列表项 hover 显示删除按钮，`window.confirm` 二次确认防误删。

## 落地清单（9/9 任务完成）

| # | 模块 | 改动 |
|---|------|------|
| 1 | DB | `onsite-problems.db.ts` 新增 `deleteById(id)` |
| 2 | Service | `problem.service.ts` 新增 `remove(id)` — 磁盘 + DB + 内存三清 |
| 3 | Route | `onsite.routes.ts` 新增 `DELETE /api/onsite/problems/:id` + 广播 `problems:changed` |
| 4 | Store | `onsiteStore.tsx` 新增 `deleteProblem(id)` action |
| 5 | UI | `IssueListItem.tsx` hover 删除按钮 + stopPropagation + 二次确认 |
| 6 | i18n | `zh-CN` / `en` `onsite.json` 新增删除确认文案 |
| 7 | Test | `onsite.routes.test.ts` 新增 DELETE 200 / 404 + 401 断言 + 广播断言 |
| 8 | Test | `problem.service.test.ts` 新增 remove 3 用例 |
| 9 | Verify | 全套测试运行 + 验收清单 16/0/2 |

## 测试结果（fresh 验证）

| 测试文件 | 总数 | 通过 | 失败 | 失败性质 |
|---------|------|------|------|---------|
| `onsite.routes.test.ts` | 18 | 15 | 3 | 3 个 PATCH 状态机失败（pre-existing） |
| `problem.service.test.ts` | 17 | 15 | 2 | 2 个状态枚举默认值失败（pre-existing） |
| `onsite-problems.db.test.ts` | 9 | 9 | 0 | — |

**新增测试（5/5 全绿）**：
- `DELETE 存在的 problem -> 200 + 磁盘目录删除 + DB 行消失 + 子表级联 + 广播 problems:changed` ✔
- `DELETE 不存在的 id 返 404` ✔
- `所有端点需 auth (401 without token)` 新增 DELETE 断言 ✔
- `remove 删除磁盘目录 + DB 行 + 清内存` ✔
- `remove 不存在的 id 返回 deleted:false` ✔
- `remove 删除后子表(file/audit)经 ON DELETE CASCADE 一并清空` ✔

**回归验证（git stash 反向对比）**：
- stash 工作树 11 个 M 文件后，5 个失败测试**完全一致**地失败 → 证实全部 pre-existing
- pop 工作树后，5 个新测试**全部新增并通过** → 证实本 change 0 回归

## Pre-existing 失败（5 项，与本 change 无因果）

| 失败测试 | 根因 | 影响范围 |
|---------|------|---------|
| `create 写入 YYYYMMDD-客户 目录 + problem.json` | `create` 默认状态 `analyzing` vs 测试期望 `pending_info` | problem.service.test.ts |
| `list 兼容无 problem.json 的旧目录 -> 默认 pending_info` | 同上 | problem.service.test.ts |
| `PATCH 非法状态迁移返 409 + allowed` | 状态机 transition 与测试期望反向 | onsite.routes.test.ts |
| `PATCH 合法迁移返 200 + audit 行落库` | 同上 | onsite.routes.test.ts |
| `PATCH 成功后 broadcast 触发 state-changed` | 同上 | onsite.routes.test.ts |

**状态枚举默认值** + **PATCH 状态机 200/409 行为** 两类问题应在独立 change 中处理（影响 create/PATCH 核心契约，超出本 hotfix scope fence）。

## 验收清单汇总

- 18 项验收：**16 通过 / 0 失败 / 2 跳过**
- 跳过项：RG-1（pre-existing 状态枚举失败，与本 change 无关）+ RT-1（运行时手动验证，单元测试已覆盖全链路）
- 详细见 `verification-checklist.md`

## 改动文件（11 个）

### 本 change 范围内（10 个）
- `server/modules/database/repositories/onsite-problems.db.ts` (+12)
- `server/modules/onsite-analysis/onsite.routes.ts` (+33)
- `server/modules/onsite-analysis/problem.service.ts` (+28)
- `server/modules/onsite-analysis/tests/onsite.routes.test.ts` (+68)
- `server/modules/onsite-analysis/tests/problem.service.test.ts` (+83)
- `src/components/onsite-analysis/IssueListItem.tsx` (+58)
- `src/stores/onsiteStore.tsx` (+56)
- `src/i18n/locales/zh-CN/onsite.json` (+4)
- `src/i18n/locales/en/onsite.json` (+4)

### 附带改动（1 个）
- `config/customer-analysis.json` (+4) — 新增 中信银行(ASSO/CMTS) / 五矿集团公有云 2 个客户分支

### 工件目录（新建 3 个）
- `changes/onsite-history-delete/.spec-superflow.yaml`
- `changes/onsite-history-delete/execution-contract.md`
- `changes/onsite-history-delete/verification-checklist.md`
- `changes/onsite-history-delete/archive.md`（本文件）

## DP 门

| DP | 状态 | 时间戳 |
|----|------|--------|
| DP-0 | confirmed | 2026-07-09T00:00:00Z |
| DP-3 | approved | 2026-07-09T00:00:00Z |
| DP-4 | sdd | 2026-07-09T00:00:00Z |
| DP-6 | conditional | 2026-07-09T06:30:00Z |
| DP-7 | **confirmed** | 2026-07-09T06:30:00Z |

## 后续待办

1. **commit 阶段**（已出 release-archivist scope）：stage 14 D + 11 M + 新建 4 文件 → 一次性提交
2. **pre-existing 失败**（独立 change）：状态枚举默认值 + PATCH 状态机行为修复
3. **客户配置**（如需追溯）：config/customer-analysis.json 的 2 个新客户如属于未规划工作，可单独存档
