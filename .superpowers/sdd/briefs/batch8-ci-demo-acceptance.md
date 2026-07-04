# Task Brief — Batch 8(CI + demo + 11 SC 验收 + 收尾)

## 范围

按 D → A 链组织:**先修 3 个 deferred Important(I1/I2/I3),再走 8.1-8.4**。

## Phase 0 — 修 3 个 deferred Important(每个 ≤ 1 commit)

### I1. 加 `GET /api/onsite/problems/:id/messages` 端点

**文件**:`server/modules/onsite-analysis/onsite.routes.ts`(新增路由 + 内存 store)
**新增**:`server/modules/onsite-analysis/messages-store.service.ts`(ring buffer,per-problem,500 messages)

设计:
- 服务端内存 ring buffer per `problemId`,每条 entry `{role, content, ts, kind}`
- WS `assistant` / `user` 消息也写一份到此 store(由 WS handler 在发 client 前同步写)
- `GET /:id/messages` → `messagesStore.getByProblemId(id)`(最新 500 条按时间正序)
- `POST /:id/messages` 用于客户端 user 消息上报(本地 echo) — 留接口,Batch 7 已在线 state

**TDD 写**:
- `messages-store.service.test.ts` — append / getByProblemId / cap 500 / FIFO
- `onsite-messages-route.test.ts` — 200 + 数组 / 404 unknown id

**Commit**:`feat(onsite): GET /api/onsite/problems/:id/messages endpoint`

### I2. no-third-party cwd 验证

**先 verify**:读 `server/modules/onsite-analysis/problem.service.ts` 的 `assertCwdUnderRoot` + `create`:

```ts
const absoluteCwd = path.isAbsolute(cwd) ? path.resolve(cwd) : path.resolve(root, cwd);
```

**verify 路径**:
- 当 wizard 在 no-third-party 路径下传 `cwd: "山西公安"`(customer label)
- `assertCwdUnderRoot("山西公安", root)` → `path.resolve(root, "山西公安")` = `~/work/customer-onsite-analysis/山西公安`
- `path.relative(root, "~/work/customer-onsite-analysis/山西公安")` = `"山西公安"`(以 `..` 开头?**否**)
- → 不会 throw

若 verify 通过 → I2 不是真 bug,改为**文档**:`NewIssueWizard.tsx` 加注释「no-third-party 时 cwd = customer label,server 已通过 assertCwdUnderRoot」+ 改 reviewer 报告状态。

若 verify 失败 → 在 problem.service.ts 调整(no-third-party 路径 server 端默认 cwd = `<root>` 跳过 assert,或 special-case)。

**Commit**(任一):`fix(onsite): document no-third-party cwd resolution` / `fix(onsite): server-side cwd fallback for no-third-party`

### I3. shared types 形式化 `discipline` envelope flag

**文件**:`shared/onsite-types.ts`

新增:
```ts
export interface OnsiteDisciplineEnvelope {
  softening?: boolean;
  write_original_log?: boolean;   // server 给的是 snake_case,跟 shared types 一致
  trace_id_empty?: boolean;
  trace_id_suspect?: boolean;
  matched_text?: string;           // 主信号 traceId 命中片段
  cmd?: string;                    // 工具命令字符串
}
```

更新 `OnsiteServerEvent` 加 `discipline?: OnsiteDisciplineEnvelope`。

读 `server/modules/onsite-analysis/discipline/*.middleware.ts` 验证 server 实际发的字段名(snake_case 已锁),做相应映射。

修改 `src/components/onsite-analysis/OnsiteChatStream.tsx` 的防御性读取 → 强类型 `ev.discipline?.softening === true`。

**TDD 写**:无新行为,纯类型;TypeScript 编译通过即过。

**Commit**:`refactor(onsite): promote discipline envelope to shared types`

---

## Phase 1 — 8.1 validate-no-hardcoded-customers.sh(关键防线)

### 文件

`scripts/validate-no-hardcoded-customers.sh`

### 逻辑(伪代码)

