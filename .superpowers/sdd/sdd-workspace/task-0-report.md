# Task 0 Implementer Report — Batch 0 (Task 0.1 + 0.2)

> 状态:DONE_WITH_CONCERNS
> 实现者:Batch 0 implementer
> 日期:2026-07-03

---

## 完成内容

### Task 0.1 — chat 路径回归基线脚本 + CI step

**Create** `scripts/regression-chat.sh`
- `set -euo pipefail`,严格的 bash 写法(POSIX/Bash 3.2 兼容 + 跨平台 `now_ms` 函数适配 GNU date 与 macOS BSD date)
- 支持 `--dry-run` / `-h` / `--help`,未知 flag exit 2
- 必须从仓库根运行(脚本启动即校验)
- 用 `node_modules/.bin/tsx --test --tsconfig server/tsconfig.json "server/**/*.test.{ts,js}" "server/*.test.{ts,js}"` 全跑后端测试
- 解析 TAP 输出得到 pass/fail/总数,计算 elapsed 毫秒,写一行 `<commit_sha> <ISO_date> <pass_count> <fail_count> <elapsed_ms>` 到 `chat-regression-baseline.txt`
- 退出码:Fail > 0 或测试进程非零 → 1;其余 → 0
- `--dry-run` 模式:
  - 若 `chat-regression-baseline.txt` 已存在 → 直接 `cat`(支持重基线协议)
  - 否则打印全部 0 的 dummy 行,不写文件
- README / 用法通过 `--help` 输出

**Create** `scripts/tests/regression-chat.test.ts`
- 5 个 `node:test` 用例:preflight / dry-run 5 字段格式 / `--help` / 未知 flag / dry-run 不写 baseline
- RED → GREEN 完整链路(bash 脚本从无到有)

**Create** `chat-regression-baseline.txt`(已落盘)
```
696fc5a5b0a06c3c8eaa3dd960557bb07bcfd654 2026-07-03T11:23:06Z 78 1 8862
```
含义:78 pass / 1 fail / 8862 ms。

### Task 0.2 — chat 路径影响 diff 工具

**Create** `scripts/diff-chat-impact.sh`
- `set -euo pipefail`,严格 bash
- 接受 `BASE_SHA` / `HEAD_SHA`(env 或位置参数)
- 缺变量 exit 2(清晰报错,使用说明打 stderr)
- 走 `git diff --name-only BASE..HEAD` 找改动文件
- 关键路径列表 4 项(用 bash 数组 + glob):
  - `server/claude-sdk.js`
  - `server/modules/websocket/services/chat-run-registry.service.ts`
  - `server/modules/websocket/services/chat-websocket.service.ts`
  - `server/modules/database/repositories/sessions*.ts`(glob 扩展)
- 命中任何文件 → exit 1 + 列出文件与 `+/-` 行数 + 设计建议
- 全部未改 → exit 0 + 友好提示
- 支持 `GIT_DIFF_AGAINST=WORKTREE`:本地发 PR 前自检,可与未提交改动比较

**Create** `scripts/tests/diff-chat-impact.test.ts`
- 5 个用例:preflight / zero-diff / 真实修改后 exit 1 / 未知 flag / 缺 SHA
- 真实修改用例:在临时分支 commit 一个无关行,跑 baseline..head 比对,然后 **强制 try/finally 还原文件 + 切回 main + 删除分支**

### CI workflow

**Create** `.github/workflows/regression.yml`
- 触发:`pull_request`(分支 main) + `workflow_dispatch`
- 三步流程:
  1. `diff-chat-impact.sh`  → exit 0/1 视为"检测完毕",exit 2 报错
  2. `regression-chat.sh`   → exit 非 0 直接 fail job
  3. `upload-artifact`      → 上传 `chat-regression-baseline.txt` 与运行日志(30 天 retention)
- SHA 获取:`pull_request` 事件读 `github.event.pull_request.base.sha / .head.sha`;`workflow_dispatch` 退化到 `git merge-base origin/main HEAD`
- 权限:`contents: read`,加 job-level 显式声明
- checkout `fetch-depth: 0`(diff BASE..HEAD 需要完整历史)
- 步骤 2 失败时 `::error::` 提示"chat path regression FAILED — 见 log 与 baseline,贴 PR 描述"
- 步骤 1 失败但 exit 1(预期:有人改了 chat 文件)只 `::warning::`

---

## TDD 证据链(RED → GREEN)

### regression-chat

| 阶段 | 命令 | 结果 |
|---|---|---|
| RED(脚本不存在) | `node_modules/.bin/tsx --test --tsconfig server/tsconfig.json scripts/tests/regression-chat.test.ts` | `127 !== 0`(bash 找不到脚本) |
| GREEN(脚本实现后) | 同上 | `tests 5 / pass 5 / fail 0` |

### diff-chat-impact

