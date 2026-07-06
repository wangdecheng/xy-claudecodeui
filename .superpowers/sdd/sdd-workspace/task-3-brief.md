# Batch 3 Brief — StateMachine + REST routes + Broadcast

> **范围**:`tasks.md § Batch 3`(Tasks 3.1 / 3.2 / 3.3)
> **Spec**:`specs/issue-state.md` REQ-3.1 / 3.2 / 3.3 / 3.4
> **Design**:design.md 「状态机」段
> **依赖**:Batch 2(`ProblemService`,4 个 onsite repos,`sessionsDb.createOnsiteSession`/`findOnsiteSessionByCwd` I-9 fix)
> **Working directory**:`/Users/xylink/ai/xy-claudecodeui`
> **报告**:`.superpowers/sdd/sdd-workspace/task-3-report.md`
> **模式**:SDD,单 implementer 处理 3 子任务,每项 TDD 纪律
> **预计 commits**:3(每个子任务 1 个)

## 既有资产(不要重写)

- `server/modules/onsite-analysis/problem.service.ts`:`problemService.create / list / getById / sanitizeCustomerLabel / CwdEscapeError`(I-6 之后 `updateStatusOnly` 是 repo 的方法,不在 service 里)
- `server/modules/onsite-analysis/config.service.ts`:`getConfig()`,里面有 `customers: { label, branch }[]` 列表
- `server/modules/onsite-analysis/onsiteWatcher.ts`:`startOnsiteWatcher / onWatcherChange(listener) / stopOnsiteWatcher`
- `server/modules/database/repositories/onsite-problems.db.ts`:`onsiteProblemsDb.insert / findById / findByCwd / list / updateStatusOnly(id, status) / updateMtime`
- `server/modules/database/repositories/onsite-state-audit.db.ts`:`onsiteStateAuditDb.append({ problem_id, from_status, to_status, reason, actor_id }) / listByProblemId`
- `server/modules/database/repositories/onsite-files.db.ts`:文件列表查询
- `server/modules/database/repositories/sessions.db.ts`:`createOnsiteSession / findOnsiteSessionByCwd`(I-9 fix)

## Task 3.1 — `StateMachine` 纯函数 + apply

**Create**:`server/modules/onsite-analysis/state-machine.service.ts`

### 类型与常量

```ts
export type ProblemStatus = 'pending_info' | 'analyzing' | 'blocked' | 'confirmed' | 'abandoned';

const ALLOWED: Record<ProblemStatus, ProblemStatus[]> = {
  pending_info: ['analyzing', 'abandoned'],
  analyzing:    ['blocked', 'confirmed', 'pending_info', 'abandoned'],
  blocked:      ['analyzing', 'abandoned'],
  confirmed:    ['analyzing', 'abandoned'],
  abandoned:    [],
};

const MIN_REASON_LENGTH = 8;
```

注:`abandoned` 是终态(`ALLOWED.abandoned = []`),可达自任何非 abandoned 状态。spec REQ-3.2 表里 `* → abandoned` 表示"用户主动归档,仅在最终归档流程中"。实现时保留 `abandoned` 在每条 outgoing 列表里。

### 导出 API

```ts
// Pure function — no DB / IO
export function canTransition(
  from: ProblemStatus,
  to: ProblemStatus
): { ok: true } | { ok: false; allowed: ProblemStatus[] };

// Async — uses DB transaction (updateStatusOnly + audit append + problem.json 同步)
// Throws InvalidStateTransitionError / ReasonTooShortError / ProblemNotFoundError
export async function apply(
  problemId: string,
  to: ProblemStatus,
  reason: string,
  actorId: string | null
): Promise<{ from: ProblemStatus; to: ProblemStatus; at: string }>;
```

### 实现要点

- `canTransition` 是纯函数,无 IO
- `apply` 用 `db.transaction(() => {...})()` 包三个写:`updateStatusOnly` + `onsiteStateAuditDb.append` + 同步 problem.json 的 `status` 字段(读 → 改 → 写,失败抛)
- reason 长度校验:trim 后 >= 8 字符;短了抛 `ReasonTooShortError`
- `ProblemNotFoundError` 当 problemId 不存在
- 校验 from 状态的 currentStatus 从 `onsiteProblemsDb.findById(id)` 读,然后再 canTransition

### Test 写

`server/modules/onsite-analysis/tests/state-machine.test.ts`,至少:

