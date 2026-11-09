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
- `eslint-plugin-jsx-a11y` runs in lint.
- "Keyboard and axe checked for changed screens" is in the PR template and in the definition of done of every issue.

## Audit of 2026-11-07 (H-02, #139)

- **axe in CI:** `a11y.spec.ts` runs with the e2e suite on every PR, over every registered route plus empty, error and form-error states. Its `KNOWN` list is empty: no rule is switched off anywhere, so there are no known violations of any impact.
- **Keyboard pass on critical flows:** every module that has a task has a "with the keyboard alone" spec (sign-in, patients, appointments, queue, triage, consultation, prescriptions, orders, lab, radiology, pharmacy, inventory, purchasing, indents, billing, cash register, reports, roles, platform, catalogs). The landing page and notices were the gap and are in `dashboard-notices.spec.ts`.
- **Screen reader:** not run with a real reader (NVDA or VoiceOver) on this machine. What it relies on is checked in code: names for controls and icons (axe, `jsx-a11y`), live regions for saved, refused and busy states, a title that takes focus on each step, and `<main>` focused on navigation. A manual pass with NVDA on the sign-in, a consultation and an invoice is still to be done by a person and recorded here.

## Critical flows (H-04, #141)

`critical-flows.spec.ts` chains the modules in one session, as the pilot uses them: register a patient, issue a token, vitals and allergies, call the token, consultation, lab order and prescription, the lab (collect, receive, result, verify) and the result back in the consultation, the pharmacy dispense, then a service charged to the visit, the invoice issued and paid in full. It then checks the role matrix (receptionist, pharmacist and store keeper reach their own links and get "no access", with no request for the screen's data, on a forbidden address) and that a second hospital cannot open the first one's consultation. It runs with the rest of the suite on every PR, at all three widths. The module specs still own each screen's keyboard and detail checks; add to this one only when two modules hand over to each other.

## Unit tests without isolation (#535)

`isolate: false` in `vitest.config.ts` was tried again (#535). Run in one worker per file it passes, but with 2 workers on a loaded machine the same suite fails at random: once `clinical.test.tsx` "opens the encounter from the token being served" with an undici `assert(!this.aborted)` (a queue event stream the browser aborts while the mock closes it), other runs 17 calendar tests or 2 prescription tests on timeouts. No single leaking test was found; the failures move between runs, so it is shared timers, streams and module state under load, not one test. `isolate` stays on. One real leak was fixed: `server.events` listeners from `watchOpens` were never removed, so `setup.ts` now clears them after each test. Try again only with a fix for the queue stream abort race in `mocks/handlers/queue.ts`.
