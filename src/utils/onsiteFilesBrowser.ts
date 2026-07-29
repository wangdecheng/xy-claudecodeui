/**
 * Onsite 文件浏览器工具 (ADR 0002)。
 *
 * - listOnsiteTree:拉取 /api/onsite/files/tree?dir=<相对>,懒加载一层。
 * - onsiteDownloadUrl:拼直链下载 URL,token 走 query(<a href> 直跳带不了
 *   Authorization header),与 api.js 的 searchConversationsUrl 同构。
 *   IS_PLATFORM 平台模式不带 token(单用户,无鉴权)。
 *
 * 路径一律相对 ONSITE_ROOT,后端做越界校验。
 */
import { IS_PLATFORM } from '../constants/config';

export type OnsiteTreeNode = {
  name: string;
  type: 'file' | 'dir';
  relativePath: string;
  size?: number;
  mtime?: number;
};

export async function listOnsiteTree(dir = ''): Promise<OnsiteTreeNode[]> {
  const params = new URLSearchParams();
  if (dir) params.set('dir', dir);
  const qs = params.toString();
  const res = await fetch(`/api/onsite/files/tree${qs ? `?${qs}` : ''}`, {
    headers: onsiteAuthHeader(),
  });
  if (!res.ok) throw new Error(`list failed (HTTP ${res.status})`);
  const body = (await res.json()) as { entries?: OnsiteTreeNode[] };
  return body.entries ?? [];
}

/**
 * 直链下载 URL,供 <a href> / window.location 跳转。
 * 浏览器原生下载,大归档不占内存。
 */
export function onsiteDownloadUrl(relativePath: string): string {
  const params = new URLSearchParams({ path: relativePath });
  const token = localStorage.getItem('auth-token');
  if (!IS_PLATFORM && token) params.set('token', token);
  return `/api/onsite/files/download?${params.toString()}`;
}

function onsiteAuthHeader(): Record<string, string> {
  const token = localStorage.getItem('auth-token');
  if (!IS_PLATFORM && token) return { Authorization: `Bearer ${token}` };
  return {};
}