```ts
import { canTransition, apply, ReasonTooShortError, InvalidStateTransitionError, ProblemNotFoundError } from '../state-machine.service.js';

// 纯函数测试 — 7 条合法边
test.each([
  ['pending_info', 'analyzing'],
  ['analyzing',    'blocked'],
  ['analyzing',    'confirmed'],
  ['analyzing',    'pending_info'],
  ['blocked',      'analyzing'],
  ['confirmed',    'analyzing'],
  // 任意非 abandoned → abandoned
  ['pending_info', 'abandoned'],
  ['analyzing',    'abandoned'],
  ['blocked',      'abandoned'],
  ['confirmed',    'abandoned'],
])('合法迁移 %s → %s', (from, to) => {
  const r = canTransition(from as ProblemStatus, to as ProblemStatus);
  assert.equal(r.ok, true);
});

// 7+ 条非法边
test.each([
  ['pending_info', 'blocked'],     // 必须先 analyzing
  ['pending_info', 'confirmed'],   // 必须先 analyzing
  ['abandoned',    'analyzing'],   // 终态不可出
  ['blocked',      'confirmed'],   // 跳级
  ['confirmed',    'pending_info'],// 跳级
  ['pending_info', 'pending_info'],// 自环
  ['analyzing',    'analyzing'],   // 自环
])('非法迁移 %s → %s 返回 allowed 列表', (from, to) => {
  const r = canTransition(from as ProblemStatus, to as ProblemStatus);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(Array.isArray(r.allowed));
});

// apply 行为
test('apply reason 长度 < 8 抛 ReasonTooShortError', async () => {...});
test('apply 不存在的 problemId 抛 ProblemNotFoundError', async () => {...});
test('apply 合法迁移:更新 status + 写 audit 行 + 同步 problem.json', async () => {...});
test('apply 非法迁移抛 InvalidStateTransitionError', async () => {...});
test('apply 在事务中:audit 行与 status 更新原子(故意抛错则两者都回滚)', async () => {...});
```

### Commit

`feat(onsite): state machine with table-driven transitions + transactional apply`

## Task 3.2 — REST 路由

**Modify**:`server/modules/onsite-analysis/onsite.routes.ts`(已有 `/config` 端点)

### 新增 5 个端点

```ts
// GET /api/onsite/problems
// → 200: { problems: ProblemRecord[] } — list() 按状态排序: blocked → analyzing → pending_info → confirmed → abandoned
//   (排序用 SQL CASE WHEN 或 app-side sort)

// POST /api/onsite/problems
// body: { customer, third_bridge_branch?, iteration, database, cwd }
// → 201: { id, status, cwd, ... }
// → 400: 缺 customer/iteration/database/cwd 中任一必给
// → 422: customer label 不在 config.customers 列表(用 sanitizeCustomerLabel 后比对)
// → 409: CwdEscapeError
// 内部:校验通过 → ProblemService.create({ ... })

// GET /api/onsite/problems/:id
// → 200: ProblemRecord
// → 404: ProblemNotFoundError

// PATCH /api/onsite/problems/:id
// body: { status, reason, actor_id? }
// → 200: { from, to, at }
// → 400: 缺 reason 或 < 8 字符(ReasonTooShortError)
// → 404: ProblemNotFoundError
// → 409: InvalidStateTransitionError,body: { from, to, allowed }
// 内部:StateMachine.apply(id, status, reason, actor_id)
// apply 成功后调 broadcast('problem:<id>:state-changed', { from, to, reason, at })

// GET /api/onsite/problems/:id/files
// → 200: { files: OnsiteFileRecord[] } — onsite-files.listByProblemId(id) 或新增 listByProblemId
// → 404: ProblemNotFoundError
```

### Test 写

`server/modules/onsite-analysis/tests/onsite.routes.test.ts`,用 supertest,每个端点至少一个 happy + 一个 error:

```ts
test('GET /api/onsite/problems 返 200 + 数组,按 blocked→analyzing→pending_info→confirmed→abandoned 排序', ...);
test('POST 缺 customer 返 400', ...);
test('POST customer label 不在 config 返 422', ...);
test('POST 合法 body 返 201 + problem.json 落盘 + cwd 在 ONSITE_ROOT 下', ...);
test('POST cwd 越界(/etc)返 409', ...);
test('GET /api/onsite/problems/:id 返 200 + record', ...);
test('GET /api/onsite/problems/:id 不存在返 404', ...);
test('PATCH 缺 reason 返 400', ...);
test('PATCH reason < 8 字符返 400', ...);
test('PATCH 非法状态迁移返 409 + allowed', ...);
test('PATCH 合法迁移返 200 + audit 行落库 + 同步 problem.json', ...);
test('PATCH 成功后 broadcast 触发 state-changed', ...);
test('GET /api/onsite/problems/:id/files 返 200 + file 数组', ...);
test('所有端点需 auth(401)', ...);
```

注:广播触发测试可以 stub `broadcast()` 函数或检查 subscribers Set 长度 + 暂存。

### Commit

`feat(onsite): REST routes for problems + state machine`

## Task 3.3 — Broadcast 通道

**Create**:`server/modules/onsite-analysis/onsite-broadcast.ts`

### API

