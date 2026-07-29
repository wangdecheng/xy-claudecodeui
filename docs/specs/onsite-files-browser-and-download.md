---
title: Onsite 文件浏览器与下载修复
type: spec
status: ready-for-agent
created: 2026-07-29
adr: docs/adr/0002-onsite-files-browser-and-storage-invariant.md
---

# Onsite 文件浏览器与下载修复

## Problem Statement

客户现场分析工作台（Onsite Analysis，`/onsite/*`）的文件下载功能对用户不可靠，有两种具体表现：

1. **不出现下载按钮**。结论卡片上的「下载结论」按钮只有在 AI 输出文本恰好包含一个以 `/` 开头、且扩展名属于 `.md/.zip/.tar.gz/.tgz` 的绝对路径时才会渲染。AI 没写绝对路径、路径扩展名不在白名单、或路径被特殊标点包裹时，按钮根本不出现。用户不知道服务器上到底有哪些可下载的文件，只能盲猜路径。

2. **点击没反应**。即使按钮出现，点击后若后端返回 403（路径越界）/ 404（文件不存在），前端拿到非 ok 响应后静默 `return`，没有任何错误提示，用户看到的就是「点了没反应」。

3. **下载端点绑死 problem 且只允许 ONSITE_ROOT 根层直接子文件**。`GET /api/onsite/problems/:id/download?path=<绝对>` 要求路径在 `problem.cwd` 子树内**或**正好在 ONSITE_ROOT 根这一层（不能含路径分隔符），任意深层、且不属于某个 problem 归属的文件无法下载。

## Solution

从用户视角：在 Onsite 左侧问题列表栏顶部新增一个「📁 文件」按钮，点开右侧滑出抽屉，展示 `~/work/customer-onsite-analysis`（ONSITE_ROOT）下的目录树。目录树懒加载——点开一个目录才加载它的下一层子项，默认只列根层。隐藏点号开头的目录/文件（`.claude/`、`.git/` 等不展示）。点击任意一个文件即可用浏览器原生下载保存到本地，大归档也能稳定下载带进度。这样用户不再依赖 AI 在结论里写没写绝对路径，随时能浏览并下载服务器上的真实文件。

同时，结论卡片上已有的「下载结论」按钮在下载失败时给出明确提示（按钮旁短暂显示红色错误文字），不再闷头无反应。

底层约束：所有用户通过本系统上传、打包、下载的文件一律落在 ONSITE_ROOT 子树内。该约束在现有代码中已天然满足，不新增落点逻辑，仅以 ADR 0002 记录为不变量，并以新下载端点的越界测试作机器守护。

## User Stories

1. 作为现场问题排查者，我想在 Onsite 左侧栏看到「文件」按钮，这样我能随时打开文件浏览器而不必先选某个问题。
2. 作为现场问题排查者，我想点开「文件」按钮后看到右侧抽屉列出 ONSITE_ROOT 下所有问题目录，这样我知道服务器上存了哪些客户现场数据。
3. 作为现场问题排查者，我想点击目录树里的某个目录就展开它的下一层子项，这样我不需要一次加载整棵树、响应快。
4. 作为现场问题排查者，我想点击文件就能直接下载，这样大文件也能稳定保存到本地并看到下载进度。
5. 作为现场问题排查者，我想下载文件时文件名保持原始中文/英文名不变，这样下载下来不用重命名。
6. 作为现场问题排查者，我想目录树里每个文件显示大小，这样我能在下载前判断要不要下（有的归档几百 MB）。
7. 作为现场问题排查者，我想目录树里每个文件显示修改时间，这样我能按时间找到最新一批现场日志。
8. 作为现场问题排查者，我想目录树里不显示 `.claude/`、`.git/` 这些干扰项，这样列表只看到真正有用的产物。
9. 作为现场问题排查者，我想下载任意深层的文件（比如某个旧问题里的 `unpacked-2/access.log`），这样不受「只能下根层直接子文件」的限制。
10. 作为现场问题排查者，我想下载不依赖某个问题被选中，这样我能跨问题下载任意文件。
11. 作为现场问题排查者，我想结论卡片的「下载结论」按钮失败时显示错误原因（越界/不存在），这样我知道为什么点不动而不是傻等。
12. 作为现场问题排查者，我想下载错误提示几秒后自动消失、按钮恢复正常，这样不影响后续重试。
13. 作为开发者，我想所有上传/打包/下载路径强制落在 ONSITE_ROOT 子树内，这样用户文件不会散落到本机任意位置。
14. 作为开发者，我想有人试图让下载端点接受 ONSITE_ROOT 外的路径时被测试挡住，这样存储不变量不会被后续改动破坏。
15. 作为开发者，我想复用现有 onsite 路由测试基建（Express app + supertest + auth shim + tmp 目录）测新端点，这样不引入新的测试栈。
16. 作为多语言用户，我想文件浏览器文案支持中英切换，这样与现有 Onsite 组件的国际化一致。
17. 作为现场问题排查者，我想下载链接用浏览器原生 `<a href>` 直跳而不是先在内存里转 blob，这样大归档不会卡死浏览器。
18. 作为现场问题排查者，我想下载链接自动带上登录凭证，这样不用手动配 header 也能通过鉴权。
19. 作为开发者，我想鉴权只到「已登录 + 路径不越界」即可，这样不按 problem owner 隔离（个人工具定位，目录本就是自己的客户数据）。
20. 作为现场问题排查者，我想目录树点文件时用相对路径定位，这样不暴露本机 `/Users/xxx` 绝对路径、根目录迁移也不影响。

