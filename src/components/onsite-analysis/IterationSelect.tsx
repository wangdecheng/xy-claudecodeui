/**
 * IterationSelect — pure `<select>` of iteration versions.
 *
 * Same constraints as CustomerSelect (D-8: no input/datalist/typeahead).
 */

import { useTranslation } from 'react-i18next';

import type { ConfigPayload } from '@shared/onsite-types';

import { cn } from '../../lib/utils';

export interface IterationSelectProps {
  config: ConfigPayload | null;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  className?: string;
}

export default function IterationSelect({
  config,
  value,
  onChange,
  disabled,
  className,
}: IterationSelectProps) {
  const { t } = useTranslation(['onsite']);
  const iterations = config?.data.iterations ?? [];
  const configInvalid = !config || config.status !== 'OK';

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label className="text-xs font-medium text-foreground">
        {t('onsite:wizard.iteration')}
      </label>
      <select
        data-testid="onsite-iteration-select"
        value={value}
        disabled={disabled || configInvalid || iterations.length === 0}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        <option value="" disabled>
          {t('onsite:wizard.iterationPlaceholder')}
        </option>
        {iterations.map((it) => (
          <option key={it} value={it}>
            {it}
          </option>
        ))}
      </select>
    </div>
  );
}