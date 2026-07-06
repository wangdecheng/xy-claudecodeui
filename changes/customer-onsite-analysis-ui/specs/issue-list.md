# Capability: onsite.issue.list

> **Type**: ADDED
> **Source**: proposal §「问题列表侧栏」

## Purpose

侧栏列出 `~/work/customer-onsite-analysis/` 下所有 `YYYYMMDD-*` 目录对应的问题,显示元数据(客户/状态/迭代/数据库/最后修改时间),供现场排查员快速切换与定位。

## Requirements

### REQ-2.1 扫描与目录名解析

The system MUST scan `~/work/customer-onsite-analysis/` on demand (and once on app start) and return one entry per subdirectory whose name matches `^\d{8}-.+` (e.g. `20260703-山西公安`, `20260703-山西公安_2`). Subdirectories that do not match MUST be ignored (no error).

#### Scenario: 仅匹配 YYYYMMDD 前缀的目录

- **GIVEN** `~/work/customer-onsite-analysis/` 下有 `20260703-山西公安/`、`20260702-renda/`、`docs/`、`README.md`
- **WHEN** `GET /api/onsite/problems`
- **THEN** 返回 2 个问题:`20260703-山西公安`、`20260702-renda`
- **AND** `docs/` 与 `README.md` 不出现在返回中

#### Scenario: 解析日期与客户段

- **GIVEN** 目录名 `20260703-山西公安`
- **WHEN** 解析完成
- **THEN** `date = "20260703"`,`customer = "山西公安"`
- **AND** 列表中显示为 `山西公安 · 20260703`(UI 友好形式)

### REQ-2.2 元数据回填

For each discovered problem directory, the system MUST read `problem.json` to obtain structured metadata. If `problem.json` is missing or malformed, the system MUST still include the entry in the list, defaulting `status` to `pending_info` and `thirdBridgeBranch` to `null`, and MUST emit a `console.warn` on the server.

#### Scenario: 目录存在 problem.json

- **GIVEN** `20260703-山西公安/problem.json` 存在
- **WHEN** 列表返回
- **THEN** 该条目的 `customer`,`thirdBridgeBranch`,`iteration`,`database`,`status` 均与 `problem.json` 一致

#### Scenario: 目录无 problem.json(老式目录兼容)

- **GIVEN** `20260702-renda/` 不含 `problem.json`(旧工作流遗留)
- **WHEN** 列表返回
- **THEN** 该条目 `status = "pending_info"`,`thirdBridgeBranch = null`
- **AND** 服务端 stdout 一条 `warn`,但请求仍 `200 OK`

### REQ-2.3 排序与分组

The system MUST return problems grouped by status in this fixed order: `blocked` → `analyzing` → `pending_info` → `confirmed` (top to bottom). Within each group, problems MUST be sorted by `mtime DESC` (most recently modified first).

#### Scenario: 默认排序

- **GIVEN** 4 个问题分别处于 `analyzing` / `confirmed` / `blocked` / `pending_info`
- **WHEN** 列表返回
- **THEN** 顺序: `blocked` (按 mtime 倒序) → `analyzing` → `pending_info` → `confirmed`

### REQ-2.4 实时刷新

The system MUST watch the problems root directory with `chokidar` and emit a `problems:changed` WebSocket event to all connected onsite clients within 1 second of any add/remove/rename. On receipt, the client MUST refetch `GET /api/onsite/problems` and re-render the sidebar.

#### Scenario: 现场端新建目录,UI 自动出现

- **GIVEN** UI 处于 `/onsite` 页面,WebSocket 已连
- **WHEN** 同一台机器的终端 agent 在 `~/work/customer-onsite-analysis/20260703-foo/` 下了新目录与 `problem.json`
- **THEN** 1 秒内,UI 侧栏顶部多出 `foo · 20260703` 一行
- **AND** 无需用户手动刷新

### REQ-2.5 列表项显示字段

Each list item in the sidebar MUST display: customer name (truncate to 8 chars overflow ellipsis), `YYYYMMDD-客户` (monospace, full), status badge (color-coded), iteration chip, database chip, and `mtime` relative time ("3 min ago"). Clicking MUST set the current problem in the onsite store and switch the main area to the chat stream for that problem.

### REQ-2.6 按业务阶段分组(进行中 / 已归档)

The system MUST group sidebar problems into exactly **two** business-phase buckets (NOT five status groups):
- **进行中 (Active)**: statuses `blocked` / `analyzing` / `pending_info`
- **已归档 (Archived)**: statuses `confirmed` / `abandoned`

The system MUST render a section header `<div class="list-label">进行中 · N</div>` for the active group and `已归档 · M` for the archived group. Problems MUST appear in their phase group's section, sorted by `mtime DESC`. Empty group MUST NOT be rendered (no "0 项" placeholder).

#### Scenario: 默认按业务阶段二分

- **GIVEN** 4 个问题分布在 `analyzing` / `confirmed` / `blocked` / `pending_info` 4 个状态
- **WHEN** 渲染侧栏
- **THEN** 侧栏只有一个 section header「进行中 · 4」,列出全部 4 条
- **AND** **没有**「已归档」section header(因为 M = 0)

#### Scenario: 已证实的问题进入「已归档」组

- **GIVEN** 用户把某问题状态从 `analyzing` 切到 `confirmed`
- **WHEN** 侧栏重渲染
- **THEN** 该问题从「进行中」section 移到「已归档」section
- **AND** 若进行中组变空,该 section header 不再渲染

### REQ-2.7 全宽「新建现场问题」按钮

The system MUST render the new-issue button at the top of the sidebar as a full-width primary button (occupies 100% of sidebar-head width), with text "+ 新建现场问题" and a leading `+` icon. The system MUST NOT render this button as a small icon-only button in the corner.

#### Scenario: 侧栏顶部有全宽新建按钮

- **GIVEN** 用户访问 `/onsite` 路由
- **WHEN** 侧栏渲染
- **THEN** 侧栏顶部第一个交互元素是 `<button class="btn-new">➕ 新建现场问题</button>`
- **AND** 该按钮宽度 = 侧栏宽度(`width: 100%`)
- **AND** 按钮文字含「新建现场问题」完整词组,不被截断成「+」
