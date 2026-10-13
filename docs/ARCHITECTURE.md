# Architecture reference

Reference for work that has not started: infrastructure, the platform admin module and patient messaging. It was moved out of the root `CLAUDE.md`, which holds the rules and points here. Read the section that applies before starting that work.

## Growth phases

1. **Dev and pilot (0 to a few hospitals):** everything runs locally in Docker; mock API until the backend exists. Deploy one small API container, a small managed Postgres (background jobs run on a Postgres-backed queue such as pg-boss), object storage, and the CDN-hosted SPA. Fixed, predictable monthly cost.
2. **Growth:** run containers on a managed orchestrator (ECS Fargate or Cloud Run) with autoscaling and at least 2 instances across zones; add a Postgres read replica and connection pooling (PgBouncer); add Redis for shared cache, rate limits and queues (BullMQ); separate worker containers for queues; put a WAF and per-tenant rate limits in front.
3. **Large scale:** partition big tables (appointments, invoices) by tenant/time, add more replicas, move the largest hospitals to dedicated databases, add multi-zone failover, and multi-region only if required.

## Cost guardrails

- Budget alerts from day one. Tag resources by environment and, where possible, by tenant. **Meter per-tenant usage** (requests, storage, active users) so hospitals can be priced and cost attributed.
- Autoscale with sensible min/max. Prefer ARM instances. Shut down non-prod outside working hours. Buy reserved capacity or savings plans only after 2 to 3 months of stable usage.
- Push work to the edge: CDN caching for static assets and non-PHI tenant config, cache reference data, compress responses, cap log retention, move old records and files to cheaper storage tiers.
- Self-host OSS (Keycloak, Grafana) only when ops time costs less than the SaaS bill. Otherwise use managed.
- Avoid until justified: Kubernetes, microservices, Kafka, paid UI component suites, per-seat enterprise SaaS.

## Hospital onboarding flow (platform_admin)

All in the platform module. The rules for platform admins are in the root `CLAUDE.md`, under Hospital onboarding.

1. **Create hospital:** name, slug, locale, timezone, currency, branding (logo, primary color), region.
2. **Choose plan/features:** enable or disable modules (feature flags) for this hospital, and set limits (e.g. max users, storage).
3. **Seed roles:** the built-in roles are created for the new hospital with default permissions (editable later by its admin).
4. **Invite first hospital admin:** enter the admin's name and email. The system sends an invite link. The admin sets a password and MFA, then signs in and invites their own staff.
5. **Activate:** the hospital goes live. It can later be suspended (blocks all logins, keeps data) or offboarded (export, then scheduled deletion).

## Worked example: appointment reminders (planned, not in v1)

Nothing in core changes. The feature adds:

- Backend `reminders` module subscribing to `appointment.created|rescheduled|cancelled`. It schedules or cancels delayed jobs, checks `patient.contactConsent`, renders a hospital-specific template, and sends through the `Notifier` interface using email/SMS/WhatsApp providers. It meters messages per hospital against a quota and honors opt-outs.
- Frontend `features/reminders/`: a settings section (channels, timing, templates, quota), an `appointment.row.badges` contribution ("reminder sent/failed"), and a `reminder:manage` permission.
- Messages contain minimum necessary information (date, time, hospital name) and never diagnoses or department names that reveal a condition.
- What v1 must already provide for this: the appointment events, the `Notifier` abstraction, patient phone/email/`contactConsent` captured at registration, the slot and settings mechanisms, and feature flags with per-tenant settings.
