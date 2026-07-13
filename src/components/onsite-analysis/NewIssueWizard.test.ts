import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const wizardSourceUrl = new URL('./NewIssueWizard.tsx', import.meta.url);

test('regression: clicking the new-issue backdrop does not close the wizard and discard the draft', async () => {
  const source = await readFile(wizardSourceUrl, 'utf8');
  const backdropOpeningTag = source.match(
    /<div\s+data-testid="onsite-new-issue-wizard"[\s\S]*?>/,
  )?.[0];

  assert.ok(backdropOpeningTag, 'wizard backdrop should be rendered');
  assert.doesNotMatch(
    backdropOpeningTag,
    /\bonClick=/,
    'the backdrop must not dismiss the wizard; use the explicit close controls instead',
  );
});