```ts
type Subscriber = {
  send(event: BroadcastEvent): void;
};

type BroadcastEvent =
  | { type: 'problems:changed' }
  | { type: 'problem:<id>:state-changed'; payload: { id: string; from: ProblemStatus; to: ProblemStatus; reason: string; at: string } };

export const onsiteBroadcast = {
  subscribe(sub: Subscriber): () => void;  // returns unsubscribe
  unsubscribe(sub: Subscriber): void;
  broadcast(event: BroadcastEvent): void;  // broadcasts to all current subscribers
  subscriberCount(): number;                // for tests
};

// Integration: OnsiteWatcher.onWatcherChange → broadcast({ type: 'problems:changed' })
// Patch route success → broadcast({ type: 'problem:<id>:state-changed', payload })
```

### Test 写

`server/modules/onsite-analysis/tests/onsite-broadcast.test.ts`:

```ts
test('subscribe 后 broadcast 收到事件', () => {
  const received: BroadcastEvent[] = [];
  const sub = { send: (e) => received.push(e) };
  const off = onsiteBroadcast.subscribe(sub);
  onsiteBroadcast.broadcast({ type: 'problems:changed' });
  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'problems:changed');
  off();
});

test('unsubscribe 后不再收到', () => {
  const received: BroadcastEvent[] = [];
  const sub = { send: (e) => received.push(e) };
  const off = onsiteBroadcast.subscribe(sub);
  off();
  onsiteBroadcast.broadcast({ type: 'problems:changed' });
  assert.equal(received.length, 0);
});

test('多个 subscriber 都收到', () => {...});
test('subscriber.send 抛错不影响其他 subscriber', () => {...});
test('OnsiteWatcher.onWatcherChange 触发 broadcast', async () => {...});  // 集成测试
test('state-changed 事件 payload 完整', () => {...});
```

### Commit

`feat(onsite): onsite state broadcast channel`

## 完成后必跑

```bash
# 全量 server 测试(应有 158+ 个测试,全部 pass,允许 pre-existing 1 fail)
cd /Users/xylink/ai/xy-claudecodeui && \
node_modules/.bin/tsx --test --tsconfig server/tsconfig.json \
  "server/**/*.test.{ts,js}" "server/*.test.{ts,js}"

# chat 路径零回归(对比 baseline: 157 pass / 1 fail)
bash scripts/regression-chat.sh
```

预期:`tests 165+ pass / 1 fail`(本 batch 至少 +8 测试)

## 报告格式

写到 `.superpowers/sdd/sdd-workspace/task-3-report.md`:

```markdown
# Task 3 Report — StateMachine + REST routes + Broadcast

## Status
[ DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED ]

## Commits
- <hash1> <title1>
- <hash2> <title2>
- <hash3> <title3>

## Test Results
- 全量:<N pass> / <M fail>(基线 157/1,本 batch 预期 +8 测试)
- 新增测试数:<count>

## Implementation Notes

### Task 3.1
- 5 状态定义,7 条合法迁移 + 4 条 → abandoned,共 11 条合法边
- apply() 用 db.transaction 包 updateStatusOnly + audit append + problem.json 同步
- 关键决策:<列出 1-3 个 trade-off>

### Task 3.2
- 5 个端点实现要点
- 排序:用 SQL CASE WHEN blocked→analyzing→pending_info→confirmed→abandoned
- 广播触发:PATCH 成功后调 broadcast

### Task 3.3
- subscribers Set + try/catch per-subscriber
- OnsiteWatcher.onWatcherChange 集成在 server/index.js boot 时一次

## Concerns
(若有)

## Forward Compatibility
Batch 4 (WebSocket + 中间件) 准备:
- StateMachine.apply 接受 actorId=null,系统 actor 可走
- broadcast 已暴露,subscribe 用 ws.send 即可接入

## Next Step
"Ready for reviewer subagent verification"
```

## Hard rules

- TDD:每个子任务先写测试再写代码,RED → GREEN → REFACTOR
- 不要修改 Batch 0/1/2 的代码(除非是 import 调整或路由挂载)
- 不要动 progress.md(由 reviewer 写)
- 不要修改 baseline 文件
- 不要 push(留给最后统一 push)
- 不要带 Co-Authored-By(单作者)
- 中文 commit message

## 当卡住时

- 若 reason >= 8 字符要求与 REQ-3.3 不一致 → 重新读 spec,以 spec 为准
- 若 canTransition 找不到合法边 → 重新读 design.md 第 138 行段,以 design 为准
- 若 apply 事务有 subtle 死锁风险 → 简化:先 updateStatusOnly,再 append audit,接受非原子(标注 concern);完美原子用 db.transaction 包
- 若 broadcast subscribe leak → 已有 unsubscribe 模式,继续

返回完成后,final response 给 3 句:status,commit count,top concern(若有)。