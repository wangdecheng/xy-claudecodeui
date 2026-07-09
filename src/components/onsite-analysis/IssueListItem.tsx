/**
 * IssueListItem — one row in the issue-list sidebar.
 *
 * Renders:
 *  - 问题描述(description)截断 20 字 + 省略号,鼠标悬浮展示完整(原始全量在 title 属性里)
 *  - cwd directory short-name (last segment, e.g. "20260704-山西公安")
 *  - customer / iteration / database chips
 *  - relative time (parsed from cwd's leading date or created_at fallback)
 *
 * 设计动机:首项客户「其他问题」(原"不涉及三方对接")会反复出现,若以 customer
 * 作为标题会出现一长列重复标题,看不出每条在排查什么。改用必填的 description
 * 作为主标题后,每条天然不同,搜索框也同步扩展到 description 字段。
 *
 * Click → selectProblem(id) + navigate to /onsite/:id
 */

import { useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ProblemListItem } from '@shared/onsite-types';

import { cn } from '../../lib/utils';
import { useOnsiteStore } from '../../stores/onsiteStore';

export interface IssueListItemProps {
  problem: ProblemListItem;
  active?: boolean;
}

const DESCRIPTION_PREVIEW_MAX = 20;

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

/**
 * 列表标题:description 截断到 DESCRIPTION_PREVIEW_MAX 字,超长加省略号。
 * 完整内容走 title 属性,鼠标悬浮展示。若 description 为空(旧数据/异常),
 * 回退到 customer,保证至少有一段可识别文本。
 */
function buildTitleText(problem: ProblemListItem): { text: string; title: string } {
  const raw = (problem.description ?? '').trim();
  if (raw.length === 0) {
    return { text: problem.customer || '(无描述)', title: '' };
  }
  const truncated = raw.length > DESCRIPTION_PREVIEW_MAX;
  return {
    text: truncated ? `${raw.slice(0, DESCRIPTION_PREVIEW_MAX)}…` : raw,
    title: raw,
  };
}

export default function IssueListItem({ problem, active }: IssueListItemProps) {
  const { t } = useTranslation(['onsite', 'common']);
  const navigate = useNavigate();
  const { selectProblem, deleteProblem, currentProblemId } = useOnsiteStore();
  const [deleting, setDeleting] = useState(false);
  const relative = useMemo(
    () => formatRelative(problem.created_at, problem.cwd),
    [problem.created_at, problem.cwd],
  );
  const shortName = useMemo(() => cwdShortName(problem.cwd), [problem.cwd]);
  const { text: titleText, title: titleAttr } = useMemo(
    () => buildTitleText(problem),
    [problem],
  );

  const handleClick = () => {
    selectProblem(problem.id);
    navigate(`/onsite/${encodeURIComponent(problem.id)}`);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  };

  // 删除:stopPropagation 不触发导航 -> window.confirm 二次确认 -> deleteProblem
  // -> 若删的是当前路由的 problem,导航回 /onsite(无选中态)
  const handleDelete = async (e: MouseEvent) => {
    e.stopPropagation();
    if (deleting) return;
    const wasCurrent = problem.id === currentProblemId;
    const ok = window.confirm(
      t('onsite:delete.confirm', {
        defaultValue: '删除该分析历史？将一并移除磁盘日志与数据库记录，不可恢复。',
      }),
    );
    if (!ok) return;
    setDeleting(true);
    const success = await deleteProblem(problem.id);
    setDeleting(false);
    if (success && wasCurrent) {
      navigate('/onsite');
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      data-testid="onsite-issue-item"
      data-problem-id={problem.id}
      data-active={active ? 'true' : 'false'}
      className={cn(
        'group relative block w-full cursor-pointer rounded-md border border-transparent px-3 py-2 text-left transition-colors',
        active
          ? 'border-primary/30 bg-primary/5'
          : 'hover:border-border hover:bg-muted/50',
      )}
    >
      <button
        type="button"
        onClick={handleDelete}
        disabled={deleting}
        data-testid="onsite-issue-delete"
        aria-label={t('onsite:delete.button', { defaultValue: '删除' })}
        title={t('onsite:delete.button', { defaultValue: '删除' })}
        className="absolute right-1 top-1 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus:opacity-100 group-hover:opacity-100 focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      <div className="flex items-center justify-between gap-2 pr-5">
        <span className="truncate text-sm font-medium text-foreground" title={titleAttr || undefined}>
          {titleText}
        </span>
      </div>
      <div className="mt-1 truncate text-xs text-muted-foreground" title={problem.cwd}>
        📁 {shortName}
        {problem.customer && (
          <span
            data-testid="onsite-issue-item-customer"
            className="ml-1.5 text-[10px] text-muted-foreground/80"
            title={problem.customer}
          >
            · {problem.customer}
          </span>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <div className="flex flex-wrap gap-1">
          <span className="rounded bg-muted px-1.5 py-0.5">{problem.iteration}</span>
          {problem.database && <span className="rounded bg-muted px-1.5 py-0.5">{problem.database}</span>}
          {problem.third_bridge_branch && (
            <span className="rounded bg-muted px-1.5 py-0.5">{problem.third_bridge_branch}</span>
          )}
        </div>
        <span>{relative}</span>
      </div>
    </div>
  );
}