# 需求分析：现场问题用户隔离修复

> 分析日期：2026-07-13
> 迭代版本：20260713
> Spec 来源：用户反馈截图、现网 SQLite 数据与仓库代码排查

## 1. 需求本质

现场问题的资源归属必须独立于会变化的 Claude provider session ID；所有现场问题读写入口必须使用服务端认证身份执行对象级鉴权，避免用户看到、读取或修改其他用户的问题。

当前问题链路：

```text
problem.id = 现场问题目录 ID
        ↓ 首次 Claude 对话
sessions.session_id 被改成 provider UUID
        ↓
列表仍以 problem.id 匹配 sessions.session_id
        ↓
匹配失败，被误判为公开“孤儿问题”
        ↓
其他登录用户可见，且 REST 详情接口缺少 owner 校验
```

已确认的现网证据：

- 截图中的两条问题实际均归属于 `user_id=4`，但 session 主键已变为 provider UUID。
- 当前库 16 条现场问题中有 9 条的 `problem.id` 与 `sessions.session_id` 已不相等。
- 当前代码将 `sessions.user_id IS NULL` 和无法通过 session ID 关联的数据视为公开。
- 现场问题详情、消息、附件、上传、状态变更、根因确认和删除接口仅校验登录，未统一校验资源归属。

## 2. 本迭代范围（P0）

| 功能 | 说明 |
|---|---|
| 稳定问题归属 | `onsite_problems` 增加 `owner_user_id`，作为现场问题权限的唯一权威来源 |
| 创建归属 | 新建现场问题时强制使用 `req.user.id` 写入 owner，不接受客户端指定 |
| 列表隔离 | 仅返回 `owner_user_id = 当前用户` 的问题 |
| 对象级鉴权 | 详情、消息、附件、上传、状态修改、根因确认、删除统一校验 owner |
| WebSocket 鉴权 | 使用认证 token 对应的用户校验 `problemId` 和 `cwd`，不信任 hello 帧中的 `userId` |
| 历史数据迁移 | 根据稳定的 `cwd` 关系，从唯一且非空的 `sessions.user_id` 回填 owner |
| 无主数据隔离 | 无法确认 owner 的历史问题默认隐藏，不归给首用户，不视为公开 |
| 越权响应 | 返回 `403 Forbidden`；错误体不得泄露 owner、客户、目录和附件等信息 |
| 敏感操作审计 | 删除、状态修改、根因确认、文件上传记录服务端认证用户 |
| 回归测试 | 覆盖双用户、provider UUID 映射、直接越权、无主数据、迁移幂等和正常回归 |

## 3. 非本迭代（P1/P2）

| 功能 | 优先级 | 说明 |
|---|---|---|
| 管理员查看全部问题 | P1 | 当前没有可靠 RBAC，不提供隐式管理员绕过 |
| 问题转让 | P1 | 后续需定义转让权限、审计与通知 |
| 多人协作/共享 | P1 | 后续可增加 `onsite_problem_members` ACL 表 |
| 多租户隔离 | P2 | 本次只处理用户级资源隔离 |
| 对象存储迁移 | P2 | 继续使用现有本地目录存储 |
| 全局 RBAC 平台 | P2 | 不在本次修复中扩展到其他业务模块 |

## 4. 影响范围

### 要改的

| 模块 | 改动内容 | 改动量 |
|---|---|---|
| `server/modules/database/schema.ts` | 增加 owner 字段和查询索引 | 中 |
| `server/modules/database/migrations.ts` | 新增字段、回填归属、输出未归属清单，保证幂等 | 大 |
| `server/modules/database/repositories/onsite-problems.db.ts` | 增加按 owner 查询、归属查询与 owner 写入 | 中 |
| `server/modules/onsite-analysis/problem.service.ts` | 创建时写 owner；列表按 owner 过滤；移除“孤儿公开”语义 | 大 |
| `server/modules/onsite-analysis/onsite.routes.ts` | 所有 `:id` 接口接入统一归属守卫 | 大 |
| `server/modules/websocket/services/onsite-websocket.service.ts` | 绑定 token 用户并校验 problem/cwd/owner | 大 |
| `shared/onsite-types.ts` | hello 协议移除客户端 `userId` | 小 |
| `src/contexts/OnsiteWebSocketContext.tsx` | 不再向 hello 帧发送本地 userId | 小 |
| 现场问题与数据库测试 | 增加权限矩阵和迁移回归 | 大 |

