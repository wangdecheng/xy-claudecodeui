import type { RealtimeClientConnection } from '@/shared/types.js';

/**
 * Numeric readyState for an open WebSocket connection.
 *
 * We keep this in module state so services that broadcast updates do not need
 * to import `ws` directly just to compare open/closed state.
 */
export const WS_OPEN_STATE = 1;

/**
 * Shared registry of active chat WebSocket connections.
 *
 * Project/session services publish realtime updates by iterating this set.
 */
export const connectedClients = new Set<RealtimeClientConnection>();

/**
 * 每个 WebSocket 连接对应的用户 ID 映射。
 * userId 为 null 表示未认证连接（平台模式后端未传 userId）。
 * 用于广播过滤和拥有权检查。
 */
export const clientUserMap = new Map<RealtimeClientConnection, number | null>();

/**
 * 注册一个 WebSocket 连接及其用户。
 */
export function addClient(ws: RealtimeClientConnection, userId: number | null): void {
  connectedClients.add(ws);
  clientUserMap.set(ws, userId);
}

/**
 * 注销一个 WebSocket 连接。
 */
export function removeClient(ws: RealtimeClientConnection): void {
  connectedClients.delete(ws);
  clientUserMap.delete(ws);
}

/**
 * 判断某个连接是否可以接收指定归属用户的会话事件。
 * sessionUserId 为 null（公开会话）→ 所有连接都可见；
 * clientUserId 为 null（未认证）→ 不限制（兼容平台模式）；
 * 否则必须匹配。
 */
export function canClientReceiveSession(
  client: RealtimeClientConnection,
  sessionUserId: number | null,
): boolean {
  if (sessionUserId == null) return true;
  const clientUserId = clientUserMap.get(client);
  if (clientUserId == null) return true;
  return clientUserId === sessionUserId;
}
