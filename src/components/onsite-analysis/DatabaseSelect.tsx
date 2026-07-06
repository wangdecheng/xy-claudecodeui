/**
 * DatabaseSelect — fixed dropdown of supported database types.
 *
 * Why fixed: contracts (tasks.md §7.2) hard-code 4 database kinds; they
 * are deployment-time constants, not user-configurable. Using a fixed
 * `<select>` keeps D-8 parity (no typeahead, no free text).
 *
 * Values match `server/modules/database/...` migrations — if you add a
 * 5th, also update `db-kind.ts` server-side.
 */

import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';

export const DATABASE_KINDS = ['mysql', 'dm', 'kingbase', 'oracle'] as const;
export type DatabaseKind = (typeof DATABASE_KINDS)[number];

export const DATABASE_KIND_OTHER = 'other';

export interface DatabaseSelectProps {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  className?: string;
}

export default function DatabaseSelect({
  value,
  onChange,
  disabled,
  className,
}: DatabaseSelectProps) {
  const { t } = useTranslation(['onsite']);

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label className="text-xs font-medium text-foreground">
        {t('onsite:wizard.database')}
      </label>
      <select
        data-testid="onsite-database-select"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        <option value="" disabled>
          {t('onsite:wizard.databasePlaceholder')}
        </option>
        {DATABASE_KINDS.map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
        <option value={DATABASE_KIND_OTHER}>其他</option>
      </select>
      {value === DATABASE_KIND_OTHER && (
        <p
          data-testid="onsite-database-other-hint"
          className="text-[11px] text-amber-700 dark:text-amber-300"
        >
          {t('onsite:wizard.otherHint')}
        </p>
      )}
    </div>
  );
}