## Implementation Decisions

### 新增端点（API 契约）

挂在与 `/problems/:id/...` 平级、`/api/onsite/files/*` 前缀下，继承 mount 点 `authenticateToken`（不新增鉴权层）。

**列目录** `GET /api/onsite/files/tree?dir=<相对路径>`
- `dir` 省略或为空 = 列 ONSITE_ROOT 根层。
- 只返回该层**直接子项**（不递归），懒加载语义。
- 返回项结构：`{ name: string, type: 'file' | 'dir', relativePath: string, size?: number, mtime?: number }`。目录项的 `size`/`mtime` 可省略。
- 隐藏点号开头的项（`name` 以 `.` 开头不返回）。
- `dir` 越界（含 `..`、绝对路径、解析后逃出 ONSITE_ROOT）→ 返回空数组或 403（实现取一致的一种）。
- 目录与文件分别排序后合并（目录在前，各自按名字升序）。

**下载** `GET /api/onsite/files/download?path=<相对路径>&token=<token>`
- `path` 相对 ONSITE_ROOT，后端拼到 `resolveOnsiteRoot()` 下。
- 用 `res.download(absolutePath, basename)` 流式直发，自动设 `Content-Disposition: attachment; filename=<basename>`。
- `token` 走 query 参数，复用 `server/middleware/auth.js` 既有的 `?token=` 回退通道（同前端 `searchConversationsUrl` 先例），因为 `<a href>` 直跳带不了 `Authorization` header。
- 越界 → 403 `FILE_OUTSIDE_ROOT`；不存在 → 404 `FILE_NOT_FOUND`；软链逃逸（`realpath` 解析后落在 ONSITE_ROOT 外）→ 403。

### 路径语义与越界校验

- 一律用**相对路径**（相对 ONSITE_ROOT），不用绝对路径。
- 校验与现有 `/problems/:id/download` 同构：`realpath` 解析符号链接 → `path.relative(onsiteRoot, resolved)` → 判定不以 `..` 开头且非绝对路径。
- `resolveOnsiteRoot()` 复用 `problem.service.ts` 现有实现（`process.env.ONSITE_ROOT ?? ~/work/customer-onsite-analysis`），测试可指向 tmp 目录隔离。

### 鉴权

- 新端点不绑 problem，无法做 problem-owner 隔离，鉴权到「已登录 + 路径不越界」即止。
- 个人 fork、单用户工具定位下可接受；ONSITE_ROOT 本就是用户自己存的客户数据。

### 前端 UI

- `IssueListSidebar` 顶部新增「📁 文件」按钮，与现有「+」新建按钮并列。
- 点击 → 右侧滑出抽屉（不遮挡左侧问题列表；不用居中 Modal，因为目录树纵向展开需要空间）。
- 抽屉内嵌懒加载目录树组件：默认拉根层，点目录展开拉下一层，点文件触发下载。
- 下载用 `<a href="/api/onsite/files/download?path=<相对>&token=<token>">` 直跳，`token` 取自 `localStorage['auth-token']`（与 `searchConsiteUrl` 同构；平台模式 `IS_PLATFORM` 时不带 token）。
- 不引入新路由，不破坏 `/onsite/:problemId` 的 chat 上下文（抽屉是 overlay）。

