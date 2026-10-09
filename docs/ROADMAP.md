# Roadmap

Generated from `scripts/github/roadmap.mjs`. Track progress in GitHub milestones and issues, or run `node scripts/github/status.mjs`.

Estimated duration: about 70 weeks for one developer using Claude Code (rough, re-plan at each milestone).

| Milestone | Release | Weeks | Issues | Exit criteria |
|---|---|---|---|---|
| M0 Setup | R1 | 1 | 8 | A clean clone installs and runs dev, test and build. CI is green. Hooks are active. |
| M1 Foundation | R1 | 3 | 18 | Two sample hospitals in the mock app: switching works with isolated cache, nav is permission and flag gated, and an example feature plugs in without core edits. |
| M2 Auth and access | R1 | 3 | 11 | Staff can log in with MFA, invited users onboard, and permissions from the backend drive the UI. |
| M3 Patients | R1 | 2 | 8 | A receptionist can register and find patients, a doctor can view them, and staging is deployed. |
| M4 Doctors, departments, staff | R1 | 2 | 5 | A hospital admin can manage departments, doctors and staff accounts. |
| M5 Master data and catalogs | R1 | 3 | 8 | A hospital admin can load and maintain its catalogs, prices are effective-dated, and other modules can reference them by ID. |
| M6 Appointments, queue and triage | R1 | 5 | 10 | Appointments can be booked and changed without overlaps, walk-ins get tokens in a live queue, and nurses record triage vitals before consultation. |
| M7 Clinical (OPD consultation and orders) | R1 | 4 | 10 | Doctors can run an OPD consultation with triage data, place lab, imaging and medication orders through the unified order model, and view a patient timeline. |
| M8 Laboratory | R1 | 3 | 6 | Lab orders flow through sample collection, result entry and verification, and the doctor sees verified results with critical values acknowledged. |
| M9 Radiology and imaging | R1 | 2 | 4 | Imaging orders are performed and reported, and doctors see signed-off reports. |
| M10 Pharmacy and inventory | R1 | 4 | 9 | Prescriptions are dispensed with correct batches, stock stays accurate under concurrency, and purchasing and goods receipt work. |
| M11 Billing and charge ledger | R1 | 4 | 11 | Charges from services, orders and dispenses post to a ledger, invoices are assembled from charges, paid, and immutable with credit notes for corrections. |
| M12 Dashboards and reports | R1 | 2 | 5 | Each role sees a useful dashboard, and large reports run as background jobs. |
| M13 Platform admin | R1 | 2 | 8 | A platform admin can create, configure, suspend and offboard a hospital end to end, without access to patient data. |
| M14 Roles management | R1 | 2 | 5 | A hospital admin can create roles, edit permissions and see the effects live. |
| M15 Hardening and pilot launch (R1) | R1 | 4 | 13 | Budgets met, security and accessibility reviewed, disaster recovery proven, and a pilot hospital live. |
| M16 Bed management and admissions | R2 | 3 | 6 | Patients can be admitted into beds, transferred and tracked, and double occupancy is impossible. |
| M17 Nursing and ward care | R2 | 3 | 7 | Nurses and doctors can run daily ward care with a complete, append-only record. |
| M18 Discharge and inpatient billing | R2 | 3 | 7 | A patient can be discharged only after clearances, with a signed summary and a settled final bill. |
| M19 Emergency | R3 | 2 | 5 | Emergency patients can be registered quickly (even unidentified), triaged, treated and admitted or discharged. |
| M20 Operation theatre | R3 | 3 | 5 | Surgeries can be booked without conflicts, documented, and billed with consumables. |
| M21 Insurance, TPA and claims | R3 | 4 | 8 | Insured admissions can be pre-authorized, billed with a payer split, claimed and settled. |
| M22 Medical records and documents | R4 | 2 | 6 | Hospitals can store records, capture consents, issue certificates, and merge duplicate patients safely. |
| M23 Hospital operations | R4 | 4 | 7 | Operational modules are available per hospital and can be enabled independently. |
| Backlog | - | - | 8 | Promote to a milestone when decided. |

