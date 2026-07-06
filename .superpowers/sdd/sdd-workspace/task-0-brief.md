### Task 0.1 — chat 路径回归基线脚本 + CI step(防 C-3)

> **Pre-flight note**:项目用 `node:test`(内置 Node 测试运行器),没有 `pnpm test` 脚本。chat 路径相关测试散落在 `server/modules/websocket/tests/chat-run-registry.test.ts` 等位置,`server/claude-sdk.js` 没有直接的单元测试。

- **Create** `scripts/regression-chat.sh`:
  - 跑 `node --test "server/modules/websocket/tests/*.test.ts" "server/shared/tests/*.test.ts" server/claude-sdk-path.test.*` 等所有 chat/SDK 相关测试
  - **全跑**:`node --test "server/**/*.test.{ts,js}" server/*.test.{ts,js}` 兜底(后端任何测试失败都视为 chat 路径退化,因为 onsite 与 chat 共享 sessions 表 + websocket 通道)
  - 输出 `chat-regression-baseline.txt`,内容含:`<commit_sha> <ISO_date> <pass_count> <fail_count> <elapsed_ms>`,作为后续 PR 对比的 ground truth
  - exit code = 0 当且仅当全部 pass
  - 必须从仓库根目录跑(否则 globs 失效)
- **Create/Modify** `.github/workflows/regression.yml`(新建,因为现有 workflows 都是 desktop/release/docker,无 test workflow):
  - 在 PR 流水线加 step:`./scripts/regression-chat.sh`
  - step 失败 → 阻塞 merge,提示"chat 路径回归失败,请贴 PR 描述里的 baseline 对比"
  - step 成功 → 上传 `chat-regression-baseline.txt` 作为 PR artifact
- **Acceptance**:本 PR 触发 → step 跑通 → `chat-regression-baseline.txt` 落盘;后续 PR 跑该脚本作为前置门禁
- **TDD**:对脚本本身写一个 dry-run 测试(`./scripts/regression-chat.sh --dry-run` 应输出 baseline 格式但**不**跑测试)
- **Commit**:`test(onsite): add chat path regression baseline script + CI gate`

### Task 0.2 — chat 路径影响 diff 工具

- **Create** `scripts/diff-chat-impact.sh`:
  - 对比 `BASE_SHA..HEAD_SHA` 的 `server/claude-sdk.js` + `server/modules/websocket/services/chat-run-registry.service.ts` + `server/modules/websocket/services/chat-websocket.service.ts` + `server/modules/database/repositories/sessions*.ts` 变更
  - 若任一文件有非空 diff → exit 1 + 输出"⚠️ chat 路径有改动,需在 PR 描述里贴 chat-regression-baseline.txt 对比结果"
  - 同时输出"哪些文件被改 + 改了多少行",方便 reviewer 评估
- **Modify** `.github/workflows/*.yml`:在 `regression-chat.sh` 之前加 `diff-chat-impact.sh` 步骤
- **测试**:
  - 故意改 `chat-websocket.service.ts` 一行(无功能影响) → 跑脚本应 exit 1
  - 恢复 → 跑应 exit 0
- **TDD** + **Commit**:`ci(onsite): chat impact diff + regression gate`

---

## Batch 1:配置基础设施(可独立验收,后端零依赖)

> **目标**:把 `config/customer-analysis.json` 从零做到运行时可读、可校验、可热加载,完全无任何业务模块依赖。
> **依赖**:无。

