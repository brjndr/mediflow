# Open decisions

Moved out of the root `CLAUDE.md` (#370). Decided defaults live in Technology Decisions (root `CLAUDE.md` and `docs/ARCHITECTURE.md`). When one of these is decided, write the decision where it applies and remove it here.

Decided defaults live in Technology Decisions. Remaining questions:

- Backend: Fastify + TypeBox + Drizzle decided. Revisit NestJS only if a team joins and wants enforced structure and dependency injection
- Whether any premium library licence (for example a calendar resource timeline or an advanced data grid) is ever worth buying for the scheduling and OT views. Not during development: the owner decided on 2026-10-14 that nothing paid goes into the project while it is being built
- Exact numeric budgets: the initial values in Performance Strategy are starting points to tighten or relax after the first real measurements
- Cloud provider: AWS Mumbai is the default, confirmed only when the account is opened for staging (#56). No account or subscription exists yet. Until then keep the application provider-neutral (one container image, configuration from the environment, Postgres, S3-compatible storage, SMTP) and write no infrastructure code. Alternatives (GCP, Azure, a cheaper VPS provider for the pilot phase) if cost or credits favor them
- Target markets and compliance scope: India DPDP only vs HIPAA/GDPR, and per-tenant data residency
- When per-hospital SSO (Keycloak, SAML/OIDC) is first needed
- Permission granularity: resource:action only (assumed) vs field-level and attribute-based (ABAC) rules
- Who can create custom roles (hospital admin only vs platform-approved) and whether permissions can be time-boxed
- Policy delivery: fetched at login + refresh (assumed) vs embedded in token; refresh interval
- Dynamic module loading: build-time registry (assumed) vs runtime micro-frontends (Module Federation) if independent team deployments are needed
- Whether any hospital will ever need its own branded URL or custom domain (not planned; single shared URL by default)
- Login-page branding before sign-in (generic by default; optional last-used-hospital memory)
- Real-time needs (queues, bed availability) and whether SSE is enough
- Integrations to plan adapters for: ABDM/ABHA, HL7 v2 or FHIR, lab analyzers, DICOM/PACS, insurer and TPA e-claim portals, accounting export (for example Tally)
- Statutory and regional requirements: the drug schedules are India's (H, H1, X, G, narcotic) and fixed in the contract for now, so a hospital under another country's rules needs them to become a per-hospital list; drug schedule and controlled-drug registers, GST invoice formats, death and birth certificate formats, medico-legal records
- Whether telemedicine, a patient portal or a mobile app for doctors are ever in scope (currently out of scope)
- Which modules the pilot hospital actually needs in R1, so low-priority modules (radiology, purchasing) can be deferred
- How much clinical access the hospital admin keeps (#86): today the admin role holds every clinical permission by default (writing notes, recording diagnoses, prescribing), wider than the "view" of the role matrix in `docs/PRODUCT.md`, because nobody may invite into a role that holds more than their own and the admin must invite doctors and nurses. Decide before a pilot whether invitations should be checked differently (for example a `staff:invite` that may give any built-in role) so the admin can go back to viewing, or whether the hospital narrows its own admin through role management (BE-16)
