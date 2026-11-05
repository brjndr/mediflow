# Platform admin (web)

What was decided for the platform admin screens (M13, PL-01 #125). The API is `apps/api/src/features/platform/CLAUDE.md`; the role's rules are in `docs/ARCHITECTURE.md`.

- **Not a registry feature.** A manifest is per hospital (flag, permissions, tenant policy) and a platform admin has no hospital, so the area is wired in `routes/index.tsx` under `/platform`, with its own shell (`app/PlatformShell.tsx`) and navigation (`nav.ts`, one list: PL-02 onwards add their items and routes). Nothing of it is in `appRegistry`, so no hospital flag reaches it.
- **Who may open it** comes from `session.user.isPlatformAdmin` (additive field of `GET /session`, from `users.is_platform_admin`), not a permission and not a role name. It steers the screens; every `/platform/*` route checks the flag and a confirmed authenticator on the server.
- **Others get the "no access" page** at `/platform/*` and nothing of the area loads. A platform admin on any hospital address (`/`, `/patients`) is sent to `/platform` (`RedirectPlatformAdmin`), so no patient-data screen is reachable from here, and none is in the navigation.
- **Authenticator first:** with none confirmed, only `/platform/security` opens (the same `SecurityPage`), as the server refuses every other platform route.
- Strings are in core `common.json` under `platform` until the screens grow; move them to a feature namespace with PL-02 if they do.
- Mock: `USER_IDS.platformAdmin` (no memberships; enable `setMockMfa` for it). Not yet in the Playwright responsive and a11y specs, which only walk registered routes (add when PL-02 gives the area a screen worth walking).
