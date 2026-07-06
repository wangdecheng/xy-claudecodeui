# Capability: onsite.discipline.softening_warn

> **Type**: ADDED
> **Source**: `customer-onsite-analysis/CLAUDE.md` §「表达纪律(硬约束)」+ proposal §「纪律可视化」

## Purpose

`customer-onsite-analysis/CLAUDE.md` 明确禁止软化词(「可能/也许/大概/或许/似乎/看起来像/应该是」)出现在根因结论中。本能力把这条纪律在 UI 与后端双重落地:UI 高亮 + 后端审计 + 必要时阻断「已证实」标记。

## Requirements

### REQ-9.1 软化词识别

The system MUST maintain a server-side list of softening words (zh-CN + en): `["可能", "也许", "大概", "或许", "似乎", "看起来像", "应该是", "估计是", "maybe", "perhaps", "probably", "might", "could be", "looks like"]`. The list MUST be configurable via `config/discipline-words.json` (default loaded from bundled JSON), and additions are non-breaking.

The system MUST scan every Claude `assistant` message body before forwarding to the client, and annotate each match with `<softening word="X" position="<offset>"/>` inline. The original word MUST remain in the text; annotation is added alongside.

#### Scenario: 软化词被识别并标注

- **GIVEN** Claude 输出:`这个失败可能是上游网络抖动导致的`
- **WHEN** 扫描
- **THEN** 转发给客户端的内容为:`这个失败可能<softening word="可能" position="6"/>是上游网络抖动导致的`
- **AND** 原始「可能」保留

#### Scenario: 英文软化词

- **GIVEN** Claude 输出:`The error might be due to a race condition`
- **WHEN** 扫描
- **THEN** `might` 被 `<softening word="might" position="<offset>"/>` 标注

### REQ-9.2 UI 高亮

The client MUST render `<softening>` tags as **inline amber underline** (color `hsl(38 92% 50%)`, text-decoration: underline wavy). Hovering on a softening tag MUST show a tooltip:
> ⚠️ 软化词:此措辞不构成「已证实」。请确认是否有日志/源码/SQL/接口响应原文支持,或改为「需要 X 才能钉死这一点」+ 具体获取方式。

#### Scenario: 软化词 UI 渲染

- **GIVEN** 收到的消息含 `<softening word="可能" position="6"/>`
- **WHEN** 渲染
- **THEN** 「可能」两字带琥珀色波浪下划线
- **AND** hover 显示上条 tooltip

### REQ-9.3 阻断已证实标记

When a user attempts to mark a Claude root-cause card as `confirmed`, the system MUST:
- Check the card's text for any `<softening>` tag
- If any softening word is present, REFUSE the confirmation with `422 Unprocessable Entity`, body:
```json
{
  "error": "softening_words_present",
  "words": ["可能", "似乎"],
  "hint": "已证实结论不得含软化词,请让 Claude 重写为直接断言或退回到'未证实'阻塞清单"
}
```
- Otherwise, accept the transition per `issue-state` REQ-3.2

#### Scenario: 含软化词时阻断已证实

- **GIVEN** 用户点击根因卡片的「确认为已证实」按钮
- **AND** 卡片文本含「可能是 X」
- **WHEN** 提交
- **THEN** 服务端返回 `422`,body 含 `error: softening_words_present`
- **AND** UI 弹出明确提示,引导用户要么让 Claude 重写,要么退回「未证实」

#### Scenario: 不含软化词时正常通过

- **GIVEN** 根因卡片文本无软化词
- **WHEN** 点击「确认为已证实」
- **THEN** 状态正常转为 `confirmed`,`reason = "用户确认根因"`,写入审计

### REQ-9.4 后端审计

Every detected softening match MUST be logged to `onsite_discipline_log` with `(problem_id, message_id, word, position, at)`. The frontend MUST display in the chat head a small counter: `本会话软化词 N 处`,linked to a list view.

#### Scenario: 审计与计数

- **GIVEN** 一次会话中 Claude 输出了 3 条含软化词的消息
- **WHEN** 处理完成
- **THEN** `onsite_discipline_log` 至少 3 行(每条消息可能多个)
- **AND** 头部「本会话软化词 N 处」计数 = 总命中数
- **AND** 点击计数弹窗显示每条出处
