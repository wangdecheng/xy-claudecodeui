/**
 * CustomerSelect — controlled customer Combobox.
 *
 * The search term is temporary UI state. Only an item selected from the
 * configured customer directory is passed to the wizard as the confirmed
 * value, so free-text search can never become a submitted customer.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ConfigCustomer, ConfigPayload } from '@shared/onsite-types';

import { cn } from '../../lib/utils';

import {
  filterCustomers,
  moveCustomerHighlight,
} from './customerSelector';

export interface CustomerSelectProps {
  config: ConfigPayload | null;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  className?: string;
}

function getCustomerDisplayLabel(customer: ConfigCustomer, noThirdPartyLabel: string): string {
  const suffix = customer.branch === null
    ? ` (${noThirdPartyLabel})`
    : `（${customer.branch}）`;
  return `${customer.label}${suffix}`;
}

export default function CustomerSelect({
  config,
  value,
  onChange,
  disabled,
  className,
}: CustomerSelectProps) {
  const { t } = useTranslation(['onsite']);
  const customers = useMemo(() => config?.data.customers ?? [], [config]);
  const configInvalid = !config || config.status !== 'OK';
  const configurationUnavailable = configInvalid || customers.length === 0;
  const isDisabled = disabled || configurationUnavailable;
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listboxId = `onsite-customer-list-${useId().replace(/:/g, '')}`;
  const labelId = `${listboxId}-label`;
  const valueId = `${listboxId}-value`;

  const candidates = filterCustomers(customers, searchTerm);

  const closePanel = () => {
    setOpen(false);
    setSearchTerm('');
    setHighlightedIndex(null);
  };

  const openPanel = () => {
    if (isDisabled) return;
    setSearchTerm('');
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const filteredCustomers = filterCustomers(customers, searchTerm);
    const selectedIndex = filteredCustomers.findIndex((customer) => customer.label === value);
    setHighlightedIndex(
      selectedIndex >= 0 ? selectedIndex : filteredCustomers.length > 0 ? 0 : null,
    );
  }, [open, customers, searchTerm, value]);

  useEffect(() => {
    if (!open) return;
    searchInputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        closePanel();
      }
    };
    document.addEventListener('pointerdown', handleOutsidePointerDown);
    return () => document.removeEventListener('pointerdown', handleOutsidePointerDown);
  }, [open]);

  const selectCustomer = (customer: ConfigCustomer) => {
    onChange(customer.label);
    closePanel();
  };

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closePanel();
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightedIndex(moveCustomerHighlight(highlightedIndex, candidates.length, event.key));
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      if (highlightedIndex === null) return;
      const customer = candidates[highlightedIndex];
      if (customer) selectCustomer(customer);
    }
  };

  const selectedCustomer = customers.find((customer) => customer.label === value);
  const activeDescendant = highlightedIndex === null
    ? undefined
    : `${listboxId}-option-${highlightedIndex}`;

  return (
    <div ref={containerRef} className={cn('relative flex flex-col gap-1', className)}>
      <span id={labelId} className="text-xs font-medium text-foreground">
        {t('onsite:wizard.customer')}
      </span>
      {configurationUnavailable && (
        <span
          data-testid="onsite-config-invalid"
          className="text-xs text-destructive"
        >
          {t('onsite:error.configInvalid')}
        </span>
      )}
      <button
        type="button"
        data-testid="onsite-customer-select"
        aria-labelledby={`${labelId} ${valueId}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={isDisabled}
        onClick={() => (open ? closePanel() : openPanel())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            openPanel();
          }
        }}
        className="flex w-full items-center justify-between rounded-md border border-input bg-background px-2 py-1.5 text-left text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span
          id={valueId}
          className={selectedCustomer ? 'text-foreground' : 'text-muted-foreground'}
        >
          {selectedCustomer
            ? getCustomerDisplayLabel(
              selectedCustomer,
              t('onsite:wizard.noThirdParty', { defaultValue: '无三平台分支' }),
            )
            : t('onsite:wizard.customerPlaceholder')}
        </span>
        <ChevronDown className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>

      {open && (
        <div
          data-testid="onsite-customer-panel"
          className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
        >
          <input
            ref={searchInputRef}
            data-testid="onsite-customer-search"
            role="combobox"
            type="text"
            value={searchTerm}
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded="true"
            aria-haspopup="listbox"
            aria-labelledby={`${labelId} ${valueId}`}
            aria-activedescendant={activeDescendant}
            placeholder={t('onsite:wizard.customerSearchPlaceholder')}
            onChange={(event) => setSearchTerm(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            className="w-full border-b border-border bg-transparent px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
          />
          {candidates.length === 0 && (
            <div
              role="status"
              data-testid="onsite-customer-no-match"
              className="px-2 py-6 text-center text-sm text-muted-foreground"
            >
              {t('onsite:wizard.customerNoMatch')}
            </div>
          )}
          <div
            id={listboxId}
            role="listbox"
            aria-labelledby={labelId}
            data-testid="onsite-customer-options"
            className="max-h-60 overflow-y-auto p-1"
          >
            {candidates.map((customer, index) => {
              const isHighlighted = index === highlightedIndex;
              const isSelected = customer.label === value;
              return (
                <div
                  key={customer.label}
                  id={`${listboxId}-option-${index}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={isSelected}
                  data-highlighted={isHighlighted || undefined}
                  data-testid={`onsite-customer-option-${index}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  onClick={() => selectCustomer(customer)}
                  className={cn(
                    'flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none',
                    isHighlighted && 'bg-accent text-accent-foreground',
                    isSelected && !isHighlighted && 'font-medium',
                  )}
                >
                  {getCustomerDisplayLabel(
                    customer,
                    t('onsite:wizard.noThirdParty', { defaultValue: '无三平台分支' }),
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
