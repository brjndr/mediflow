-- Extensions the schema relies on. Idempotent, so it is safe where the platform (or the local
-- Docker init script) already created them.
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid(), digests
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- trigram indexes for name and MRN search
CREATE EXTENSION IF NOT EXISTS btree_gist; -- exclusion constraints (double-booking, bed occupancy)
