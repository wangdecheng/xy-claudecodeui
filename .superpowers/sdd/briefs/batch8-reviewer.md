# Review Brief — Batch 8(CI + demo + 11 SC 验收)

## 范围

7 commits(实现者报告:`c08be34..7459316`):

| Commit | 任务 | 预期 message |
|---|---|---|
| (I1) | GET /api/onsite/problems/:id/messages | `feat(onsite): GET ...` |
| (I2) | no-third-party cwd 处理 | `fix(onsite):` or `docs(onsite):` |
| (I3) | discipline envelope 进 shared types | `refactor(onsite): promote discipline envelope to shared types` |
| (8.1) | validate-no-hardcoded-customers.sh + CI step | `ci(onsite): validate-no-hardcoded-customers script + workflow step` |
| (8.2) | demo-onsite.sh 7-step e2e | `test(onsite): end-to-end demo script` |
| (8.3) | docs/onsite-analysis.md README | `docs(onsite): readme` |
| (8.4) | 11 SC 验收 evidence | `docs(onsite): 11 SC 验收 evidence (Batch 8.4)` |

Implementer 报告:`/Users/xylink/ai/xy-claudecodeui/.superpowers/sdd/reports/batch8-implementer-report.md` — **READY_FOR_RELEASE** + 3 concerns

## 实施者声明的关注(★ 必查)

1. **Phase 2 demo 脚本未本地 e2e 跑通** —— 30 个 pre-existing server tsc 错误阻止 server 启动。脚本在 CI 干净环境下能跑。
2. **I2 verify 后认为是 doc-only fix**(assertCwdUnderRoot 已宽容 customer label)
3. **`design-prototypes/onsite-analysis/` 不存在** —— validate 脚本 graceful skip,不算违规

## 重点审查项

### A. 客户端 tsc 干净

```bash
npx tsc --noEmit -p tsconfig.json
```

期望:exit 0,无输出。

### B. 11 SC 实际 evidence(★ 关键)

**不要信任 implementer 报告的表格**。逐条复现:

| # | SC | 必跑命令 |
|---|---|---|
| 1 | 三项必给信息强制采集 | `grep -nE "disabled" src/components/onsite-analysis/NewIssueWizard.tsx` |
| 2 | 下拉由配置驱动 | `node -e "const c=require('./config/customer-analysis.json'); console.log(c.data.customers.length, c.data.iterations.length)"` 期望 13 / 2 |
| 3 | 不允许手动输入 | `grep -nE "<input\|datalist\|typeahead" src/components/onsite-analysis/{Customer,Iteration,Database}Select.tsx` 期望零匹配 |
| 4 | 工作目录锁定 | `grep -n "setHelloContext" src/components/onsite-analysis/OnsiteChatStream.tsx` + `grep -n "CwdLockView" src/components/onsite-analysis/OnsiteChatStream.tsx` |
| 5 | Provider 锁定 | 找 onsite 路径下 provider 锁的代码(可能在新文件或 routes 内)|
| 6 | 纪律可视化 | `grep -n "SofteningTag\|splitSoftening" src/components/onsite-analysis/` 找命中 |
| 7 | traceId 0 命中 → blocked | `grep -n "discipline-trace-id" server/modules/onsite-analysis/discipline/` + `grep -n "blocked" server/modules/onsite-analysis/state-machine.service.ts` |
| 8 | 一包一目录 | `grep -n "unpacked-" server/modules/onsite-analysis/log-unpack.service.ts` |
| 9 | 配置热加载 | `grep -n "watchConfig\|chokidar" server/modules/onsite-analysis/config.service.ts` |
| 10 | 零硬编码 | `./scripts/validate-no-hardcoded-customers.sh` 实际跑(期望 exit 0)|
| 11 | 三子条件 | traceId 多信号 + disallowedTools 7×7 + chat 零回归(后两个见 G) |

**如果某条 SC evidence 缺** → Important issue,需 implementer 补。

### C. validate-no-hardcoded-customers.sh 真实跑通

```bash
cd /Users/xylink/ai/xy-claudecodeui
chmod +x scripts/validate-no-hardcoded-customers.sh
./scripts/validate-no-hardcoded-customers.sh
echo "exit code: $?"
```

