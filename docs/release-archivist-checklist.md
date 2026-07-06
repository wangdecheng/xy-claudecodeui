# release-archivist-checklist.md

> Batch 10 closure gate · closure 阶段必跑 + 必交附件

release-archivist 在 release-archivist 阶段必须完成以下检查。任何不通过项必须先修,不能跳过。

## 必跑项

### 1. prototype diff 必跑且 0 FAIL

```bash
./scripts/diff-onsite-ui-vs-prototype.sh
```

- **预期**:17 条 checklist 全部 PASS,exit 0
- **失败处理**:任何 FAIL 必须先修(回到 build-executor),不允许跳过
- **产物**:`prototype-diff-report.md`(作为 release notes 附件)

### 2. chat 路径回归必跑且 pass

```bash
./scripts/regression-chat.sh
./scripts/diff-chat-impact.sh
```

- **预期**:regression exit 0 + diff_clean=true(若只动了 onsite 路径)
- **失败处理**:chat 路径退化立即回退到 bug-investigator
- **产物**:`chat-regression-baseline.txt`

### 3. 零硬编码客户/迭代

```bash
./scripts/validate-no-hardcoded-customers.sh
```

- **预期**:exit 0
- **失败处理**:grep 命中即修,不允许 CI 之外的硬编码

### 4. 11 条 Success Criteria + 17 条 Prototype alignment

- 11 条 Success Criteria(`docs/onsite-analysis-acceptance.md`)
- 17 条 Prototype alignment(`tasks.md` §Prototype field alignment checklist,自动覆盖 14 条 + 人工目视 3 条)
- 任何未勾选项一律不准 closure

## 必交附件

- `prototype-diff-report.md` ← Batch 10 新增
- `chat-regression-baseline.txt`
- `docs/onsite-analysis-acceptance.md`(11 + 17 条 closure 清单)
- `docs/release-notes.md`(Batch 9 + 10 摘要)

## 时间点

- closure **之前**:跑 diff 脚本,把 prototype-diff-report.md 提交到仓库
- release notes 生成时:把 prototype-diff-report.md 作为附件链接
- 归档时:确保上述附件都在 `changes/customer-onsite-analysis-ui/` 下

## 与 code-reviewer 的协作

- code-reviewer 必须已 review 并通过(prototype diff 报告作为 reviewer 输入)
- 若 reviewer 提出 prototype 字段遗漏但代码已 ship → 立即开新 batch 修复,不进入 closure

## 历史

- 2026-07-06:首版,Batch 10 引入