Releases: **R1** pilot OPD hospital, **R2** inpatient, **R3** emergency, surgery and insurance, **R4** records and operations. Ship each release to a pilot hospital before starting the next.

Sizes: S about half a day, M 1 to 2 days, L 3 to 5 days (split if larger). Priorities: P0 must have, P1 should have, P2 nice to have.

## M0 Setup (R1)

Repository, tooling, CI and local services.

| ID | Title | Area | Pri | Size | Depends on |
|---|---|---|---|---|---|
| S-01 | Create monorepo, branch protection and conventions | infra | P0 | S | - |
| S-02 | Scaffold apps/web (Vite + React + TypeScript) with pnpm | frontend | P0 | S | S-01 |
| S-03 | Linting, formatting, tests and git hooks | frontend | P0 | M | S-02 |
| S-04 | Tailwind CSS and shadcn/ui with tenant-ready theme tokens | frontend | P0 | S | S-02 |
| S-05 | Test infrastructure: MSW, Playwright, render helpers | frontend | P1 | M | S-03 |
| S-06 | CI pipeline with GitHub Actions | infra | P0 | M | S-03 |
| S-07 | Local services with Docker Compose | infra | P1 | S | - |
| S-08 | Adopt Claude Code project config and GitHub templates | docs | P1 | S | S-01 |

## M1 Foundation (R1)

Multi-tenant app shell, access layer and plug-in architecture, running on a mock backend. Backend skeleton and tenancy in parallel.

| ID | Title | Area | Pri | Size | Depends on |
|---|---|---|---|---|---|
| F-01 | App shell, providers and folder structure | frontend | P0 | M | S-03, S-04 |
| F-02 | API client, interceptors and error handling | frontend | P0 | M | F-01 |
| F-03 | Session bootstrap (GET /session) | frontend | P0 | M | F-01, F-02 |
| F-04 | MSW mock backend v1 | frontend | P0 | S | F-03 |
| F-05 | Active tenant, hospital picker and switcher | frontend | P0 | M | F-03 |
| F-06 | Tenant config and runtime theming | frontend | P1 | M | F-05 |
| F-07 | Access layer: AccessPolicy, usePermission, Can, PermissionGuard | frontend | P0 | M | F-03 |
| F-08 | Feature registry, route and nav generation, extension slots | frontend | P0 | L | F-07 |
| F-09 | i18n foundation | frontend | P1 | S | F-01 |
| F-10 | Layout, navigation and system pages | frontend | P1 | M | F-08 |
| F-11 | Performance guardrails | frontend | P1 | S | F-08, S-06 |
| F-12 | Error reporting with PHI scrubbing | security | P1 | S | F-01 |
| F-13 | Sample feature proving the plug-in architecture | frontend | P1 | S | F-08 |
| F-14 | Foundation test suite | frontend | P0 | M | F-08 |
| BE-01 | Backend skeleton (apps/api: Fastify, TypeBox, Drizzle) | backend | P0 | M | S-07 |
| BE-02 | Tenancy foundation: tenants and row-level security | backend | P0 | L | BE-01 |
| BE-03 | OpenAPI contract and client generation | backend | P0 | S | BE-01 |
| F-15 | Shared building blocks: data grid, charts, forms, rich text | frontend | P1 | M | F-08, F-09 |

## M2 Auth and access (R1)

Staff authentication, onboarding by invite, and policy-driven access against the real backend.

