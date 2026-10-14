// Run with: pnpm test:scripts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withDodLine } from './add-dod-line.mjs';

const LINE = 'Accessibility: keyboard and axe checked';

test('the line goes after the last item of the definition of done', () => {
  const body = [
    '## Tasks',
    '- [ ] Do it',
    '',
    '## Definition of done',
    '- [ ] Tests pass',
    '- [x] PR body contains Closes',
    '',
    '---',
    '_Generated_',
  ].join('\n');
  assert.equal(
    withDodLine(body, LINE),
    [
      '## Tasks',
      '- [ ] Do it',
      '',
      '## Definition of done',
      '- [ ] Tests pass',
      '- [x] PR body contains Closes',
      `- [ ] ${LINE}`,
      '',
      '---',
      '_Generated_',
    ].join('\n'),
  );
});

test('a body without the section gets one at the end', () => {
  assert.equal(
    withDodLine('Some text\n\n', LINE),
    `Some text\n\n## Definition of done\n- [ ] ${LINE}\n`,
  );
  assert.equal(withDodLine(null, LINE), `\n## Definition of done\n- [ ] ${LINE}\n`);
});

test('an empty section gets the line under its heading', () => {
  assert.equal(
    withDodLine('## Definition of done\n\n## Notes', LINE),
    `## Definition of done\n- [ ] ${LINE}\n\n## Notes`,
  );
});

test('a body that has the line is left alone', () => {
  assert.equal(withDodLine(`## Definition of done\n- [ ] ${LINE}\n`, LINE), null);
});

test('Windows line endings are kept', () => {
  assert.equal(
    withDodLine('## Definition of done\r\n- [ ] Tests pass\r\n', LINE),
    `## Definition of done\r\n- [ ] Tests pass\r\n- [ ] ${LINE}\r\n`,
  );
});
