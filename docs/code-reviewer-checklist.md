# code-reviewer-checklist.md

> Batch 10 closure gate · review 阶段必跑 · 防止 prototype 字段偏差漏检

code-reviewer 在收到 PR diff 后,必须完成以下检查。任何不通过项必须返回 implementer 修复。

## 必跑项

### 1. prototype 对照(强制)

- **打开** `design-prototypes/customer-onsite-analysis/index.html`(原型)
- **打开** PR 实施 UI(本地 `npm run dev` 或 dev 服务器)
- **截图并排对比**:把两者截图作为 PR 评论附件

### 2. prototype-diff 报告 review

- **读** `prototype-diff-report.md`(由 `scripts/diff-onsite-ui-vs-prototype.sh` 产出)
- **预期**:17 条 checklist 全部 PASS
- **手动核对** 3 条人工目视项(整体视觉、新建流程体感、卡片视觉权重)

### 3. 字段级 checklist(对照 tasks.md)

按 `changes/customer-onsite-analysis-ui/tasks.md` §Prototype field alignment checklist 逐条核对:

- ☐ REQ-1.5 日期选择器
- ☐ REQ-1.6 副标题
- ☐ REQ-1.7 dz-note 琥珀提示
- ☐ REQ-1.8 客户下拉分支后缀
- ☐ REQ-1.9 客户首项联动
- ☐ REQ-1.10 数据库「其他」
- ☐ REQ-1.11 ESC + 遮罩关闭
- ☐ REQ-1.12 问题主标题字段
- ☐ REQ-1.13 modal 内上传一气呵成
- ☐ REQ-4.5 消息头像
- ☐ REQ-4.6 msg-role 行
- ☐ REQ-4.7 composer 底部 hint
- ☐ REQ-4.8 composer placeholder
- ☐ REQ-4.10 证据卡片三色高亮
- ☐ REQ-2.6 业务阶段分组
- ☐ REQ-2.7 全宽新建按钮
- ☐ 整体视觉密度(目视)
- ☐ 新建流程体感(录屏 / 截图三连)
- ☐ 卡片视觉权重(🔍/⛔/✅/📋 四色)

### 4. chat 路径零回归

- **跑** `./scripts/diff-chat-impact.sh`(只读不写)
- **预期**:除 Batch 9 允许的例外(`shared/onsite-types.ts` 加 `title?: string` + `problem.service.ts` 接 `title`)外,chat 关键文件 diff 应为空
- **reviewer 必须确认**:PR 描述里说明这些例外改动,以及无 chat 路径污染

### 5. 测试覆盖 review

- 每个新功能 / bug fix 必含 Vitest / node:test 单元测试
- 测试文件命名 `*.test.ts` / `*.test.tsx`
- TDD 纪律:看 git log 是否先有失败的测试 commit 再有实现 commit

## review 输出

reviewer 在 PR 评论里至少贴:

1. prototype + 实施并排截图(1~3 张)
2. prototype-diff 报告节选(关键 PASS 行)
3. 17 条 checklist 勾选状态
4. chat 路径 diff 影响评估
5. 任何 prototype 字段遗漏的具体反馈(文件:行号 + 截图)

## 不通过的处理

- **FAIL 数量 > 0**:返回 implementer,要求重跑 + 修复
- **人工目视项未填**:要求 implementer 补截图 / 录屏
- **chat 路径有非预期改动**:stop-the-line,立即回退到 bug-investigator

## 与 release-archivist 的交接

reviewer 通过后,release-archivist 才会启动。release-archivist 必须把本 checklist 的输出作为 closure 阶段的输入。

## 历史

- 2026-07-06:首版,Batch 10 引入(首轮 ship 后发现 prototype 偏差教训)
