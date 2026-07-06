# Batch 5 Brief — 接线 + SDK 黑名单 + log-unpack

> **范围**:`tasks.md § Batch 5`(Tasks 5.1 / 5.2 / 5.3 / 5.4 / 5.5)
> **Spec**:`specs/discipline-write-protection.md` REQ-10.1/10.2/10.3 + `specs/discipline-trace-id.md` REQ-8.7
> **Design**:design.md §D-7.1(SDK 黑名单)+ §D-7.2(运行时审计)
> **依赖**:Batch 4(OnsiteWebSocketService + 3 middlewares + chat-run-registry.kind)
> **Working directory**:`/Users/xylink/ai/xy-claudecodeui`
> **报告**:`.superpowers/sdd/sdd-workspace/task-5-report.md`
> **预计 commits**:5 backend + 0 verification(5.5 不 commit 代码)

## ⚠️ Critical:3 个 Batch 4 wiring 必备项(本 batch 必做)

Reviewer 明确指出 Batch 4 有 3 个 wiring 没接,本 batch **必须**完成:

1. **`onsiteWebSocketService.attach(wss)` 接入**:`server/index.js:113` `createWebSocketServer` 后调一行;`websocket-server.service.ts` 路由表加 `/onsite/ws` 分支
2. **Middleware 挂载到 chat-run writer 出站路径**:`chat-session-writer.service.ts` 的 `originalSend` 钩子挂载 3 个 middleware(`discipline-softening`, `discipline-trace-id`, `discipline-write-protection`),使 suspect + main 信号能见真 `tool_result` envelope
3. **写保护运行时审计**:`discipline-write-protection.middleware` 同样挂到 writer 出站路径

不完成这 3 项,Batch 4 的 60 个测试虽过,但 production 上 3 个 middleware 全是 unit-test-only,suspect + main 信号 dead in prod。

## 已有资产

- `server/modules/websocket/services/onsite-websocket.service.ts`:Batch 4 创建,有 `attach(wss)` / `detach()` 入口
- `server/modules/onsite-analysis/discipline/discipline-softening.middleware.ts`:有 `attachToWs(ws, ctx)`,ctx 含 `enabledFor` / `logHit`
- `server/modules/onsite-analysis/discipline/discipline-trace-id.middleware.ts`:有 `attachToWs(ws, ctx)`,ctx 还含 `getTraceId` / `applyBlocked`
- `server/modules/onsite-analysis/discipline/discipline-write-protection.middleware.ts`:有 `attachToWs(ws, ctx)`
- `server/modules/websocket/services/chat-run-registry.service.ts`:`startRun({kind, ...})` + `getRunKind(appSessionId)`
- `server/modules/websocket/services/chat-session-writer.service.ts`:ChatSessionWriter 类,内部有 `originalSend` 钩子位置
- `server/modules/onsite-analysis/onsite.routes.ts`:5 个 REST 端点 + confirm-root-cause(共 6 端点)
- `server/claude-sdk.js:589-594`:已有 `canUseTool` 处理 `isDisallowed` 分支
- `server/modules/websocket/services/websocket-server.service.ts:57-78`:wss 路由表

---

## Sub-task A — 完整接线(server/index.js + writer middleware attach)

### A.1 server/index.js 接线

```js
// 在 createWebSocketServer(server, {...}) 之后:
onsiteWebSocketService.attach(wss);

// 已有 app.use('/api/onsite', authenticateToken, onsiteRoutes) — 确认 5.2 已挂载
// 在 initializeSessionsWatcher() 旁边加:
// startOnsiteWatcher() + onWatcherChange 调 onsiteBroadcast.broadcast(...)
```

### A.2 websocket-server.service.ts 路由表加 `/onsite/ws` 分支

读现有路由表,在 chat ws 路径分支旁加 onsite 分支:
```ts
// 伪代码:
if (req.url === '/onsite/ws') {
  // 委托给 onsiteWebSocketService 已注册的 listener
  return;  // onsite-websocket.service.ts 自己 wss.on('connection', ...) 已注册
}
// 否则走 chat ws 路径
```

**关键**:`OnsiteWebSocketService.attach(wss)` 内部 `wss.on('connection', ...)` 已经注册自己的 handler,所以路由表只需要"识别路径 + 不打 [WARN] Unknown WebSocket path 日志"。

