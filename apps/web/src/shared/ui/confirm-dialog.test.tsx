import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { ConfirmDialog } from './confirm-dialog';

function Harness({ onConfirm }: { onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Ask</button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Sure?"
        description="This cannot be undone."
        cancelLabel="No"
        confirmLabel="Yes"
        onConfirm={onConfirm}
        destructive
      />
    </>
  );
}

describe('ConfirmDialog', () => {
  it('starts on the safe answer, confirms only when asked, and passes axe', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<Harness onConfirm={onConfirm} />);
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Ask' }));
    expect(screen.getByRole('alertdialog')).toHaveAccessibleName('Sure?');
    expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription('This cannot be undone.');
    expect(screen.getByRole('button', { name: 'No' })).toHaveFocus();
    await expectNoAxeViolations();

    await user.keyboard('{Enter}');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await user.click(screen.getByRole('button', { name: 'Yes' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('ConfirmDialog, more', () => {
  it('treats Escape as a cancel and never confirms', async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
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
    screen.getByRole('alertdialog').dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('starts on the marked field and marks a pending confirm aria-disabled', () => {
    render(
      <ConfirmDialog
        open
        onClose={() => {}}
        title="Sure?"
        description="d"
        cancelLabel="No"
        confirmLabel="Yes"
        onConfirm={() => {}}
        pending
      >
        <input aria-label="Slug" data-autofocus />
      </ConfirmDialog>,
    );
    expect(screen.getByLabelText('Slug')).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Yes' })).toHaveAttribute('aria-disabled', 'true');
  });
});
