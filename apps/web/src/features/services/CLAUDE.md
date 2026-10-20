# Services and prices: module notes

What this module is and what was decided for it. The root `CLAUDE.md` holds the rules every module follows, and it wins where the two disagree. Keep this file current with the module.

## What exists

**Services and prices (web and API):** the catalog of what the hospital charges for (code, name, category, tax class), with search, a category filter and an archived view; adding and editing with a version check; and prices with effective dates on the standard price list: a new price takes over from its own date, the one before it ends the day before, no price is ever edited, and only one that has not started can be withdrawn (#62). The first price may start today; once one is in force a new one starts tomorrow or later, so what was charged this morning stays what it was; and one price at a time is scheduled. Behind the `services` switch and the `service:read` and `service:manage` permissions. A desktop-only screen, the first to use `DesktopOnly`. Decided for now: one price list per hospital (the contract already names a list, for payers and room classes later); tax as a class, not a rate; a package is a category with its own price, and what it contains belongs with billing.

The API (#298) is described in `apps/api/src/features/services/CLAUDE.md`. Where it differs from the mock: the search finds every word of what was typed in the code or the name, in any order; services are in the order the database gives their lower-cased names, not the browser's; `total` comes with the first page only; a `code` sent with a change is dropped, not refused; a withdrawn price is kept and marked, not removed; and the standard price list is made with the hospital.

## Decided

- **Text is plain and tidied (#306).** The API stores a name in one normal form with single spaces and refuses a control character and anything that prints as nothing (#322); a search term is tidied instead of refused; a description keeps its lines. The form checks the same patterns (`PLAIN_TEXT`, `PLAIN_LINES` of `shared/utils/text.ts`) and gives a pasted invisible character a message of its own. Rows written before this are left as they are and tidied when next changed: see `apps/api/src/core/http/CLAUDE.md`.
- **`ServiceSearch` is how another module orders a service (#87):** a search box for one category (imaging, procedure), the term in the body of `POST /services/search`, archived services left out, ten matches at a time. It gives the id, code and name only, never a price, as `useServiceOptions` does. It needs `service:read` and the `services` switch; without them the box says so and asks for nothing.
- **Services can be loaded from a file (#68),** through the import centre (`features/imports`), with a first price on the standard list from today. The API's create rules are in `features/services/create.ts`, which `POST /services` and the import both use: change them there.
