# Execution Contract - onsite-history-delete

> **模式**：Hotfix（轻量快速路径，DP-0 已确认）
> **生成阶段**：bridging
> **批准门**：DP-3 —— 未经你显式批准，不进入 build-executor 实现。

## Intent Lock

为客户现场分析问题列表增加删除能力：删除某条 problem 时，物理清理其磁盘目录（`~/work/customer-onsite-analysis/YYYYMMDD-客户/`，含 problem.json 与解压日志）+ DB 记录（`onsite_problems` 主表行；子表 `onsite_files`/`onsite_state_audit`/`onsite_discipline_log` 经已配置的 `ON DELETE CASCADE` 一并清空）+ 内存缓冲（`messagesStore`），并广播 `problems:changed` 通知所有客户端刷新列表；前端列表项 hover 显示删除按钮，`window.confirm` 二次确认防误删。

## Constraints（约束，已从现有代码确认）

- **路径安全**：删除前必须 `assertCwdUnderRoot(cwd)` 校验，确保只删 ONSITE_ROOT 下的目录，杜绝 path traversal / 误删其他路径。
- **外键级联**：依赖已启用的 `PRAGMA foreign_keys = ON` + `ON DELETE CASCADE`，删主表行自动清子表，无需手动删。
- **不可逆**：物理删除磁盘数据，不可恢复 → 必须二次确认。
- **不走状态机**：删除是物理删除，不经过 `state-machine.service` 的 `abandoned` 状态迁移。

## Task List（编号任务，按依赖排序）

1. **[DB]** `server/modules/database/repositories/onsite-problems.db.ts`：新增 `deleteById(id)`，`DELETE FROM onsite_problems WHERE id = ?`。
2. **[Service]** `server/modules/onsite-analysis/problem.service.ts`：新增 `remove(id)` → getById 查记录（不存在返回 `{deleted:false}`）→ `assertCwdUnderRoot(cwd)` → `rm(cwd,{recursive,force})` 删磁盘 → `onsiteProblemsDb.deleteById(id)` 删 DB → `messagesStore.clear(id)` 清内存 → 返回 `{id,deleted:true}`。
3. **[Route]** `server/modules/onsite-analysis/onsite.routes.ts`：新增 `DELETE /api/onsite/problems/:id` → 调 `problemService.remove` → `deleted:false` 返回 404 → 成功广播 `problems:changed` 并返回 200 `{id,deleted:true}`。
4. **[Store]** `src/stores/onsiteStore.tsx`：新增 `deleteProblem(id)` action → `authenticatedFetch(url,{method:'DELETE'})` → 成功后本地 `problems.filter(p=>p.id!==id)` + 若删的是当前选中则清空 `currentProblemId` + 清 `files[id]`/`pendingInitialPrompt[id]` → 返回 boolean。
5. **[UI]** `src/components/onsite-analysis/IssueListItem.tsx`：外层 `<button>` 改 `<div role="button">`（button 不可嵌 button）；hover 右上角显示删除图标按钮（`stopPropagation`）；点击 → `window.confirm` 二次确认 → `deleteProblem(id)`；删除成功后若删的是当前路由 problemId 则 `navigate('/onsite')`。
6. **[i18n]** `src/i18n/locales/zh-CN/onsite.json` + `en/onsite.json`：新增删除确认/失败文案（en 镜像中文）。
7. **[Test]** `server/modules/onsite-analysis/tests/onsite.routes.test.ts`：DELETE 200（磁盘目录被删 + DB 行消失 + 子表级联清空 + 广播 `problems:changed` 触发）、DELETE 404。
8. **[Test]** `server/modules/onsite-analysis/tests/problem.service.test.ts`：`remove` 用例（删磁盘 + 删 DB + 清内存 + 不存在返回 `deleted:false`）。
9. **[Verify]** 运行后端测试套件确认全绿。

## Approval Gate（DP-3）

- 本契约为 Hotfix 最小契约，按 contract-builder Hotfix Mode 跳过 Scope Fence / Build Rules / Review Gates / Test Evidence。
- **未经你显式批准，不进入实现。**
- 批准后状态：`bridging → approved-for-build`，路由至 build-executor（TDD 纪律化执行）。
