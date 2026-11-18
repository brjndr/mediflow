# Hospital onboarding (platform admins)

For the operators of the product. A platform admin manages hospitals and has no access to patient data. The rules are in `docs/ARCHITECTURE.md` (Hospital onboarding rules) and the API notes in `apps/api/src/features/platform/CLAUDE.md`.

## 1. Make the first platform admin (once per deployment)

Done by an engineer with the API's environment (database URL, `APP_BASE_URL`), never through the UI or public sign-up:

```
pnpm --filter api platform:bootstrap --email=<address> --name="<name>"
```

- The link it prints is shown once, in that terminal only. Pass it to the person safely; it expires (the output says in how many hours).
- They follow it, choose a password, sign in and set up an authenticator. Platform routes refuse an account without a confirmed authenticator (403 `mfa_required`).
- Running it again for an existing address makes a new link instead of a second account.

## 2. Onboard a hospital (`/platform`)

Only platform admins see `/platform`; others get "no access". The screens need a desktop width.

1. **Hospitals, Create:** name, slug, locale, time zone, currency, and the modules to switch on. Creating makes the hospital active with its built-in roles and default permissions.
2. **Open the hospital's page:** check the module flags and limits (`max_users`). Turn on only what the hospital's contract covers. Authenticator switches: `mfa` makes it available, `mfa_required` makes it compulsory; decide with the hospital.
3. **Invite the first admin:** enter the address of the person the hospital named. Allowed only while the hospital is active and has no active admin, and never to a platform admin's address. The invite goes by email; open invites can be sent again or withdrawn on the same page.
4. **Hand over:** the hospital admin accepts the invite, sets a password and then creates staff, roles and master data themselves (see [`docs/guides/admin.md`](../guides/admin.md), the day-one checklist).
5. **Check:** the platform audit page lists every step, searchable by hospital and actor.

## 3. Changing a hospital later

- **Suspend:** staff lose access on their next request, open invites are withdrawn and sessions end. **Reactivate** reverses it. Each asks for confirmation.
- **Offboard:** schedules deletion after a grace period, queues an export and lets you email the hospital admin a download link. Confirm the export was downloaded before the deletion date (details in the platform API notes).
- Every action is written to the platform audit trail with ids and codes only. Do not put patient or staff details in anything you add there.

## Not covered yet

Hospital limits other than `max_users`, and break-glass support access (designed, not built; see the incident runbook). Production steps (where the bootstrap command runs, the production database login) wait for the CD pipeline (#146).