| ID | Title | Area | Pri | Size | Depends on |
|---|---|---|---|---|---|
| A-01 | Login page and sign-in flow | frontend | P0 | M | F-03, F-04 |
| A-02 | MFA enrollment and challenge | frontend | P1 | M | A-01 |
| A-03 | Invite acceptance and password reset | frontend | P0 | M | A-01 |
| A-04 | Session lifecycle: inactivity logout and multi-tab sync | frontend | P0 | S | A-01 |
| A-05 | Route protection and deep links | frontend | P0 | S | A-01, F-07 |
| A-06 | Profile and account settings | frontend | P2 | S | A-01 |
| BE-04 | Authentication and sessions API | backend | P0 | L | BE-02 |
| BE-05 | Roles, permissions and AccessPolicy API | backend | P0 | L | BE-04 |
| BE-06 | Audit log and transactional outbox | backend | P0 | M | BE-02 |
| BE-07 | Per-tenant rate limiting and idempotency | backend | P1 | M | BE-04 |
| BE-08 | Notifier abstraction for staff email | backend | P2 | S | BE-01 |

## M3 Patients (R1)

Register, find, view and edit patients. First staging deployment.

| ID | Title | Area | Pri | Size | Depends on |
|---|---|---|---|---|---|
| P-01 | Patient list with server-side search and pagination | frontend | P0 | M | F-08 |
| P-02 | Patient registration form | frontend | P0 | M | P-01 |
| P-03 | Patient detail view with extension slots | frontend | P0 | M | P-01 |
| P-04 | Edit patient and field-level permissions | frontend | P1 | M | P-03 |
| P-05 | Duplicate detection and search UX | frontend | P2 | S | P-02 |
| P-06 | Patients tests and end-to-end flow | frontend | P0 | S | P-04 |
| BE-09 | Patients API | backend | P0 | L | BE-05, BE-06 |
| INF-01 | Staging environment and deploy pipeline | infra | P1 | L | S-06, BE-01 |

## M4 Doctors, departments, staff (R1)

Departments, doctors and staff user management.

| ID | Title | Area | Pri | Size | Depends on |
|---|---|---|---|---|---|
| D-01 | Departments management | frontend | P1 | S | F-08 |
| D-02 | Doctors management | frontend | P1 | M | D-01 |
| D-03 | Staff user management for hospital admins | frontend | P0 | M | A-03 |
| D-04 | Tests and end-to-end for this milestone | frontend | P1 | S | D-03 |
| BE-10 | Departments, doctors and staff users API | backend | P0 | L | BE-05, BE-08 |

## M5 Master data and catalogs (R1)

Catalogs every other module depends on: services and prices, drugs, lab tests, codes, wards and beds, templates, and bulk import.

| ID | Title | Area | Pri | Size | Depends on |
|---|---|---|---|---|---|
| MD-01 | Service and tariff catalog with price lists | frontend | P0 | M | F-08, BE-05 |
| MD-02 | Drug and consumable master | frontend | P0 | M | MD-01 |
| MD-03 | Lab test catalog and reference ranges | frontend | P0 | M | MD-01 |
| MD-04 | Wards, rooms and bed setup | frontend | P1 | M | MD-01 |
| MD-05 | Diagnosis and procedure code search | frontend | P1 | S | MD-01 |
| MD-06 | Document and clinical templates | frontend | P2 | S | MD-01 |
| MD-07 | Bulk import centre (patients, staff, catalogs) | frontend | P1 | M | MD-01, MD-02, MD-03 |
| BE-17 | Master data API | backend | P0 | L | BE-05 |

## M6 Appointments, queue and triage (R1)

Booking, calendar and lifecycle of appointments without double booking.

| ID | Title | Area | Pri | Size | Depends on |
|---|---|---|---|---|---|
| AP-01 | Appointment list with filters | frontend | P0 | M | P-01, D-02 |
| AP-02 | Create appointment with conflict handling | frontend | P0 | L | AP-01 |
| AP-03 | Calendar views (day and week per doctor) | frontend | P1 | L | AP-01 |
| AP-04 | Reschedule, cancel, complete and no-show | frontend | P0 | M | AP-02 |
| AP-05 | Appointment tests and end-to-end | frontend | P0 | S | AP-04 |
| BE-11 | Appointments API | backend | P0 | L | BE-09, BE-10 |
| Q-01 | Walk-in registration and OPD token queue | frontend | P0 | M | P-02, D-02 |
| Q-02 | Triage and vitals capture | frontend | P0 | M | Q-01 |
| Q-03 | Waiting-room display screen | frontend | P2 | S | Q-01 |
| BE-18 | Queue and triage API | backend | P0 | M | BE-11 |

