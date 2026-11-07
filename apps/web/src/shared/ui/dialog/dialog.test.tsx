import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expectNoAxeViolations } from '@/test/axe';
import { Button } from '@/shared/ui/button';
import { Dialog } from './dialog';

function Harness({ busy = false, withField = true }: { busy?: boolean; withField?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open it</button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Cancel the order"
        description="Say why."
        closeLabel="Close"
        busy={busy}
        footer={<Button onClick={() => setOpen(false)}>Done</Button>}
      >
        {withField && (
          <label>
            Reason
            <input />
          </label>
        )}
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('is named by its title, described, and passes axe', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Open it' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel the order' });
    expect(dialog).toHaveAccessibleDescription('Say why.');
    await expectNoAxeViolations(dialog);
  });

  it('focuses the first field, closes on Escape and returns focus to the opener', async () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open it' });
    await userEvent.click(opener);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Reason' })).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('focuses the title when there is no field', async () => {
    render(<Harness withField={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open it' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Cancel the order' })).toHaveFocus(),
    );
  });

  it('keeps focus inside when tabbing past the last control', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Open it' }));
    const dialog = await screen.findByRole('dialog');
    for (let i = 0; i < 6; i++) await userEvent.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it('stays open on Escape and on Close while busy', async () => {
    render(<Harness busy />);
    await userEvent.click(screen.getByRole('button', { name: 'Open it' }));
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
