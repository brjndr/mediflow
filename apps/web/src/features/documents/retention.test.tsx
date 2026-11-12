import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { revokePermission, setTenantFeature, TENANT_IDS } from '@/mocks/db';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// The retention rules screen (#561). The mock's hospital keeps consents for 10 years and every
// other category for ever.

const HOSPITAL = TENANT_IDS.hospital;

async function openPage() {
  renderApp({ entry: '/document-retention' });
  await screen.findByRole('heading', { level: 1, name: 'Document retention' });
  return screen.findByRole('table', { name: 'Document retention' });
}

const rowOf = (table: HTMLElement, text: string) =>
  within(table)
    .getAllByRole('row')
    .find((row) => within(row).queryByText(text)) as HTMLElement;

describe('the retention rules screen', () => {
  it('lists every category with its years, and has no axe violations', async () => {
    const table = await openPage();
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(8));
    expect(within(rowOf(table, 'Consent')).getByText('10 years')).toBeInTheDocument();
    expect(within(rowOf(table, 'Other')).getByText('Kept for ever')).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it('changes a category to a number of years, and back to for ever', async () => {
    const table = await openPage();
    await within(table).findByText('10 years');
    await userEvent.click(
      within(
        rowOf(screen.getByRole('table', { name: 'Document retention' }), 'Insurance'),
      ).getByRole('button', { name: /^Change/ }),
    );
    // A category kept for ever starts with the box ticked; the years count only without it.
    await userEvent.click(await screen.findByLabelText('Keep for ever'));
    await userEvent.type(screen.getByLabelText(/Years kept/), '7');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Retention of Insurance saved.')).toBeInTheDocument();
    expect(await screen.findByText('7 years')).toBeInTheDocument();

    await userEvent.click(
      within(
        rowOf(screen.getByRole('table', { name: 'Document retention' }), 'Insurance'),
      ).getByRole('button', { name: /^Change/ }),
    );
    await userEvent.click(await screen.findByLabelText('Keep for ever'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByText('7 years')).toBeNull());
  });

  it('refuses years that are not a whole number from 1 to 100', async () => {
    const table = await openPage();
    await within(table).findByText('10 years');
    await userEvent.click(within(rowOf(table, 'Consent')).getByRole('button', { name: /^Change/ }));
    const field = await screen.findByLabelText(/Years kept/);
    await userEvent.clear(field);
    await userEvent.type(field, '101');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('This value is not in the expected format.'),
    ).toBeInTheDocument();
    expect(within(table).getByText('10 years')).toBeInTheDocument();
  });
});

describe('who sees what', () => {
  it('shows the rules but no Change without documentRetention:manage', async () => {
    revokePermission(HOSPITAL, 'admin', 'documentRetention:manage');
    const table = await openPage();
    await within(table).findByText('10 years');
    expect(screen.queryByRole('button', { name: /^Change/ })).toBeNull();
  });

  it('has no screen without documentRetention:read', async () => {
    revokePermission(HOSPITAL, 'admin', 'documentRetention:read');
    renderApp({ entry: '/document-retention' });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('heading', { name: 'Document retention' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Document retention' })).toBeNull();
  });

  it('has no screen when the documents module is off for the hospital', async () => {
    setTenantFeature(HOSPITAL, 'documents', false);
    renderApp({ entry: '/document-retention' });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('heading', { name: 'Document retention' })).toBeNull();
  });
});
