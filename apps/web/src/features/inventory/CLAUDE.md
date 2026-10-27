# Inventory: module notes

What this module is and what was decided for it. The root `CLAUDE.md` holds the rules every module follows, and it wins where the two disagree. Keep this file current with the module.

## What exists

**Stock, batches and expiry (#102, web and API):** `inventory`, in the navigation after radiology, behind the `inventory` switch and `stock:read`. Four screens, linked to one another by a row of links under each heading (the current one marked `aria-current`). Works at every width.

- **Stock** (`inventory`): every item in use of the drug and consumable master, by generic name then brand, with its units at the place chosen (or the whole hospital), at the whole hospital, its reorder level, **Low** (a word and an icon) when the hospital's stock is at or below it, and its batches with stock, soonest expiry first, each with its number, expiry, place and units, in bold when expiring or expired. Three alert buttons above the list ("3 items low", "1 item expiring", "0 items expired", `aria-pressed`) narrow it on the server, as does the **Show** list; the window of "expiring" is 30, 60, 90 (the default) or 180 days; one item can be chosen with the drug search. Row actions: **Ledger** (that item's ledger) and **Adjust stock** (`stock:adjust`, the adjustment panel with the item chosen).
- **Adjustments** (`inventory/adjustments`): waiting for approval (the default), approved or rejected, newest asked first, with the change, the batch (or the new batch), the place, the reason and note, the batch's stock at the place now, who asked and when, and who decided. **New adjustment** (`stock:adjust`) opens a panel in place. **Approve** and **Reject** (`stock:approve`) on a waiting one, `aria-disabled` on one's own; Reject asks why in a panel.
- **Ledger** (`inventory/ledger`): every change of stock, newest first, by place, item and a range of days at the hospital, with the stock of the batch at the place after it. No count: it only grows.
- **Places** (`inventory/locations`): the places in use, or archived; **Add a place**, **Edit**, **Archive** and **Restore** for `stockLocation:manage`.

## Decided

- **A module of its own, `inventory`,** not under `pharmacy`: a hospital may keep a store without the pharmacy module, and the role matrix has "Inventory and purchasing" apart from "Pharmacy dispense". Dispensing (#100) posts to this ledger.
- **Permissions:** `stock:read` (store keeper, pharmacist, admin), `stock:adjust` and `stock:approve` (store keeper, admin), `stockLocation:manage` (admin). The mock's hospital has a `store_keeper` role and a store keeper (`USER_IDS.storeKeeper`, `stores@sample-hospital.test`).
- **Two people for every adjustment, opening stock included:** asked for by one, approved or rejected by someone else. Nothing moves while it waits. The API refuses one's own (409 `own_adjustment`, and a check constraint); the screen offers Approve and Reject `aria-disabled` on one's own. A store with one store keeper needs the admin to approve.
- **Stock moves only through the ledger,** which the database keeps append-only; a correction is a new adjustment. An approval checks the stock again (409 `insufficient_stock`), so two approvals of the last units move them once.
- **A new batch comes in as opening stock only,** with its number, expiry date and maximum retail price (optional, typed as an amount and sent in minor units through `toMinor` from `features/services`: "12,50" is refused). The batch is made when the adjustment is approved. Goods receipts (#103) will bring batches in too.
- **The batch list of the form** offers the item's batches with stock somewhere, each once, soonest expiry first, and **A new batch** for opening stock. A batch with no stock left anywhere is not offered (a gap, below).
- **The reason fixes the way** for opening (in), damaged and expired (out); a count correction and other are chosen in or out. Other needs a note. Quantities are whole units of the item.
- **Expiry:** a batch is usable through its expiry date and expired the day after, at the hospital. Expiring is within the window chosen, 90 days unless another is chosen. A per-hospital setting is the change when settings exist (no per-hospital settings mechanism yet).
- **Low is the whole hospital's stock** against the item's reorder level, whatever the place shown: the reorder level is the hospital's, in the drug master.
- **Every address holds ids only:** the stock list's Adjust passes the item in the router's state (memory), the Ledger link its id in the query. Nothing typed is in an address; stock holds no patient data, so the lists are `GET`s.
- **Every POST carries an idempotency key,** one per body.
- **Focus.** A panel's heading takes focus when it opens (`usePanelFocus`), and focus goes back to its button when it closes, or to the status line when that went away. A row that leaves the list (approved, rejected) is said in the status line, which takes focus. A failed submit of the adjustment focuses the first invalid field, the item first (it is first on the form). A refusal is an alert in the panel; the form stays open to change it.
- **`DrugSearch` offers consumables on request** (`includeConsumables`, #102), and its `aria-expanded` now follows whether a list is drawn (an open box with nothing in it controlled nothing, which axe found when the form moved focus to it).

## Known gaps

- A batch with no stock anywhere cannot be chosen for a positive count correction; opening stock of it again is refused as `batch_exists`. Rare: a count that finds stock of a batch the ledger says is gone.
- `stock.expiring` is not emitted yet: it needs a daily job (BE-21, #107). `stock.low` is emitted when an approval brings the hospital to its reorder level.
- No transfer between places yet (store indents, #105), no goods receipt (#103), no dispensing (#100).
- The adjustments list has no filter by item or place.

## Mock

`mocks/handlers/inventory.ts` follows the API's rules and codes. At the hospital: a main store and a pharmacy counter (`loc_h_store`, `loc_h_pharmacy`), opening stock of the first thirty items of the drugs mock by name (batches `SB001A` at the store and `SB001B` at the counter, and on; the third item's expire within the month; every fifth item is low), each with its approved adjustment and ledger entry, and two adjustments the store keeper asked for: `adj_h_pending_1` (10 units of `SB002A` out, damaged) and `adj_h_pending_2` (120 units of a new batch `NEW001` in, opening). The clinic has one place, no stock and inventory switched off. Tests read it with `mockStock`.