## M7 Clinical (OPD consultation and orders) (R1)

Visits, prescriptions, lab orders and the clinical timeline.

| ID | Title | Area | Pri | Size | Depends on |
|---|---|---|---|---|---|
| C-01 | Encounter (OPD visit) creation and notes | frontend | P0 | M | AP-04 |
| C-02 | Prescriptions | frontend | P0 | M | C-01 |
| C-03 | Lab orders and result viewing | frontend | P0 | M | C-01 |
| C-04 | Patient clinical timeline tab | frontend | P1 | M | C-02, C-03 |
| C-05 | Clinical permissions and limited nurse view | frontend | P1 | S | C-01 |
| C-06 | Clinical tests and end-to-end | frontend | P0 | S | C-04 |
| BE-12 | Clinical API | backend | P0 | L | BE-11 |
| C-07 | Imaging and procedure orders | frontend | P1 | M | C-01, MD-01 |
| C-08 | Referrals and follow-up scheduling | frontend | P1 | S | C-01 |
| C-09 | Printable prescription and visit summary | frontend | P0 | S | C-02 |

## M8 Laboratory (R1)

Lab workflow from order to verified report.

| ID | Title | Area | Pri | Size | Depends on |
|---|---|---|---|---|---|
| LB-01 | Lab worklist and sample collection | frontend | P0 | M | C-03, MD-03 |
| LB-02 | Result entry and verification | frontend | P0 | L | LB-01 |
| LB-03 | Lab reports and result viewing | frontend | P0 | M | LB-02 |
| LB-04 | Laboratory tests and end-to-end flow | frontend | P0 | S | LB-03 |
| LB-05 | Outsourced tests tracking | frontend | P2 | S | LB-02 |
| BE-19 | Laboratory API | backend | P0 | L | BE-12, BE-17 |

## M9 Radiology and imaging (R1)

Imaging orders, scheduling and reporting.

| ID | Title | Area | Pri | Size | Depends on |
|---|---|---|---|---|---|
| RD-01 | Imaging worklist and scheduling | frontend | P1 | M | C-07 |
| RD-02 | Imaging report entry and sign-off | frontend | P1 | M | RD-01 |
| RD-03 | Radiology tests and end-to-end flow | frontend | P1 | S | RD-02 |
| BE-20 | Radiology API | backend | P1 | M | BE-12 |

## M10 Pharmacy and inventory (R1)

Dispense medicines safely and manage stock, batches, expiry and purchasing.

| ID | Title | Area | Pri | Size | Depends on |
|---|---|---|---|---|---|
| PH-01 | Prescription queue and dispensing | frontend | P0 | L | C-02, MD-02 |
| PH-02 | Counter sales and controlled drug register | frontend | P1 | M | PH-01 |
| PH-03 | Stock, batches and expiry | frontend | P0 | M | MD-02 |
| PH-04 | Suppliers, purchase orders and goods receipt | frontend | P1 | L | PH-03 |
| PH-05 | Pharmacy returns and wastage | frontend | P1 | S | PH-01 |
| PH-06 | Store indents and issue | frontend | P2 | M | PH-03 |
| PH-07 | Pharmacy tests and end-to-end flow | frontend | P0 | S | PH-04 |
| BE-21 | Pharmacy and inventory API | backend | P0 | L | BE-12, BE-17 |
| BE-22 | Purchasing API | backend | P1 | L | BE-21 |

## M11 Billing and charge ledger (R1)

Invoices, payments and corrections with strong integrity.

