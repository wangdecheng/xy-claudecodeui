# Capability: onsite.issue.create

> **Type**: ADDED
> **Source**: proposal §「新建问题工作流」

## Purpose

现场排查员新建一个客户问题,系统强制收齐三项必给信息(客户 / 迭代 / 数据库),自动在 `~/work/customer-onsite-analysis/<YYYYMMDD-客户>/` 下建目录并落 `problem.json` 元数据。

## Requirements

### REQ-1.1 三项必给信息强制采集

The system MUST require the user to provide a non-empty value for **客户(customer)**, **迭代(iteration)** and **数据库类型(database)** before allowing submission. The submit button MUST be disabled until all three fields have a non-empty value, and submission MUST be rejected with `400 Bad Request` if any field is missing.

#### Scenario: 缺任一字段,提交按钮置灰

- **GIVEN** 用户打开新建向导
- **AND** 客户下拉未选(值 = "")
- **WHEN** 任意时刻渲染
- **THEN** 提交按钮为 `disabled` 状态
- **AND** 鼠标 hover 提交按钮时,提示文案为「请补齐: 客户」

#### Scenario: 三项全选后,提交按钮可点

- **GIVEN** 用户已从客户下拉选「山西公安」
- **AND** 迭代下拉选 `release_5.2_3.2_20260327`
- **AND** 数据库下拉选 `MySQL`
- **WHEN** 渲染提交按钮
- **THEN** 按钮为可点击状态
- **AND** 点击后调用 `POST /api/onsite/problems`

### REQ-1.2 客户与迭代下拉由配置文件驱动

The system MUST populate the customer and iteration `<select>` elements exclusively from `config/customer-analysis.json`. The system MUST NOT allow free-text input on either field. There MUST be no `typeahead`/`datalist`/`autocomplete` element wrapping these selects.

#### Scenario: 配置文件存在,下拉 13 客户 2 迭代

- **GIVEN** `config/customer-analysis.json` 存在且包含 13 个 customers、2 个 iterations
- **WHEN** 用户打开新建向导
- **THEN** 客户下拉共 15 个 `<option>`(1 提示 + 13 数据 + 1 提示)
  - 错误:实际为 1 空提示 + 13 数据
  - 修正:**14** 个 `<option>`(1 空提示 + 13 数据项)
- **AND** 迭代下拉共 **3** 个 `<option>`(1 提示 + 2 数据)
- **AND** 客户下拉第 1 项 `label = "不涉及三方对接"`,`value = "-"`,`data-no-third-bridge = "true"`
- **AND** 客户下拉不含「其他」/「手动输入」/空 input 元素

#### Scenario: 配置文件不存在,前端报错并禁用提交

- **GIVEN** `config/customer-analysis.json` 不存在
- **WHEN** 用户打开新建向导
- **THEN** 客户下拉显示「配置加载失败」
- **AND** 迭代下拉显示「配置加载失败」
- **AND** 帮助文案变红显示 `❌ 无法读取 config/customer-analysis.json`
- **AND** 提交按钮永久 disabled(直到问题修复)

### REQ-1.3 目录名与 problem.json 约定

The system MUST create the problem directory at `~/work/customer-onsite-analysis/<YYYYMMDD>-<客户>/` (where `<客户>` is the customer label, with slash-like characters sanitized) and MUST write a `problem.json` file in that directory with shape:
```json
{
  "id": "<uuid v4>",
  "createdAt": "<ISO8601>",
  "customer": "<label>",
  "thirdBridgeBranch": "<branch | null>",
  "iteration": "<value>",
  "database": "<value>",
  "status": "pending_info",
  "cwd": "<absolute path>"
}
```

#### Scenario: 新建成功,目录与 problem.json 创建

- **GIVEN** 用户在 `2026-07-03` 新建问题,选「山西公安」「release_5.2_3.2_20260327」「MySQL」
- **WHEN** 提交后 `POST /api/onsite/problems` 返回 `201 Created`
- **THEN** 服务器在 `~/work/customer-onsite-analysis/20260703-山西公安/` 下创建目录
- **AND** `problem.json` 中 `customer = "山西公安"`,`thirdBridgeBranch = "master_5.2_3.2"`,`status = "pending_info"`,`cwd = "<绝对路径>"`

#### Scenario: 同日同客户重复创建,自动加后缀

- **GIVEN** 20260703-山西公安 目录已存在
- **AND** 用户再次提交「山西公安」
- **WHEN** 创建完成
- **THEN** 新目录名为 `20260703-山西公安_2`(数字后缀按顺序递增)
- **AND** 旧目录不受影响

### REQ-1.4 数据库元数据登记

The system MUST insert a row into the `onsite_problems` table with the same fields as `problem.json` plus `user_id` (the authenticated user from JWT). The DB row is the source of truth for in-app listings; the `problem.json` file is the source of truth for terminal/agent access.

#### Scenario: 写入 onsite_problems 表

- **GIVEN** 用户已登录(JWT 中 `user_id = 42`)
- **WHEN** 新建问题成功
- **THEN** `onsite_problems` 表新增一行,`user_id = 42`,其余字段与 `problem.json` 一致