| 阶段 | 命令 | 结果 |
|---|---|---|
| RED | `node_modules/.bin/tsx --test --tsconfig server/tsconfig.json scripts/tests/diff-chat-impact.test.ts` | `127 !== 1`(脚本不存在) |
| GREEN | 同上 | `tests 5 / pass 5 / fail 0` |

### 全部合并

| 阶段 | 命令 | 结果 |
|---|---|---|
| 10 测试全跑 | `tsx --test scripts/tests/{regression-chat,diff-chat-impact}.test.ts` | `tests 10 / pass 10 / fail 0` |

---

## 真实测试运行结果(Batch 0 baseline 实证)

`scripts/regression-chat.sh` 直接跑出:
- 当前 commit:`696fc5a`
- pass = 78,fail = 1,elapsed ≈ 9 秒
- 失败用例:`server/modules/providers/tests/provider-models.service.test.ts` 的 "provider model cache is persisted across service instances"
- **此失败与 chat 路径无关**(是 providers 的 model cache 测试,出现在 Batch 0 之前的 `main` 上)
- 这是 baseline 的**当前真实状态**;Batch 5.5 跑同样命令,通过 `git diff <(cat baseline) <(cat new-baseline)` 比对前后,只要 pass/fail 数一致就视为无回归

---

## 偏离 brief 的地方

1. **额外提供 `GIT_DIFF_AGAINST=WORKTREE`**:brief 只要求 BASE/HEAD SHA 比对。本地发 PR 前开发者需要自检,工作区可能脏,所以我加了 `WORKTREE` 模式。这不是要求项,但用了不到 10 行代码,价值明确。
2. **CI workflow 步骤 1(diff)失败不阻塞**:brief 文字暗示 "exit 1 提示 reviewer 贴 baseline 对比"。我认为在 CI 里把这条直接当 fail 不合适 — 它本来就是个报告(改 chat 路径不一定是 bug,可能是必要变更),所以 exit 0/1 都视为"检测完毕",只有 exit 2(脚本错)才算 CI 失败。reviewer 实际通过 PR 描述/PR diff 看到警告。如果 reviewer 想要更严格(让 exit 1 直接 fail CI),只需在 yaml 里加一行 `exit 1` → `exit 1`,改起来极轻。这点在实现里写明以备后续调整。
3. **`scripts/regression-chat.sh` 使用 `tsx` 而非裸 `node --test`**:实测发现现有测试用 `@/modules/...` 路径别名,裸 `node --test` 会 `ERR_MODULE_NOT_FOUND`。`tsx` 自带 alias 解析(GitHub Actions runner 是 Linux,装的就是 tsc-alias + tsx 的正常路径)。安装用 `npm ci` 已有 `tsx` 在 devDeps。
4. **`README.md` / 更详细文档暂未撰写**:brief 任务清单 `docs/onsite-analysis.md` 是 Batch 8 范畴,Batch 0 不要求写文档。脚本本身的 `--help` 已覆盖用法。

---

## 后续 / 关注点

1. **pre-existing test failure(progress)**:`provider-models.service.test.ts` 当前在 main 上是失败的。Batch 5.5 的 baseline 比对只要"这次失败的 fail_count 等于上次的 fail_count"就过,**默认情况无回归**;但建议 Batch 8 验收前先修一下这个测试,否则 baseline diff 会一直带着一个 fail。
2. **CI workflow 的 SHA 获取依赖 `pull_request` 事件**:GitHub 在 fork PR 上会把 `pull_request.base.sha` 与 `.head.sha` 都给到(可能是空白填充),`fetch-depth: 0` 也已设置。如果在 fork PR 上仍跑不通,后续可改用 `gh pr view <num> --json baseRefOid,headRefOid` 兜底。
3. **`diff-chat-impact.sh` glob 行数计算**:对 untracked 文件用 `wc -l` 估算(当作"全部新增")。如果该 untracked 文件真的有改动合并进来,后续 commit 后的 diff 才是准确数字。Baseline 报告这种行数仅供 reviewer 体感判断。
4. **`scripts/regression-chat.sh` 在某些 runner 上可能要更长 `timeout-minutes`**:本仓库测试 ≈ 9 秒,15 分钟在 CI runner 上绰绰有余。
5. **`ESLint` 警告**:本仓库 lint 配置默认不扫 `scripts/tests/**`,test 文件被忽略——只是 warning,不是 error。如果后续要把这些测试纳入 lint,需要在 `eslint.config.js` 加 `files: ['scripts/**/*.ts']` 配置块。

---

## Commit

按 brief 要求两个 commit:

```bash
git add scripts/regression-chat.sh scripts/tests/regression-chat.test.ts scripts/diff-chat-impact.sh scripts/tests/diff-chat-impact.test.ts chat-regression-baseline.txt
git commit -m "test(onsite): add chat path regression baseline script + CI gate"

git add .github/workflows/regression.yml
git commit -m "ci(onsite): chat impact diff + regression gate"
```

提交人等控制器拍板(本报告由 implementer 输出,不直接 push)。

---

## Commit SHAs

_(待控制器提交后填入)_