| ID | Title | Area | Pri | Size | Depends on |
|---|---|---|---|---|---|
| B-01 | Create invoice from a visit or appointment | frontend | P0 | M | C-01 |
| B-02 | Invoice list, detail and print view | frontend | P0 | M | B-01 |
| B-03 | Record payments | frontend | P0 | M | B-02 |
| B-04 | Void and credit notes | frontend | P1 | M | B-02 |
| B-05 | Billing tests and end-to-end | frontend | P0 | S | B-04 |
| BE-13 | Billing API | backend | P0 | L | BE-12, BE-19, BE-21 |
| B-06 | Pending charges and bill assembly | frontend | P0 | M | B-01, LB-03, PH-01 |
| B-07 | Discounts, concessions and approvals | frontend | P1 | M | B-06 |
| B-08 | Packages and bundled pricing | frontend | P2 | M | B-06, MD-01 |
| B-09 | Cash register and day-end settlement | frontend | P1 | M | B-03 |
| B-10 | Tax and invoice numbering | frontend | P1 | S | B-02 |

## M12 Dashboards and reports (R1)

Role-based dashboards and asynchronous reports.

| ID | Title | Area | Pri | Size | Depends on |
|---|---|---|---|---|---|
| R-01 | Role-based dashboards via widget slots | frontend | P1 | M | F-08, AP-05 |
| R-02 | Reports with asynchronous export | frontend | P1 | L | R-01 |
| R-03 | Dashboards and reports tests and performance checks | frontend | P1 | S | R-02 |
| BE-14 | Reporting API and workers | backend | P1 | L | BE-13 |
| R-04 | Operational reports | frontend | P1 | M | R-02, B-05, PH-07, LB-04 |

## M13 Platform admin (R1)

Onboard and manage hospitals without touching the database.

| ID | Title | Area | Pri | Size | Depends on |
|---|---|---|---|---|---|
| PL-01 | Platform admin shell and guard | frontend | P0 | S | F-10 |
| PL-02 | Create hospital wizard | frontend | P0 | M | PL-01 |
| PL-03 | Feature toggles and limits per hospital | frontend | P0 | M | PL-02 |
| PL-04 | Invite the first hospital admin | frontend | P0 | S | PL-02 |
| PL-05 | Suspend, reactivate and offboard a hospital | frontend | P1 | M | PL-02 |
| PL-06 | Platform audit view | frontend | P2 | S | PL-01 |
| PL-07 | Platform tests and end-to-end | frontend | P0 | S | PL-05 |
| BE-15 | Platform admin API | backend | P0 | L | BE-05, BE-08 |

## M14 Roles management (R1)

Hospital admins customize roles and permissions.

| ID | Title | Area | Pri | Size | Depends on |
|---|---|---|---|---|---|
| RP-01 | Role list and custom role editor | frontend | P0 | M | F-08, BE-05 |
| RP-02 | Permission matrix editor | frontend | P0 | M | RP-01 |
| RP-03 | View-as-role preview | frontend | P1 | M | RP-02 |
| RP-04 | Policy change propagation tests | frontend | P0 | S | RP-02 |
| BE-16 | Roles management API | backend | P0 | M | BE-05 |

## M15 Hardening and pilot launch (R1) (R1)

Performance, accessibility, security, resilience and a pilot launch.

