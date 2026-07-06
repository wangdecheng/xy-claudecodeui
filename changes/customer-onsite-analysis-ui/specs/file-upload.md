# Capability: onsite.file.upload

> **Type**: ADDED
> **Source**: proposal §「新建问题工作流」 + 「一包一目录」

## Purpose

新建问题或分析过程中,允许用户上传多个日志/截图/工单文件,服务端并行解压,严格遵守"一包一目录,禁止覆盖"。

## Requirements

### REQ-5.1 多文件并行解压

The system MUST accept multiple file uploads in a single `multipart/form-data` request, and MUST unpack each uploaded archive (`.zip`, `.tar.gz`, `.tgz`) into its **own** subdirectory under the problem root, named `unpacked-<n>` (e.g. `unpacked-1/`, `unpacked-2/`). For non-archive files (`.log`, `.gz`, `.xlsx`, images), the system MUST preserve the original filename at the problem root.

#### Scenario: 三个 zip 并行解压到独立子目录

- **GIVEN** 用户在新建向导中选 3 个 zip:`thirdbridge.log.zip`、`third-adapter.log.zip`、`iauth.log.zip`
- **WHEN** 提交后 `POST /api/onsite/problems/:id/files` 成功
- **THEN** 问题目录下出现 `unpacked-1/`、`unpacked-2/`、`unpacked-3/`
- **AND** 每个子目录里只有对应 zip 的内容,**没有同名覆盖**
- **AND** 服务端响应 body 返回每包的解压统计 `{ file: "...", dir: "unpacked-1", count: 42 }`

#### Scenario: 单个非压缩文件保留原名

- **GIVEN** 用户上传 `iauth.2026-07-01.0.log.gz`
- **WHEN** 上传完成
- **THEN** 问题目录下出现 `iauth.2026-07-01.0.log.gz` 原文件(不解压,gz 原文保留给后续 grep)

### REQ-5.2 单包大小与数量上限

The system MUST reject any single file larger than **200 MB** with `413 Payload Too Large`, and MUST reject any request that contains more than **20** files with `400 Bad Request`.

#### Scenario: 超过 200 MB 单包

- **GIVEN** 用户上传 250 MB 的日志压缩包
- **WHEN** 提交
- **THEN** 返回 `413`,body 含 `file <name> exceeds 200 MB limit`

#### Scenario: 超过 20 个文件

- **GIVEN** 用户一次选 25 个文件
- **WHEN** 提交
- **THEN** 返回 `400`,body 含 `too many files (25 > 20)`

### REQ-5.3 解压失败回滚

The system MUST detect corrupted archives and roll back any partial extraction for that archive. Other successfully extracted archives in the same request MUST NOT be rolled back.

#### Scenario: 第三个 zip 损坏,前两个保留

- **GIVEN** 用户上传 3 个 zip,前两个正常,第三个 CRC 错误
- **WHEN** 服务端处理
- **THEN** `unpacked-1/`、`unpacked-2/` 保留
- **AND** `unpacked-3/` 不存在(或为空)
- **AND** 响应 `207 Multi-Status`,body 含 `unpacked-3: error=<message>`
- **AND** UI 顶部弹 toast「3 个文件中 2 个解压成功,1 个失败」

### REQ-5.4 元数据落库

The system MUST record each successful upload in the `onsite_files` table with fields `(id, problem_id, original_name, stored_path, size, kind, unpacked_dir?, uploaded_at)`.

#### Scenario: 上传元数据落库

- **GIVEN** 上述三 zip 上传完成
- **WHEN** 写入完成
- **THEN** `onsite_files` 新增 3 行
- **AND** 后续 `GET /api/onsite/problems/:id/files` 返回这 3 行
