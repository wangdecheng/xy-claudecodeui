import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConfigCustomer } from '@shared/onsite-types';

import {
  filterCustomers,
  moveCustomerHighlight,
  normalizeCustomerSearch,
} from './customerSelector';

const customers: ConfigCustomer[] = [
  { label: '其他问题', branch: null },
  { label: 'Alpha Telecom', branch: 'Master_5.2' },
  { label: 'Beta Bank', branch: 'branch-anke' },
  { label: 'Gamma', branch: null },
];

test('customer search trims input and ignores letter case', () => {
  assert.equal(normalizeCustomerSearch('  ALPHA  '), 'alpha');
  assert.deepEqual(filterCustomers(customers, '  alpha '), [customers[1]]);
});

test('customer search matches a continuous substring in the label or branch', () => {
  assert.deepEqual(filterCustomers(customers, 'tele'), [customers[1]]);
  assert.deepEqual(filterCustomers(customers, 'anke'), [customers[2]]);
  assert.deepEqual(filterCustomers(customers, 'ha Ba'), []);
});

test('customer search preserves configured order and shows all customers for an empty query', () => {
  assert.deepEqual(filterCustomers(customers, ''), customers);
  assert.deepEqual(filterCustomers([
    customers[2],
    customers[1],
    { label: 'Alpha Branch', branch: 'branch-anke' },
  ], 'anke').map((customer) => customer.label), [
    'Beta Bank',
    'Alpha Branch',
  ]);
});

test('customer highlight wraps with arrow keys and starts at the first candidate', () => {
  assert.equal(moveCustomerHighlight(null, 3, 'ArrowDown'), 0);
  assert.equal(moveCustomerHighlight(2, 3, 'ArrowDown'), 0);
  assert.equal(moveCustomerHighlight(0, 3, 'ArrowUp'), 2);
  assert.equal(moveCustomerHighlight(null, 3, 'ArrowUp'), 2);
  assert.equal(moveCustomerHighlight(1, 0, 'ArrowDown'), null);
});
