import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { revokePermission, setTenantFeature, TENANT_IDS } from '@/mocks/db';
import { mockConsentAudit } from '@/mocks/handlers/consents';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// Consents and certificates (MR-02, #190): the tab of the patient's screen. The mock's hospital
// has one signed consent and one medical certificate on pth_00001.

const HOSPITAL = TENANT_IDS.hospital;

async function openTab() {
  renderApp({ entry: '/patients/pth_00001?tab=consents' });
  await screen.findByRole('tab', { name: 'Consents and certificates', selected: true });
  const consents = await screen.findByRole('table', { name: 'Consents' });
  const certificates = await screen.findByRole('table', { name: 'Certificates' });
  return { consents, certificates };
}

describe('the consents and certificates tab', () => {
  it('lists what was signed and issued, and has no axe violations', async () => {
    const { consents, certificates } = await openTab();
    expect(await within(consents).findByText('Appendectomy')).toBeInTheDocument();
    expect(within(consents).getByText('Asha Verma (Patient)')).toBeInTheDocument();
    expect(await within(certificates).findByText('MED-2026-0001')).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it('shows a signed consent as it was kept, with nothing to change or remove', async () => {
    const { consents } = await openTab();
    await within(consents).findByText('Appendectomy');
    await userEvent.click(within(consents).getByRole('button', { name: /^View/ }));
    await screen.findByRole('heading', { name: 'Consent for Appendectomy' });
    expect(
      await screen.findByText('I, Asha Verma, consent to Appendectomy at Sample Hospital.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Signed by typing the name Asha Verma.')).toBeInTheDocument();
    expect(screen.getByText(/cannot be changed or removed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit|delete|remove|retire/i })).toBeNull();
    expect(mockConsentAudit(HOSPITAL)).toContainEqual({
      tenantId: HOSPITAL,
      consentId: 'cns_h_1',
    });
  });

  it('signs a consent from a template, filled in for the patient and the procedure', async () => {
    const { consents } = await openTab();
    await within(consents).findByText('Appendectomy');
    await userEvent.click(screen.getByRole('button', { name: 'Record a consent' }));
    await screen.findByRole('heading', { name: 'Record a consent' });
    await userEvent.selectOptions(
      await screen.findByLabelText(/^Consent form/),
      await screen.findByRole('option', { name: 'Consent for a procedure' }),
    );
    await userEvent.type(screen.getByLabelText(/^Procedure/), 'Hernia repair');
    expect(
      await screen.findByText(/consent to Hernia repair at Sample Hospital/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\{\{/)).toBeNull();

    await userEvent.type(screen.getByLabelText(/^Name of the signer/), 'Ravi Kumar');
    await userEvent.selectOptions(screen.getByLabelText(/^Signing as/), 'guardian');
    // Not signed without a signature.
    await userEvent.click(screen.getByRole('button', { name: 'Sign the consent' }));
    expect(
      await screen.findByText('Draw the signature, or choose to type the name instead.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/was signed and kept/)).toBeNull();

    await userEvent.click(screen.getByLabelText('Type the name instead'));
    await userEvent.click(screen.getByRole('button', { name: 'Sign the consent' }));
    expect(
      await screen.findByText('Confirm that the signer agrees to the text.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/The signer has read the text/));
    await userEvent.click(screen.getByRole('button', { name: 'Sign the consent' }));
    expect(
      await screen.findByText('The consent for Hernia repair was signed and kept.'),
    ).toBeInTheDocument();
    expect(await within(consents).findByText('Ravi Kumar (Guardian)')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Record a consent' })).toBeNull();
  });

  it('refuses a consent with no procedure or signer name', async () => {
    const { consents } = await openTab();
    await within(consents).findByText('Appendectomy');
    await userEvent.click(screen.getByRole('button', { name: 'Record a consent' }));
    await userEvent.click(await screen.findByLabelText('Type the name instead'));
    await userEvent.click(screen.getByRole('button', { name: 'Sign the consent' }));
    expect((await screen.findAllByText('This field is required.')).length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it('issues a certificate of the kind chosen and numbers it', async () => {
    const { certificates } = await openTab();
    await within(certificates).findByText('MED-2026-0001');
    await userEvent.selectOptions(screen.getByLabelText('Kind of certificate'), 'death');
    await userEvent.click(screen.getByRole('button', { name: 'Issue a certificate' }));
    await screen.findByRole('heading', { name: 'Issue a Death certificate' });

    // The required fields of the kind are asked for.
    await userEvent.click(screen.getByRole('button', { name: 'Issue the certificate' }));
    expect((await screen.findAllByText('This field is required.')).length).toBeGreaterThanOrEqual(
      4,
    );

    await userEvent.type(screen.getByLabelText(/^Name of the deceased/), 'Mohan Das');
    await userEvent.type(screen.getByLabelText(/^Date of death/), '2026-11-01');
    await userEvent.type(screen.getByLabelText(/^Place of death/), 'Ward 4');
    await userEvent.type(screen.getByLabelText(/^Cause of death/), 'Cardiac arrest');
    await userEvent.selectOptions(screen.getByLabelText(/^Manner of death/), 'natural');
    await userEvent.click(screen.getByRole('button', { name: 'Issue the certificate' }));
    expect(await screen.findByText(/Certificate DTH-\d{4}-0001 was issued\./)).toBeInTheDocument();
    await waitFor(() => expect(within(certificates).getAllByRole('row')).toHaveLength(3));
    await userEvent.click(within(certificates).getAllByRole('button', { name: /^View/ })[0]!);
    expect(await screen.findByText('Mohan Das')).toBeInTheDocument();
    expect(screen.getByText('Natural')).toBeInTheDocument();
  });

  it('refuses a medical certificate whose rest ends before it starts', async () => {
    const { certificates } = await openTab();
    await within(certificates).findByText('MED-2026-0001');
    await userEvent.click(screen.getByRole('button', { name: 'Issue a certificate' }));
    await userEvent.type(await screen.findByLabelText(/^Diagnosis/), 'Fever');
    await userEvent.type(screen.getByLabelText(/^Rest advised from/), '2026-11-05');
    await userEvent.type(screen.getByLabelText(/^Rest advised until/), '2026-11-02');
    await userEvent.click(screen.getByRole('button', { name: 'Issue the certificate' }));
    expect(
      await screen.findByText('This value is not in the expected format.'),
    ).toBeInTheDocument();
  });
});

describe('who sees what', () => {
  it('offers neither signing nor issuing without consent:sign and certificate:issue', async () => {
    revokePermission(HOSPITAL, 'admin', 'consent:sign');
    revokePermission(HOSPITAL, 'admin', 'certificate:issue');
    const { consents } = await openTab();
    await within(consents).findByText('Appendectomy');
    expect(screen.queryByRole('button', { name: 'Record a consent' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Issue a certificate' })).toBeNull();
    expect(within(consents).getAllByRole('button', { name: /^View/ }).length).toBeGreaterThan(0);
  });

  it('shows only the certificates without consent:read, and reads no consent', async () => {
    revokePermission(HOSPITAL, 'admin', 'consent:read');
    renderApp({ entry: '/patients/pth_00001?tab=consents' });
    expect(await screen.findByRole('table', { name: 'Certificates' })).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Consents' })).toBeNull();
  });

  it('has no tab without either read permission', async () => {
    revokePermission(HOSPITAL, 'admin', 'consent:read');
    revokePermission(HOSPITAL, 'admin', 'certificate:read');
    renderApp({ entry: '/patients/pth_00001' });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('tab', { name: 'Consents and certificates' })).toBeNull();
    expect(mockConsentAudit(HOSPITAL)).toEqual([]);
  });

  it('has no tab when the module is off for the hospital', async () => {
    setTenantFeature(HOSPITAL, 'consents', false);
    renderApp({ entry: '/patients/pth_00001' });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('tab', { name: 'Consents and certificates' })).toBeNull();
  });
});

describe('printing a signed record (#568)', () => {
  it('prints a consent with its text and signer, and a certificate with its fields', async () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    try {
      const { consents, certificates } = await openTab();
      await within(consents).findByText('Appendectomy');
      await userEvent.click(within(consents).getByRole('button', { name: /^View/ }));
      await screen.findByText(/consent to Appendectomy at Sample Hospital/);
      await userEvent.click(await screen.findByRole('button', { name: 'Print' }));
      await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
      const sheet = document.querySelector<HTMLElement>('[data-print-sheet]')!;
      expect(
        within(sheet).getByRole('heading', { name: 'Consent for Appendectomy' }),
      ).toBeInTheDocument();
      expect(sheet).toHaveTextContent('Asha Verma');
      expect(sheet).toHaveTextContent('Signed by typing the name Asha Verma.');
      window.dispatchEvent(new Event('afterprint'));
      await waitFor(() => expect(document.querySelector('[data-print-sheet]')).toBeNull());

      await userEvent.click(within(certificates).getAllByRole('button', { name: /^View/ })[0]!);
      await userEvent.click(await screen.findByRole('button', { name: 'Print' }));
      await waitFor(() => expect(print).toHaveBeenCalledTimes(2));
      expect(document.querySelector('[data-print-sheet]')).toHaveTextContent('MED-2026-0001');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
