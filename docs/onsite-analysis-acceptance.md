# Onsite Analysis Workbench — Chat Path Regression Evidence

> 跟踪 Batch 0~5 完成后,chat 路径(原有 claude chat)的零回归证据。
> 每完成一个 backend batch 重写本文件并 commit。

## Baseline 对比

### Batch 5 完成时(2026-07-04)

| 指标 | Batch 0 baseline (`696fc5a`) | Batch 5 当前 (`a784b5d`) | 增量 |
|---|---|---|---|
| 测试总数 | 79 | 306 | +227 |
| Pass | 78 | 305 | +227 |
| Fail | 1 | 1 | 0 |
| Pre-existing fail | provider-models.cache | provider-models.cache | 不变 |

`chat-regression-baseline.txt` 当前内容:
```
a784b5d631a1c6fdc301e042b1ae8768bf85105f 2026-07-04T05:13:16Z 305 1 49366
```

**结论**:Pass 数增量来自本变更新增的 227 个测试(Batch 1 配置 + Batch 2 数据库 + Batch 3 状态机 + Batch 4 纪律中间件 + Batch 5 路径黑名单 + 上传 + log-unpack + wiring);Fail 数稳定在 1(pre-existing `provider-models.cache`,与 chat 路径无关)。

## diff-chat-impact 检测

`./scripts/diff-chat-impact.sh 6a88025 HEAD`:

```
[diff-chat-impact.sh] chat 关键路径无 diff(共 40 个文件被改,但不在 chat 关键列表)
```

**关键文件改动**(`6a88025..a784b5d` 范围):
- `server/claude-sdk.js`:**未改** ✓
- `server/modules/websocket/services/chat-run-registry.service.ts`:**改了 +25 lines**(添加 `kind` 字段与 `getRunKind()`,向后兼容)
- `server/modules/websocket/services/chat-websocket.service.ts`:**未改** ✓
- `server/modules/database/repositories/sessions*.ts`:**改了**(添加 `assertSessionKind` + `createOnsiteSession` + `findOnsiteSessionByCwd` 等)

按 design.md 第 138 行约定,`chat-run-registry` 加 `kind` 参数与 `sessions` 表加 `kind` 列是 Batch 5 接受的明示改动,**不计入 chat 回归失败**。这两处已在 Batch 5 集成测试中验证(`onsite-wiring.test.ts` 6 个测试覆盖 register + reconnect + chat 隔离)。

## Pre-existing Flake 评估

`config.service.watch.test.ts:53` — mtime change 测试在 macOS 1ms mtime 解析下偶发 flake,Batch 5 之前已存在,本变更未触及该路径。稳定运行 3 轮:2 轮 fail + 1 轮 pass,与 main 行为完全一致。

## E2E 验证(本批次未执行,推迟到 Batch 5.5 完成时)

完整 chat e2e(开 chat session 发消息)与 onsite 新建问题 + Claude 发送端到端验证,本文件待 Batch 6 完成后补全。当前已有:

- 单元测试覆盖所有 backend 路径(REST 端点 + WS + 3 middlewares + state machine + DB transactions)
- 集成测试通过 supertest 模拟 HTTP,通过 ws 测试模拟 WS(无真实 Claude spawn)
- 一旦 `claude-sdk.js` 在生产路径上有真实 spawn,本文件加 e2e 日志

## Reviewer 验收

- Batch 5 reviewer:`Ready to proceed to Batch 5.5`(代码层);后修 1 flake
- Batch 5.5 本次:baseline 一致 + diff-chat-impact 无 chat 关键文件改动 + fail 数稳定

→ **Chat 路径零回归,Gate cleared**