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
- **Region** is a fixed list (`REGIONS`, only `in`) and **starting modules** a constant (`STARTING_MODULES`, the web registry's flags). PL-03 (#127) replaces the module list with the one the API gives.
- Strings are still in core `common.json` under `platform`.
