/**
 * CustomerSelect — pure `<select>` of customer labels.
 *
 * Why pure `<select>` (D-8 double defense):
 *  - Backend enforcement lives in `validate-no-hardcoded-customers.sh` (Batch 8).
 *  - Frontend enforcement: NO input / NO datalist / NO typeahead. The
 *    only HTML the operator can interact with is a native select, whose
 *    options come exclusively from `config.data.customers`. There is no
 *    way to inject a customer label by typing.
 *
 * Behavior:
 *  - config.status !== 'OK' → all selects disabled + red error above.
 *  - selectedCustomer === first customer → caller is supposed to NOT
 *    send `third_bridge_branch` to POST /problems (branch=null contract).
 *    That logic lives in NewIssueWizard; this component is purely
 *    presentational.
 */

import { useTranslation } from 'react-i18next';

import type { ConfigPayload } from '@shared/onsite-types';

import { cn } from '../../lib/utils';

export interface CustomerSelectProps {
  config: ConfigPayload | null;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  className?: string;
}

export default function CustomerSelect({
  config,
  value,
  onChange,
  disabled,
  className,
}: CustomerSelectProps) {
  const { t } = useTranslation(['onsite']);
  const customers = config?.data.customers ?? [];
  const configInvalid = !config || config.status !== 'OK';

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label className="text-xs font-medium text-foreground">
        {t('onsite:wizard.customer')}
      </label>
      {configInvalid && (
        <span
          data-testid="onsite-config-invalid"
          className="text-xs text-destructive"
        >
          {t('onsite:error.configInvalid')}
        </span>
      )}
      <select
        data-testid="onsite-customer-select"
        value={value}
        disabled={disabled || configInvalid || customers.length === 0}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        <option value="" disabled>
          {t('onsite:wizard.customerPlaceholder')}
        </option>
        {customers.map((c) => {
          // label 自带「（」/「(」 或 label === branch 时不附加后缀;
          // branch === null 时附加「(无三平台分支)」标记
          const hasInline = /[（(]/.test(c.label) || c.label === c.branch;
          const suffix =
            c.branch === null
              ? ` (${t('onsite:wizard.noThirdParty')})`
              : hasInline
                ? ''
                : `（${c.branch}）`;
          return (
            <option key={c.label} value={c.label}>
              {c.label}
              {suffix}
            </option>
          );
        })}
      </select>
    </div>
  );
}