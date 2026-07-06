/**
 * AnalysisFilesRow — 分析头的已上传日志文件行(对齐原型 .files-row)。
 *
 * 读 store 的 getFiles(problemId),每个文件显示:
 *  - original_name
 *  - unpacked_dir 存在 → 「→ <dir> · 已解压」(绿色边),否则显示大小
 * 无文件时不渲染。
 */

import { CheckCircle2, FileArchive } from 'lucide-react';

import type { OnsiteFile } from '@shared/onsite-types';

import { cn } from '../../lib/utils';

export interface AnalysisFilesRowProps {
  files: OnsiteFile[];
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Last path segment of the unpacked dir, e.g. ".../unpacked-1" → "unpacked-1". */
function shortDir(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts.length === 0 ? dir : (parts[parts.length - 1] ?? dir);
}

export default function AnalysisFilesRow({ files }: AnalysisFilesRowProps) {
  if (files.length === 0) return null;

  return (
    <div data-testid="onsite-files-row" className="flex flex-wrap items-center gap-1.5">
      {files.map((f) => {
        const extracted = Boolean(f.unpacked_dir);
        return (
          <span
            key={f.id}
            data-testid="onsite-file-tag"
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[11px]',
              extracted
                ? 'border-green-400/40 bg-green-50 text-green-900 dark:border-green-700/50 dark:bg-green-900/20 dark:text-green-200'
                : 'border-border bg-secondary text-foreground/85',
            )}
            title={f.original_name}
          >
            {extracted ? (
              <CheckCircle2 className="h-3 w-3 flex-shrink-0" />
            ) : (
              <FileArchive className="h-3 w-3 flex-shrink-0" />
            )}
            <span className="max-w-[220px] truncate">{f.original_name}</span>
            {extracted ? (
              <span className="text-muted-foreground">→ {shortDir(f.unpacked_dir as string)}/ · 已解压</span>
            ) : (
              formatSize(f.size) && <span className="text-muted-foreground">{formatSize(f.size)}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}
