import { expect, test } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, goTo } from './support';

/**
 * The insurance flow (IN-06, #186) in a real browser against the mock backend, at every
 * supported width: a patient's policy, a pre-authorization asked for and answered, the visit's
 * bill split between the patient and the payer, and the claim prepared, sent, approved and paid.
 *
 * A full page load resets the mock, so everything after the first load happens inside the app.
 * Axe runs with no dialog open: a dimmed page behind a dialog is not what is being checked.
 */

test('policy, pre-authorization, split bill and claim', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');

  // The patient's insurance tab: the sample Gold policy is there; a second one is added.
  await goTo(page, 'Patients');
  await page.getByRole('main').getByRole('link', { name: /Verma/ }).first().click();
  await page.getByRole('tab', { name: 'Insurance' }).click();
  await expect(page.getByText('STAR-2026-0001')).toBeVisible();

  await page.getByRole('button', { name: 'Add a policy' }).click();
  const policy = page.getByRole('dialog', { name: 'Add an insurance policy' });
  await policy.getByRole('button', { name: 'Save' }).click();
  await expect(policy.getByText(/required/i).first()).toBeVisible();
  await policy
    .getByRole('combobox', { name: /Insurer, TPA or corporate/ })
    .selectOption('pyr_h_star');
  await policy.getByRole('combobox', { name: /^Plan/ }).selectOption('pln_h_gold');
  await policy.getByLabel(/Policy number/).fill('STAR-E2E-1');
  await policy.getByLabel(/Policy holder/).fill('Second Holder');
  await policy.getByLabel(/Valid from/).fill('2026-11-01');
  await policy.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('STAR-E2E-1')).toBeVisible();
  await expectNoAxeViolations(page);

  // Pre-authorization: asked for, then answered.
  await page.getByRole('button', { name: 'Request pre-authorization' }).click();
  const ask = page.getByRole('dialog', { name: 'Request pre-authorization' });
  await ask.getByRole('combobox', { name: /Policy/ }).selectOption({ index: 1 });
  await ask.getByLabel(/Treatment or procedure/).fill('Day-care cataract surgery');
  await ask.getByLabel(/Amount asked for/).fill('30000');
  await ask.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByText('Day-care cataract surgery')).toBeVisible();
  await expect(page.getByText('Waiting for the payer').first()).toBeVisible();
  await page.getByRole('button', { name: 'Record the answer' }).click();
  const answer = page.getByRole('dialog', { name: 'Record the payer’s answer' });
  await answer.getByLabel(/Amount approved/).fill('25000');
  await answer.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('The approval was recorded.')).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  // The visit's bill: the cover panel and the split, which adds up.
  await goTo(page, 'Consultations');
  await page.getByRole('main').getByRole('link').first().click();
  await page.getByRole('link', { name: 'Create invoice' }).click();
  await expect(page.getByRole('heading', { name: 'New invoice', level: 1 })).toBeVisible();
  const split = page.getByRole('region', { name: 'Split between the patient and the payer' });
  await expect(split.getByTestId('split-ledger')).toContainText('901.00');
  await expect(split.getByText('The split adds up to the charges')).toBeVisible();
  await expect(split.getByTestId('split-patient')).toBeVisible();
  await expect(split.getByTestId('split-payer')).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  // The claim is prepared from the split.
  await split.getByRole('button', { name: 'Prepare a claim' }).click();
  const packet = page.getByRole('dialog', { name: 'Prepare a claim' });
  await packet.getByLabel('Documents enclosed').fill('Final bill');
  await packet.getByRole('button', { name: 'Prepare claim' }).click();
  await expect(split.getByText(/was prepared/)).toBeVisible();
  await split.getByRole('link', { name: 'Open the claim' }).click();
  await expect(page.getByRole('heading', { name: /^Claim CLM-/, level: 1 })).toBeVisible();
  await expect(page.getByText('Being prepared')).toBeVisible();

  const step = async (action: string, fill?: [string, string]) => {
    await page
      .getByRole('region', { name: 'What you can do' })
      .getByRole('button', { name: action })
      .click();
    const dialog = page.getByRole('dialog');
    if (fill) await dialog.getByLabel(fill[0]).fill(fill[1]);
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  };
  await step('Send to the payer');
  await expect(page.getByText('Sent to the payer').first()).toBeVisible();
  await step('Record approval', ['Amount approved', '500']);
  await expect(page.getByText('Approved, payment due').first()).toBeVisible();
  await step('Record payment', ['Amount received', '500']);
  await expect(page.getByText('Paid').first()).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  // And it is on the list of claims.
  await page.getByRole('link', { name: 'Back to the claims' }).click();
  await expect(page.getByRole('heading', { name: 'Insurance claims', level: 1 })).toBeVisible();
  await expectNoAxeViolations(page);
});
