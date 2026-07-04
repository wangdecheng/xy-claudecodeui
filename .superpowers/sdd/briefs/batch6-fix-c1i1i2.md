# Fix Brief — Batch 6 C1 + I1 + I2

## 来源

Reviewer report: `/Users/xylink/ai/xy-claudecodeui/.superpowers/sdd/reports/batch6-reviewer-report.md`

## 必须修(Critical,Batch 7 阻塞)

### C1 — shared/onsite-types.ts 字段命名与 server 真实返回形状不匹配

**问题**:`shared/onsite-types.ts:36-50` 用 camelCase,server `GET /api/onsite/problems` 与 `GET /problems/:id` 用 snake_case(`third_bridge_branch` / `problem_json_path` / `root_cause_text`)。Batch 7 会写 `problem.thirdBridgeBranch` 拿到 `undefined`。

**修复方案**(reviewer 推荐 #1):
改 `shared/onsite-types.ts` 为 snake_case,**严格按 server 返回形态**(wire format 一致,零转换)。

**对照表**(必须改的字段):

| 当前(camelCase,错) | 应改(snake_case,对) |
|---|---|
| `thirdBridgeBranch` | `third_bridge_branch` |
| `problemJsonPath` | `problem_json_path` |
| `rootCauseText` | `root_cause_text` |
| `createdAt` | `created_at` |
| `uploadedAt` | `uploaded_at` |
| `originalName` | `original_name` |
| `storedPath` | `stored_path` |
| `unpackedDir` | `unpacked_dir` |
| `problemId` | `problem_id` |
| `size` | `size` |

**校验源**(实现时务必对得上):
- `server/modules/onsite-analysis/problem.service.ts:226-239` —— `ProblemRecord` 返回
- `server/modules/database/repositories/onsite-problems.db.ts` —— `OnsiteProblemRecord`
- `server/modules/database/repositories/onsite-files.db.ts` —— `OnsiteFileRecord`
- `server/modules/onsite-analysis/onsite.routes.ts:211-223` —— GET problems
- `server/modules/onsite-analysis/onsite.routes.ts:374` —— confirm-root-cause 返回 `{ ...result, root_cause_text }`

修完后**重新跑** client tsc,确认 still exit 0:
```bash
npx tsc --noEmit -p tsconfig.json
```

## 应修(Important,可一起修)

### I1 — `localStorage['auth-user']` 永远没人写

**文件**:`src/contexts/OnsiteWebSocketContext.tsx:268-281`

**问题**:implementer 在 §Q6 已 flag,但没修。`auth-token` 才是 canonical key(`src/components/auth/constants.ts:1` `AUTH_TOKEN_STORAGE_KEY`),用户实际在 `AuthContext` 里。

**修复方案**:
1. **Decode JWT payload** 来拿 userId(jwt body 是 base64url,无签名验证也可信用作展示):

```ts
function readUserIdFromAuthToken(): string | null {
  try {
    const token = localStorage.getItem('auth-token');  // 实际 key
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1];
    // base64url → base64 → atob
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      Array.from(atob(b64)).map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    );
    const parsed = JSON.parse(json);
    return typeof parsed.sub === 'string' ? parsed.sub : (typeof parsed.id === 'string' ? parsed.id : null);
  } catch {
    return null;
  }
}
```

2. 用更宽容的 lookup:`localStorage.getItem('auth-user') ?? localStorage.getItem('user-id')` 或 fallback 到 JWT decode

**只改 `OnsiteWebSocketContext.tsx`,不要动其他文件**。

### I2 — `useProblem` / `useUploadProgress` / `useAnyUploading` 不是真 hook

**文件**:`src/stores/onsiteStore.tsx:253-268`

**问题**:这三个是 `useCallback`,但内部不调用 React hooks、不订阅,只在调用时读 `stateRef.current`。在子组件调用不会触发 re-render。

**修复方案**(reviewer 推荐 a,最小改动):
**重命名**:去掉 `use` 前缀。

```ts
// 改名为 (无 use 前缀)
const getProblem = useCallback((id: string) => { ... }, []);
const getUploadProgress = useCallback((id: string) => { ... }, []);
const getAnyUploading = useCallback(() => { ... }, []);
```

返回类型 `OnsiteStore` 的字段声明一并 rename。

**搜索影响**:
- `onsiteStore.tsx` 内定义处
- 类型导出 `OnsiteStore` 字段
- 当前**未被调用**(Batch 7 才会用)— 可放心改

## 报告约束

- **零 backend 改动** — 这次完全是 frontend/ shared 范畴
- **零 chat-path 文件改动** — git diff 验证 5 个文件零变更
- **TypeScript 编译通过** — `npx tsc --noEmit -p tsconfig.json` 干净
- 写在 `.superpowers/sdd/reports/batch6-fix1-report.md`:Status / Files / Commits / tsc output / 验证清单
- 单个 commit:`fix(onsite): align shared types to snake_case + auth token lookup + selector naming`

## 报告后

回 5 行状态摘要。修复完后 read 自身修改 + 跑 tsc + git diff --stat。