| ID | Title | Area | Pri | Size | Depends on |
|---|---|---|---|---|---|
| H-01 | Performance audit and bundle tuning | frontend | P0 | M | R-03 |
| H-02 | Accessibility audit (WCAG 2.1 AA) | frontend | P0 | M | R-03 |
| H-03 | Threat model and security review | security | P0 | M | BE-16 |
| H-04 | End-to-end suite for critical flows | frontend | P0 | M | PL-07 |
| H-05 | Load testing with k6 | backend | P0 | M | BE-14 |
| H-06 | Monitoring, alerting and dashboards | infra | P0 | M | INF-01 |
| H-07 | Backups and disaster recovery drill | infra | P0 | M | INF-01 |
| H-08 | Production infrastructure (IaC) | infra | P0 | L | INF-01 |
| H-09 | CD pipeline with approvals and rollback | infra | P0 | M | H-08 |
| H-10 | Compliance checklist (DPDP, and HIPAA or GDPR if applicable) | security | P0 | M | H-03 |
| H-11 | Documentation and runbooks | docs | P1 | M | H-09 |
| H-12 | Pilot hospital onboarding and feedback loop | product | P0 | M | H-09, PL-07 |
| H-13 | Launch checklist and go/no-go | product | P0 | S | H-12 |

## M16 Bed management and admissions (R2)

Admit, track and move inpatients with an accurate live bed board.

| ID | Title | Area | Pri | Size | Depends on |
|---|---|---|---|---|---|
| IP-01 | Bed board and ward map | frontend | P0 | L | MD-04 |
| IP-02 | Admission workflow | frontend | P0 | L | IP-01, C-01 |
| IP-03 | Transfers and bed changes | frontend | P1 | M | IP-02 |
| IP-04 | Inpatient census and admitted list | frontend | P1 | S | IP-02 |
| IP-05 | Admissions tests and end-to-end flow | frontend | P0 | S | IP-03 |
| BE-23 | Admission, discharge and transfer (ADT) API | backend | P0 | L | BE-12, BE-17 |

## M17 Nursing and ward care (R2)

Bedside care: vitals, medication administration, rounds, notes and diet.

| ID | Title | Area | Pri | Size | Depends on |
|---|---|---|---|---|---|
| NR-01 | Nursing worklist and vitals charting | frontend | P0 | M | IP-02 |
| NR-02 | Medication orders and administration record (MAR) | frontend | P0 | L | IP-02, C-07 |
| NR-03 | Doctor rounds and progress notes | frontend | P0 | M | IP-02 |
| NR-04 | Nursing notes, intake and output, care plans | frontend | P1 | M | NR-01 |
| NR-05 | Diet orders and kitchen list | frontend | P2 | S | IP-02 |
| NR-06 | Ward care tests and end-to-end flow | frontend | P0 | S | NR-03 |
| BE-24 | Nursing and ward care API | backend | P0 | L | BE-23 |

## M18 Discharge and inpatient billing (R2)

Controlled discharge with a correct running and final bill.

| ID | Title | Area | Pri | Size | Depends on |
|---|---|---|---|---|---|
| DS-01 | Discharge planning and clearances | frontend | P0 | L | NR-03 |
| DS-02 | Discharge summary | frontend | P0 | M | DS-01, MD-05 |
| DS-03 | Running inpatient bill and deposits | frontend | P0 | L | B-06, IP-02 |
| DS-04 | Final bill and settlement | frontend | P0 | M | DS-03 |
| DS-05 | Discharge tests and end-to-end flow | frontend | P0 | S | DS-04 |
| BE-25 | Discharge and inpatient billing API | backend | P0 | L | BE-23, BE-13 |
| DS-06 | Release R2 hardening | security | P0 | M | DS-05 |

## M19 Emergency (R3)

Emergency registration, triage, rapid care and disposition.

| ID | Title | Area | Pri | Size | Depends on |
|---|---|---|---|---|---|
| ER-01 | Emergency registration and triage board | frontend | P0 | M | P-02, Q-02 |
| ER-02 | Emergency care and disposition | frontend | P0 | M | ER-01, IP-02 |
| ER-03 | Medico-legal case records | frontend | P1 | S | ER-01 |
| ER-04 | Emergency tests and end-to-end flow | frontend | P1 | S | ER-02 |
| BE-26 | Emergency API | backend | P0 | M | BE-12, BE-23 |

## M20 Operation theatre (R3)

Surgery scheduling, safety checklists, operation records and charges.

