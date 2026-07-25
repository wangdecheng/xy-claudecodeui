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

test('问题入口服务是可选字段，并传入 problem.json 与首轮代码分析提示', async () => {
  const source = await readFile(wizardSourceUrl, 'utf8');

  assert.match(source, /data-testid="onsite-entry-service-input"/);
  assert.match(source, /body\.entry_service = entryService\.trim\(\)/);
  assert.match(source, /`问题入口服务:\$\{entryService\}`/);
  assert.doesNotMatch(
    source.match(/const canSubmit =[\s\S]*?;/)?.[0] ?? '',
    /entryService/,
    '问题入口服务不得参与必填校验',
  );
});
