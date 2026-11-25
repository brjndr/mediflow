# Audit seal bucket (Object Lock)

For whoever deploys and is on call. Each new audit seal (`core/audit/seal.ts`, #1081) is copied to a write-once bucket (#1092) so that `audit.seal-verify` can tell a chain made again from the real one. Without the bucket, someone with database owner rights could rewrite the log and its seals together. The code is `core/audit/seal-mirror.ts`; the notes are in `apps/api/CLAUDE.md` (Audit, events and jobs).

## 1. Set up the bucket (once per environment)

1. **Create a bucket with Object Lock enabled at creation.** Object Lock comes with versioning and, on most providers, cannot be turned on for an existing bucket. Use a bucket of its own, never the `S3_BUCKET` that holds files, so no file lifecycle rule or file-store credential reaches it.
2. **Do not set a default retention or any lifecycle expiry.** The API sets the lock on each copy (mode `COMPLIANCE`, so nobody, the account owner included, can shorten or lift it until it ends).
3. **Credentials:** a key that may `PutObject` (with the object lock headers), `GetObject`, `ListBucket` and `GetObjectRetention` on this bucket only, and nothing that deletes or bypasses retention (`DeleteObject`, `DeleteObjectVersion`, `BypassGovernanceRetention`, `PutBucketObjectLockConfiguration`). Keep any administrator key outside the API's environment. The API uses `S3_REGION`, `S3_ENDPOINT` and the S3 key pair that are set for the file store, so if the file store's key must not reach this bucket, give the audit copy its own deployment of the API variables.
4. **Encryption:** server-side encryption on, as for the file store (`S3_SERVER_SIDE_ENCRYPTION`).
5. **Set in the API's environment:**
   - `AUDIT_SEAL_BUCKET=<bucket name>` (needs `S3_REGION`; the API refuses to start without it).
   - `AUDIT_SEAL_RETENTION_MONTHS`: how long each copy stays locked. Never below `AUDIT_RETENTION_MONTHS` (the seals must outlive the rows they vouch for). Unset, it follows `AUDIT_RETENTION_MONTHS`, or 120 months when the log is kept for ever.
   - `AUDIT_SEAL_KEY` is a separate secret and stays outside the database.
6. **Restart and check:** within five minutes the `audit.seal` job logs `audit_sealed` and the bucket shows one object for each hospital's new seal. Seals that have no copy yet are copied by the same job on each run.

**Compliance mode cannot be undone.** A retention that is too long stays until it ends, and every copy costs storage for that time. Try the bucket and the retention first in a test environment with a short retention, then set the real value. Never test against the production bucket.

## 2. What runs

| Job                 | When               | What it does                                                                                                               |
| ------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `audit.seal`        | every 5 minutes    | Seals new rows, copies each new seal, and copies again any seal whose earlier copy failed.                                 |
| `audit.seal-verify` | daily at 04:30 UTC | Checks the chain against the database and the bucket: every seal on Sundays, the last two days and a sample on other days. |

## 3. Alerts

Both jobs write structured logs (ids and codes only, never patient data) and fail the job on a problem, so an alert can use the log event or the failed job. Page for the first three rows, ticket for a single copy failure.

| Signal                                                                  | Meaning                                                                                                            | Alert                                                                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Log `event=audit_seal_mismatch` with `problem=chain_rewritten`          | A copy in the bucket differs from the database, or the database has no such seal. The log may have been rewritten. | Page at once, on any occurrence. Follow section 4.                                                                        |
| Log `event=audit_seal_mismatch` with `problem=mirror_missing`           | A seal past the overdue limit has no copy in the bucket.                                                           | Page on the first daily run that reports it: the copy job has been failing for hours.                                     |
| Job `audit.seal-verify` failed, or no `audit_seal_verified` in 26 hours | Verification did not run, or it found a mismatch.                                                                  | Page.                                                                                                                     |
| Log `event=audit_seal_copy_failed` (fields `tenantId`, `seal`)          | `audit.seal` could not copy a seal in this run. It tries again in 5 minutes.                                       | Ticket for one. Page when it appears in 3 runs in a row (15 minutes) or when `audit_sealed` is not logged for 15 minutes. |

Until the CD pipeline and a log system exist (#146), these are the rules to create there: match on the `event` field of the API's JSON logs, and on failed `audit.seal` and `audit.seal-verify` jobs in `pgboss.job` (state `failed`).

## 4. When an alert fires

1. **`audit_seal_copy_failed` or `mirror_missing`:** read the error in the log (the provider's code, not a patient detail). Usual causes: the credential expired or lost a permission, the bucket name changed, the endpoint is down, the clock is far off. Fix the cause. The next `audit.seal` run copies every seal that has no copy, and the next `audit.seal-verify` then reports none. Compare the number of objects for the hospital in the bucket with its rows in `audit_seal`.
2. **`chain_rewritten`:** treat it as a security incident. Do not run anything that changes `audit_log` or `audit_seal`. Follow [incident response](incident-response.md), keep the logs, list the hospital and seal ids from the log lines, and compare the copies in the bucket (they cannot have been rewritten) with the database rows. Only the copies in the bucket are trusted.
3. **Never delete or "repair" a copy.** It cannot be done in compliance mode, and an attempt by another route is itself a finding.

## 5. Changing things later

- **Rotating the bucket credentials:** create the new key, set it, restart, check one `audit_sealed` cycle, then remove the old key.
- **Changing the retention:** only new copies take the new value; old copies keep their lock.
- **Changing `AUDIT_SEAL_KEY`:** makes every earlier seal fail verification (see `core/config/config.ts`). Keep the old key until those months are retired.
- **Moving to another bucket:** set `AUDIT_SEAL_BUCKET` to the new one; the job copies every seal there over its next runs. Leave the old bucket in place until its locks end.
- **A deleted hospital:** its seals go with its data; its copies are left alone and expire with their lock.
