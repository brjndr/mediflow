# Hospital admin: day-one checklist

Do these in order and tick each box. Practise first in the practice hospital ([practice-hospital.md](practice-hospital.md)).

## Before opening

- [ ] **Sign in** with the first-admin invitation you received and set your password. Turn on the authenticator if your hospital has it.
- [ ] **Hospital profile:** name, logo, brand colour, timezone, currency, language.
- [ ] **Departments** and **wards, rooms and beds**.
- [ ] **Services and prices:** consultation fees, lab tests, procedures, each with the date its price starts and its tax class. Use the **Import centre** for many at once.
- [ ] **Drugs and lab tests** catalogs: import or add the ones you use.
- [ ] **Staff:** open **Staff**, then **Invite**, one person each with the right role (**Send invitation**). Doctors also need a doctor profile and working hours.
- [ ] **Roles:** check what each role can do on the Roles screen. Create `billing_clerk` here if you want one. View-as-role shows what a role sees.
- [ ] **Patients:** import the existing patient list from the Import centre, starting from `docs/samples/patients.csv`. Check the preview, fix the rows it rejects, then run it.
- [ ] **Stock places** (Inventory, Locations): main store, pharmacy counter.
- [ ] **Opening stock:** import with the `opening_stock` kind (`docs/samples/opening-stock.csv`): one row for each batch at a place. A second person approves the stock adjustments.
- [ ] **Billing settings:** tax rates and the discount limit.

## Test before go-live

- [ ] With the staff logins you just made, register a test patient, book, consult, order a lab test, dispense, bill and take a payment. Keep test records marked and tell staff.
- [ ] Print an invoice and a prescription on your printer.

## Day one

- [ ] Give each person their guide and their training hour ([training.md](training.md)).
- [ ] Be reachable. Collect what staff write on each guide's "Rough edges" line.
- [ ] End of day: check the cash register sessions were settled and the low and expiring stock alerts.

## Always

Approve other people's stock adjustments and discounts only after checking them. Review who holds the admin role.

Rough edges I met:
