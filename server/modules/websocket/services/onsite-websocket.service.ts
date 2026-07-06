/**
 * OnsiteWebSocketService — 挂载 /onsite/ws 路径,验证 hello frame,
 * 标记 ws.kind = 'onsite',并交给 chat-websocket 处理后续消息。
 *
 * Spec:specs/discipline-trace-id.md REQ-8.x + design.md §D-7.1
 *
 * 设计要点:
 *  - /onsite/ws 与 /ws 是**不同 path**,但复用同一个 WebSocketServer 实例
 *    (由 websocket-server.service.ts 在 wss.on('connection', ...) 路由)
 *  - 首帧必须是 { kind: 'onsite', problemId, cwd, userId }
 *  - validateOnsiteHelloFrame 是纯函数,易测
 *  - 验证失败 → ws.close(4001, reason);成功 → 设 ws.kind = 'onsite'
 *    并在 ws 上挂 send 包装(中间件会通过 ctx.enabledFor(ws) === true 判断)
 *  - 后续消息直接复用 chat-websocket 的 chat.send / chat.abort / chat.subscribe
 *    协议,因为 protocol 完全一致(只是来源不同)
 *
 * 注意:Batch 4 中间件(softening / traceId / write-protection)**通过 ctx.enabledFor**
 * 检查 ws.kind === 'onsite',所以 chat 路径不受影响。
 */

import path from 'node:path';
import type { WebSocket, WebSocketServer } from 'ws';

import { assertCwdUnderRoot, resolveOnsiteRoot } from '@/modules/onsite-analysis/problem.service.js';
import { messagesStore, type StoredMessage } from '@/modules/onsite-analysis/messages-store.service.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { onsiteProblemsDb } from '@/modules/database/repositories/onsite-problems.db.js';

import { parseIncomingJsonObject } from '@/shared/utils.js';

export const ONSITE_HELLO_KIND = 'onsite' as const;
export const ONSITE_WS_PATH = '/onsite/ws';

/**
 * Close codes used by the onsite websocket protocol:
 *  - 4001 — hello frame validation failure (kind/problemId/cwd invalid)
 *  - 4002 — protocol error after hello (e.g. unknown message type)
 */
export const ONSITE_WS_CLOSE_CODE_HELLO_FAILED = 4001;

export type OnsiteHelloPayload = {
  problemId: string;
  cwd: string;
  userId: string | null;
};

export type OnsiteHelloValidation =
  | { ok: true; payload: OnsiteHelloPayload }
  | { ok: false; reason: string };

/**
 * 纯函数:校验 hello frame。失败返 `{ ok: false, reason }`,便于中间件透传给客户端。
 *
 * 校验顺序:
 *  1. 必须是 plain object(非 null / 非 array / 非 string 等)
 *  2. frame.kind === 'onsite'
 *  3. frame.problemId 是非空字符串
 *  4. frame.cwd 是绝对或 relative 路径(后者会被拼到 root)
 *     且 assertCwdUnderRoot(cwd, root) 通过
 *  5. frame.userId 可选(string | null),缺失或 null 都接受
 */
export function validateOnsiteHelloFrame(
  frame: unknown,
  root: string = resolveOnsiteRoot()
): OnsiteHelloValidation {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    return { ok: false, reason: 'hello frame must be a JSON object' };
  }

  const obj = frame as Record<string, unknown>;

  if (obj.kind !== ONSITE_HELLO_KIND) {
    return { ok: false, reason: `hello kind must be "${ONSITE_HELLO_KIND}"` };
  }

  if (typeof obj.problemId !== 'string' || obj.problemId.trim().length === 0) {
    return { ok: false, reason: 'problemId must be a non-empty string' };
  }

  if (typeof obj.cwd !== 'string' || obj.cwd.length === 0) {
    return { ok: false, reason: 'cwd must be a non-empty string' };
  }

  const cwd = path.isAbsolute(obj.cwd) ? path.resolve(obj.cwd) : path.resolve(root, obj.cwd);
  try {
    assertCwdUnderRoot(cwd, root);
  } catch {
    return { ok: false, reason: `cwd escapes onsite root (${root})` };
  }

  let userId: string | null = null;
  if (obj.userId !== undefined && obj.userId !== null) {
    if (typeof obj.userId !== 'string') {
      return { ok: false, reason: 'userId must be string | null' };
    }
    userId = obj.userId;
  }

  return {
    ok: true,
    payload: {
      problemId: obj.problemId.trim(),
      cwd,
      userId,
    },
  };
}

type HelloContext = {
  /** problemId validated by hello frame; attached to ws for middleware context. */
  problemId: string;
  /** cwd validated by hello frame. */
  cwd: string;
  /** userId (string | null) from hello frame. */
  userId: string | null;
};

/**
 * 幂等地确保某个 onsite problem 的 session 行存在(kind='onsite')。
 * chat.send 用 sessionId=problemId 查 sessionsDb;缺行则 SESSION_NOT_FOUND。
 * 元数据(branch/iteration/database)从 onsite_problems 表补齐,取不到就留空/NULL
 * (denormalized 副本,不影响 spawn — spawn 只用 project_path/cwd)。全同步,无竞态。
 */
