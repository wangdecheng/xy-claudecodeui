### Task 1.1 — 创建配置文件与 schema

- **Create** `config/customer-analysis.json` — 内容已就位(13 customers + 2 iterations),首项 `branch: null`
- **Create** `config/discipline-words.json` — 软化词中英文 15 个左右
- **Create** `config/json-schemas/customer-analysis.schema.json` — JSON schema;首项 branch 必须 null;iterations 必须匹配 `^(release|master)_...`
- **Test 写**:无(纯配置文件)
- **Acceptance**:`cat config/customer-analysis.json | jq .` 成功;`ajv validate -s config/json-schemas/customer-analysis.schema.json -d config/customer-analysis.json` 退出码 0

### Task 1.2 — `ConfigService` 最小骨架 + 单例

- **Create** `server/modules/onsite-analysis/config.service.ts`
  - 导出 `loadConfig(path: string): Promise<ConfigPayload>`
  - 导出 `getConfig(): ConfigPayload`(单例)
  - 内部用 `ajv` + schema 校验;失败抛 `InvalidConfigError`
  - Type:
    ```ts
    type ConfigCustomer = { label: string; branch: string | null };
    type ConfigPayload = {
      status: 'OK' | 'INVALID';
      mtime: string;
      data: { customers: ConfigCustomer[]; iterations: string[] };
      error?: string;
    };
    ```
- **Test 写** `server/modules/onsite-analysis/tests/config.service.test.ts`:
  ```ts
  test('loadConfig 解析正确配置的 13+2', async () => {
    const c = await loadConfig('config/customer-analysis.json');
    expect(c.status).toBe('OK');
    expect(c.data.customers).toHaveLength(13);
    expect(c.data.iterations).toHaveLength(2);
    expect(c.data.customers[0].branch).toBeNull();
  });
  test('loadConfig 缺首项 branch=null 报 INVALID', async () => {
    await expect(loadConfig('tests/fixtures/bad-first-not-null.json'))
      .rejects.toThrow(/customers\[0\]\.branch must be null/);
  });
  ```
- **跑测试** → 失败(`loadConfig` 还不存在)
- **实现**:写最小函数;**跑测试** → 通过
- **Commit**:`feat(onsite): add config schema and ConfigService skeleton`

### Task 1.3 — mtime 监听与热加载

- **Modify** `server/modules/onsite-analysis/config.service.ts`:
  - 加 `watchConfig(path: string): fs.FSWatcher`,挂 `change` 事件
  - 加 `onConfigChange(cb: (cfg: ConfigPayload) => void): () => void`(订阅,返回 unsubscribe)
- **Test 写**:
  ```ts
  test('mtime 变化触发回调且单例被替换', async () => {
    const cb = vi.fn();
    const off = onConfigChange(cb);
    fs.writeFileSync(tmp, JSON.stringify({ customers: [{label:'x', branch:null}], iterations:['master_5.2_3.2'] }));
    await waitFor(() => cb.mock.calls.length > 0);
    expect(getConfig().data.customers[0].label).toBe('x');
    off();
  });
  ```
- **TDD**:先写测试,确认它失败(因为 watchConfig 还没实现),再实现,再通过
- **Commit**:`feat(onsite): ConfigService mtime watch and hot-reload`

### Task 1.4 — 暴露 HTTP API

- **Create** `server/modules/onsite-analysis/onsite.routes.ts`(暂时只装 config 端点)
  - `GET /api/onsite/config` → 返回 `getConfig()`,附 `Cache-Control: no-store`
  - 用现有 `authenticateToken` 中间件(从 `server/middleware/auth.js` 引用)
- **Modify** `server/index.js:212` 之后新增一行:
  ```js
  app.use('/api/onsite', authenticateToken, onsiteRoutes);
  ```
- **Test 写** `tests/config.route.test.ts`:`supertest` 启动 express mini app;GET 返回 `{ status: 'OK', data: {...} }`
- **TDD** + **Commit**:`feat(onsite): GET /api/onsite/config route`

---

## Batch 2:问题目录与数据模型(后端基础)

> **目标**:数据库 schema、迁移、`ProblemService` 写盘/读盘/列表全部就绪。
> **依赖**:Batch 1(需要 schema 来约束 ProblemService 写 problem.json 时不写非法字段)。