```bash
#!/usr/bin/env bash
set -euo pipefail

# 扫描 src/ server/ design-prototypes/onsite-analysis/ 中
# 是否硬编码了 customer/iteration 字面量
ALLOWED_DIRS="src/ server/ design-prototypes/onsite-analysis/"
EXCLUDE_PATTERN="(test|spec|fixture|README|CLAUDE|\\.md|node_modules|dist)"

# 已知客户/迭代字面量(从 config/customer-analysis.json 读出来,grep 它们)
CUSTOMERS=$(jq -r '.data.customers[].label' config/customer-analysis.json)
ITERATIONS=$(jq -r '.data.iterations[]' config/customer-analysis.json)
HARDCODED_HINT_PATTERN="(手动输入|请输入客户|请输入迭代|自定义)"

VIOLATIONS=0
for dir in $ALLOWED_DIRS; do
  # 1. 关键提示短语
  HINTS=$(grep -rnE "$HARDCODED_HINT_PATTERN" $dir 2>/dev/null \
    | grep -vE "$EXCLUDE_PATTERN" || true)
  if [[ -n "$HINTS" ]]; then
    echo "❌ 硬编码提示短语: $HINTS"
    VIOLATIONS=$((VIOLATIONS + 1))
  fi

  # 2. 客户/迭代字面量(只在 config 外的位置)
  for label in $CUSTOMERS $ITERATIONS; do
    # 转义 grep special chars
    LITERALS=$(grep -rnF "$label" $dir 2>/dev/null \
      | grep -vE "($EXCLUDE_PATTERN|config/customer-analysis|config/json-schemas)" \
      | grep -vE "(test|spec|fixture|README|CLAUDE|\\.md)" || true)
    if [[ -n "$LITERALS" ]]; then
      echo "⚠️  字面量 '$label' 出现在: $LITERALS"
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
  done
done

if [[ $VIOLATIONS -gt 0 ]]; then
  echo ""
  echo "共 $VIOLATIONS 处违规。请走配置驱动而不是硬编码。"
  exit 1
fi
echo "✓ validate-no-hardcoded-customers 0 violations"
```

### TDD(可手测,无需 test runner)

```bash
# 加临时文件
echo "请选择客户" > src/components/onsite-analysis/test-violation.tsx
./scripts/validate-no-hardcoded-customers.sh  # 应 exit 1
rm src/components/onsite-analysis/test-violation.tsx
./scripts/validate/validate-no-hardcoded-customers.sh  # 应 exit 0
```

### 接入 CI

`.github/workflows/*.yml`:
- 找 `regression.yml` 或 `pr.yml`(在 `.github/workflows/`)
- 在 `regression-chat.sh` 之前加 `./scripts/validate-no-hardcoded-customers.sh`
- step 失败 → 阻塞 merge

**Commit**:`ci(onsite): validate-no-hardcoded-customers script + workflow step`

---

## Phase 2 — 8.2 demo 端到端脚本

### 文件

`scripts/demo-onsite.sh`

### 流程(7 步)

```bash
#!/usr/bin/env bash
set -euo pipefail

# Step 1. 起服务(开发模式)
echo "→ 启动 server (background)"
npm run server:dev &
SERVER_PID=$!
trap "kill $SERVER_PID 2>/dev/null || true" EXIT
sleep 5  # 等 server 启动

# Step 2. 拉 token
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"demo","password":"demo"}' | jq -r .token)
[[ -n "$TOKEN" ]] || { echo "❌ 拿不到 token"; exit 1; }
echo "✓ 拿到 token"

# Step 3. 创建问题
PROBLEM_ID=$(curl -s -X POST http://localhost:3001/api/onsite/problems \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"customer":"中车长客","iteration":"master_5.2_3.2","database":"mysql","files":[]}' \
  | jq -r .id)
echo "✓ 创建问题 $PROBLEM_ID"

# Step 4. 上传 2 个 zip(用已经造好的 fixture)
curl -s -X POST "http://localhost:3001/api/onsite/problems/$PROBLEM_ID/files" \
  -H "Authorization: Bearer $TOKEN" \
  -F "files=@tests/fixtures/sample-1.zip" \
  -F "files=@tests/fixtures/sample-2.zip" | jq .

# Step 5. 拉列表 + 状态
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/onsite/problems | jq '.[0]'

# Step 6. 切到 analyzing + 切到 confirmed(测试软化词阻断)
curl -s -X PATCH "http://localhost:3001/api/onsite/problems/$PROBLEM_ID" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"analyzing","reason":"开始排查现场日志"}' | jq .
echo "✓ 切到 analyzing"

# 软化词阻断
BLOCKED=$(curl -s -X POST "http://localhost:3001/api/onsite/problems/$PROBLEM_ID/confirm-root-cause" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"root_cause_text":"可能是 xx 引起的"}' \
  -w "%{http_code}" -o /tmp/blocked-resp.json)
if [[ "$BLOCKED" == "422" ]]; then
  echo "✓ 软化词阻断 422 (符合预期)"
else
  echo "❌ 软化词应该 422 但拿到 $BLOCKED"
  cat /tmp/blocked-resp.json
  exit 1
fi

# 切到 confirmed(不带软化词)
curl -s -X PATCH "http://localhost:3001/api/onsite/problems/$PROBLEM_ID" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"confirmed","reason":"已证实根因,提交工单"}' | jq .
echo "✓ 切到 confirmed"

echo ""
echo "=== demo 7 步全跑通 ==="
```

### TDD

- 不能跑需要 server up 的 TDD,改为 **manual** 验证:
  1. 跑脚本,观察 7 步 exit 0
  2. 检查 `/tmp/blocked-resp.json` 含 `softening_words_present`
- 留 `scripts/test-demo-onsite-dry.sh`(纸面 mock,不依赖 server)— 留 future batch 接入 vitest

**Commit**:`test(onsite): end-to-end demo script`

---

## Phase 3 — 8.3 README + 8.4 SC 验收

### 8.3 文件