### 卡片下载按钮修复（保留旧端点）

- `DownloadButton`（cards/CardFoot）保持用旧端点 `/problems/:id/download`（绝对路径 + problem id），**只修静默失败**：
  - 加本地 error state。
  - 失败时按钮旁短暂显示红色错误文字（如「下载失败：文件不存在」），1.5s 后还原。
  - 复刻同文件 `CopyButton` 的「已复制」临时态模式。
- **不改** `conclusionFile()` 正则——「不出现下载按钮」由新文件浏览器兜底。
- 不引入全局 toast 库（项目现有 `LogUploader`/`NewIssueWizard` 均为组件内本地 state 模式）。

### i18n

- 新组件文案走 `t('onsite:files.*')`，给 `src/i18n/locales/en/onsite.json` 和 `src/i18n/locales/zh-CN/onsite.json` 各加一组键（按钮名、抽屉标题、空状态、加载中、错误文案等）。
- 其他语言无 `onsite.json`，回退到 en。

### 存储不变量（约束）

- 所有上传/打包/下载产物一律落 ONSITE_ROOT 子树。现有代码已满足（上传/打包落 `problem.cwd/unpacked-N/`，Claude 归档落 ONSITE_ROOT），不新增落点逻辑。
- 以 ADR 0002 记录为不变量，新下载端点的越界测试（`/files/download` 越界 403）即机器守护。

### 模块改动范围

- **后端路由**（onsite 路由模块）：新增 `/files/tree`、`/files/download` 两个 handler；复用 `resolveOnsiteRoot`。
- **前端**：`IssueListSidebar` 加按钮；新增文件浏览器抽屉组件（目录树 + 下载触发）；`DownloadButton` 加错误态。
- **i18n**：en/zh-CN `onsite.json` 加 `files.*` 键组。

## Testing Decisions

### 什么是好测试

只测**外部 HTTP 行为**，不测内部函数实现。通过 supertest 向 Express app 发请求、断言响应状态码与 body，不直接调用内部函数、不 mock 到函数级。这样实现重构不会让测试脆。

### 唯一测试 seam

复用 `onsite.routes.test.ts` 的 `buildApp()` 模式：Express app + supertest + auth shim 注入假 user + `ONSITE_ROOT` 指向 tmp 目录 + 内存 schema。这是 onsite 路由层既有的测试标准，不引入新 seam、新测试栈。

### 被测模块与用例

后端路由模块的两个新端点：

- `GET /files/tree?dir=`：列根层返回非隐藏项；列子层；隐藏点号开头项不出现；越界 `dir`（含 `..`）返回空或 403。
- `GET /files/download?path=&token=`：下文件 200 + `Content-Disposition: attachment`；深层文件可下；越界 403；不存在 404；软链逃逸 403。

### Prior art

`server/modules/onsite-analysis/tests/onsite.routes.test.ts`：同栈、同 `buildApp()`、同 `ONSITE_ROOT` tmp 隔离、同 auth shim。新测试沿用其 helper 与隔离方式。

### 前端不测

Q17-B 已定：CardFoot 静默失败修复与文件浏览器组件交互不补前端测试，靠手动验证。原因：项目无 React testing 设施，引入不划算，组件逻辑简单可由后端测试兜底安全关键路径。

## Out of Scope

- 不打包目录下载（不引 `archiver` 等流式压缩库，只下单个文件）。
- 不改 `conclusionFile()` 正则、不统一卡片按钮到新端点（两套下载入口并存，各用各端点）。
- 不做 problem-owner 级别的下载隔离。
- 不引入全局 toast 库。
- 不做整棵树一次性返回（坚持懒加载）。
- 不新增前端组件测试。
- 不改动上传/打包的落点逻辑（已满足约束）。
- 不动 `~/work/customer-onsite-analysis/CLAUDE.md` 那套终端守则。

## Further Notes

- 决策依据与权衡详见 `docs/adr/0002-onsite-files-browser-and-storage-invariant.md`（grilling 会话产出）。
- 主文档 `docs/onsite-analysis.md` 已补「文件浏览与下载」节与两条已知限制。
- 现有 `/problems/:id/download` 路由保留不动，作为「绑 problem 的下载入口」与新「文件浏览器」并存。
- `IS_PLATFORM` 平台模式下 `authenticatedFetch` 不带 token（`src/utils/api.js:14`），下载直链在平台模式下走无鉴权路径——平台模式本就单用户，可接受。