### A.3 3 middlewares 挂到 ChatSessionWriter 出站路径

读 `chat-session-writer.service.ts`,找到 `originalSend` 钩子(写消息给 ws 的位置)。

**方案**:在 `OnsiteWebSocketService.attach` 或 `chat-run-registry.startRun({kind:'onsite'})` 路径里,run 创建后立刻调:

```ts
// 仅对 onsite run 挂载
if (run.kind === 'onsite') {
  const ws = connection.ws;
  
  disciplineSofteningMiddleware.attachToWs(ws, {
    enabledFor: (w) => chatRunRegistry.getRunKind(runAppSessionId) === 'onsite',
    logHit: (entry) => onsiteDisciplineLogDb.append({ ...entry, kind: 'softening' }),
  });
  
  disciplineTraceIdMiddleware.attachToWs(ws, {
    enabledFor: (w) => chatRunRegistry.getRunKind(runAppSessionId) === 'onsite',
    getTraceId: () => loadTraceId(runCwd),  // 从 cwd/.traceId 读
    applyBlocked: (problemId, reason) => StateMachine.apply(problemId, 'blocked', reason, SYSTEM_ACTOR_ID),
    logHit: (entry) => onsiteDisciplineLogDb.append({ ...entry }),
  });
  
  disciplineWriteProtectionMiddleware.attachToWs(ws, {
    enabledFor: (w) => chatRunRegistry.getRunKind(runAppSessionId) === 'onsite',
    logHit: (entry) => onsiteDisciplineLogDb.append({ ...entry }),
  });
}
```

**位置决策**:在 `chat-run-registry.service.ts` 的 `startRun` 末尾加 if (kind==='onsite') 分支,因为 run registry 是 single source of truth。这样后续 ws 切换(reconnect)也由 `attachConnection` 重新挂载。

### Tests(≥ 4 个)

```ts
test('server/index.js 启动后 wss.on connection 注册 onsite handler', ...);
test('/onsite/ws 路径不打印 "Unknown WebSocket path" 警告', ...);
test('startRun({kind:onsite}) 触发 3 middleware 挂载', ...);
test('startRun({kind:chat}) 不挂 3 middleware', ...);
test('attachConnection 重连后 middleware 仍挂载', ...);  // 集成
```

### Commit
`feat(onsite): wire onsite routes + WS + middleware into server index`

---

## Sub-task B — 5.1 Onsite 路径黑名单(disallowedTools 注入)

### 新增 `server/modules/onsite-analysis/discipline/onsite-path-blacklist.service.ts`

```ts
const ONSITE_PROTECTED_GLOBS = [
  '*.log', '*.log.gz', '*.jsonl', 'unpacked-*', 'problem.json', '*.tar.gz', '*.tgz'
];

const WRITE_ACTIONS = ['rm', 'rm -rf', 'tee', 'sed -i', 'awk -i'];  // bash 子动作

/**
 * 把 glob 翻成 SDK disallowedTools 接受的字符串 pattern。
 * 对每个 glob,生成"写动作 + 该 glob"的所有组合 pattern。
 */
export function toDisallowPatterns(globs: string[]): string[] {
  // 实现要点:
  // - '*.log' → ['Bash(rm **/*.log)', 'Bash(> **/*.log)', 'Bash(tee **/*.log)', 'Bash(sed -i **/*.log)',
  //              'Bash(python*open*.log)', 'Bash(python*>*.log)', 'Write(**/*.log)', 'Edit(**/*.log)']
  // - 'unpacked-*' → ['Bash(rm **/unpacked-*)', 'Bash(rm -rf **/unpacked-*)', 'Bash(> **/unpacked-*/**)',
  //                  'Write(**/unpacked-*/**)', 'Edit(**/unpacked-*/**)']
  // - 'problem.json' → ['Write(**/problem.json)', 'Edit(**/problem.json)']
  // - '*.tar.gz' / '*.tgz' → ['Bash(rm **/*.tar.gz)', 'Write(**/*.tar.gz)'] 等
  // - dedupe(防跨 glob 重复 pattern)
}

export const ONSITE_PROTECTED_GLOBS_LIST = ONSITE_PROTECTED_GLOBS;
```

### Modify `onsite-websocket.service.ts`(Batch 4 文件)

