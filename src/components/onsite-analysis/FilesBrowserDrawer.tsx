/**
 * FilesBrowserDrawer — ONSITE_ROOT 文件浏览器抽屉 (ADR 0002)。
 *
 * 右侧滑出抽屉(不遮挡左侧问题列表)。懒加载目录树:默认拉根层,点目录
 * 展开拉下一层,点文件用 <a href> 直链下载(浏览器原生下载,大归档不占内存)。
 *
 * 不依赖某个 problem 被选中,鉴权到"已登录 + 路径不越界"。
 * 隐藏点号开头项由后端 tree 端点过滤,前端只渲染返回项。
 */
import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, Download, File as FileIcon, Folder, FolderOpen, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { listOnsiteTree, onsiteDownloadUrl, type OnsiteTreeNode } from '../../utils/onsiteFilesBrowser';

interface DirCache {
  entries: OnsiteTreeNode[];
  loading: boolean;
  error: string | null;
}

function formatSize(bytes?: number): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(ms?: number): string {
  if (ms === undefined) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface FilesBrowserDrawerProps {
  open: boolean;
  onClose: () => void;
}

export default function FilesBrowserDrawer({ open, onClose }: FilesBrowserDrawerProps) {
  const { t } = useTranslation();
  // expandedDirs:当前展开的目录 relativePath 集合(空串 = 根层始终展开)。
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));
  const [cache, setCache] = useState<Record<string, DirCache>>({});

  const loadDir = useCallback(async (dir: string) => {
    setCache((prev) => ({ ...prev, [dir]: { entries: prev[dir]?.entries ?? [], loading: true, error: null } }));
    try {
      const entries = await listOnsiteTree(dir);
      setCache((prev) => ({ ...prev, [dir]: { entries, loading: false, error: null } }));
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      setCache((prev) => ({ ...prev, [dir]: { entries: prev[dir]?.entries ?? [], loading: false, error: message } }));
    }
  }, []);

  // 打开抽屉时拉一次根层(若没缓存)。
  useEffect(() => {
    if (open && !cache['']) void loadDir('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ESC 关闭。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const toggleDir = (dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
    if (!cache[dir]) void loadDir(dir);
  };

  const renderDir = (dir: string, depth: number): React.ReactNode => {
    const state = cache[dir];
    const children = state?.entries ?? [];
    return (
      <div data-testid={`files-dir-${dir || 'root'}`}>
        {children.map((node) => {
          const pad = { paddingLeft: `${depth * 14 + 12}px` };
          if (node.type === 'dir') {
            const open = expanded.has(node.relativePath);
            return (
              <div key={node.relativePath}>
                <button
                  type="button"
                  className="flex w-full items-center gap-1 py-1 pr-2 text-left text-xs hover:bg-muted/60"
                  style={pad}
                  onClick={() => toggleDir(node.relativePath)}
                >
                  <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
                  {open ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-primary" /> : <Folder className="h-3.5 w-3.5 shrink-0 text-primary" />}
                  <span className="truncate">{node.name}</span>
                </button>
                {open && (
                  <div className="border-l border-border/40" style={{ marginLeft: `${depth * 14 + 18}px` }}>
                    {(cache[node.relativePath]?.loading ?? false) && (
                      <div className="px-2 py-1 text-[11px] text-muted-foreground">{t('onsite:files.loading')}</div>
                    )}
                    {cache[node.relativePath]?.error && (
                      <div className="px-2 py-1 text-[11px] text-destructive">{t('onsite:files.loadError')}</div>
                    )}
                    {renderDir(node.relativePath, depth + 1)}
                  </div>
                )}
              </div>
            );
          }
          return (
            <a
              key={node.relativePath}
              href={onsiteDownloadUrl(node.relativePath)}
              download
              className="flex w-full items-center gap-1 py-1 pr-2 text-xs hover:bg-muted/60"
              style={pad}
              title={`${formatDate(node.mtime)}  ${formatSize(node.size)}`}
            >
              <span className="w-3 shrink-0" />
              <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate">{node.name}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">{formatSize(node.size)}</span>
              <Download className="h-3 w-3 shrink-0 text-muted-foreground" />
            </a>
          );
        })}
      </div>
    );
  };

  if (!open) return null;
  const root = cache[''];
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm"
      role="dialog"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="flex h-full w-full max-w-md flex-col border-l border-border bg-card shadow-xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{t('onsite:files.drawerTitle')}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('onsite:common.back')}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto py-1">
          {root?.loading && !root.entries.length && (
            <div className="px-4 py-3 text-xs text-muted-foreground">{t('onsite:files.loading')}</div>
          )}
          {root?.error && (
            <div className="px-4 py-3 text-xs text-destructive">{t('onsite:files.loadError')}</div>
          )}
          {root && !root.loading && !root.error && root.entries.length === 0 && (
            <div className="px-4 py-3 text-xs text-muted-foreground">{t('onsite:files.empty')}</div>
          )}
          {renderDir('', 0)}
        </div>
      </aside>
    </div>
  );
}
