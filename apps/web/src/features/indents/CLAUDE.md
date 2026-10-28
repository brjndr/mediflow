# Indents: module notes

What this module is and what was decided for it. The root `CLAUDE.md` holds the rules every module follows, and it wins where the two disagree. Keep this file current with the module.

## What exists

**Store indents and issue vouchers (#105, web and API):** `indents`, in the navigation after inventory, behind inventory's `inventory` switch and `indent:read`. Works at every width.

- **Indents** (`inventory/indents`): the newest asked first, of every status or one and of every place or one (the place that asked or the store asked), with both places, the status in words, the items and who asked. **New indent** (`indent:create`); **Open** on a row.
- **New indent** (`inventory/indents/new`, `indent:create`): the place that asks (the places in use) and the store asked (the stores in use, never the same place), a note, and the items, each added with the drug search (medicines and consumables) with its units. Sending opens the indent.
- **An indent** (`inventory/indents/:indentId`): its status, both places, who asked, decided or ended it and when and why, the note, its lines (asked, approved, issued, and, for whoever approves or issues, the store's stock of the item now), and its vouchers, each with its batches and **Print voucher**. By its step: **Approve** and **Reject** a requested one (`indent:approve`, `aria-disabled` with a hint on one's own), **Withdraw** one's own requested one (`indent:create`), **Issue** and **Close short** an approved or partly issued one (`indent:issue`).
- **Approve** (a panel): the units approved of each line, started at what it asked, each up to that, 0 for an item the store will not give, at least one above 0, with the store's stock beside.
- **Issue** (a panel): a row per batch the store may issue of each line still waiting (in date, with stock at the store, nearest expiry first, as the API offers them), started with what the line still has to issue taken nearest expiry first; a row left empty sends nothing; a note. A line with no batch in date says so.
- **Reject** and **Close short** (a panel): a note saying why, required.
- **Inventory's screens** link to the indents (`InventoryLinks`, for `indent:read`), and the ledger reads an issue as "Issued against an indent" and "Received against an indent".

## Decided

- **The API is inventory's; the screens are a module of their own here.** The registry gives a feature one navigation entry, which requires all of its permissions, and inventory's needs `stock:read`, which the nurse does not hold: so a nurse who indents for a ward would have no way in. `indents` shares inventory's switch (`featureFlag: 'inventory'`) and reaches inventory only through addresses (`/inventory/...`), never its code.
- **Permissions** (the "indent" of the nurse and "request/indent" of the role matrix): `indent:read` and `indent:create` (nurse, pharmacist, store keeper, admin), `indent:approve` and `indent:issue` (store keeper, admin). Asking needs no `stock:read`: the places come from `GET /inventory/indent-places` (`indent:read`), and the store's stock of a line's item is given only to whoever approves or issues (`storeOnHand`, absent otherwise, and its column with it), so a nurse sees an indent, not the stock. Scope is not read, as in the rest of inventory.
- **Only a store is asked** (kind `store`, 400 otherwise): an indent is a request to the hospital's store, and the store keeper never issues out of a ward. A hospital with several stores chooses one.
- **Two people:** whoever asked does not approve or reject it (409 `own_indent`, and the check `stock_indents_two_people`). One person may approve and issue. Only whoever asked withdraws it, before it is decided (409 `not_requester`); the store closes one short with a reason.
- **An indent reconciles with what was issued.** A voucher line names the ledger entry out of the store and the entry into the place that asked, both of its batch; the database adds its units to its indent line's `issued_quantity` (a trigger; nothing else may change it), which never passes what was approved (409 `over_issue`), and approved never passes asked. The indent is `issued` once every line has its approved units, `partly_issued` until then.
- **Issuing moves stock at once,** out and in, in one transaction (`transferStock` in the API): no goods in transit, no receiving step at the ward. Expired batches are never issued (409 `batch_expired`). The hospital's stock does not change, so no `stock.low`; `stock.issued` carries the indent, the voucher and the two places.
- **The panels take the indent and its version when they open** and keep them, so what was typed stays with its line or batch when the indent is read again, and a step by someone else meanwhile is refused (409 `conflict`, said as "close this and open it again"), never sent against rows that no longer hold; stock moved meanwhile is refused too (`insufficient_stock`, `over_issue`). A voucher holds at most 400 batches (checked on the form).
- **A voucher prints with print CSS** (`PrintSheet`, the hospital's letterhead), from what the screen read; nothing is recorded, as it holds no patient data.
- **Inventory links to the indents** (`InventoryLinks`, a path and `indent:read`): they share a switch, so the link never leads to a module that is off. If they ever split, a slot contribution from `indents` replaces it.
- **Every address holds ids only;** the lists are `GET`s (nothing about a patient). Every POST carries an idempotency key, one per body; steps send the version the indent was read at.
- **Focus.** As in purchasing: a panel's heading takes focus when it opens (`usePanelFocus`), focus goes back to its button or the status line when it closes; a step done is said in the status line, which takes focus; a refusal is an alert in the panel; a failed submit focuses the first invalid field.

## Known gaps

- No link between a place and a ward or department of the masters: a place is a name and a kind (`department` added for #105).
- A place's list on the form holds the first hundred places in use.
- No scope by place: whoever holds `indent:read` sees every place's indents, and `indent:create` may ask for any place.
- No reorder suggestion (from a ward's usage or level) and no standing indents.
- **Issued stock stays in the hospital's stock:** nothing records its use on the ward, so the hospital's on-hand (and `stock.low` against the reorder level) still counts units issued to wards and departments. Ward consumption, or a reorder level counted on stores only, is a follow-up.
- Adding an item uses the drug search, which needs the `drugs` switch and `drug:read` (the nurse holds it by default).

## Mock

`mocks/handlers/indents.ts` follows the API's rules and codes, and moves stock through the inventory mock (`mockTransfer`, checked with `dryRun` for every item before any moves). The inventory mock has a third place, `loc_h_ward` (Ward 2 stock). At the hospital: `ind_h_requested` (IND-000001, the pharmacist's, the pharmacy counter asking the main store for 50 and 30 units of two items, waiting) and `ind_h_approved` (IND-000002, the admin's for Ward 2 stock, approved by the store keeper for 40 units of one item, nothing issued). The mock's admin, store keeper and pharmacist hold the indent permissions as the API's defaults give them. Tests read it with `mockIndents`.
