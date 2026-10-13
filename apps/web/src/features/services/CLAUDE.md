# Services and prices: module notes

What this module is and what was decided for it. The root `CLAUDE.md` holds the rules every module follows, and it wins where the two disagree. Keep this file current with the module.

## What exists

**Services and prices (web and API):** the catalog of what the hospital charges for (code, name, category, tax class), with search, a category filter and an archived view; adding and editing with a version check; and prices with effective dates on the standard price list: a new price takes over from its own date, the one before it ends the day before, no price is ever edited, and only one that has not started can be withdrawn (#62). The first price may start today; once one is in force a new one starts tomorrow or later, so what was charged this morning stays what it was; and one price at a time is scheduled. Behind the `services` switch and the `service:read` and `service:manage` permissions. A desktop-only screen, the first to use `DesktopOnly`. Decided for now: one price list per hospital (the contract already names a list, for payers and room classes later); tax as a class, not a rate; a package is a category with its own price, and what it contains belongs with billing.

The API (#298) is described in `apps/api/CLAUDE.md`, under Services and prices. Where it goes further than the mock: the search finds every word of what was typed in the code or the name, in any order; a withdrawn price is kept and marked, not removed; and the standard price list is made with the hospital.
