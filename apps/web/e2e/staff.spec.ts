import { expect, test, type Page } from '@playwright/test';
import { expectNoSidewaysScroll, goTo } from './support';

/**
 * Who works at the hospital, in a real browser against the mock backend, at every supported
 * width: invite someone and see the open invitation, accept an invitation from its link,
 * deactivate and reactivate a member, invite several people from a file, and set up a department
 * and a doctor with working hours.
 *
 * A full page load resets the mock, so everything after the first load happens inside the app.
 */

const heading = (page: Page, name: string) => page.getByRole('heading', { name, exact: true });
const status = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text });
const field = (page: Page, name: RegExp) => page.getByRole('textbox', { name });
const show = (page: Page, view: string) => page.getByLabel('Show').selectOption({ label: view });
/** A name as it stands in the list, not inside a sentence about that person. */
const inList = (page: Page, name: string) => page.getByText(name, { exact: true });

test('invite someone, then deactivate and reactivate a member', async ({ page }) => {
  await page.goto('/');
  await goTo(page, 'Staff');
  await expect(heading(page, 'Staff')).toBeVisible();
  await expect(status(page, '37 active members of staff')).toBeVisible();

  // Invite one person.
  await page.getByRole('link', { name: 'Invite staff' }).click();
  await expect(heading(page, 'Invite one person')).toBeVisible();
  await field(page, /^Name/).fill('Nina Rao');
  await field(page, /^Email/).fill('Nina.Rao@sample-hospital.test');
  await page.getByRole('combobox', { name: /^Role/ }).selectOption({ label: 'Doctor' });
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(
    status(page, 'An invitation was sent to nina.rao@sample-hospital.test.'),
  ).toBeVisible();
  // Ready for the next person, in the same role.
  await expect(field(page, /^Name/)).toHaveValue('');
  await expectNoSidewaysScroll(page);

  // The invitation is open until it is accepted.
  await page.getByRole('link', { name: 'Back to the staff list' }).click();
  await show(page, 'Open invitations');
  await expect(inList(page, 'Nina Rao')).toBeVisible();
  await expect(status(page, '2 open invitations')).toBeVisible();

  // Deactivate a member: a question first, then they are gone from the active staff.
  await show(page, 'Active staff');
  await page.getByRole('button', { name: 'Deactivate: Aarav Iyer' }).click();
  await expect(heading(page, 'Deactivate Aarav Iyer?')).toBeFocused();
  await expectNoSidewaysScroll(page);
  await page.getByRole('button', { name: 'Deactivate', exact: true }).click();
  await expect(status(page, 'Aarav Iyer was deactivated.')).toBeVisible();
  await expect(inList(page, 'Aarav Iyer')).toHaveCount(0);

  // They are among the deactivated staff, and can be brought back.
  await show(page, 'Deactivated staff');
  await expect(inList(page, 'Aarav Iyer')).toBeVisible();
  await page.getByRole('button', { name: 'Reactivate: Aarav Iyer' }).click();
  await expect(status(page, 'Aarav Iyer is active again.')).toBeVisible();
  await show(page, 'Active staff');
  await expect(inList(page, 'Aarav Iyer')).toBeVisible();
});

