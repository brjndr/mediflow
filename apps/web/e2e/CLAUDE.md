# End-to-end checks

Moved out of the root `CLAUDE.md` (#370), which keeps the rule; Claude Code loads this file when a file of this folder is read. Read it before changing or using what is here.

## Responsive (how it is checked)

- **Playwright runs every spec at three widths** (`apps/web/playwright.config.ts`): desktop, tablet (768 px, touch) and phone (360 px, touch). `e2e/responsive.spec.ts` checks that screens fit the width, that lists become cards, and that controls are touch-sized. Add a new screen to it.
- **Specs reach the navigation through `goTo(page, name)`** from `e2e/support.ts`, which uses the sidebar or the drawer as the width requires. A spec that depends on a table uses `gridIsStacked(page)` to pick the table or the cards.
- "Works at phone and tablet width" is in the definition of done of every frontend issue.

## Accessibility (checks every screen gets)

- **axe in the unit tests:** `expectNoAxeViolations` from `src/test/axe.ts` on the rendered screen (contrast is off in jsdom).
- **axe in Playwright:** in a real browser with contrast on, through `expectNoAxeViolations` from `e2e/support.ts` (the WCAG 2.2 AA tags). `e2e/a11y.spec.ts` reads every route from the registry and checks it at desktop and phone width, and a form that adds a record sent empty, so a new route needs nothing added. A route with an id finds its record from a link on the list above it, or from `RECORDS` in that spec. A rule switched off on one screen goes in its `KNOWN` list, with the issue that will fix it (#338).
- **A keyboard test in Playwright:** the screen's main task done with the keyboard alone (reach it, fill it, submit it, close what opened), with focus visible at each step.
- `eslint-plugin-jsx-a11y` runs in lint.
- "Keyboard and axe checked for changed screens" is in the PR template and in the definition of done of every issue.
