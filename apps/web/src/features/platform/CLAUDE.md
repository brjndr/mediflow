# Platform admin (web)

What was decided for the platform admin screens (M13, PL-01 #125). The API is `apps/api/src/features/platform/CLAUDE.md`; the role's rules are in `docs/ARCHITECTURE.md`.

- **Not a registry feature.** A manifest is per hospital (flag, permissions, tenant policy) and a platform admin has no hospital, so the area is wired in `routes/index.tsx` under `/platform`, with its own shell (`app/PlatformShell.tsx`) and navigation (`nav.ts`, one list: PL-02 onwards add their items and routes). Nothing of it is in `appRegistry`, so no hospital flag reaches it.
- **Who may open it** comes from `session.user.isPlatformAdmin` (additive field of `GET /session`, from `users.is_platform_admin`), not a permission and not a role name. It steers the screens; every `/platform/*` route checks the flag and a confirmed authenticator on the server.
- **Others get the "no access" page** at `/platform/*` and nothing of the area loads. A platform admin on any hospital address (`/`, `/patients`) is sent to `/platform` (`RedirectPlatformAdmin`), so no patient-data screen is reachable from here, and none is in the navigation.
- **Authenticator first:** with none confirmed, only `/platform/security` opens (the same `SecurityPage`), as the server refuses every other platform route.
- Strings are in core `common.json` under `platform` until the screens grow; move them to a feature namespace with PL-02 if they do.
- Mock: `USER_IDS.platformAdmin` (no memberships; enable `setMockMfa` for it, or start the dev app with `?mockUser=user_platform_admin&mockMfa=on`). The registry-walking specs (`a11y`, `responsive`) do not reach this area, so `e2e/platform.spec.ts` walks its screens at all three widths: add new platform screens there.

## Hospitals (PL-02, #126)

- **List** `/platform/hospitals` (`HospitalList`): `DataGrid` over `GET /platform/hospitals` by cursor, filtered by status. **Create** `/platform/hospitals/new` (`HospitalWizard`): three steps (who, language/clock/look, modules/limits) in one form, so Back loses nothing. Next is the form's submit button on steps 1 and 2, so Enter advances and only the last step creates. Each step takes focus at its heading.
- **Query keys carry no hospital id** (`platformKeys`): a platform admin has none, and the cache is dropped whenever a session ends.
- **The idempotency key** is made once per request as typed (`useCreateHospital`), so a double click or a retry creates one hospital. A `slug_taken` (409) sends the wizard back to the slug with the message on it.
- **The slug is suggested from the name** until the person types one. A brand colour `themeFromBrandColor` would not theme with (too light for text on white) is refused in the form, instead of being stored and ignored.
- **Region** is a fixed list (`REGIONS`, only `in`) and the **modules offered** come from `GET /platform/modules` (`useModules`, #468), so a module added to the API appears with no web change except its name. Names are `platform.modules.<id>` in `common.json`; an id with no name is shown as the id (`useModuleName`).
- Strings are still in core `common.json` under `platform`.

## Modules and limits (PL-03, #127)

- **Page** `/platform/hospitals/:hospitalId` (`HospitalDetail`), opened from the hospital's name in the list. `HospitalModules` and `HospitalLimits` are separate forms with separate saves; later platform screens (status, invite) add sections to this page.
- **Modules:** a checklist saved with `PUT .../features`, sending only the flags that changed. A flag the hospital holds that the web list does not know is shown too, named by its id, so none is hidden. `mfa_required` can only be ticked while `mfa` is on, and goes off with it. A change reaches the hospital's staff at their next policy refresh; nothing here signs anyone out.
- **Limits:** `maxUsers` and `storageMb`, empty for none, saved with `PATCH` and `version`; only changed fields are sent. On a `version_conflict` the typed values stay, the hospital is read again, and a field both changed shows the other value. The limits are **stored, not enforced** (API notes).
- The saved hospital replaces the cached one (`platformKeys.hospital(id)`) and the list is read again.

## The first admin (PL-04, #128)

- **Section** `HospitalAdminInvites` on a hospital's page, shown while the hospital is `active` (the API refuses an invite otherwise). A name and an email, then the list of open invites (a `DataGrid`, cursor envelope without a cursor: at most 50) with **Send again** and **Withdraw** on each row.
- **Send again is the same invite route** with the row's name and email: the API withdraws the earlier invite to that address and emails a new link. There is no resend route. Expired invites stay in the list, marked, so they can be sent again.
- **Refusals have their own words:** `hospital_has_admin` (once the hospital has an admin, its admins invite their own staff), `hospital_not_active`, and 400 for a platform admin's address. The address is lower-cased before it is sent, as the API does.
- **Focus:** a withdrawn row leaves the list, so focus goes to the status line (`focusIfLost`), which also says what was done.
- **Mock:** a mock hospital with staff (`memberCount > 0`) has an admin, so an invite to it is refused; create a hospital first to invite into one. An address starting `platform.` stands for a platform admin's.
- The invitee onboards through the link as any invited member (A-03).

## Suspend, reactivate, offboard (PL-05, #129)

- **Section** `HospitalStatus` at the top of a hospital's page: the status in words with its dates, and the actions that apply (active: Suspend, Offboard; suspended: Reactivate, Offboard; offboarding: Reactivate, which cancels it and clears the dates).
- **Every action asks first** in a `ConfirmDialog` (`shared/ui/confirm-dialog`) that says what happens: staff are signed out now, open invites are withdrawn, nothing is deleted. Cancel has focus first. **Offboard** also needs the hospital's slug typed back and the days (1 to 3650, default 90) before its data may be deleted.
- **The export and the deletion are not built** (API notes): offboarding closes the hospital and marks a date, and the dialog and the page say that nothing is deleted yet. Do not word a screen as if an export ran.
- **A refused change** (409 `invalid_transition`: someone changed the status first) is said in words and the hospital is read again, so the page shows the status it has.
- **Focus:** the button that asked often goes away (Suspend becomes Reactivate), so after a change focus goes to the status line (`focusIfLost`), which also says what was done.
- **Suspended users see the suspended page** through `tenancy/SuspendedPage` (the tenancy hook answers 403 `tenant_suspended`); `app/layout.test.tsx` covers it, including a suspension during an open session.
- Mock: the three routes follow the API's transitions; suspend and offboard withdraw the hospital's open invites.

## Audit trail (PL-06, #130)

- **Screen** `/platform/audit` (`routes/AuditView`): `DataGrid` over `GET /platform/audit` by cursor (50 a page), newest first. The nav item is `audit` in `nav.ts`; `e2e/platform.spec.ts` walks it.
- **Filters:** a hospital (a select over the first 100 hospitals; rows of a hospital not in that list read "Removed hospital") and an actor. `actorId` is an additive query parameter of the API. The platform role has no grant on `users`, so an actor is shown and searched **by id**, not by name; an input that is not an id is refused in words and not sent.
- Action codes (`hospital.create`) are translated through `platform.audit.actions.<code with _ for .>`; an unknown code is shown as it is. `detail` holds ids and codes only and is shown as `key: value`.
