---
title: ONSITE_ROOT 存储不变量与独立文件浏览器
category: onsite
summary: 所有上传/打包/下载产物一律落 ONSITE_ROOT 子树；新增脱离 problem 的文件树浏览+下载端点；卡片下载按钮修静默失败
owner: xy-claudecodeui
last_reviewed: 2026-07-29
---

# ONSITE_ROOT 存储不变量与独立文件浏览器

## 背景

现有下载链路有两个痛点：

1. **下载入口寄生在 AI 输出文本的正则解析上**。`CardRenderer.conclusionFile()` 从 assistant 文本里正则抓"以 `/` 开头的 `.md/.zip/.tar.gz/.tgz` 绝对路径"，抓到才渲染 `<DownloadButton>`。AI 没写绝对路径、扩展名不在白名单、或路径被特殊标点包裹 → 按钮根本不出现（"不出现下载按钮"症状）。
2. **下载失败静默**。`DownloadButton` 走 `fetch → blob → objectURL → anchor.click()`，后端返回 403/404 时 `response.ok` 为 false 即 `return`，无任何提示（"点击没反应"症状）。
3. **下载端点绑死 problem 且只允许 ONSITE_ROOT 根层直接子文件**。`GET /api/onsite/problems/:id/download?path=<abs>` 要求路径在 `problem.cwd` 子树内**或**正好在 ONSITE_ROOT 根这一层（`!relativeToOnsiteRoot.includes(path.sep)`），任意深层非 problem 归属文件无法下载。

## 决策

### 1. 存储不变量（约束）

**所有用户通过本系统上传、打包、下载的文件，一律落在 `~/work/customer-onsite-analysis`（`ONSITE_ROOT`）子树内。**

查证结论：该约束在现有代码中**已天然满足**——

- **上传**：Multer `diskStorage` 临时文件落 `os.tmpdir()`（中途态，成功后 `cleanupUploadedFiles` 删除），解压产物落 `<problem.cwd>/unpacked-N/`，在 ONSITE_ROOT 下。
- **打包（解压）**：`unpackMany` 的 `destDir = problem.cwd`，在 ONSITE_ROOT 下；Claude Code 生成的结论归档也写在 ONSITE_ROOT 下。
- **下载**：只读，不产生文件。

故本约束不在代码层新增落点逻辑，仅以本 ADR 记录为**不变量**，并以 Q17 的越界测试（`/files/download` 越界返回 403）作为机器守护：任何让下载能越界 ONSITE_ROOT 的改动都会让该测试红。

`resolveOnsiteRoot()`（`problem.service.ts`）允许 `ONSITE_ROOT` 环境变量覆盖根路径，测试用此指向 tmp 目录隔离。

### 2. 新增独立文件浏览器 + 下载端点（脱离 problem）

新增两个端点，挂在与 `/problems/:id/...` 平级、`/api/onsite/files/*` 前缀下，继承 mount 点 `authenticateToken`：

- `GET /api/onsite/files/tree?dir=<相对路径>` —— 懒加载，只列该层直接子项。返回 `[{ name, type: 'file'|'dir', relativePath, size?, mtime? }]`。隐藏点号开头项（`.claude/`、`.git/` 等会话 JSONL 所在目录）。`dir` 省略 = 列 ONSITE_ROOT 根层。
- `GET /api/onsite/files/download?path=<相对路径>&token=<token>` —— 后端 `res.download` 流式直发，设 `Content-Disposition: attachment`。前端用 `<a href>` 直跳，浏览器原生下载（有进度、不占内存）。`token` 走 query 参数，复用 `server/middleware/auth.js` 既有的 `?token=` 回退通道（同 `searchConversationsUrl` 先例）。

**路径语义用相对路径**（相对 ONSITE_ROOT），不用绝对路径。越界校验与现有 `/problems/:id/download` 同构：`realpath` 解析符号链接 + `path.relative` 判定不以 `..` 开头且非绝对路径；软链逃逸下载时返回 403。

**鉴权放宽**：新端点不绑 problem，无法做 problem-owner 隔离，鉴权到"已登录 + 路径不越界"即止。个人 fork、单用户工具定位下可接受。

### 3. UI：侧栏顶部按钮 + 右侧抽屉

`IssueListSidebar` 顶部加「📁 文件」按钮，点开右侧滑出抽屉（不遮挡左侧问题列表），内嵌懒加载目录树。点文件即下载。不引入新路由，不破坏 `/onsite/:problemId` 的 chat 上下文。

### 4. 卡片下载按钮修静默失败（保留旧端点）

`DownloadButton`（`src/components/onsite-analysis/cards/CardFoot.tsx`）保持用旧端点 `/problems/:id/download`（绝对路径 + problem id），**只修静默失败**：加本地 error state，失败时按钮旁短暂显示红色错误文字（复刻同文件 `CopyButton` 的"已复制"临时态模式），1.5s 后还原。**不**改 `conclusionFile` 正则——"不出现下载按钮"由新文件浏览器兜底（用户可自行去树里找文件下，不依赖 AI 写没写绝对路径）。不引入全局 toast 库（项目现有 `LogUploader`/`NewIssueWizard` 均为组件内本地 state 模式）。

### 5. i18n

新组件文案走 `t('onsite:files.*')`，给 `src/i18n/locales/en/onsite.json` 和 `src/i18n/locales/zh-CN/onsite.json` 各加一组键。其他语言无 `onsite.json`，回退到 en。

### 6. 测试

只测后端安全关键路径：`/files/tree`（列根层、列子层、隐藏点号项、越界 dir）+ `/files/download`（下文件、深层文件、越界 403、不存在 404、软链逃逸 403）。前端不补测。用 `node:test` + `supertest` + auth shim + `ONSITE_ROOT` 指向 tmp 目录，与 `onsite.routes.test.ts` 同栈。

## 不在范围

- 不打包目录下载（不引 `archiver`，只下单个文件）。
- 不改 `conclusionFile` 正则、不统一卡片按钮到新端点。
- 不做 problem-owner 级别的下载隔离。
- 不引入全局 toast 库。
