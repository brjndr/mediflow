# Purchasing: module notes

What this module is and what was decided for it. The root `CLAUDE.md` holds the rules every module follows, and it wins where the two disagree. Keep this file current with the module.

## What exists

**Suppliers, purchase orders, goods receipt and returns (#103, web and API, with BE-22 #108):** `purchasing`, in the navigation after inventory, behind the `purchasing` switch and `purchaseOrder:read`. Every screen starts with links to the orders, receipts, returns and suppliers (`PurchasingLinks`), each shown for what its route requires. Works at every width.

- **Purchase orders** (`purchasing`): the newest first, of every status or one, with the supplier, status in words, items, total, where it goes and who drafted it. **New purchase order** (`purchaseOrder:create`); **Open** on a row.
- **New and edit** (`purchasing/orders/new`, `purchasing/orders/:orderId/edit`, `purchaseOrder:create` with `supplier:read`): the supplier (those in use), where to deliver (inventory's places), a note, and the items, each added with the drug search (medicines and consumables), its units and the agreed price of one (typed as an amount through `toMinor`), with the total. Saving opens the order. A submitted order's edit address says it can no longer be changed.
- **An order** (`purchasing/orders/:orderId`): its status, supplier, place, who drafted, submitted, approved or ended it and when, the note, its lines with what has been received of each, and its goods receipts. By its step: **Edit** and **Submit for approval** (a draft), **Approve** (`purchaseOrder:approve`, `aria-disabled` with a hint on one's own), **Receive goods** (`goodsReceipt:create`, approved or partly received), **Cancel order** (nothing received) and **Close order** (partly received), the last two in a panel asking why.
- **Receive goods** (a panel on the order): where they came in (the order's place first), the supplier's invoice, a row per batch started with what its line still waits for and its agreed price (batch number, expiry date, units, cost of one, MRP), **Another batch** for a line that came in two, and a note. A row left without units is not received.
- **Goods receipts** (`purchasing/receipts`) and **a receipt** (`purchasing/receipts/:receiptId`): its order (a link), supplier, invoice, who received it where and when, its batches with expiry, units at cost, MRP and what was sent back, and its returns. **Return to supplier** (`purchaseReturn:create`), a panel: the units of each line still kept, a reason and a note.
- **Returns** (`purchasing/returns`): the newest first, with the receipt, supplier, reason, what went back, the total at its received cost and who sent it from where. **Open receipt** on a row.
- **Suppliers** (`purchasing/suppliers`, `supplier:read`): in use or archived, with GSTIN, drug licence, phone (masked) and email; **Add a supplier**, **Edit**, **Archive** and **Restore** for `supplier:manage`.

## Decided

- **A module of its own, `purchasing`,** beside `inventory` as inventory is beside `pharmacy`: a hospital may keep a store without buying through the app. Stock moves only through inventory (`stockReceive` and `stockOut` in the API), and the inventory ledger shows the entries as "Received from a supplier" and "Returned to the supplier".
- **Permissions** (store keeper and admin): `supplier:read`, `supplier:manage`, `purchaseOrder:read`, `purchaseOrder:create`, `purchaseOrder:approve`, `goodsReceipt:create`, `purchaseReturn:create`. The pharmacist has none.
- **Two people for an order:** whoever drafted, last changed or submitted it does not approve it (Approve is `aria-disabled` with a hint for them, and the API refuses it); nothing moves in stock on approval. **A receipt is posted at once by one person:** it records what was delivered, and a correction is a return or an adjustment. Only against an approved order: no receipt without an order yet.
- **Two people editing:** a draft or a supplier is changed from what it was when the form opened, and only the changed fields are sent (an order's lines as a whole). After 409 `conflict` the form takes the newest version: a field this person did not touch takes what was saved, what they typed stays, and the fields both changed are named; Save waits until the newest version is read.
- **Order lines are edited whole:** each item once (the search says so and focuses the line already there), whole units, a price typed as an amount ("12,50" is refused, as everywhere). A draft's edit sends all its lines with the version it was read at.
- **The receive panel takes the order's open lines when it opens** and keeps them, so the rows typed stay with their lines when the order is read again; the form checks that a line's rows never bring more than it waits for, that each batch is once per item, that the expiry date is a real day not before today at the hospital, and that a row with units has a batch number and a cost no higher than the agreed price (a dearer delivery needs a new order). The server refuses the same (and `cost_above_order`, `item_archived`) (`over_receipt`, `batch_exists` for a number the item has with another expiry, `batch_expired`).
- **A return goes back from the receipt's place and batch,** expired units included, never more than was received less what went back (`over_return`), nor more than the batch has there (`insufficient_stock`). Other needs a note.
- **Costs are before tax** and kept per batch; GST on purchases is a follow-up.
- **Every address holds ids only;** the lists are `GET`s (nothing about a patient). Every POST carries an idempotency key, one per body.
- **Focus.** A panel's heading takes focus when it opens (`usePanelFocus`), focus goes back to its button when it closes, or to the status line when the button went away (a step that moved the order on). A step done (submitted, approved, received, cancelled, closed, returned) is said in the status line, which takes focus. A refusal is an alert in the panel (`role="alert"`, announced; focus stays on the button pressed, as in inventory); the form stays open. A panel opened clears an earlier step's refusal. A failed submit focuses the first invalid field; with nothing added, the item search; with no units on any row, the first row's units.

## Known gaps

- No tax (GST) on order lines, no free goods or discounts, no receipt without an order, no printed order or receipt.
- An order's supplier list holds the first hundred suppliers in use.
- The receipts and returns lists have no filter by supplier or dates on screen (the API takes `supplierId`).
- Choosing a place needs inventory's `stock:read` and switch (the store keeper and the admin hold it); without them the order screen says so and offers no form (a route requires only its own module's permissions).
- Replacements of goods sent back cannot be received against the same order: they come on a new order.

## Mock

`mocks/handlers/purchasing.ts` follows the API's rules and codes, and moves stock through the inventory mock (`mockStockReceive`, and `mockStockOut` with the source `purchase_return` and `expiredAllowed`; `mockPlaceInUse` checks a place), checking every item with `dryRun` before any moves, as the API's one transaction does. At the hospital: suppliers `sup_h_sunrise` (Sunrise Pharma Distributors) and `sup_h_medline` (Medline Surgical Supplies), and orders the store keeper drafted, each of two items at 200 units: `po_h_draft` (PO-000001), `po_h_submitted` (PO-000002, waiting for the admin), `po_h_approved` (PO-000003, lines `po_h_approved_line_1` and `_2`) and `po_h_cancelled` (PO-000004). No receipt or return at first. The clinic has purchasing off. Tests read it with `mockPurchasing`.
