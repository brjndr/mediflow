import { expect, test } from '@playwright/test';

test('app loads and reaches the (mock) API', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Hospital management system' })).toBeVisible();
  await expect(page.getByTestId('api-status')).toHaveText('ok');
});
