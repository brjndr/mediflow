# Product reference

The journeys, the release plan, the default role matrix and the shapes of the entities not built yet. Moved out of the root `CLAUDE.md` (#370), which keeps the architecture rules the modules follow (Product Scope) and points here. Read the section that applies before planning a new module.

## Architecture rules that make the modules fit together

The root `CLAUDE.md` lists these in short; this is the full statement of each.

- **Encounter is the spine.** Every clinical, ordering and billing record attaches to an `Encounter` (type `opd`, `ipd`, `er` or `daycare`), which belongs to one patient. Modules never invent their own visit concept. One exception, decided for #101: a pharmacy counter sale may be to an unnamed walk-in and has no encounter; billing (M11) charges it on its own, from `pharmacy.sold`.
- **Unified orders (CPOE).** Lab, imaging, procedure, medication and diet requests are all `Order` records with a type, status and `order.placed` event. Lab, radiology, pharmacy and nursing modules consume orders by event. Ordering never calls those modules directly.
- **Charge ledger.** Services performed, tests, imaging, dispenses, bed days and procedures post **charges** to the encounter's charge ledger (priced from the active price list at that time; a pharmacy counter sale is priced at each batch's maximum retail price, recorded on the sale, #101). Invoices are assembled from charges. No module writes invoices directly.
- **Master data first.** Services and tariffs, drugs, lab tests, ICD codes, wards and beds are catalogs owned by the master data module and referenced by ID everywhere else. Prices are effective-dated so old bills never change.
- **Append-only where it matters:** stock ledger, medication administration record, audit log, results and signed documents. Corrections are new entries or addenda with the reason and the author.
- **State machines** for orders, samples, admissions, bed status, claims and discharge, enforced on the backend. The UI only offers valid transitions.
- **Concurrency-safe resources:** double-booking, bed occupancy, theatre and surgeon slots, and stock decrements are protected by database constraints or row locks, never by client checks.
- **Every module is a feature module** with its own flag, permissions, migrations, events and settings, and registers via the manifest and Fastify plugin. A module that needs another one's data uses events or its `index.ts` contract.
- Large code sets (ICD-10, drug and test catalogs) are searched on the server and never bundled into the web app.

## Journeys

- **OPD:** register or find patient -> appointment or walk-in token -> triage (vitals, allergies) -> consultation -> orders (lab, imaging, medication, procedures) -> sample collection and results -> prescription -> pharmacy dispense -> billing and payment -> follow-up or referral.
- **IPD:** admission advice -> bed allocation (ADT) -> nursing care (vitals, medication administration, notes) -> doctor rounds and orders -> diagnostics and pharmacy -> running bill and deposits -> discharge clearance -> discharge summary -> final bill or insurance settlement -> bed cleaning.
- **Emergency:** quick or unidentified registration -> triage -> rapid care -> disposition (discharge, admit to IPD, refer, expired). Patients may be merged into a real identity later.
- **Surgery:** OT booking -> pre-op checklist -> operation and anaesthesia notes -> consumables and charges -> post-op care.
- **Insured patients:** policy capture -> pre-authorization -> split billing -> claim submission -> settlement.

## Module map and releases

| Release                               | Modules                                                                                                                                                                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1 Pilot (OPD hospital or clinic)** | Auth and roles, patients, doctors and departments, master data and catalogs, appointments, queue and triage, OPD clinical and orders, laboratory, radiology, pharmacy and inventory, billing, reports, platform admin, role management |
| **R2 Inpatient**                      | Bed management and admissions (ADT), nursing and ward care, discharge and IPD billing                                                                                                                                                  |
| **R3 Specialty and payers**           | Emergency, operation theatre, insurance, TPA and claims                                                                                                                                                                                |
| **R4 Records and operations**         | Medical records and documents, consents and certificates, rosters, blood bank, ambulance, housekeeping                                                                                                                                 |

## Out of scope for now

Patient portal or app, telemedicine, a DICOM viewer or PACS, full accounting or payroll, and external integrations (HL7/FHIR, lab analyzers, ABDM/ABHA, e-claim portals). Design data models so these can be added later through adapters.

See `docs/OPEN_DECISIONS.md`.

## Default role matrix

Default matrix (seed data only; the live policy comes from the backend). Each cell is what the role holds in a new hospital, read from the `defaults` of every `apps/api/src/features/*/permissions.ts`. Every default is at scope `all`: no role starts with `own` or `department`. "view" means the read permissions only. A role with no grant for an area is `no`. A hospital's admin changes its roles afterwards.

**Why the admin holds everything.** The `admin` role holds every permission the API declares (198 today), at scope `all`, including clinical writes and sign-offs (`clinicalNote:write`, `labResult:verify`, `imagingReport:sign`, `mar:record`, `dischargeSummary:sign`). This is deliberate: nobody grants beyond what they hold (`grantsWithin`), so an admin who lacks a permission cannot put it in a custom role. A hospital that wants a non-clinical admin removes those grants from its own `admin` role, and gives the clinical ones to custom roles first.

| Area                                          | platform_admin | admin                                      | doctor                                    | nurse                                     | receptionist                                                      | pharmacist                   | lab_technician                         | radiologist               | store_keeper                 |
| --------------------------------------------- | -------------- | ------------------------------------------ | ----------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------- | ---------------------------- | -------------------------------------- | ------------------------- | ---------------------------- |
| Manage hospitals/tenants                      | yes            | no                                         | no                                        | no                                        | no                                                                | no                           | no                                     | no                        | no                           |
| Users, roles, master data                     | yes (tenants)  | all, own hospital                          | view catalogs and roster                  | view catalogs and roster                  | view catalogs and roster                                          | view catalogs and roster     | view catalogs and roster               | view catalogs and roster  | view drug catalog and roster |
| Patient registration and demographics         | no*            | yes (also import, merge)                   | register/edit                             | register/edit                             | register/edit                                                     | view (no contact details)    | view (no contact details), blood group | view (no contact details) | no                           |
| Appointments and queue                        | no*            | yes                                        | view, call next                           | view, call next                           | create/edit, queue create and cancel                              | no                           | no                                     | no                        | no                           |
| Triage and vitals                             | no*            | yes (also ranges)                          | view                                      | record                                    | no                                                                | allergies view               | no                                     | no                        | no                           |
| Clinical notes, diagnosis, orders             | no*            | yes                                        | yes                                       | view encounters and orders, update orders | no                                                                | no                           | no                                     | no                        | no                           |
| Referrals and follow-ups                      | no*            | yes                                        | yes                                       | view follow-up                            | view follow-up                                                    | no                           | no                                     | no                        | no                           |
| Lab (collect, result, verify)                 | no*            | yes                                        | view results, acknowledge, print          | collect, view samples                     | no                                                                | no                           | yes                                    | no                        | no                           |
| Imaging (perform, report)                     | no*            | yes                                        | no                                        | no                                        | no                                                                | no                           | no                                     | yes                       | no                           |
| Pharmacy dispense and sales                   | no*            | yes                                        | no                                        | no                                        | no                                                                | yes                          | no                                     | no                        | no                           |
| Inventory and purchasing                      | no*            | yes                                        | no                                        | indent                                    | no                                                                | stock view, indent           | no                                     | no                        | yes                          |
| Admissions and beds (ADT)                     | no*            | yes (also set-up)                          | admit, transfer, cancel, discharge        | view, transfer, beds                      | admit desk (admit, transfer, cancel, reserve)                     | no                           | no                                     | no                        | no                           |
| Discharge clearances (nursing, pharmacy, lab) | no*            | all three                                  | all three                                 | nursing only                              | no                                                                | pharmacy only                | lab only                               | no                        | no                           |
| Nursing care (MAR, notes)                     | no*            | yes                                        | view, write progress notes                | yes                                       | no                                                                | no                           | no                                     | no                        | no                           |
| Billing and payments                          | no*            | yes (also refunds, adjustments, approvals) | view charges and invoices                 | no                                        | charges, invoices, payments, discounts, cash register (no refund) | no (counter sales: pharmacy) | no                                     | no                        | no                           |
| Insurance and claims                          | no*            | yes                                        | no                                        | no                                        | view payers; manage policies, pre-auths, claims; view receivables | no                           | no                                     | no                        | no                           |
| Emergency                                     | no*            | yes                                        | view, triage, care, dispose, medico-legal | view, register, triage, care              | view, register                                                    | no                           | no                                     | no                        | no                           |
| Theatre                                       | no*            | yes                                        | view, schedule, perform                   | view, schedule, perform                   | no                                                                | no                           | no                                     | no                        | no                           |
| Blood bank and transfusion                    | no*            | yes                                        | view, record reactions                    | view, issue, record reactions             | no                                                                | no                           | yes                                    | no                        | no                           |
| Documents                                     | no*            | yes (also retire)                          | view, upload                              | view, upload                              | view, upload                                                      | no                           | no                                     | no                        | no                           |
| Audit log                                     | no*            | yes                                        | no                                        | no                                        | no                                                                | no                           | no                                     | no                        | no                           |
| Reports                                       | no*            | all                                        | no                                        | no                                        | no                                                                | no                           | no                                     | no                        | no                           |

\*Platform admins manage tenants but do **not** get default access to patient data. Any support access must be explicit, audited, and time-limited.

## Domain types to build

Not built yet, and the shape to build:

```ts
export interface Appointment {
  id: string;
  tenantId: string;
  patientId: string;
  doctorId: string;
  startsAt: string; // ISO datetime (UTC); display in tenant timezone
  status: 'scheduled' | 'completed' | 'cancelled' | 'no_show';
  reason?: string;
}

// The spine of care. Everything clinical, ordered or billed attaches to an encounter.
export interface Encounter {
  id: string;
  tenantId: string;
  patientId: string;
  type: 'opd' | 'ipd' | 'er' | 'daycare';
  status: 'open' | 'closed' | 'cancelled';
  appointmentId?: string;
  attendingDoctorId?: string;
  departmentId?: string;
  openedAt: string;
  closedAt?: string;
}

export interface Order {
  id: string;
  tenantId: string;
  encounterId: string;
  type: 'lab' | 'imaging' | 'procedure' | 'medication' | 'diet';
  catalogItemId: string; // service, drug or test from master data
  status: 'placed' | 'accepted' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'routine' | 'urgent' | 'stat';
  orderedBy: string;
  placedAt: string;
  details?: Record<string, unknown>; // dosage and frequency for medication, notes, etc.
}

export interface Charge {
  id: string;
  tenantId: string;
  encounterId: string;
  serviceId: string;
  source: 'service' | 'order' | 'dispense' | 'bed' | 'procedure' | 'manual';
  sourceRef?: string;
  quantity: number;
  unitPriceMinor: number; // minor currency units, from the price list effective at posting time
  status: 'pending' | 'invoiced' | 'void';
  postedAt: string;
}

export interface Invoice {
  id: string;
  tenantId: string;
  patientId: string;
  encounterId?: string;
  chargeIds: string[];
  totalMinor: number;
  currency: string;
  status: 'draft' | 'issued' | 'paid' | 'void';
  issuedAt?: string;
}
```

**Other entities (defined with their module, each carrying `tenantId` and `id`, and referencing `encounterId` or `patientId` where relevant):**

- Master data: `Service`, `PriceList` (effective-dated), `Drug`, `LabTest` (with reference ranges), `Ward`, `Room`, `Bed`, `DiagnosisCode`, `Template`.
- Front desk and OPD: `QueueToken`, `Vitals`, `ClinicalNote`, `Prescription`, `Referral`.
- Diagnostics: `LabSample`, `LabResult` (versioned, verified), `ImagingReport`.
- Pharmacy and stores: `StockItem`, `Batch`, `StockLedgerEntry` (append-only), `Supplier`, `PurchaseOrder`, `GoodsReceipt`, `Dispense`, `Indent`.
- Inpatient: `Admission`, `BedAssignment` (history), `MedicationAdministration` (append-only), `ProgressNote`, `DischargeSummary`, `Deposit`.
- Specialty: `ErEncounter`, `Surgery`, `OtBooking`, `Insurer`, `Policy`, `PreAuth`, `Claim`.
- Records and operations: `Document`, `Consent`, `Certificate`, `Roster`, `BloodUnit`, `AmbulanceTrip`.
