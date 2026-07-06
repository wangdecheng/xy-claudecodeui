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

const VISIBLE_GROUPS: { status: ProblemStatus; key: string }[] = [
  { status: 'blocked', key: 'blocked' },
  { status: 'analyzing', key: 'analyzing' },
  { status: 'pending_info', key: 'pending_info' },
  { status: 'confirmed', key: 'confirmed' },
  { status: 'abandoned', key: 'abandoned' },
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
    if (!q) return problems;
    return problems.filter(
      (p) =>
        p.customer.toLowerCase().includes(q) ||
        p.iteration.toLowerCase().includes(q) ||
        p.database.toLowerCase().includes(q),
    );
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
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold text-foreground">
          🔍 {t('onsite:nav.onsite', { defaultValue: 'Onsite' })}
        </h2>
        <button
          type="button"
          onClick={() => setWizardOpen(true)}
          data-testid="onsite-new-issue-button"
          className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('onsite:wizard.title', { defaultValue: 'New' }).split(' ')[0] ?? '+'}
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
          VISIBLE_GROUPS.map(({ status, key }) => {
            const items = grouped.get(status) ?? [];
            if (items.length === 0) return null;
            return (
              <section key={key} className="mb-3" data-testid={`onsite-group-${status}`}>
                <h3 className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t(`onsite:status.${status}`)} ({items.length})
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