期望:exit 0,输出 "✓ ... 0 violations"。

测 failure path:
```bash
echo "请选择客户" > /tmp/test-violation.tsx
# 临时挪进 src/ 让脚本能扫到
mkdir -p src/components/onsite-analysis
echo "请选择客户" > src/components/onsite-analysis/test-violation.tsx
./scripts/validate-no-hardcoded-customers.sh
echo "exit code: $?"  # 应 1
rm src/components/onsite-analysis/test-violation.tsx
```

### D. demo-onsite.sh 至少能 bash -n 过(语法对)

```bash
bash -n scripts/demo-onsite.sh && echo "syntax OK"
```

期望:无错。脚本可能因 server 不能启不能实际跑——记录在 report。

### E. I1 GET /messages 端点 + 测试

```bash
ls server/modules/onsite-analysis/tests/  # 找 messages-store.service.test.ts
ls server/modules/onsite-analysis/tests/onsite-messages-route.test.ts 2>/dev/null

# 跑测试
node_modules/.bin/tsx --test --tsconfig server/tsconfig.json \
  server/modules/onsite-analysis/tests/messages-store.service.test.ts 2>&1 | tail -10
```

期望:test 文件存在并 pass。如果没测试文件 → Critical。

### F. I3 shared types refactor 类型干净

```bash
git diff cd901cc HEAD -- shared/onsite-types.ts | head -50
# 应只有"promote discipline envelope"相关的 +/-
```

期望:diff 范围 < 50 行,只动 discipline 相关。

### G. Chat 路径零回归(★ 关键,3 commits 涵盖 5 文件)

```bash
git diff f1e6bb4 HEAD --stat -- \
  src/contexts/WebSocketContext.tsx \
  src/stores/useSessionStore.ts \
  server/claude-sdk.js \
  server/modules/websocket/services/chat-run-registry.service.ts \
  server/modules/websocket/services/chat-websocket.service.ts
```

期望:空 diff。

### H. CI workflow 集成正确

读 `.github/workflows/regression.yml`(或对应文件):
- 找 `validate-no-hardcoded-customers.sh` step
- step 位置 + failure handling

### I. README 完整

读 `docs/onsite-analysis.md`:
- 「是什么」段
- 「快速开始」段
- 「与终端工作流关系」段
- 链接到 `docs/onsite-analysis-acceptance.md`

### J. Acceptance doc 11 SC 表格 evidence 真实

读 `docs/onsite-analysis-acceptance.md`(Batch 8.4 追加段):
- 每条 SC 的 evidence 不是空指针
- grep 输出 / 文件路径 / 测试结果 真实存在
- 不是 "TBD" / "N/A" / 假数据

### K. Server pre-existing 30 errors 保持

```bash
git checkout f1e6bb4 -- server/  # 回到 pre-Batch-6
npx tsc --noEmit -p server/tsconfig.json 2>&1 | grep -c "error TS"
git checkout HEAD -- server/
npx tsc --noEmit -p server/tsconfig.json 2>&1 | grep -c "error TS"
```

期望:两者 ≥ 30 且相等(任何新 server commit 不引入新 error)。

### L. I2 是 doc-only 还是 fix

读 `src/components/onsite-analysis/NewIssueWizard.tsx` 与 `server/modules/onsite-analysis/problem.service.ts`:
- cwd fallback 的实现
- 注释是否清楚

## Output

写 `/Users/xylink/ai/xy-claudecodeui/.superpowers/sdd/reports/batch8-reviewer-report.md`:

- **Verdict**: `READY_TO_RELEASE` / `HOLD_FOR_FIX` / `BLOCKED`
- **Critical issues**(0-3 项)
- **Important issues**(可推到 release-archivist 的标 "defer")
- **Minor**
- **Strengths**
- **11 SC evidence 复现表**(A-L 各项 PASS/FAIL + 真实 grep 输出)
- **Forward to release-archivist**:已完成 artifacts 清单

回 5 行状态摘要。

## 规则

- 独立跑所有 grep + tsc。**不要**信任 implementer 表格。
- 11 SC evidence 不真实 → 标 Important
- 找真 bug → file:line + 复现命令
- 不要写新代码,只 review
- 若发现 implementer fabricated evidence → Critical(违反诚实原则)

Begin now。
