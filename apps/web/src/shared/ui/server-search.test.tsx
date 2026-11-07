import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { ServerSearch, type ServerSearchResult } from './server-search';

const NAMES = ['Aspirin', 'Amoxicillin', 'Atenolol'];

function search(typed: string, enabled: boolean): ServerSearchResult<string> {
  const q = typed.trim().toLowerCase();
  return {
    data: enabled && q !== '' ? NAMES.filter((n) => n.toLowerCase().includes(q)) : undefined,
    isError: false,
    isPending: false,
    isPlaceholderData: false,
  };
}

function Box({
  onChoose = vi.fn(),
  available = true,
}: {
  onChoose?: (name: string, reset: () => void) => void;
  available?: boolean;
}) {
  return (
    <main>
      <form onSubmit={(event) => event.preventDefault()} data-testid="form">
        <ServerSearch
          label="Medicine"
          available={available}
          useSearch={search}
          messages={{
            placeholder: 'Type',
            unavailable: 'Not open to you.',
            typeToSearch: 'Type to search.',
            loading: 'Searching',
            failed: 'Failed',
            none: () => 'None',
            found: (count) => `${count} found`,
          }}
          optionKey={(name) => name}
          renderOption={(name) => name}
          onChoose={onChoose}
        />
      </form>
    </main>
  );
}

describe('ServerSearch', () => {
  it('finds, wraps with the arrows, chooses with Enter and clears', async () => {
    const onChoose = vi.fn((_name: string, reset: () => void) => reset());
    const user = userEvent.setup();
    render(<Box onChoose={onChoose} />);
    const input = screen.getByRole('combobox', { name: 'Medicine' });

    await user.type(input, 'a');
    expect(await screen.findAllByRole('option')).toHaveLength(3);
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findAllByText('3 found')).not.toHaveLength(0);
    await expectNoAxeViolations();

    await user.keyboard('{ArrowUp}');
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[2]?.id);
    await user.keyboard('{Enter}');
    expect(onChoose).toHaveBeenCalledWith('Atenolol', expect.any(Function));
    expect(input).toHaveValue('');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('closes on Escape and never submits the form on Enter', async () => {
    const submit = vi.fn();
    const user = userEvent.setup();
    render(<Box />);
    screen.getByTestId('form').addEventListener('submit', submit);
    const input = screen.getByRole('combobox', { name: 'Medicine' });
    await user.type(input, 'asp');
    await screen.findByRole('option', { name: 'Aspirin' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.keyboard('{ArrowDown}');
    await screen.findByRole('listbox');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(submit).not.toHaveBeenCalled());
  });

  it('does not choose a stale result while the typed text is still settling', async () => {
    const onChoose = vi.fn();
    const user = userEvent.setup();
    render(<Box onChoose={onChoose} />);
    const input = screen.getByRole('combobox', { name: 'Medicine' });
    await user.type(input, 'a');
    await screen.findAllByRole('option');
    // Typing again: the list is withheld until the new text has settled.
    await user.type(input, 'm{Enter}');
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('says when it is not open to the person and stays disabled', async () => {
    render(<Box available={false} />);
    const input = screen.getByRole('combobox', { name: 'Medicine' });
    expect(input).toBeDisabled();
    expect(input).toHaveAccessibleDescription('Not open to you.');
    await expectNoAxeViolations();
  });
});
