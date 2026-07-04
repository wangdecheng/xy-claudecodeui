/**
 * CwdLockView — read-only cwd indicator with lock icon and middle-ellipsis
 * truncation for long paths.
 *
 * Format:
 *   🔒 ~/wo.../20260704-山西公安
 *
 * - Always shows the full cwd on hover via the `title` attribute.
 * - Middle truncation: keeps the first ~5 chars and the last segment.
 * - "lock" is purely visual — the actual filesystem permission is set
 *   server-side via ONSITE_ROOT assertCwdUnderRoot.
 */

import { useMemo } from 'react';

import { cn } from '../../lib/utils';

export interface CwdLockViewProps {
  cwd: string;
  className?: string;
}

function shortenCwd(cwd: string, maxLen = 32): string {
  if (!cwd) return '';
  if (cwd.length <= maxLen) return cwd;

  // Split into segments preserving the trailing directory (the
  // problem's date folder, which is what users care about).
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return cwd.slice(0, maxLen - 1) + '…';

  const tail = parts[parts.length - 1] ?? '';
  const head = parts[0] ?? '';
  const middle = parts.slice(1, -1).join('/');
  // Pattern: <head>/<middle prefix>.../<tail>
  const budget = maxLen - head.length - tail.length - 6; // 6 for '/.../'
  if (budget <= 0) return `${head}/.../${tail}`.slice(0, maxLen) + '…';
  const middlePrefix = middle.slice(0, budget);
  return `${head}/${middlePrefix}…/${tail}`;
}

export default function CwdLockView({ cwd, className }: CwdLockViewProps) {
  const display = useMemo(() => shortenCwd(cwd), [cwd]);
  return (
    <div
      data-testid="onsite-cwd-lock"
      title={cwd}
      className={cn(
        'inline-flex items-center gap-1 truncate rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground',
        className,
      )}
    >
      <span aria-hidden="true">🔒</span>
      <span className="truncate">{display}</span>
    </div>
  );
}