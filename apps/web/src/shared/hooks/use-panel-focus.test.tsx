import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { usePanelFocus } from './use-panel-focus';

function Rooms({ removeOpener = false }: { removeOpener?: boolean }) {
  const [panel, setPanel] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const box = useRef<HTMLElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  usePanelFocus(panel, box, status);
  return (
    <section ref={box}>
      <p ref={status} tabIndex={-1}>
        Status
      </p>
      {!gone && (
        <button type="button" onClick={() => setPanel('rename')}>
          Rename
        </button>
      )}
      {panel && (
        <div>
          <h3 data-panel-heading tabIndex={-1}>
            Rename the room
          </h3>
          <button
            type="button"
            onClick={() => {
              if (removeOpener) setGone(true);
              setPanel(null);
            }}
          >
            Done
          </button>
        </div>
      )}
    </section>
  );
}

describe('usePanelFocus', () => {
  it('takes focus to the panel’s heading, and back to the button that opened it', async () => {
    render(<Rooms />);
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(screen.getByRole('heading', { name: 'Rename the room' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('button', { name: 'Rename' })).toHaveFocus();
  });

  it('goes to the fallback when the button that opened it is gone', async () => {
    render(<Rooms removeOpener />);
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByText('Status')).toHaveFocus();
  });
});

function Replaced() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLElement>(null);
  usePanelFocus(open || null, box);
  return (
    <section ref={box}>
      {open ? (
        <div>
          <h3 data-panel-heading tabIndex={-1}>
            Add a room
          </h3>
          <button type="button" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)}>
          Add a room
        </button>
      )}
    </section>
  );
}

describe('usePanelFocus, when the form took the button’s place', () => {
  it('gives focus to the button of the same name that comes back', async () => {
    render(<Replaced />);
    await userEvent.click(screen.getByRole('button', { name: 'Add a room' }));
    expect(screen.getByRole('heading', { name: 'Add a room' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Add a room' })).toHaveFocus();
  });
});