在 spawn Claude 之前:
```ts
const patterns = toDisallowPatterns(ONSITE_PROTECTED_GLOBS_LIST);
sdkOptions.disallowedTools = [
  ...(sdkOptions.disallowedTools ?? []),
  ...patterns,
];
```

### Tests(≥ 8 个)

```ts
test('toDisallowPatterns("*.log") 含 Bash rm/>/tee/sed-i/python/Write/Edit 模式', ...);
test('toDisallowPatterns("problem.json") 只含 Write/Edit', ...);
test('toDisallowPatterns 7 类 glob 全覆盖,无重复 pattern', ...);
test('toDisallowPatterns 跨 glob dedupe', ...);
test('Onsite 路径 spawn 时 sdkOptions.disallowedTools 含保护模式', ...);
test('Chat 路径 spawn 不调 toDisallowPatterns', ...);
test('Claude 尝试 Write(problem.json) → canUseTool 拒绝(回放现有 chat 测试)', ...);
test('Claude 尝试 echo x > foo.log → canUseTool 拒绝', ...);
```

### Commit
`feat(onsite): path blacklist via disallowedTools (no SDK change)`

---

## Sub-task C — 5.3 日志解压服务

### 新增 `server/modules/onsite-analysis/log-unpack.service.ts`

```ts
export class PayloadTooLargeError extends Error {
  readonly code = 'PAYLOAD_TOO_LARGE';
  readonly size: number;
  readonly maxSize: number;
}

export class TooManyFilesError extends Error {
  readonly code = 'TOO_MANY_FILES';
  readonly count: number;
  readonly max: number;
}

type UploadedFile = { originalname: string; path: string; size: number };
type UnpackResult =
  | { ok: true; originalName: string; unpackedDir: string; size: number }
  | { ok: false; originalName: string; error: string };

const MAX_SINGLE_SIZE = 200 * 1024 * 1024;  // 200MB
const MAX_TOTAL_FILES = 20;

/**
 * 1 zip → 1 unpacked-N/ 目录。
 * 失败 → 删除对应 unpacked-N/(回滚),返回 { ok: false }。
 * 单包 > 200MB → PayloadTooLargeError(整批失败)
 * 总数 > 20 → TooManyFilesError(整批失败)
 */
export async function unpackMany(
  files: UploadedFile[],
  destDir: string,
): Promise<UnpackResult[]> { ... }
```

**实现**:
- 用 `unzipper` 或 `node:stream/web`(后者更轻)
- 每个 zip 解到 `destDir/unpacked-N/`,N 从 1 起
- 损坏 zip:删 `unpacked-N/` 目录,返回该项 `{ ok: false, error: 'corrupted_zip' }`
- 全部成功返回 207 multi-status with per-file results

### Tests(≥ 4 个)

```ts
test('3 个 zip 并行 → 3 个 unpacked-N 目录,N=1,2,3,无覆盖', ...);
test('单包 250MB 抛 PayloadTooLargeError', ...);
test('第 3 个 zip 损坏 → unpacked-3 不存在 + 该项 ok:false', ...);
test('总数 21 个抛 TooManyFilesError', ...);
test('空文件数组返空数组', ...);
```

### Commit
`feat(onsite): log-unpack service with one-archive-per-dir rule`

---

## Sub-task D — 5.4 文件上传路由

### Modify `onsite.routes.ts`

```ts
// 加 multer 中间件:
import multer from 'multer';
const upload = multer({ dest: 'tmp/uploads/' });

// POST /api/onsite/problems/:id/files
router.post('/:id/files', upload.array('files', 20), async (req, res) => {
  try {
    const problem = problemService.getById(req.params.id);
    if (!problem) return res.status(404).json({ error: 'PROBLEM_NOT_FOUND' });
    
    const files = (req.files as Express.Multer.File[]).map((f) => ({
      originalname: f.originalname,
      path: f.path,
      size: f.size,
    }));
    
    const results = await logUnpackService.unpackMany(files, problem.cwd);
    
    // 落 onsite_files 表(成功的)
    for (const r of results.filter((x) => x.ok)) {
      onsiteFilesDb.insert({
        id: crypto.randomUUID(),
        problem_id: problem.id,
        original_name: r.ok ? r.originalName : '',
        stored_path: r.ok ? `${problem.cwd}/${r.unpackedDir.split('/').pop()}` : '',
        size: r.ok ? r.size : 0,
        kind: 'archive',
        unpacked_dir: r.ok ? r.unpackedDir : null,
      });
    }
    
    res.status(207).json({ results });
  } catch (err) {
    if (err instanceof PayloadTooLargeError) return res.status(413).json({ error: err.code });
    if (err instanceof TooManyFilesError) return res.status(413).json({ error: err.code });
    throw err;
  }
});

// GET /api/onsite/problems/:id/files 已存在,确认/扩展
```

