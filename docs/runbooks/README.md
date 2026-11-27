# Runbooks

Procedures that need no deployed environment. Deploy, rollback and restore steps wait for the CD pipeline (#146) and are written in #148.

| Runbook                                                         | For                                         |
| --------------------------------------------------------------- | ------------------------------------------- |
| [Architecture overview](../OVERVIEW.md)                         | Anyone new: how the system fits together    |
| [Local onboarding](local-onboarding.md)                         | A new engineer: run the app, tour the code  |
| [Hospital onboarding](hospital-onboarding.md)                   | Platform admins: first admin, new hospitals |
| [Incident response and support access](incident-response.md)    | Whoever is on call: policy and steps        |
| [Offboarding export recipient](offboarding-export-recipient.md) | Operators: nobody can receive an export     |
| [Audit seal bucket](audit-seal-bucket.md)                       | Deploy and on call: Object Lock, alerts     |

Staff sheets for hospital roles are in [`docs/guides`](../guides/README.md).
