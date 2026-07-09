/**
 * IssueListSidebar — left rail listing all onsite problems, grouped by status.
 *
 * Behavior:
 *  - top: "+ 新建问题" button → opens NewIssueWizard modal
 *  - search box → client-side filter on customer name (case-insensitive)
 *  - server already sorts by status (blocked → analyzing → pending_info →
 *    confirmed → abandoned). We additionally split into 4 visible groups
 *    so the operator can scan the most urgent issues first.
 *  - empty group → render nothing (don't show "0 项")
 *
 * This file lives outside `layout/` because it is the actual sidebar
 * component (the layout composes it).
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Search } from 'lucide-react';

import type { ProblemListItem, ProblemStatus } from '@shared/onsite-types';

import { useOnsiteStore } from '../../stores/onsiteStore';
import IssueListItem from './IssueListItem';
import NewIssueWizard from './NewIssueWizard';

// 业务阶段二分(REQ-2.6):进行中 = 未解决态;已归档 = 已收尾态
const BUSINESS_PHASES: { key: 'active' | 'archived'; statuses: ProblemStatus[] }[] = [
  {
    key: 'active',
    statuses: ['blocked', 'analyzing', 'pending_info'],
  },
  {
    key: 'archived',
    statuses: ['confirmed', 'abandoned'],
  },
];

export interface IssueListSidebarProps {
  currentProblemId?: string | null;
}

export default function IssueListSidebar({ currentProblemId }: IssueListSidebarProps) {
  const { t } = useTranslation(['onsite', 'common']);
  const store = useOnsiteStore();
  const problems = store.problems;
  const loadProblems = store.loadProblems;
  const lastError = store.lastError;

  const [filter, setFilter] = useState('');
  const [wizardOpen, setWizardOpen] = useState(false);

  // Initial load (also re-runs after wizard closes via store updates).
  useEffect(() => {
    void loadProblems();
  }, [loadProblems]);

  const filtered = useMemo<ProblemListItem[]>(() => {
    const q = filter.trim().toLowerCase();
    const base = q
      ? problems.filter(
          (p) =>
            p.customer.toLowerCase().includes(q) ||
            p.iteration.toLowerCase().includes(q) ||
            p.database.toLowerCase().includes(q) ||
            (p.description ?? '').toLowerCase().includes(q),
        )
      : problems;
    // 按创建时间降序排列，最新的排最前面
    return [...base].sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return tb - ta;
    });
  }, [problems, filter]);

  const grouped = useMemo(() => {
    const map = new Map<ProblemStatus, ProblemListItem[]>();
    for (const p of filtered) {
      const list = map.get(p.status);
      if (list) list.push(p);
      else map.set(p.status, [p]);
    }
    return map;
  }, [filtered]);

  return (
    <aside
      data-testid="onsite-issue-sidebar"
      className="flex h-full w-[300px] flex-shrink-0 flex-col border-r border-border bg-card"
    >
      <div className="flex flex-col gap-2 border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold text-foreground">
          🔍 {t('onsite:nav.onsite', { defaultValue: 'Onsite' })}
        </h2>
        <button
          type="button"
          onClick={() => setWizardOpen(true)}
          data-testid="onsite-new-issue-button"
          className="inline-flex w-full items-center justify-center gap-1 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('onsite:nav.newIssue', { defaultValue: '新建现场问题' })}
        </button>
      </div>

      <div className="relative border-b border-border px-3 py-2">
        <Search className="pointer-events-none absolute left-5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('onsite:common.empty', { defaultValue: 'search...' })}
          className="w-full rounded-md border border-input bg-background py-1 pl-8 pr-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {lastError && (
        <div className="border-b border-border bg-destructive/10 px-3 py-1 text-xs text-destructive">
          {lastError}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t('onsite:common.empty', { defaultValue: 'No data' })}
          </div>
        ) : (
          BUSINESS_PHASES.map(({ key, statuses }) => {
            const items = statuses.flatMap((s) => grouped.get(s) ?? []);
            if (items.length === 0) return null;
            return (
              <section key={key} className="mb-3" data-testid={`onsite-group-${key}`}>
                <h3 className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t(`onsite:nav.${key}`, { defaultValue: key === 'active' ? '进行中' : '已归档' })} · {items.length}
                </h3>
                <ul className="space-y-1">
                  {items.map((p) => (
                    <li key={p.id}>
                      <IssueListItem problem={p} active={p.id === currentProblemId} />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>

      <NewIssueWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
    </aside>
  );
}