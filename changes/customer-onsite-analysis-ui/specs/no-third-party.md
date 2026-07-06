# Capability: onsite.no_third_party

> **Type**: ADDED
> **Source**: proposal §「不涉及三方对接联动」

## Purpose

当客户下拉选「不涉及三方对接」时,UI 与后端都必须联动,跳过所有 third-bridge 相关逻辑,避免误切分支或误读 third-bridge 服务日志。

## Requirements

### REQ-7.1 UI 联动

When the user selects the customer option whose `label = "不涉及三方对接"`, the system MUST:
- Hide the `third-bridge 分支` info-chip in the chat head
- Hide the `branch: <branch>` line in the New Issue wizard preview
- Add a one-line hint below the customer select: `本问题不涉及三方对接,跳过 third-bridge 切分支`

When any other customer is selected, the third-bridge chip MUST reappear with the actual branch name from the config.

#### Scenario: 切换到「不涉及三方对接」,chip 消失

- **GIVEN** 用户在 New Issue 向导中
- **WHEN** 客户下拉选「不涉及三方对接」
- **THEN** 向导预览的 `branch: master_5.2_3.2` 行消失
- **AND** 下方出现 `本问题不涉及三方对接,跳过 third-bridge 切分支`
- **AND** 提交后 `thirdBridgeBranch` 字段在 `problem.json` 中为 `null`

#### Scenario: 切回有分支客户,chip 复现

- **GIVEN** 之前选了「不涉及三方对接」
- **WHEN** 改成「山西公安」
- **THEN** 预览的 `branch: master_5.2_3.2` 重新出现
- **AND** 提示文字消失

### REQ-7.2 服务端跳过切分支

When the chat workspace spawns Claude, if the problem's `thirdBridgeBranch` is `null`, the system MUST NOT run any `git worktree add` / `git checkout` against the `~/work/projects/third-bridge/` repo for this problem. The Claude `cwd` remains the problem directory only.

#### Scenario: 不涉及三方对接,服务端不切分支

- **GIVEN** 问题的 `problem.json.thirdBridgeBranch = null`
- **WHEN** 用户在 onsite chat 中发首条消息,服务端启动 Claude 子进程
- **THEN** `~/work/projects/third-bridge/` 的 worktree 列表**不变**(没有新增条目)
- **AND** `git -C ~/work/projects/third-bridge status` 没有 switch 分支的迹象
- **AND** Claude 子进程的 `cwd` 仅为问题目录

### REQ-7.3 配置变更不破坏既有"不涉及"问题

If a user later edits `config/customer-analysis.json` and renames or removes the "不涉及三方对接" entry, existing problems whose `thirdBridgeBranch = null` MUST NOT be retroactively changed. Their `problem.json` continues to store `null`, and the chip-hiding behavior in REQ-7.1 MUST fall back to "branch unknown" rather than showing the wrong branch.

#### Scenario: 删掉首项,既有 null 问题仍正常

- **GIVEN** 既有 5 个问题,其中 2 个 `thirdBridgeBranch = null`
- **WHEN** 现场修改 `config/customer-analysis.json`,删除「不涉及三方对接」项
- **THEN** 既有 2 个 `null` 问题的 chip 仍隐藏
- **AND** 其他 3 个问题 chip 仍按各自的 branch 显示
- **AND** `config` API 返回的 customers 数组不含已删除项,但**不触发任何对既往问题 `problem.json` 的写**
