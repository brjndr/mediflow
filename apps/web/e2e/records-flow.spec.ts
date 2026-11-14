import { expect, test } from '@playwright/test';
import { goTo } from './support';

/**
 * The records flow end to end (MR-05, #193), in a real browser against the mock backend: add a
 * document to a patient, sign a consent for the same patient, then merge another record into
 * it and see the merge in its history. A full page load resets the mock, so everything after
 * the first load happens inside the app.
 */
test('upload a document, sign a consent and merge a duplicate', async ({ page }) => {
  await page.goto('/');
  await goTo(page, 'Patients');
  const list = page.locator('[aria-label="Patients"]');
  await expect(page.getByRole('heading', { name: 'Patients', exact: true })).toBeVisible();
  const links = list.getByRole('link');
  const duplicateName = ((await links.nth(1).textContent()) ?? '').trim();
  expect(duplicateName).not.toBe('');
  await links.first().click();

  // Upload.
  await page.getByRole('tab', { name: 'Documents' }).click();
  await page.getByRole('button', { name: 'Add document' }).click();
  await page.getByLabel('File').setInputFiles({
    name: 'referral-letter.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 test'),
  });
  await page.getByRole('button', { name: 'Upload' }).click();
  await expect(page.getByText(/referral-letter was uploaded/)).toBeVisible();

  // Consent, signed by typing the name.
  await page.getByRole('tab', { name: 'Consents and certificates' }).click();
  await page.getByRole('button', { name: 'Record a consent' }).click();
  await page.getByLabel('Consent form').selectOption({ index: 1 });
  await page.getByLabel('Procedure').fill('Appendectomy');
  await expect(page.getByRole('heading', { name: 'Text to be signed' })).toBeVisible();
  await page.getByLabel('Name of the signer').fill('Asha Rao');
  await page.getByLabel('Type the name instead').check();
  await page.getByLabel(/The signer has read the text above/).check();
  await page.getByRole('button', { name: 'Sign the consent' }).click();
  await expect(page.getByText(/The consent for Appendectomy was signed and kept/)).toBeVisible();

  // Merge.
  await page.getByRole('link', { name: 'Merge a duplicate' }).click();
  await expect(page.getByRole('heading', { name: 'Merge a duplicate record' })).toBeVisible();
  await page.getByLabel(/Find the duplicate to merge/).fill(duplicateName.split(' ')[0] ?? '');
  await page.getByRole('option').filter({ hasText: duplicateName }).first().click();
  await page
    .getByLabel('Why these records are the same patient')
    .fill('Same person registered twice');
  await page.getByRole('button', { name: 'Merge records' }).click();
  await page.getByRole('button', { name: 'Merge', exact: true }).click();
  await expect(page.getByText('The records were merged.')).toBeVisible();
  await page.getByRole('link', { name: 'Open the patient' }).click();
  await page.getByRole('tab', { name: 'Merge history' }).click();
  await expect(page.getByText('Same person registered twice')).toBeVisible();
});
