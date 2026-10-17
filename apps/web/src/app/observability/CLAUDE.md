# Error reporting and logging policy

Moved out of the root `CLAUDE.md` (#370), which keeps the rule; Claude Code loads this file when a file of this folder is read. Read it before changing or using what is here.

Web: `app/observability/` and `shared/lib/logger.ts`.

- Errors only. No session replay, no performance tracing, no breadcrumbs. The SDK loads after first paint, and only when `VITE_SENTRY_DSN` is set for the deployment.
- Every outgoing event is **rebuilt from an allowlist** (`scrubEvent`): error type, stack frames (file, function, line), environment, release, and two tags, the route pattern and the tenant id. Request and response bodies, URLs, query strings, headers, cookies, the user, and any extra data are never sent.
- **Error messages are not sent**, because code builds them from data. The one exception is `ApiError`, whose message is always a fixed code. Do not put information you need for debugging in an error message; use the error type and a stable code.
- Report a caught error with `reportError(error)`. Never attach context objects to it.
- App code does not call `console.*` (lint error). Use `logger.warn(event, fields)` or `logger.error(event, fields)`: a static event name plus fields from the `LogFields` allowlist (tenant id, route pattern, feature, code, status, request id, key, count, duration). Adding a field is a reviewed change to `LogFields`, where "can this ever hold patient data?" is asked once.
- Web vitals carry the metric, its rating, the route pattern and the tenant id only.