### REQ-1.5 问题日期字段(date picker)

The system MUST render a `<input type="date">` field inside the new-issue modal, default value `today` (local time), positioned in the same row as the customer select. The system MUST use the selected date as the canonical `YYYYMMDD` prefix of the problem directory name and as the `createdAt` value in `problem.json`. The system MUST reject dates in the future with `400 Bad Request` (operator cannot pre-book a directory for tomorrow's onsite).

#### Scenario: 日期字段默认今日,提交后写入 createdAt

- **GIVEN** 用户在 `2026-07-03` 打开新建向导
- **WHEN** modal 渲染
- **THEN** 日期字段值为 `2026-07-03`(今天)
- **AND** 提交成功后 `problem.json` 中 `createdAt = "2026-07-03..."`(ISO 8601)
- **AND** 目录名为 `20260703-<客户>`(与日期字段一致)

#### Scenario: 选了未来日期,提交被拒

- **GIVEN** 用户把日期字段改成 `2099-01-01`
- **WHEN** 提交
- **THEN** 服务端返回 `400 Bad Request`,`message = "问题日期不能晚于今天"`
- **AND** 客户端在错误区显示该 message
- **AND** 没有任何目录被创建

### REQ-1.6 Modal 副标题(必填信息解释)

The system MUST display a non-empty subtitle inside the new-issue modal head section, with the exact text: 「三项必给信息用于定位服务分支与 SQL 方言，缺任一项将无法开始分析。目录会按 `YYYYMMDD-客户简称` 自动创建。」 The subtitle MUST appear above the form fields and remain visible the entire time the modal is open.

#### Scenario: 打开 modal,副标题可见

- **GIVEN** 用户点击侧栏「+ 新建现场问题」按钮
- **WHEN** modal 渲染
- **THEN** modal 头部下方显示副标题文本(含「三项必给信息用于定位服务分支与 SQL 方言」)
- **AND** 副标题不随用户填字段而消失

### REQ-1.7 dz-note 琥珀色提示(防覆盖)

The system MUST display an amber-bordered notice inside the file dropzone area, with the exact text: 「每个压缩包将解压到独立子目录（pod-1/、pod-2/…），禁止覆盖——避免排查盲区。」 The notice MUST be visible whenever the dropzone is rendered (i.e. before AND after the problem is created).

#### Scenario: dropzone 渲染时,琥珀提示始终可见

- **GIVEN** 用户打开新建向导(尚未提交)
- **WHEN** modal 渲染
- **THEN** 上传区域下方显示琥珀色提示「每个压缩包将解压到独立子目录（pod-1/、pod-2/…），禁止覆盖——避免排查盲区」
- **AND** 提交成功后,modal 仍处于打开状态(上传区继续可见),琥珀提示仍然存在

### REQ-1.8 客户下拉 label 自动追加分支名后缀

The system MUST format each customer `<option>` label by appending `（{branch}）` when (a) the configured label does not already contain a `（` or `(`, AND (b) `label !== branch`. When `branch === null` (the first "不涉及三方对接" option), the system MUST NOT append any suffix. The option's `value` MUST be the branch string (or `-` when null).

#### Scenario: label 自带括号,不重复后缀

- **GIVEN** 配置项 `{ label: "中车长客（zcck）", branch: "zcck" }`
- **WHEN** 渲染客户下拉
- **THEN** 显示文本为 `中车长客（zcck）`(原样,不附加 `（zcck）`)
- **AND** option `value = "zcck"`

#### Scenario: label 是纯中文,自动追加分支后缀

- **GIVEN** 配置项 `{ label: "中石化", branch: "sinopec" }`
- **WHEN** 渲染客户下拉
- **THEN** 显示文本为 `中石化（sinopec）`(自动追加)
- **AND** option `value = "sinopec"`

#### Scenario: 首项「不涉及三方对接」不追加后缀

- **GIVEN** 配置项 `{ label: "不涉及三方对接", branch: null }`
- **WHEN** 渲染客户下拉
- **THEN** 显示文本为 `不涉及三方对接`(原样,不附加任何后缀)
- **AND** option `value = "-"` 且 `data-no-third-bridge = "true"`

### REQ-1.9 客户首项联动头部 third-bridge chip

When the customer dropdown's selected option has `data-no-third-bridge === "true"` (the "不涉及三方对接" item), the system MUST hide the `third-bridge 分支` info-chip in the chat-stream header. When the selected customer changes to a non-first item, the chip MUST reappear. The system MUST NOT require a server round-trip for this toggle.

#### Scenario: 选「不涉及三方对接」,third-bridge chip 隐藏

- **GIVEN** 用户已创建一个 `thirdBridgeBranch = null` 的问题并打开它
- **WHEN** chat-stream 头部渲染
- **THEN** info-chip 行只显示「客户 / 迭代 / 数据库」三个 chip,**没有**「third-bridge 分支」chip

#### Scenario: 切到带分支的客户,third-bridge chip 重新出现

- **GIVEN** 同一问题,用户把 customer select 切到「山西公安」(`branch = "master_5.2_3.2"`)
- **WHEN** chat-stream 头部重渲染
- **THEN** info-chip 行恢复显示「third-bridge 分支: master_5.2_3.2」chip

### REQ-1.10 数据库下拉必须含「其他」项

The system MUST include an `其他` (`value = "other"`) option as the LAST item in the database dropdown. When the user submits with `database = "other"`, the server MUST store `database = null` in `problem.json` / `onsite_problems` and return the problem in `pending_info` state. The system MUST display an inline hint near the database select explaining that "other" defers selection.

#### Scenario: 选「其他」,服务端映射为 null

- **GIVEN** 用户选「其他」
- **AND** 提交 `POST /api/onsite/problems` with `database: "other"`
- **WHEN** 服务端处理
- **THEN** `problem.json` 中 `database = null`
- **AND** `onsite_problems` 表 `database` 列存 `null`
- **AND** 返回的 problem 状态为 `pending_info`

#### Scenario: 选「其他」,显示提示

- **GIVEN** 用户在 database 下拉选了「其他」
- **WHEN** 渲染
- **THEN** database select 下方显示提示「未指定数据库类型，请稍后在现场补充」

### REQ-1.11 Modal 支持 ESC 与遮罩点击关闭

The system MUST close the new-issue modal when the user presses `Escape` key OR clicks on the dimmed overlay backdrop (outside the modal card). The system MUST NOT close when the click target is inside the modal card (form, inputs, footer). On close, all unsaved form state MUST be reset.

#### Scenario: 按 ESC 关闭 modal

- **GIVEN** modal 处于打开状态,客户/迭代/数据库已部分填写
- **WHEN** 用户按 `Escape` 键
- **THEN** modal 立即关闭
- **AND** 下次再打开时,三个字段都是空(状态已重置)

#### Scenario: 点击遮罩关闭 modal

- **GIVEN** modal 处于打开状态
- **WHEN** 用户点击 modal 卡片**外**的遮罩区域
- **THEN** modal 立即关闭

#### Scenario: 点击 modal 卡片**内**不关闭

- **GIVEN** modal 处于打开状态
- **WHEN** 用户点击客户 select、迭代 select、数据库 select、文本输入或按钮(都在 modal 卡片内)
- **THEN** modal 保持打开

### REQ-1.12 问题主标题字段(title)

The system MUST provide an optional `title` text input in the new-issue modal, defaulting to empty. When non-empty, the system MUST store `title` in `problem.json` and `onsite_problems`. The chat-stream header MUST render the title in the format `{customer} · {title}` when title is non-empty, and `{customer} · 现场问题` when empty. Title length MUST be capped at 80 characters on both client and server.

#### Scenario: 填写 title,头部按规范渲染

- **GIVEN** 用户填 title = "第三方登录失败"
- **WHEN** 创建问题并打开 chat 流
- **THEN** 头部标题显示「山西公安 · 第三方登录失败」
- **AND** `problem.json` 含 `title = "第三方登录失败"`

#### Scenario: 不填 title,头部用默认文案

- **GIVEN** 用户未填 title
- **WHEN** 创建并打开 chat 流
- **THEN** 头部标题显示「山西公安 · 现场问题」

#### Scenario: title 超过 80 字符,前端禁用提交

- **GIVEN** 用户在 title 字段输入 81 个字符
- **WHEN** 渲染
- **THEN** 提交按钮 disabled
- **AND** title 字段下方显示红字「标题不能超过 80 字符」

### REQ-1.13 新建+上传一气呵成(no two-stage flow)

The system MUST render the file dropzone area (`LogUploader`) inside the new-issue modal at all times — both BEFORE the problem is created AND AFTER. The system MUST NOT split creation and upload into two separate UI states (e.g. "create first → success toast → then upload"). The system MUST defer the actual `POST /api/onsite/problems` call until the user clicks the submit button; uploads before that point MUST be disabled with the inline message 「请先创建问题再上传文件」. After successful creation, the modal MUST remain open, the dropzone MUST transition to active state, and the user can immediately drag-drop files.

#### Scenario: modal 打开时,dropzone 可见但上传按钮 disabled

- **GIVEN** 用户打开新建向导,尚未填字段
- **WHEN** modal 渲染
- **THEN** dropzone 区域可见
- **AND** 点击/拖拽 dropzone 不会触发任何网络请求(只显示提示「请先创建问题再上传文件」)

#### Scenario: 创建成功后,modal 保持打开,dropzone 可上传

- **GIVEN** 用户填齐三项必给信息后点提交
- **AND** `POST /api/onsite/problems` 返回 201
- **WHEN** modal 重渲染
- **THEN** modal **不**关闭
- **AND** dropzone 变为可点击/可拖拽状态
- **AND** 提交按钮变为 disabled(已创建,不能再提交一次)
- **AND** 琥珀色 dz-note 提示仍然可见
- **AND** 用户拖入 zip 后,`POST /api/onsite/problems/:id/files` 被调用并接受该文件