`docs/onsite-analysis.md`

内容:
- 1 段「是什么」(客户现场问题分析工作台,基于 xy-claudecodeui)
- 1 段「快速开始」(菜单入口 / 路由 `/onsite`)
- 1 段「与终端工作流关系」(替代 `customer-onsite-analysis/CLAUDE.md` 手工运行)
- 1 段「纪律护栏」(traceId / softening / write-protection 三层)
- 1 段「已知限制」(mobile 不支持 / 30s 退避)
- 链接到 `docs/onsite-analysis-acceptance.md` 验收记录

**Commit**:`docs(onsite): readme`

### 8.4 文件

`docs/onsite-analysis-acceptance.md` — 已经存在(Batch 5.5 已写),追加 Batch 8 验收段。

**11 条 SC 逐条勾**(来自 `proposal.md §Success Criteria`):

| # | SC | 验证方式 | 结果 |
|---|---|---|---|
| 1 | 三项必给信息强制采集 | grep `disabled` in NewIssueWizard;smoke 三项全空时 button disabled | ☐ |
| 2 | 下拉由配置驱动 | grep `customers/iterations` 字面量在 src/ 数 = 0(validate 脚本) | ☐ |
| 3 | 不允许手动输入 | grep `<input\|datalist\|typeahead` in CustomerSelect/IterationSelect/DatabaseSelect = 0 | ☐ |
| 4 | 工作目录锁定 | grep `setHelloContext` in OnsiteChatStream;grep `CwdLockView` 顶栏 mounted | ☐ |
| 5 | Provider 锁定 | grep `provider === 'claude'` 或 hardcode 路径只 Claude | ☐ |
| 6 | 纪律可视化 | grep `SofteningTag` in OnsiteChatStream;grep `splitSoftening` in RootCauseCard | ☐ |
| 7 | traceId 0 命中 → blocked | grep `discipline-trace-id` middleware;grep `state-machine.service.ts` blocked path | ☐ |
| 8 | 一包一目录 | grep `unpacked-` regex in log-unpack;test onsite-upload-routes.test.ts 已存在 | ☐ |
| 9 | 配置热加载 | grep `watchConfig` in config.service.ts;test config.service.watch.test.ts 已存在 | ☐ |
| 10 | 零硬编码客户/迭代 | 跑 `validate-no-hardcoded-customers.sh` → 0 violations | ☐ |
| 11 | 纪律护栏与回归门禁 | 3 sub-check:traceId 多信号 / disallowedTools 7×7 / chat 零回归 | ☐ |

逐条 ✅ 完成后,在每个 SC 旁贴 grep 输出 + 路径。

**Commit**:`docs(onsite): 11 SC 验收 evidence (Batch 8.4)`

---

## 提交策略

每个 Phase 独立 commit:

```
Phase 0:
  feat(onsite): GET /api/onsite/problems/:id/messages endpoint (I1)
  fix(onsite): [no-third-party cwd 处理] (I2)
  refactor(onsite): promote discipline envelope to shared types (I3)
Phase 1:
  ci(onsite): validate-no-hardcoded-customers script + workflow step
Phase 2:
  test(onsite): end-to-end demo script
Phase 3:
  docs(onsite): readme
  docs(onsite): 11 SC 验收 evidence (Batch 8.4)
```

预计 6-8 commits。

## ⚠️ 重要约束

1. **不动**:`server/claude-sdk.js` / `chat-websocket.service.ts` / `chat-run-registry.service.ts` / `src/contexts/WebSocketContext.tsx` / `src/stores/useSessionStore.ts`
2. **可接受 scope 扩展**:Phase 0 I1 必然涉及 server;仅限 `server/modules/onsite-analysis/onsite.routes.ts` 与新文件
3. **CI step 修改**:`.github/workflows/*.yml` 可改,只在原文件加 step,**不**改其他 job 结构
4. **零新增 npm 包**
5. **client tsc 必须 exit 0**

## 测试调整路线

- Phase 0 I1 有完整 TDD 路径(写 server 端 unit + route test)
- Phase 1 是 shell 脚本,用 file-fixture 测 happy path + 1 failure path
- Phase 2 是 shell 脚本,需 server up,无法用 TDD,**manual 跑通**即过
- Phase 3 是文档,**纯人工勾 SC**,附 grep 输出作 evidence

## 报告

写到 `/Users/xylink/ai/xy-claudecodeui/.superpowers/sdd/reports/batch8-implementer-report.md`:

- Status (DONE / DONE_WITH_CONCERNS / BLOCKED)
- Phase 0 三个 fix 的 result(I1 commit / I2 是 fix 还是 doc / I3 type refactor)
- Phase 1-3 各自 commit hash
- 11 SC 表格(每条 ✅ + evidence)
- demo 脚本跑通的 7 步输出
- `validate-no-hardcoded-customers.sh` 跑通输出
- chat-path 5 文件 + shared types(cd901cc)零 diff 验证
- 任何未完成项 / blocked 项

回 5 行状态摘要。

Begin now。
