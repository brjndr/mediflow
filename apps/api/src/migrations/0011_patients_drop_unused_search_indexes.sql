-- Removes the two trigram indexes that 0010 added for patient search.
--
-- They are never used. Under row-level security Postgres may only use a clause as an index
-- condition if its operator is leakproof, and LIKE is not (it could reveal rows the policy hides
-- through errors or timing). So a search runs as: find this hospital's rows through a
-- tenant-first b-tree index, then match the text against those rows. The trigram indexes only
-- made every registration slower.
--
-- Measured on 60,000 patients in one hospital, a substring search takes about 40 ms. A faster
-- search for very large hospitals needs its own design (issue to be filed), not an index the
-- planner cannot use.
DROP INDEX patients_tenant_search;
DROP INDEX patients_tenant_phone_search;
