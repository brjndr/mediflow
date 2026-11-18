# Compliance checklist (H-10, #147)

Working checklist for the pilot. It covers India's DPDP Act by default, and HIPAA or GDPR only if a hospital in those markets is served (`docs/OPEN_DECISIONS.md`). Each line says what the product does today, where, and what is still open. Open lines need a person (a lawyer, the product owner, a cloud account), not code. **Sign-off is a human act**: the table at the end stays empty until the named people fill it in. This is an engineering checklist, not legal advice.

Roles: the hospital is the data fiduciary (DPDP) and owns its data; the platform is the processor (offboarding decision in `docs/OPEN_DECISIONS.md`). Status: **Done** (built and tested), **Partial**, **Open** (needs a decision or an account).

Related: threat model (#140), `docs/runbooks/incident-response.md`, `docs/R2-HARDENING.md`.

## 1. Consent, retention and residency

| #    | Item                                                       | Status  | Where and note                                                                                                                                                                                                      |
| ---- | ---------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1  | Consent to contact captured at registration, who and when  | Done    | `contact_consent_*` columns (migration 0010). Nothing contacts a patient in v1; stored for future reminders.                                                                                                        |
| 1.2  | Consent for treatment and procedures, with a signed record | Partial | Consents and certificates are on the mock only in the web app (#190). Open until the API exists or paper consent is accepted for the pilot.                                                                         |
| 1.3  | Staff-only access, no patient login                        | Done    | Product scope in `CLAUDE.md`; there is no patient role.                                                                                                                                                             |
| 1.4  | Minimum data shown: masked fields, permission-gated fields | Done    | Masked phone and MRN in lists; `patient.diagnosis:read`.                                                                                                                                                            |
| 1.5  | Retention of documents per category, with legal hold       | Done    | `document_retention_rules`, `retain_until`, sweep job, legal holds (`apps/api/src/features/documents/CLAUDE.md`). Default is keep for ever; each hospital sets years.                                               |
| 1.6  | Retention of reports and account events                    | Done    | Reports sweep; `account_event_settings.retention_days` (`apps/api/src/core/auth/retention.ts`). Audit log: see 3.3.                                                                                                 |
| 1.7  | Statutory minimum periods stated to hospitals              | Partial | Listed in the offboarding decision (doctor's records 3 years, GST invoices 72 months, drug registers 2 to 3 years, blood bank 5 years). **Open:** a lawyer confirms; add to the hospital terms.                     |
| 1.8  | Correction and erasure requests                            | Partial | Corrections are new entries (append-only); merge and unmerge exist. No erasure workflow, since records the law requires are kept. **Open:** written policy on who answers a request (the hospital as fiduciary).    |
| 1.9  | Data residency in India                                    | Open    | Target is Mumbai (`docs/ARCHITECTURE.md`). No hosted environment yet (#56, #146). Confirm primary, replica and backups stay in India when the account is made. Foreign hospitals need a per-tenant region decision. |
| 1.10 | Children's data and guardian consent                       | Open    | DPDP needs verifiable parental consent. Decide how a hospital records it (see 1.2) before paediatric patients are registered in the pilot.                                                                          |
| 1.11 | No real patient data outside production                    | Done    | Fictional seed data; the dev seed refuses a remote host without `--allow-host`.                                                                                                                                     |

## 2. Breach response process

| #   | Item                                                       | Status | Where and note                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | Written procedure: detect, contain, assess, tell hospitals | Done   | `docs/runbooks/incident-response.md`. Tenant isolation or PHI exposure is a breach until shown otherwise.                                                                                                             |
| 2.2 | Evidence to assess scope                                   | Done   | Per-hospital audit log of PHI reads and writes, platform audit trail, account events.                                                                                                                                 |
| 2.3 | Who notifies the authority, and the deadline               | Open   | The runbook says the product owner decides and files (the Data Protection Board under DPDP). **Open:** name the owner and a deputy, the notice time promised to hospitals (suggest 72 hours), and a message template. |
| 2.4 | Contacts: security mailbox, hospital admins, host support  | Open   | Needs a mailbox, an on-call rota and a cloud account.                                                                                                                                                                 |
| 2.5 | Breach register (date, scope, cause, actions, notices)     | Open   | Kept privately outside the repo (no PHI in git). **Open:** choose where.                                                                                                                                              |
| 2.6 | One tabletop exercise before the pilot                     | Open   | Walk the runbook with a made-up leak and record the fixes.                                                                                                                                                            |
| 2.7 | Logs and error reports free of PHI                         | Done   | pino redaction, `scrubEvent`, error messages never sent; `/phi-check` on each change.                                                                                                                                 |

## 3. Audit log review

| #   | Item                                                  | Status  | Where and note                                                                                                                                |
| --- | ----------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 | PHI reads and writes recorded in the same transaction | Done    | `audit` hook (`apps/api/src/core/audit`).                                                                                                     |
| 3.2 | Audit rows cannot be updated or deleted               | Done    | Immutability triggers (migrations 0007, 0008).                                                                                                |
| 3.3 | Audit log retention                                   | Partial | Partitioned by month, never swept. **Open:** decide the period (suggest at least 3 years, in step with record retention) and an archive step. |
| 3.4 | A hospital can search its own audit log               | Partial | The platform trail is searchable (#130). **Open:** confirm a hospital-side screen or export; if none, raise an issue.                         |
| 3.5 | Sensitive reads audited and restricted                | Done    | Medico-legal cases, documents, patient merge, platform support access.                                                                        |
| 3.6 | Routine review of the log                             | Open    | **Open:** who, how often (suggest monthly: support access, failed sign-ins, exports) and where findings are recorded.                         |
| 3.7 | Partition health                                      | Done    | `auditDefaultRows` must be zero; partitions made ahead by a job.                                                                              |

## 4. BAA and processor terms

| #   | Item                                                  | Status  | Where and note                                                                                                                       |
| --- | ----------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 4.1 | Is any US (HIPAA) or EU (GDPR) hospital in the pilot? | Open    | Default for the pilot: no, India only. If yes, 4.2 to 4.4 block go-live.                                                             |
| 4.2 | BAA with the hosting provider before US patient data  | Open    | Needs the cloud account (#56); choose a provider that signs one.                                                                     |
| 4.3 | BAA or processor agreement with each hospital         | Open    | Purpose, security measures, sub-processors, breach notice, return or deletion at exit (the offboarding export covers the last).      |
| 4.4 | Sub-processor list with regions                       | Open    | Sentry gets scrubbed errors only. List hosting, error tracking and mail; none receives patient data by design.                       |
| 4.5 | HIPAA technical safeguards                            | Partial | Unique users, idle timeout, MFA by hospital switch, audit controls, TLS. Encryption at rest and backups to be confirmed when hosted. |

## 5. Cross-checks

| #   | Item                                                  | Status  | Where and note                                                                                                    |
| --- | ----------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| 5.1 | Tenant isolation by RLS, cross-tenant test per table  | Done    | Mandatory API tests; `/tenant-safety-check`.                                                                      |
| 5.2 | Argon2id, MFA, rate limits, httpOnly sessions         | Done    | MFA is off until a hospital's `mfa` switch is set. **Open:** set `mfa_required` for the pilot hospital.           |
| 5.3 | Backups, point-in-time recovery, a tested restore     | Open    | Needs hosting; restore steps follow the CD pipeline (#146, #148).                                                 |
| 5.4 | Threat model and security review                      | Open    | #140; link its result here when merged.                                                                           |
| 5.5 | Offboarding: export, then erase, legal hold respected | Done    | #959 to #961. Backups keep deleted data until they rotate (about 35 days); the hospital is told.                  |
| 5.6 | Security headers and strict CORS                      | Partial | `@fastify/helmet` and CORS are not built yet (`CLAUDE.md`, Not built yet); CSP at the host. Close before go-live. |

## Sign-off

Signed off when every line is Done, or Open with a written owner and date, and the people below have signed. This table is the only place a signature is recorded.

| Role                                   | Name | Date | Notes |
| -------------------------------------- | ---- | ---- | ----- |
| Product owner                          |      |      |       |
| Engineering lead                       |      |      |       |
| Legal adviser (1.7, 1.8, 1.10, 2.3, 4) |      |      |       |