test('invite several people from a file', async ({ page }) => {
  await page.goto('/');
  await goTo(page, 'Staff');
  await page.getByRole('link', { name: 'Invite staff' }).click();
  await expect(heading(page, 'Invite several people from a file')).toBeVisible();

  const file = [
    'name;email;role',
    'Asha Rao;asha.rao@sample-hospital.test;Doctor',
    '"Rao, Vikram";vikram.rao@sample-hospital.test;admin',
    'No Address;not-an-address;Doctor',
  ].join('\r\n');
  await page
    .getByLabel('CSV file')
    .setInputFiles({ name: 'staff.csv', mimeType: 'text/csv', buffer: Buffer.from(file) });

  // Every row is shown, with what is wrong with it, before anything is sent.
  await expect(
    status(page, '2 of 3 rows can be sent. 1 row has a problem and will be left out.'),
  ).toBeVisible();
  await expect(page.getByText('Not an email address')).toBeVisible();
  await expect(inList(page, 'Rao, Vikram')).toBeVisible();
  await expectNoSidewaysScroll(page);

  await page.getByRole('button', { name: 'Send 2 invitations' }).click();
  await expect(status(page, '2 invitations were sent.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Send \d+ invitation/ })).toHaveCount(0);

  await page.getByRole('link', { name: 'Back to the staff list' }).click();
  await show(page, 'Open invitations');
  await expect(inList(page, 'Asha Rao')).toBeVisible();
  await expect(inList(page, 'Rao, Vikram')).toBeVisible();
});

test('accept an invitation from its link', async ({ page }) => {
  // Nobody is signed in on the invited person's own device.
  await page.goto('/invite?token=mock-invite-new&mockUser=none');
  await expect(heading(page, 'Accept your invitation')).toBeVisible();
  await expectNoSidewaysScroll(page);

  // A password that is too easy is refused, and the link is not used up.
  await page.getByRole('textbox', { name: 'New password', exact: true }).fill('password12345');
  await page.getByRole('textbox', { name: 'Confirm new password' }).fill('password12345');
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page.getByText('That password is too easy to guess.')).toBeVisible();

  await page
    .getByRole('textbox', { name: 'New password', exact: true })
    .fill('a long quiet harbour 42');
  await page.getByRole('textbox', { name: 'Confirm new password' }).fill('a long quiet harbour 42');
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(heading(page, 'Invitation accepted')).toBeVisible();

  await expect(page.getByRole('status')).toHaveText('You can now sign in to Sample Hospital.');

  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(heading(page, 'Sign in')).toBeVisible();
});

test('add a department and a doctor in it, with working hours', async ({ page }) => {
  await page.goto('/');
  await goTo(page, 'Departments');
  await expect(heading(page, 'Departments')).toBeVisible();
  await page.getByRole('button', { name: 'Add department' }).click();
  await field(page, /^Name/).fill('Audiology');
  await page.getByRole('button', { name: 'Save department' }).click();
  await expect(status(page, 'Audiology was added.')).toBeVisible();

  // A doctor is a member of staff with a profile, in one department.
  await goTo(page, 'Doctors');
  await expect(heading(page, 'Doctors')).toBeVisible();
  await page.getByRole('link', { name: 'Add a doctor' }).click();
  await page.getByRole('searchbox', { name: 'Find a staff member' }).fill('sample doc');
  await page.getByRole('radio', { name: /Sample Doctor/ }).check();
  await page.getByRole('combobox', { name: /^Department/ }).selectOption({ label: 'Audiology' });
  await field(page, /^Specialization/).fill('Hearing assessment');
  await expectNoSidewaysScroll(page);
  await page.getByRole('button', { name: 'Add doctor' }).click();

  await expect(heading(page, 'Sample Doctor')).toBeVisible();
  await expect(page.getByText('Hearing assessment')).toBeVisible();

  // Working hours: two sessions on a Monday.
  await page.getByRole('button', { name: 'Add hours on Monday' }).click();
  await page.getByLabel('Monday, session 1: from').fill('09:00');
  await page.getByLabel('Monday, session 1: to').fill('13:00');
  await page.getByRole('button', { name: 'Add hours on Monday' }).click();
  await page.getByLabel('Monday, session 2: from').fill('12:00');
  await page.getByLabel('Monday, session 2: to').fill('16:00');
  await page.getByRole('button', { name: 'Save working hours' }).click();
  await expect(page.getByText('Two sessions on this day overlap.')).toBeVisible();

  await page.getByLabel('Monday, session 2: from').fill('14:00');
  await page.getByRole('button', { name: 'Save working hours' }).click();
  await expect(status(page, 'The working hours were saved.')).toBeVisible();
  await expect(page.getByLabel('Monday, session 2: from')).toHaveValue('14:00');
  await expectNoSidewaysScroll(page);

  // The new doctor is in the list, under the new department.
  await page.getByRole('link', { name: 'Back to the doctor list' }).click();
  await page.getByRole('searchbox', { name: 'Search doctors' }).fill('hearing');
  await expect(page.getByRole('link', { name: 'Sample Doctor' })).toBeVisible();
  await expect(status(page, '1 doctor')).toBeVisible();
});
