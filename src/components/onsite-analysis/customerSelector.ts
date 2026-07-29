import type { ConfigCustomer } from '@shared/onsite-types';

/** Normalize only the variations promised by the customer-search contract. */
export function normalizeCustomerSearch(value: string): string {
  return value.trim().toLowerCase();
}

/** Return configured customers in their original order when either field matches. */
export function filterCustomers(
  customers: ConfigCustomer[],
  searchTerm: string,
): ConfigCustomer[] {
  const normalizedTerm = normalizeCustomerSearch(searchTerm);
  if (!normalizedTerm) return customers;

  return customers.filter((customer) => {
    const label = normalizeCustomerSearch(customer.label);
    const branch = customer.branch ? normalizeCustomerSearch(customer.branch) : '';
    return label.includes(normalizedTerm) || branch.includes(normalizedTerm);
  });
}

export type CustomerHighlightKey = 'ArrowDown' | 'ArrowUp';

/** Calculate the next listbox option index for keyboard navigation. */
export function moveCustomerHighlight(
  currentIndex: number | null,
  candidateCount: number,
  key: CustomerHighlightKey,
): number | null {
  if (candidateCount <= 0) return null;

  const current = currentIndex ?? (key === 'ArrowDown' ? -1 : candidateCount);
  const delta = key === 'ArrowDown' ? 1 : -1;
  return (current + delta + candidateCount) % candidateCount;
}
