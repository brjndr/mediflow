# Billing API: module notes

What was decided for billing's API (#114). The root and `apps/api` `CLAUDE.md` rules apply; the web module's notes are `apps/web/src/features/billing/CLAUDE.md`.

## What exists

Behind the `billing` switch. Permissions: `charge:read`, `invoice:read|create|issue|adjust`, `payment:read|create|refund`, `creditNote:create`, `cashRegister:read|manage`. Billing works the whole hospital's bills, so every route needs the scope `all`.

- **Charges** (`charges`): posted by `posting.ts` from events, never by a route. `order.completed` (a lab test's service, or the order's imaging or procedure service), `pharmacy.dispensed` (one charge a batch, at the batch's MRP) and `pharmacy.dispense_returned`. Unique by `source_ref` (`order:<id>`, `dispense:<line id>`), so a repeated event, or an order completed again after a reopening, posts nothing more. Emits `charge.posted`.
- **Pricing:** the standard price list's price in effect today at the hospital. A service archived since, or with no price in effect, is posted at its last price and flagged `service_archived`; with no price at all, at 0 and flagged `no_price`. Work done is never held up by the price list; the billing desk reads the flag. Decided for the question in #114's comment on archived services.
- **Returns of dispenses:** a charge still pending and on no draft whose units all came back is voided; any other is flagged `return_review` for the desk to credit. Computed from all that has been returned, so a repeat changes nothing.
- **Invoices:** drafts are made from pending charges and typed lines (`invoice:adjust`). The server works out every line and total (generated columns), refuses one above a safe integer (422 `amount_too_large`). A charge sits in one draft (the draft row-locks its charges in id order: 409 `charge_unavailable`). A change carries the `version` it started from (409 `version_conflict`).
- **No empty draft:** a create or change with no charge and no typed line is 422 `empty_invoice`. An invoice holding a charge flagged `return_review` is not issued (409 `charge_returned`) until the desk takes it off. `cashRegister:read` (every session, with its difference) is the admin's by default; a receptionist opens and settles their own drawer with `cashRegister:manage`.
- **Issuing:** the next number of the fiscal year (April to March, `INV-2026-27-000001`), from `invoice_counters`, a row locked in the issuing transaction, so numbers are gapless and a rolled-back issue gives its number back. Charges become `invoiced`. An invoice of 0 is issued as `paid`. Issued invoices are immutable in the database (a trigger): number, visit, patient, lines and total never change; only paid and credited sums, status and version move. Emits `invoice.issued`, `invoice.paid`.
- **Payments and refunds** (`payments`, append-only): each takes the invoice's row lock first, so racing payments never overshoot what is due (409 `overpayment`, `refund_exceeds`). Cash goes into the caller's open register session (409 `no_open_register`). A refund is its own row of kind `refund`; `paid_minor` is net. A paid invoice refunded becomes `issued` again.
- **Credit notes** (`credit_notes`, append-only, own number series `CN-…`): an amount against an issued invoice, up to what is left (409 `credit_exceeds`) and never leaving more paid than is owed (409 `refund_first`). Credited in full, the invoice is `void` and its charges go back to `pending` to be billed again (the one way an invoiced charge goes back: the trigger asks for a void invoice). Emits `invoice.credited`.
- **Cash register** (`cash_register_sessions`): one open a person (partial unique index). Cash payments and refunds recorded by the person go into it; closing keeps the cash counted, the expected amount the server worked out (opening plus cash taken less cash refunded) and so the difference. Only the opener closes it; a closed session is immutable and takes no more cash. Emits `register.closed`.
- **Idempotency:** every POST needs an `Idempotency-Key` except `PATCH /invoices/{id}`, which accepts one. They store ids only (`body: 'none'`), and a repeat answers with the record as it is now.

## Not built (follow-ups)

- **Counter sales** (`pharmacy.sold`) have no encounter, so no charge is posted for them yet (#101 says billing charges them on its own). They need a charge without a visit, and an invoice for it.
- No invoice list outside a visit and no print view (#110), no tax (#119), discounts (#116), packages (#117), bed days (R2) or consultation fees: a consultation is billed by a typed line or a charge until a service is linked to the visit.
- Insurance and split billing (R3).
- An invoice left as a draft is never deleted; a draft's charges stay held until it is changed.
