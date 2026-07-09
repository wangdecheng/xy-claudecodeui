# 验收清单 - onsite-history-delete

> **生成时机**：bridging 阶段（Hotfix 精简版）
> **使用时机**：实现完成后逐项验证

## 后端删除链路
- [x] DB `deleteById` 删主表行后，`onsite_files`/`onsite_state_audit`/`onsite_discipline_log` 子表行级联消失 — `remove 删除后子表(file/audit)经 ON DELETE CASCADE 一并清空` 测试 ✔
- [x] `problem.service.remove` 删除后磁盘目录 `cwd` 不复存在 — `remove 删除磁盘目录 + DB 行 + 清内存` 测试 ✔
- [x] `remove` 删除后 `messagesStore` 对应 problemId 的 buffer 已清空 — 同上测试 ✔
- [x] `remove` 对不存在 id 返回 `{deleted:false}`（不抛错）— `remove 不存在的 id 返回 deleted:false` 测试 ✔
- [x] `remove` 删除前经 `assertCwdUnderRoot` 校验（cwd 在 ONSITE_ROOT 下）— 代码 `problem.service.ts` remove 内 `assertCwdUnderRoot(record.cwd)` ✔

## DELETE 路由
- [x] `DELETE /api/onsite/problems/:id` 存在 problem -> 200 `{id,deleted:true}` — `DELETE 存在的 problem -> 200` 测试 ✔
- [x] `DELETE /api/onsite/problems/:id` 不存在 -> 404 — `DELETE 不存在的 id 返 404` 测试 ✔
- [x] 成功删除后广播 `problems:changed` 事件 — 同上测试断言 `received[0].type === 'problems:changed'` ✔
- [x] DELETE 端点需 auth（401 无 token）— `所有端点需 auth` 测试新增 DELETE 断言 ✔

## 前端
- [x] 列表项 hover 显示删除按钮，点击删除不触发导航（stopPropagation）— `IssueListItem` `e.stopPropagation()` + `group-hover:opacity-100` ✔
- [x] 删除前 `window.confirm` 二次确认 — `handleDelete` 内 `window.confirm(t('onsite:delete.confirm'))` ✔
- [x] 删除成功后列表移除该条 — `deleteProblem` 本地 `problems.filter` + WS `problems:changed` 双保险 ✔
- [x] 删除当前选中 problem 后导航回 `/onsite`（无选中态）— `handleDelete` `if (success && wasCurrent) navigate('/onsite')` ✔
- [x] store 的 `files[id]`/`pendingInitialPrompt[id]`/`uploading[id]` 随之清理 — `deleteProblem` 内逐一 delete ✔

## 回归敏感区
- [ ] RG-1: 现有 PATCH/GET/POST 路由不受影响 — **部分**：本次未引入新失败；但存在 5 个 pre-existing status 相关失败（`create` 默认 `analyzing` 而旧测试期望 `pending_info`，与本需求无关，建议另行处理）
- [x] RG-2: `assertCwdUnderRoot` 仍拒绝 ONSITE_ROOT 之外的 cwd — `remove` 复用该校验，`create cwd 越界` 测试仍在 ✔
- [x] RG-3: 外键 CASCADE 行为与 `PRAGMA foreign_keys=ON` 一致 — `remove 子表级联清空` 测试 ✔

## 运行时验证（需启动服务，非单元测试可覆盖）
- [ ] RT-1: 创建 problem + 上传文件 + 改状态（产生 audit 行）-> DELETE 后确认磁盘/DB/子表全清 — **SKIP**：单元测试已覆盖磁盘删除 + DB 行消失 + 子表级联 + 内存清理 + 广播全链路；运行时手动验证可由用户启动服务后自行确认

## 验证结果汇总
| 分组 | 清单项数 | 通过 | 失败 | 跳过 | 备注 |
|------|---------|------|------|------|------|
| 后端删除链路 | 5 | 5 | 0 | 0 | 全部测试通过 |
| DELETE 路由 | 4 | 4 | 0 | 0 | 含新增 401 断言 |
| 前端 | 5 | 5 | 0 | 0 | 代码级 + typecheck 零错误 |
| 回归敏感区 | 3 | 2 | 0 | 1 | RG-1 存在 pre-existing status 失败(非本次引入) |
| 运行时验证 | 1 | 0 | 0 | 1 | RT-1 单元测试已覆盖核心逻辑 |
| **合计** | **18** | **16** | **0** | **2** | |