### 不用改的

- Claude provider UUID 生成、映射和 `--resume` 机制。
- 现场问题本地目录结构及 `problem.json` 格式。
- 前端问题列表布局和交互样式。
- 普通聊天模块已有的 session 隔离逻辑。
- 文件解压实现及单文件、总数量限制。
- 现有 REST 路径。
- 不引入新服务、消息队列或对象存储。

## 5. 架构决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| 权限权威数据 | `onsite_problems.owner_user_id` | owner 生命周期跟问题一致，不跟执行 session 一致 |
| `sessions.user_id` | 仅负责聊天执行层鉴权 | session 主键会因 provider 映射变化，不能作为问题权限关联键 |
| 服务边界 | 继续放在 `onsite-analysis` 模块 | 权限逻辑属于现场问题生命周期，无需拆服务 |
| 历史回填键 | `onsite_problems.cwd = sessions.cwd` | 现网未发现同一 cwd 对应多个 owner；比可变 session ID 稳定 |
| 无主数据 | 隐藏并输出迁移报告 | 不能猜测归属或默认公开 |
| 用户删除 | 不级联删除问题 | 客户日志和审计数据不能随账号删除而丢失 |
| 越权响应 | 403 | 用户已明确接受 403；响应体仍需避免泄露资源详情 |
| WebSocket 身份 | 认证 request 用户 | 客户端 hello 字段可伪造，不能作为授权依据 |
| 未来共享 | 独立 ACL 表 | 本次保持单 owner 模型，避免提前复杂化 |

## 6. 关键约束（非功能性需求）

| 维度 | 要求 |
|---|---|
| 安全性 | 服务端认证身份是唯一身份来源；所有对象入口默认拒绝 |
| 兼容性 | provider session UUID、会话恢复和现有目录不变 |
| 数据完整性 | 迁移不得覆盖已存在 owner；同一 cwd 出现多 owner 时停止自动回填 |
| 幂等性 | 数据库迁移和历史回填可重复执行 |
| 可审计性 | 敏感写操作记录认证用户，不接受请求体 actor 代替认证身份 |
| 隐私 | 403 响应不得携带客户、cwd、owner、文件名或消息摘要 |
| 性能 | `owner_user_id` 建索引，列表查询不扫描全部 session 后在内存过滤 |
| 可运维性 | 启动时报告未归属问题数量和 ID 清单，但不得输出消息正文或文件内容 |

## 7. 验收标准

1. 用户 A 创建的问题，用户 B 的列表中不可见。
2. session ID 变为 provider UUID 后，列表隔离保持不变。
3. 用户 B 即使知道问题 ID，也无法读取详情、消息和附件，接口返回 403。
4. 用户 B 无法上传文件、修改状态、确认根因或删除问题，接口返回 403。
5. WebSocket hello 中伪造或省略 `userId` 均不能改变 token 用户身份。
6. hello 的 `problemId`、`cwd` 不属于同一问题时拒绝连接上下文绑定。
7. owner 为空或无 session 的历史问题对普通用户不可见。
8. 合法 owner 的创建、列表、聊天、恢复、上传、状态修改和删除流程保持可用。
9. 迁移可重复执行，不覆盖已确定 owner；多 owner 冲突不自动选择。
10. 越权响应不返回资源归属和业务内容。

## 8. 待明确事项

| # | 问题 | 影响 | 状态 |
|---|---|---|---|
| 1 | 无 owner 历史问题如何处理 | 自动归属会泄露数据 | 已确认：隐藏并人工处理 |
| 2 | 是否提供管理员查看全部能力 | 需要 RBAC 与审计 | 已确认：不在本迭代 |
| 3 | 用户停用后的数据 | 影响保留与审计 | 已确认：保留但不可访问 |
| 4 | 是否支持转让/协作 | 决定是否引入 ACL | 已确认：不在本迭代 |
| 5 | 越权返回码 | 影响客户端处理和资源探测 | 已确认：返回 403 |
| 6 | 敏感操作审计范围 | 影响追责能力 | 已确认：删除、状态修改、根因确认、上传 |
