import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sourceUrl = new URL('./CustomerSelect.tsx', import.meta.url);

test('customer selector exposes controlled combobox and listbox semantics', async () => {
  const source = await readFile(sourceUrl, 'utf8');

  assert.match(source, /role="combobox"/);
  assert.match(source, /aria-autocomplete="list"/);
  assert.match(source, /aria-activedescendant=\{activeDescendant\}/);
  assert.match(source, /aria-labelledby=\{`\$\{labelId\} \$\{valueId\}`\}/);
  assert.match(source, /role="listbox"/);
  assert.match(source, /role="option"/);
  assert.match(source, /aria-selected=\{isSelected\}/);
});

test('customer selector focuses on open, supports keyboard dismissal, and bounds long lists', async () => {
  const source = await readFile(sourceUrl, 'utf8');

  assert.match(source, /searchInputRef\.current\?\.focus\(\)/);
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(source, /event\.key === 'ArrowDown' \|\| event\.key === 'ArrowUp'/);
  assert.match(source, /if \(event\.key === 'Enter'\) \{[\s\S]*?event\.preventDefault\(\)/);
  assert.match(source, /document\.addEventListener\('pointerdown'/);
  assert.match(source, /max-h-60 overflow-y-auto/);
  assert.match(source, /moveCustomerHighlight\(highlightedIndex, candidates\.length, event\.key\)/);
  assert.match(source, /const filteredCustomers = filterCustomers\(customers, searchTerm\)/);
  assert.doesNotMatch(source, /\}, \[open, candidates, value\]\)/);
});

test('customer selector confirms labels only and disables invalid directories', async () => {
  const source = await readFile(sourceUrl, 'utf8');

  assert.match(source, /const configurationUnavailable = configInvalid \|\| customers\.length === 0/);
  assert.match(source, /const isDisabled = disabled \|\| configurationUnavailable/);
  assert.match(source, /onChange\(customer\.label\)/);
  assert.doesNotMatch(source, /onChange\(searchTerm\)/);
  assert.match(source, /customer\.branch === null/);
});