| ID | Title | Area | Pri | Size | Depends on |
|---|---|---|---|---|---|
| OT-01 | OT scheduling and theatre calendar | frontend | P0 | L | IP-02, D-02 |
| OT-02 | Pre-operative checklist and anaesthesia record | frontend | P1 | M | OT-01, MD-06 |
| OT-03 | Operation note, consumables and procedure charges | frontend | P0 | M | OT-01, PH-03 |
| OT-04 | Post-operative care and OT tests | frontend | P1 | S | OT-03 |
| BE-27 | Operation theatre API | backend | P0 | L | BE-23, BE-21 |

## M21 Insurance, TPA and claims (R3)

Cashless and claim workflows with split billing and receivables.

| ID | Title | Area | Pri | Size | Depends on |
|---|---|---|---|---|---|
| IN-01 | Insurer, TPA and corporate masters | frontend | P0 | M | MD-01 |
| IN-02 | Policy capture and pre-authorization | frontend | P0 | L | IN-01, IP-02 |
| IN-03 | Split billing and co-pay | frontend | P0 | L | IN-02, DS-04 |
| IN-04 | Claims submission and tracking | frontend | P0 | L | IN-03 |
| IN-05 | Corporate credit billing and receivables | frontend | P1 | M | IN-03 |
| IN-06 | Insurance tests and end-to-end flow | frontend | P1 | S | IN-04 |
| BE-28 | Insurance and claims API | backend | P0 | L | BE-25 |
| IN-07 | Release R3 hardening | security | P0 | M | IN-06, ER-04, OT-04 |

## M22 Medical records and documents (R4)

Document storage, consents, certificates and record quality.

| ID | Title | Area | Pri | Size | Depends on |
|---|---|---|---|---|---|
| MR-01 | Patient document store | frontend | P1 | M | P-03 |
| MR-02 | Consents and certificates | frontend | P1 | M | MD-06 |
| MR-03 | Patient merge and record corrections | frontend | P1 | M | P-04 |
| MR-04 | Medical records department tools | frontend | P2 | M | MR-01 |
| MR-05 | Records tests and end-to-end flow | frontend | P1 | S | MR-03 |
| BE-29 | Documents and records API | backend | P1 | L | BE-09 |

## M23 Hospital operations (R4)

Rosters, blood bank, ambulance and housekeeping.

| ID | Title | Area | Pri | Size | Depends on |
|---|---|---|---|---|---|
| OP-01 | Duty rosters and shifts | frontend | P1 | M | D-03 |
| OP-02 | Blood bank | frontend | P1 | L | LB-04, IP-02 |
| OP-03 | Ambulance management | frontend | P2 | M | OP-01 |
| OP-04 | Housekeeping and bed cleaning tasks | frontend | P2 | S | IP-01 |
| OP-06 | Operations tests and end-to-end flow | frontend | P2 | S | OP-02 |
| BE-30 | Operations API | backend | P1 | L | BE-23, BE-19 |
| OP-07 | Release R4 hardening and full-journey regression | security | P0 | M | OP-06, MR-05, BE-30 |

## Backlog

Ideas and future features. Not scheduled.

| ID | Title | Area | Pri | Size | Depends on |
|---|---|---|---|---|---|
| FUT-01 | Appointment reminders (email, SMS, WhatsApp) | product | P2 | L | - |
| FUT-02 | Per-hospital SSO (OIDC and SAML) | backend | P2 | L | - |
| FUT-03 | Custom domain per hospital | product | P2 | M | - |
| FUT-05 | ABDM and ABHA integration | backend | P2 | L | - |
| FUT-06 | HL7 or FHIR, lab analyzer and PACS integration adapters | backend | P2 | L | - |
| FUT-07 | Telemedicine and patient-facing app | product | P2 | L | - |
| FUT-08 | Accounting export and statutory reports | backend | P2 | M | - |
| FUT-04 | Dedicated database for large hospitals | infra | P2 | L | - |