function ensureOnsiteSession(problemId: string, cwd: string): void {
  try {
    // session_id 可能在首次 run 后被 assignProviderSessionId 从
    // problem.id 更新为 UUID。先按 problemId 查,查不到再按 cwd 查。
    let existing = sessionsDb.getSessionById(problemId);
    if (!existing) {
      existing = sessionsDb.findOnsiteSessionByCwd(cwd);
    }
    if (existing) return;
    const rec = onsiteProblemsDb.findById(problemId);
    sessionsDb.createOnsiteSession(problemId, 'claude', cwd, {
      cwd,
      third_bridge_branch: rec?.third_bridge_branch ?? null,
      iteration: rec?.iteration ?? '',
      database: rec?.database ?? '',
    });
  } catch (err: unknown) {
    // 并发/重连下可能已被另一帧创建;不阻断连接,chat.send 会再次校验。
    console.warn(
      '[onsite-ws] ensureOnsiteSession failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * 把 hello 上下文写到 ws 上,供 discipline 中间件在 send 拦截时取用。
 * 注意:这里**不会**自动开启 chat run;后续业务消息由客户端通过 chat.send
 * 触发(以保证 onsite 与 chat 协议完全一致 — 只有首帧验证是 onsite 特有的)。
 *
 * 还会包一层 ws.send:对 ws.kind === 'onsite' 的 outbound envelope,
 * 若 kind ∈ {text, tool_use, tool_result} 且 role ∈ {user, assistant} → 落 messagesStore。
 * 这是 Batch 8 I1 的服务端持久化入口,放在这里确保不污染 chat 路径。
 */
function attachHelloContext(ws: WebSocket, ctx: HelloContext): void {
  // 给 ws 打上 kind 标记 — discipline 中间件的 enabledFor(ws) 据此决定是否挂
  (ws as WebSocket & { kind?: string }).kind = 'onsite';
  (ws as WebSocket & { onsite?: HelloContext }).onsite = ctx;

  const originalSend = ws.send.bind(ws);
  ws.send = ((data: unknown, ...args: unknown[]) => {
    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        const kind = parsed.kind;
        const role = parsed.role;
        if (
          (kind === 'text' || kind === 'tool_use' || kind === 'tool_result') &&
          (role === 'user' || role === 'assistant')
        ) {
          const content = typeof parsed.content === 'string'
            ? parsed.content
            : (typeof parsed.text === 'string' ? parsed.text : '');
          const ts = typeof parsed.ts === 'number' ? parsed.ts : Date.now();
          const stored: StoredMessage = {
            problemId: ctx.problemId,
            role,
            kind: kind as StoredMessage['kind'],
            content,
            ts,
          };
          try {
            messagesStore.append(stored);
          } catch {
            /* ignore — store failure must not break send */
          }
        }
      } catch {
        /* ignore parse failures */
      }
    }
    return originalSend(data as never, ...(args as []));
  }) as WebSocket['send'];
}

/**
 * OnsiteWebSocketService — 单例,负责把 /onsite/ws 路径接入 wss。
 * 测试中通过 attach / detach 控制挂载生命周期。
 */
export const onsiteWebSocketService = {
  /**
   * 注册 hello-frame 验证 handler 到 wss。
   * 注意:**不**接管后续消息处理 — 后续 chat.send / chat.abort 仍由
   * handleChatConnection 处理(因为协议复用)。本服务只做 hello 验证 + 标记 ws.kind。
   */
  attach(wss: WebSocketServer): void {
    wss.on('connection', (ws: WebSocket, request) => {
      const url = request?.url ?? '/';
      const pathname = new URL(url, 'http://localhost').pathname;
      if (pathname !== ONSITE_WS_PATH) {
        return;
      }

      const sendProtocolError = (code: string, error: string): void => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            kind: 'protocol_error',
            code,
            error,
            timestamp: new Date().toISOString(),
          }));
        }
      };

      let helloReceived = false;

      ws.once('message', (raw) => {
        helloReceived = true;
        try {
          const parsed = parseIncomingJsonObject(raw);
          if (!parsed) {
            sendProtocolError('INVALID_JSON', 'hello frame must be valid JSON');
            ws.close(ONSITE_WS_CLOSE_CODE_HELLO_FAILED, 'invalid hello frame');
            return;
          }

          const validation = validateOnsiteHelloFrame(parsed);
          if (!validation.ok) {
            sendProtocolError('HELLO_INVALID', validation.reason);
            ws.close(ONSITE_WS_CLOSE_CODE_HELLO_FAILED, validation.reason);
            return;
          }

          attachHelloContext(ws, {
            problemId: validation.payload.problemId,
            cwd: validation.payload.cwd,
            userId: validation.payload.userId,
          });

          // hello 验证通过后,确保该 problem 对应的 onsite session 行存在。
          // 否则后续 chat.send(sessionId=problemId)会因 SESSION_NOT_FOUND 静默失败
          // (卡片死电路的第三处根因:onsite 会话从未被创建)。同步、幂等。
          ensureOnsiteSession(validation.payload.problemId, validation.payload.cwd);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          sendProtocolError('HELLO_INTERNAL', message);
          ws.close(ONSITE_WS_CLOSE_CODE_HELLO_FAILED, 'hello processing failed');
        }
      });

      // 给客户端一个上界时间,3 秒内没收到合法 hello 就主动 close,
      // 防止恶意客户端占住 connection 却不发 hello。
      const helloTimeout = setTimeout(() => {
        if (!helloReceived && ws.readyState === ws.OPEN) {
          sendProtocolError('HELLO_TIMEOUT', 'hello frame not received within 3s');
          ws.close(ONSITE_WS_CLOSE_CODE_HELLO_FAILED, 'hello timeout');
        }
      }, 3000);
      // 不让 timeout 阻塞进程退出
      helloTimeout.unref?.();
      ws.once('close', () => clearTimeout(helloTimeout));
    });
  },

  /**
   * 测试 escape hatch — 当前实现 attach 不会重复挂载(因为 wss.on('connection') 累加),
   * 但保留接口以便未来扩展。
   */
  detach(): void {
    /* no-op: 复用 wss 的 connection 事件,wss.close 自行清理 */
  },
};