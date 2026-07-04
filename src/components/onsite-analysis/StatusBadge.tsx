/**
 * StatusBadge — 5-state problem-status pill.
 *
 * Statuses come from `shared/onsite-types.ts:ProblemStatus`. Colors:
 *  - pending_info: gray       (awaiting more info from customer)
 *  - analyzing:    blue       (AI is reading logs)
 *  - blocked:      amber      (waiting on something — usually human)
 *  - confirmed:    green      (root cause locked)
 *  - abandoned:    dim gray   (closed without resolution)
 *
 * Labels come from `i18n:onsite.status.*`. Pure presentational; no store
 * coupling so this can be used anywhere (sidebar item, chat header, etc).
 */

import { useTranslation } from 'react-i18next';

import type { ProblemStatus } from '@shared/onsite-types';

import { cn } from '../../lib/utils';

export interface StatusBadgeProps {
  status: ProblemStatus;
  className?: string;
}

const STATUS_STYLES: Record<ProblemStatus, string> = {
  pending_info:
    'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
  analyzing:
    'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  blocked:
    'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  confirmed:
    'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
  abandoned:
    'bg-gray-300 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};

export default function StatusBadge({ status, className }: StatusBadgeProps) {
  const { t } = useTranslation(['onsite']);
  const label = t(`onsite:status.${status}`, { defaultValue: status });
  return (
    <span
      data-testid="onsite-status-badge"
      data-status={status}
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        STATUS_STYLES[status],
        className,
      )}
    >
      {label}
    </span>
  );
}