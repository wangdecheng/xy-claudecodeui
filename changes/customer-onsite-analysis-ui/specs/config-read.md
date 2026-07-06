# Capability: onsite.config.read

> **Type**: ADDED
> **Source**: proposal §「配置文件驱动下拉」

## Purpose

把 `config/customer-analysis.json` 作为客户/迭代下拉选项的**唯一真相源**;UI 不允许手动输入,运行时配置改动 1 秒内反映到前端。

## Requirements

### REQ-6.1 单例配置读取

The system MUST read `config/customer-analysis.json` exactly once at server startup, and MUST re-read the file whenever its `mtime` changes (detected via `fs.watch` or polling at 1-second granularity). The in-memory config MUST be reloaded atomically (no partial reads visible to consumers).

#### Scenario: 启动时一次读

- **GIVEN** 服务端进程启动
- **WHEN** `loadConfig()` 首次调用
- **THEN** 整个 JSON 解析为一个对象并缓存到 `appState.config`
- **AND** 后续 `GET /api/onsite/config` 直接返回该对象,**不再**读盘

#### Scenario: 改文件后 1 秒内重读

- **GIVEN** 服务已启动,`config/customer-analysis.json` 内容是初始 13 客户 2 迭代
- **WHEN** 现场修改 JSON 加了 1 个新客户并保存
- **THEN** `mtime` 变化被服务端检测
- **AND** 1 秒内,`GET /api/onsite/config` 返回 14 个 customers
- **AND** 客户端 1 秒内(下轮轮询或 WS 推送)刷新下拉,显示新增项

### REQ-6.2 配置文件结构与校验

The system MUST validate the loaded config against the following JSON schema; any validation failure MUST mark the config as `INVALID` and cause `/api/onsite/config` to return `500` with a clear error message. Frontend MUST show the error and disable the New Issue wizard until the file is fixed.

```json
{
  "type": "object",
  "required": ["customers", "iterations"],
  "properties": {
    "customers": {
      "type": "array", "minItems": 1,
      "items": {
        "type": "object",
        "required": ["label", "branch"],
        "properties": {
          "label":     { "type": "string", "minLength": 1, "maxLength": 64 },
          "branch":    { "type": ["string", "null"], "pattern": "^[a-zA-Z0-9._-]+$|^null$" }
        }
      }
    },
    "iterations": {
      "type": "array", "minItems": 1,
      "items": { "type": "string", "pattern": "^(release|master)_[a-z0-9.]+_\\d{8}.*$" }
    }
  }
}
```

Additional invariant enforced at load: the FIRST customer's `branch` MUST be `null` (this is the "不涉及三方对接" entry). All other customers MUST have non-null `branch`.

#### Scenario: 配置文件被破坏为非法 JSON

- **GIVEN** JSON 末尾缺 `}`
- **WHEN** 启动或重读
- **THEN** `appState.config.status = "INVALID"`
- **AND** `GET /api/onsite/config` 返回 `500`,body 含 `JSON parse error: ...`
- **AND** 前端 New Issue 向导的客户/迭代下拉显示「配置加载失败」

#### Scenario: 缺少不涉及三方对接首项

- **GIVEN** customers[0].branch = "sinopec"(非 null)
- **WHEN** 启动
- **THEN** 校验失败,`appState.config.status = "INVALID"`
- **AND** 错误信息 `customers[0].branch must be null (the '不涉及三方对接' entry)`

### REQ-6.3 不允许手动输入的硬约束

The system MUST NOT include any free-text input element (HTML `<input type="text">` or `<textarea>`) for `customer` or `iteration` in the New Issue wizard. The system MUST NOT include any "其他" / "手动输入" option in either select. A static lint check MUST enforce this in CI.

#### Scenario: 源码扫描零命中

- **GIVEN** 客户端代码 `src/components/onsite-analysis/NewIssueWizard.tsx`
- **WHEN** 运行 `scripts/validate-no-hardcoded-customers.sh`
- **THEN** 退出码 0
- **AND** 脚本 grep 失败条件:`src/components/onsite-analysis/**` 含 `手动输入` / `其他` / `请输入客户` / `请输入迭代` / `其他(手动输入)`

### REQ-6.4 API 响应形态

`GET /api/onsite/config` MUST return:
```json
{
  "status": "OK",
  "mtime": "2026-07-03T16:00:00.000Z",
  "data": {
    "customers": [{ "label": "...", "branch": "..." | null }, ...],
    "iterations": ["...", ...]
  }
}
```

The response MUST include `Cache-Control: no-store` so clients always revalidate.
