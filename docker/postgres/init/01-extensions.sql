-- Runs once when the volume is first created.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist; -- exclusion constraints (double-booking, bed occupancy)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Test database for API integration tests (BE-01).
CREATE DATABASE mediflow_test;
