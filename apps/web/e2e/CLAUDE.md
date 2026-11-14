# End-to-end checks

Moved out of the root `CLAUDE.md` (#370), which keeps the rule; Claude Code loads this file when a file of this folder is read. Read it before changing or using what is here.

## Responsive (how it is checked)

- **Playwright runs every spec at three widths** (`apps/web/playwright.config.ts`): desktop, tablet (768 px, touch) and phone (360 px, touch). `e2e/responsive.spec.ts` checks that screens fit the width, that lists become cards, and that controls are touch-sized. Add a new screen to it.
- **Specs reach the navigation through `goTo(page, name)`** from `e2e/support.ts`, which uses the sidebar or the drawer as the width requires. A spec that depends on a table uses `gridIsStacked(page)` to pick the table or the cards.
- "Works at phone and tablet width" is in the definition of done of every frontend issue.

## WebKit (Safari on iOS, #334)

- **CI only:** `playwright.config.ts` adds a `webkit-phone` project (iPhone 14 profile, about 390 px, touch) when `CI` is set; the dev machine keeps Chromium alone. It runs a subset to keep CI time down: `responsive`, `login`, `patients`, `appointments` and `webkit` specs.
- `e2e/webkit.spec.ts` (skipped in other projects) checks what WebKit does differently: date inputs, `pointer: coarse`, 44 px targets, inputs of 16 px or more and no zoom on focus, `BroadcastChannel` sign-out across tabs, and the idle timer with a tab in the background.
- A check that cannot pass on WebKit is marked `test.fixme(browserName === 'webkit', 'reason, #issue')` in the spec, never deleted.

## Accessibility (checks every screen gets)

- **axe in the unit tests:** `expectNoAxeViolations` from `src/test/axe.ts` on the rendered screen (contrast is off in jsdom).
- **axe in Playwright:** in a real browser with contrast on, through `expectNoAxeViolations` from `e2e/support.ts` (the WCAG 2.2 AA tags). `e2e/a11y.spec.ts` reads every route from the registry and checks it at desktop and phone width, and a form that adds a record sent empty, so a new route needs nothing added. A route with an id finds its record from a link on the list above it, or from `RECORDS` in that spec. A rule switched off on one screen goes in its `KNOWN` list, with the issue that will fix it (#338).
- **A keyboard test in Playwright:** the screen's main task done with the keyboard alone (reach it, fill it, submit it, close what opened), with focus visible at each step.
- **Live regions under a modal (#763):** Radix `hideOthers` leaves an `aria-live`, `role="status"` or `role="alert"` element and all its ancestors exposed, so a live region in the header or sidebar kept that landmark visible under a dialog and broke axe on tablet (#730). `expectModalHidesLandmarks` (`e2e/support.ts`) fails when one sits in a landmark other than `main` with a modal open; `a11y.spec.ts` runs it on the housekeeping dialog. Keep live regions out of the header, navigation and sidebar, or inside the dialog.
- **Dark and brand colors (#714):** the header has a theme switch (#730, light, dark or system, kept in `localStorage` as `mediflow.theme`); `A11Y_DARK=1 pnpm --filter web e2e a11y.spec.ts` saves "dark" there and runs the whole file in dark (CI runs light only). `a hospital brand colour passes axe` applies the tokens of four brand colors to the landing page, in light only: `themeFromBrandColor` guarantees a brand color on white, so on the dark page the widget links in the primary color fail contrast (checked in #714, follow-up filed).
- `eslint-plugin-jsx-a11y` runs in lint.
- "Keyboard and axe checked for changed screens" is in the PR template and in the definition of done of every issue.

## Audit of 2026-11-07 (H-02, #139)

- **axe in CI:** `a11y.spec.ts` runs with the e2e suite on every PR, over every registered route plus empty, error and form-error states. Its `KNOWN` list is empty: no rule is switched off anywhere, so there are no known violations of any impact.
- **Keyboard pass on critical flows:** every module that has a task has a "with the keyboard alone" spec (sign-in, patients, appointments, queue, triage, consultation, prescriptions, orders, lab, radiology, pharmacy, inventory, purchasing, indents, billing, cash register, reports, roles, platform, catalogs). The landing page and notices were the gap and are in `dashboard-notices.spec.ts`.
- **Screen reader:** not run with a real reader (NVDA or VoiceOver) on this machine. What it relies on is checked in code: names for controls and icons (axe, `jsx-a11y`), live regions for saved, refused and busy states, a title that takes focus on each step, and `<main>` focused on navigation. A manual pass with NVDA on the sign-in, a consultation and an invoice is still to be done by a person and recorded here.

## Critical flows (H-04, #141)

`critical-flows.spec.ts` chains the modules in one session, as the pilot uses them: register a patient, issue a token, vitals and allergies, call the token, consultation, lab order and prescription, the lab (collect, receive, result, verify) and the result back in the consultation, the pharmacy dispense, then a service charged to the visit, the invoice issued and paid in full. It then checks the role matrix (receptionist, pharmacist and store keeper reach their own links and get "no access", with no request for the screen's data, on a forbidden address) and that a second hospital cannot open the first one's consultation. It runs with the rest of the suite on every PR, at all three widths. The module specs still own each screen's keyboard and detail checks; add to this one only when two modules hand over to each other.

## Unit tests without isolation (#535)

`isolate: false` in `vitest.config.ts` was tried again (#535). Run in one worker per file it passes, but with 2 workers on a loaded machine the same suite fails at random: once `clinical.test.tsx` "opens the encounter from the token being served" with an undici `assert(!this.aborted)` (a queue event stream the browser aborts while the mock closes it), other runs 17 calendar tests or 2 prescription tests on timeouts. No single leaking test was found; the failures move between runs, so it is shared timers, streams and module state under load, not one test. `isolate` stays on. One real leak was fixed: `server.events` listeners from `watchOpens` were never removed, so `setup.ts` now clears them after each test. The queue stream race is fixed (#632): the mock no longer closes, pings or publishes to a stream whose request the browser has aborted. Tried again on `src/features/queue` and `src/features/clinical` with `--no-isolate`: the undici assert did not come back, the run took 126 s against 199 s isolated, but `clinical.test.tsx` "opens the encounter from the token being served" still timed out at 5 s (isolated: 212 of 212 pass). `isolate` stays on; the remaining cause is load, not the stream.

## Records and operations screens (#565)

`records-operations.spec.ts` covers the patient's Documents and Consents tabs, housekeeping, the blood bank and document retention: fit at every width, axe on the forms, and the keyboard alone (tabs move with the arrow keys, since they use a roving tabindex). Known gap: closing the housekeeping "Request a cleaning" dialog leaves focus on the page body, so that spec does not assert the return of focus (the blood bank one does).
