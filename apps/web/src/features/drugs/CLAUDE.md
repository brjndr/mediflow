# Drugs and consumables: module notes

What this module is and what was decided for it. The root `CLAUDE.md` holds the rules every module follows, and it wins where the two disagree. Keep this file current with the module.

## What exists

**Drugs and consumables (web, against the mock):** what each medicine and consumable the hospital keeps is (generic name, brand, form, strength, unit, drug schedule, controlled or not, tax class, reorder level), in one list with a type; server search on every word, filters for type, form, schedule and controlled drugs, and an archived view; adding with a warning when the list has the same generic name in the same form, and a refusal for exactly the same item; editing with a version check (#63). Behind the `drugs` switch and the `drug:read` and `drug:manage` permissions. Desktop-only. Decided for now: no price and no stock here (a selling price goes with the batch, in the pharmacy); the schedule is recorded as a class, and what each schedule requires is the pharmacy module's to enforce; Schedule X and narcotic items are always controlled.
