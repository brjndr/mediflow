import fs from 'node:fs';
const edit = (file, pairs) => {
  let s = fs.readFileSync(file, 'utf8');
  for (const [a, b] of pairs) {
    if (!s.includes(a)) throw new Error(`missing in ${file}: ${a.slice(0, 60)}`);
    s = s.replace(a, () => b);
  }
  fs.writeFileSync(file, s);
};
const W = 'apps/web/src/features/platform/';
edit(W + 'schemas.ts', [
  [
    ".regex(/^[0-9]{1,4}$/, 'platform.create.errors.whole')",
    ".regex(/^[0-9]{1,4}$/, 'platform.status.offboard.daysInvalid')",
  ],
]);
let sc = fs.readFileSync(W + 'schemas.ts', 'utf8');
sc = sc.replace(
  /\.refine\(\(value\) => Number\(value\) >= 1 && Number\(value\) <= 3650, 'platform\.create\.errors\.whole'\)/,
  ".refine((value) => Number(value) >= 1 && Number(value) <= 3650, 'platform.status.offboard.daysInvalid')",
);
fs.writeFileSync(W + 'schemas.ts', sc);
edit('apps/web/src/app/locales/en/common.json', [
  [
    '"daysHint": "From 1 to 3650.",',
    '"daysHint": "From 1 to 3650.",\n        "daysInvalid": "Enter a whole number from 1 to 3650.",',
  ],
]);
edit(W + 'components/HospitalStatus.tsx', [
  [
    `  const failed = (error: unknown) => {
    setRefused(
      isApiError(error) && error.serverCode === 'invalid_transition'
        ? t('platform.status.changedMeanwhile')
        : t(errorMessageKey(error)),
    );
  };`,
    `  const failed = (error: unknown) => {
    if (isApiError(error) && error.serverCode === 'invalid_transition') {
      // The question no longer fits the hospital: close it, say why where it stays on the page,
      // and let the page show the status the hospital really has.
      setAsking(null);
      form.reset();
      setMessage(t('platform.status.changedMeanwhile'));
      queueMicrotask(() => focusIfLost(statusLine.current));
      return;
    }
    setRefused(t(errorMessageKey(error)));
  };`,
  ],
  [
    `  const close = () => {
    setAsking(null);`,
    `  const close = () => {
    // A request is on its way: the answer was given, and the dialog stays until it is back.
    if (busy) return;
    setAsking(null);`,
  ],
]);
edit('apps/web/src/shared/ui/confirm-dialog.tsx', [
  [
    "import { useEffect, useRef, type ReactNode } from 'react';",
    "import { useEffect, useId, useRef, type ReactNode } from 'react';",
  ],
  [
    '  const dialog = useRef<HTMLDialogElement>(null);\n',
    '  const dialog = useRef<HTMLDialogElement>(null);\n  const titleId = useId();\n  const descriptionId = useId();\n',
  ],
  ['aria-labelledby="confirm-title"', 'aria-labelledby={titleId}'],
  ['aria-describedby="confirm-description"', 'aria-describedby={descriptionId}'],
  ['<h2 id="confirm-title"', '<h2 id={titleId}'],
  ['<p id="confirm-description"', '<p id={descriptionId}'],
]);
edit(W + 'hospital-status.test.tsx', [
  [
    `    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
      /changed by someone else/,
    );`,
    `    // The question closes, the page says why, and shows the status the hospital really has.
    expect(await screen.findByText(/changed by someone else/)).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await screen.findByRole('button', { name: 'Reactivate' })).toBeInTheDocument();`,
  ],
  [
    `  it('is out of reach for hospital staff'`,
    `  it('forgets what was typed when the offboard question is cancelled', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/hosp_city' });
    await user.click(await screen.findByRole('button', { name: 'Offboard' }));
    await user.type(within(dialog()).getByLabelText(/Type city-general/), 'city-gen');
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Offboard' }));
    expect(within(dialog()).getByLabelText(/Type city-general/)).toHaveValue('');
    expect((await fetchHospital('hosp_city')).status).toBe('active');
  });

  it('refuses days above the limit', async () => {
    asPlatformAdmin();
    const user = userEvent.setup();
    renderApp({ entry: '/platform/hospitals/hosp_city' });
    await user.click(await screen.findByRole('button', { name: 'Offboard' }));
    await user.type(within(dialog()).getByLabelText(/Type city-general/), 'city-general');
    const days = within(dialog()).getByLabelText(/Days until/);
    await user.clear(days);
    await user.type(days, '3651');
    await user.click(within(dialog()).getByRole('button', { name: 'Offboard hospital' }));

    expect(await within(dialog()).findByText('Enter a whole number from 1 to 3650.')).toBeVisible();
    expect((await fetchHospital('hosp_city')).status).toBe('active');
  });

  it('is out of reach for hospital staff'`,
  ],
]);
edit('apps/web/src/shared/ui/confirm-dialog.test.tsx', [
  [
    "import { describe, expect, it, vi } from 'vitest';",
    "import { describe, expect, it, vi } from 'vitest';\nimport { useForm } from 'react-hook-form';",
  ],
]);
fs.appendFileSync(
  'apps/web/src/shared/ui/confirm-dialog.test.tsx',
  `
describe('ConfirmDialog, more', () => {
  it('closes on Escape without confirming', async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        open
        onClose={onClose}
        title="Sure?"
        description="d"
        cancelLabel="No"
        confirmLabel="Yes"
        onConfirm={onConfirm}
      />,
    );
    const element = screen.getByRole('alertdialog');
    element.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Yes' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('is aria-disabled while pending and keeps focus on the first marked field', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        open
        onClose={() => {}}
        title="Sure?"
        description="d"
        cancelLabel="No"
        confirmLabel="Yes"
        onConfirm={onConfirm}
        pending
      >
        <input aria-label="Slug" data-autofocus />
      </ConfirmDialog>,
    );
    expect(screen.getByLabelText('Slug')).toHaveFocus();
    const yes = screen.getByRole('button', { name: 'Yes' });
    expect(yes).toHaveAttribute('aria-disabled', 'true');
    await user.click(yes);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
`,
);