### Tests(≥ 4 个)

```ts
test('上传 3 zip 返 207,3 行入库,3 个 unpacked-N 目录存在', ...);
test('单包 250MB 返 413 + PayloadTooLargeError', ...);
test('第 3 包损坏 返 207,2 行入库,unpacked-3 不存在', ...);
test('GET files 返 200 + file 数组', ...);
```

### Commit
`feat(onsite): file upload routes`

---

## Sub-task E — root_cause_text 列(cleanup minor)

### Migration 加列

`server/modules/database/schema.ts` 加:
```sql
ALTER TABLE onsite_problems ADD COLUMN root_cause_text TEXT;
```

并加 `ONSITE_MIGRATION_STEPS` 新条目(name: `006_add_root_cause_text`, sql: 这条 ALTER)。

### 移除 `updateRootCause` hack

`server/modules/onsite-problems.db.ts` 删 `updateRootCause` 方法(用 `require('node:fs')` 写 problem.json 的版本),改为新方法:
```ts
updateRootCause(id: string, rootCauseText: string): void {
  const db = getConnection();
  db.prepare(`UPDATE onsite_problems SET root_cause_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(rootCauseText, id);
}
```

`onsite.routes.ts:307-313` 调用点更新用新方法。

### Tests(≥ 2 个)

```ts
test('updateRootCause 写 root_cause_text 列', ...);
test('onsite-problems.db.ts 不再 require node:fs', ...);
```

### Commit
`refactor(onsite): replace updateRootCause hack with root_cause_text column`

---

## 验证(Batch 5.5,不 commit 代码)

```bash
# 1. chat 路径零回归
bash scripts/regression-chat.sh
# 对比 baseline:157/1(从 696fc5a 之前)

# 2. diff-chat-impact
./scripts/diff-chat-impact.sh BASE_SHA=6a88025 HEAD_SHA=$(git rev-parse HEAD)
# 期望:chat 关键文件有改动(chat-run-registry 加 kind + sessions 表加列),报告即通过

# 3. E2E 集成测试
# 起服务,跑 chat e2e:开 chat session 发消息,确认与 main 行为一致
# 跑 onsite e2e:新建问题 → 上传 zip → 解压 → 创建 session → Claude spawn
```

deliverable:更新 `docs/onsite-analysis-acceptance.md` 加 "chat 路径回归证据" 段,贴 baseline diff + e2e 日志。

---

## 完成后必跑

```bash
# 全量 server 测试(预期 +15 测试,~283 pass / 2 fail pre-existing)
cd /Users/xylink/ai/xy-claudecodeui && \
node_modules/.bin/tsx --test --tsconfig server/tsconfig.json \
  "server/**/*.test.{ts,js}" "server/*.test.{ts,js}"

# chat 路径零回归
bash scripts/regression-chat.sh
```

## Hard rules

- TDD:每子任务先写测试再写代码
- 不带 Co-Authored-By
- 不动 chat 路径行为(middleware attach 只在 kind=='onsite' 时挂载)
- 不动 progress.md / baseline(5.5 才动 baseline)
- 5 个 commits,每个对应一个子任务
- chat 路径 zero-regression 是 hard gate:任何 chat 行为变化 → 立即修

## 卡住时

- 若 `chat-session-writer.service.ts` 出站路径不明确 → 读它的 `originalSend` 调用,加 middleware 层包装
- 若 multer 集成与现有中间件栈冲突 → 用 `multer.memoryStorage()` + 手动写 tmp 文件
- 若 5 个子任务超 context → 优先做 Sub-task A(wiring 必备),B(5.1 黑名单),5.5 验证;后做 C/D/E

Return when complete。Final response:status, commit count, top concern。