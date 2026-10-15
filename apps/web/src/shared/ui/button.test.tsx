import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { Button } from './button';

describe('Button', () => {
  it('does nothing when pressed while it says it is unavailable, and keeps focus', async () => {
    const onClick = vi.fn();
    renderWithProviders(
      <Button aria-disabled onClick={onClick}>
        Archive
      </Button>,
      { session: null },
    );
    const button = await screen.findByRole('button', { name: 'Archive' });
    button.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(button).toHaveFocus();
    expect(button).toBeUnavailable();
  });

  it('stops the child’s own handler too when drawn as its child', async () => {
    const onClick = vi.fn();
    renderWithProviders(
      <Button asChild aria-disabled>
        <a href="#next" onClick={onClick}>
          Next
        </a>
      </Button>,
      { session: null },
    );
    await userEvent.click(await screen.findByRole('link', { name: 'Next' }));
    expect(onClick).not.toHaveBeenCalled();
    expect(window.location.hash).not.toBe('#next');
  });

  it('works as usual when available', async () => {
    const onClick = vi.fn();
    renderWithProviders(<Button onClick={onClick}>Save</Button>, { session: null });
    const button = await screen.findByRole('button', { name: 'Save' });
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button).not.toBeUnavailable();
  });
});
