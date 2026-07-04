/**
 * IssueListItem — one row in the issue-list sidebar.
 *
 * Renders:
 *  - customer name + <StatusBadge />
 *  - cwd directory short-name (last segment, e.g. "20260704-山西公安")
 *  - iteration + database chips
 *  - relative time (parsed from cwd's leading date or created_at fallback)
 *
 * Click → selectProblem(id) + navigate to /onsite/:id
 */

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import type { ProblemListItem } from '@shared/onsite-types';

import { cn } from '../../lib/utils';
import { useOnsiteStore } from '../../stores/onsiteStore';
import StatusBadge from './StatusBadge';

export interface IssueListItemProps {
  problem: ProblemListItem;
  active?: boolean;
}

function formatRelative(isoOrUndefined: string | undefined, cwd: string): string {
  // Try created_at first.
  let ts: number | null = null;
  if (isoOrUndefined) {
    const parsed = Date.parse(isoOrUndefined);
    if (Number.isFinite(parsed)) ts = parsed;
  }
  // Fallback: cwd leading YYYYMMDD like "20260704-山西公安".
  if (ts === null) {
    const m = cwd.match(/(20\d{2})(\d{2})(\d{2})/);
    if (m && m[1] && m[2] && m[3]) {
      ts = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    }
  }
  if (ts === null || !Number.isFinite(ts)) return '—';

  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return `${Math.floor(diffSec / 86400)}d`;
}

function cwdShortName(cwd: string): string {
  // Last path segment; "/Users/x/work/20260704-山西公安" → "20260704-山西公安"
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.length === 0 ? cwd : (parts[parts.length - 1] ?? cwd);
}

export default function IssueListItem({ problem, active }: IssueListItemProps) {
  const navigate = useNavigate();
  const selectProblem = useOnsiteStore().selectProblem;
  const relative = useMemo(
    () => formatRelative(problem.created_at, problem.cwd),
    [problem.created_at, problem.cwd],
  );
  const shortName = useMemo(() => cwdShortName(problem.cwd), [problem.cwd]);

  const handleClick = () => {
    selectProblem(problem.id);
    navigate(`/onsite/${encodeURIComponent(problem.id)}`);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      data-testid="onsite-issue-item"
      data-problem-id={problem.id}
      data-active={active ? 'true' : 'false'}
      className={cn(
        'block w-full rounded-md border border-transparent px-3 py-2 text-left transition-colors',
        active
          ? 'border-primary/30 bg-primary/5'
          : 'hover:border-border hover:bg-muted/50',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium text-foreground" title={problem.customer}>
          {problem.customer}
        </span>
        <StatusBadge status={problem.status} />
      </div>
      <div className="mt-1 truncate text-xs text-muted-foreground" title={problem.cwd}>
        📁 {shortName}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <div className="flex gap-1">
          <span className="rounded bg-muted px-1.5 py-0.5">{problem.iteration}</span>
          <span className="rounded bg-muted px-1.5 py-0.5">{problem.database}</span>
        </div>
        <span>{relative}</span>
      </div>
    </button>
  );
}