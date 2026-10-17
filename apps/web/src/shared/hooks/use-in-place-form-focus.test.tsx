import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { useInPlaceFormFocus } from './use-in-place-form-focus';

function Record() {
  const [editing, setEditing] = useState(false);
  const box = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useInPlaceFormFocus(editing, box, heading);
  return (
    <section ref={box}>
      <h2 ref={heading} tabIndex={-1}>
        Details
      </h2>
      {editing ? (
        <form>
          <input aria-label="Name" />
          <button type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button type="button" data-opens="edit" onClick={() => setEditing(true)}>
          Edit
        </button>
      )}
      <button type="button">Elsewhere</button>
    </section>
  );
}

describe('useInPlaceFormFocus', () => {
  it('takes focus to the heading when the form opens, and back to Edit when it closes', async () => {
    render(<Record />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('heading', { name: 'Details' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveFocus();
  });

  it('does nothing on the first render', () => {
    render(<Record />);
    expect(document.body).toHaveFocus();
  });
});
